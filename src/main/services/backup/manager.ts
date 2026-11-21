/**
 * Backup orchestration for the open database: settings (kept outside the database
 * so a restore cannot change them), the backup folder per environment, automatic
 * backups, retention, verification, import, restore and restore history.
 * Electron-free so it is unit-testable; the main process supplies the callbacks.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  DEFAULT_BACKUP_SETTINGS, type BackupInfo, type BackupOverview, type BackupReason, type BackupSettings, type BackupVerifyResult, type DbEnvironment,
  type RestoreHistoryEntry
} from '@shared/backup'
import type { DB } from '../../db/connection'
import { LATEST_SCHEMA_VERSION } from '../../db/migrations'
import { cleanupInterrupted, createBackup, importBackupFile, listBackups, nextAutomaticDue, pruneBackups, verifyDatabaseFile, writeFileAtomic } from './backup'
import { restoreDatabase, type RestoreResult } from './restore'
import { isInside } from './workspace'

export const SETTINGS_FILE = 'backup-settings.json'
export const HISTORY_FILE = 'restore-history.jsonl'

export interface BackupManagerOptions {
  /** Data folder (userData). */
  root: string
  environment: DbEnvironment
  dbPath: string
  appVersion: string
  getDb: () => DB | null
  /** Close the live connection (checkpointing WAL) before the file is replaced. */
  closeDb: () => void
  /** Folders a backup directory must not be inside (the installation folder). */
  forbiddenDirs?: string[]
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export class BackupManager {
  private partialRemoved = 0
  constructor(private readonly o: BackupManagerOptions) {}

  get environment(): DbEnvironment {
    return this.o.environment
  }

  settings(): BackupSettings {
    try {
      const raw = JSON.parse(readFileSync(join(this.o.root, SETTINGS_FILE), 'utf8')) as Partial<BackupSettings>
      return { ...DEFAULT_BACKUP_SETTINGS, ...raw }
    } catch {
      return { ...DEFAULT_BACKUP_SETTINGS }
    }
  }

  saveSettings(next: Partial<BackupSettings>): BackupSettings {
    const merged = { ...this.settings(), ...next }
    if (merged.directory) this.assertUsableDirectory(merged.directory)
    mkdirSync(this.o.root, { recursive: true })
    writeFileAtomic(join(this.o.root, SETTINGS_FILE), JSON.stringify(merged, null, 2))
    return merged
  }

  assertUsableDirectory(dir: string): void {
    if (!isAbsolute(dir)) throw new Error('Choose a full folder path for backups')
    for (const f of this.o.forbiddenDirs ?? []) if (isInside(dir, f)) throw new Error('Backups cannot be stored inside the application installation folder (it is replaced on upgrade)')
    if (isInside(dir, join(this.o.root, 'data'))) throw new Error('Backups cannot be stored inside the live database folder')
  }

  defaultDirectory(): string {
    return join(this.o.root, 'backups')
  }

  /** Backups for this environment only: <folder>\company or <folder>\demo. */
  directory(): string {
    return join(this.settings().directory ?? this.defaultDirectory(), this.o.environment === 'COMPANY' ? 'company' : 'demo')
  }

  list(): BackupInfo[] {
    return listBackups(this.directory()).filter((b) => b.environment === this.o.environment || b.environment === 'UNKNOWN')
  }

  /** Startup housekeeping: remove interrupted backup files. */
  housekeeping(): string[] {
    const removed = cleanupInterrupted(this.directory())
    this.partialRemoved += removed.length
    if (removed.length) this.o.log?.('warn', 'Removed incomplete backup files', { removed })
    return removed
  }

  overview(schemaVersion: number): BackupOverview {
    const s = this.settings()
    const next = nextAutomaticDue(this.directory(), s)
    return {
      environment: this.o.environment, databasePath: this.o.dbPath, directory: this.directory(), defaultDirectory: join(this.defaultDirectory(), this.o.environment === 'COMPANY' ? 'company' : 'demo'),
      settings: s, backups: this.list(), lastAutomaticAt: next.last, nextAutomaticDue: next.due ? next.due.toISOString() : null,
      partialFilesRemoved: this.partialRemoved, restoreHistory: this.history().slice(0, 20), schemaVersion
    }
  }

  async backupNow(reason: BackupReason, label?: string | null, now?: Date): Promise<BackupInfo> {
    const db = this.o.getDb()
    if (!db || !db.open) throw new Error('No database is open')
    const info = await createBackup(db, { dir: this.directory(), reason, appVersion: this.o.appVersion, label, now })
    const pruned = pruneBackups(this.directory(), this.settings())
    this.o.log?.('info', 'Backup created', { file: info.fileName, reason, sizeBytes: info.sizeBytes, pruned: pruned.length })
    return info
  }

  /** Called periodically; makes an AUTO backup when one is due. */
  async autoTick(now = new Date()): Promise<BackupInfo | null> {
    const due = nextAutomaticDue(this.directory(), this.settings()).due
    if (!due || due > now) return null
    try {
      return await this.backupNow('AUTO', null, now)
    } catch (err) {
      this.o.log?.('error', 'Automatic backup failed', err)
      return null
    }
  }

  find(fileName: string): BackupInfo {
    const b = this.list().find((x) => x.fileName === fileName)
    if (!b) throw new Error('Backup not found in the backup folder')
    return b
  }

  verify(fileName: string): BackupVerifyResult {
    const b = this.find(fileName)
    return verifyDatabaseFile(b.path, { maxSchemaVersion: LATEST_SCHEMA_VERSION, expectSha256: b.sha256, expectedEnvironment: this.o.environment })
  }

  importFile(source: string): BackupInfo {
    const info = importBackupFile(source, this.directory(), { appVersion: this.o.appVersion, maxSchemaVersion: LATEST_SCHEMA_VERSION })
    if (info.environment !== this.o.environment) {
      // Keep it out of this environment's restore list.
      this.o.log?.('warn', 'Imported backup belongs to another environment', { file: info.fileName, environment: info.environment })
    }
    return info
  }

  /**
   * Full restore. Verifies the backup, takes a verified PRE_RESTORE backup of the
   * current database, closes it and swaps the file. The caller restarts the app.
   */
  async restore(fileName: string, user: string | null): Promise<RestoreResult & { safetyBackup: string }> {
    const b = this.find(fileName)
    const check = verifyDatabaseFile(b.path, { maxSchemaVersion: LATEST_SCHEMA_VERSION, expectSha256: b.sha256, expectedEnvironment: this.o.environment })
    if (!check.ok) {
      this.appendHistory({ outcome: 'FAILED', backupFile: fileName, safetyBackup: null, message: check.errors.join('; '), user })
      throw new Error(`The backup cannot be restored: ${check.errors.join('; ')}`)
    }
    const safety = await this.backupNow('PRE_RESTORE', `Before restoring ${fileName}`)
    this.o.closeDb()
    try {
      const res = restoreDatabase({
        livePath: this.o.dbPath, backupPath: b.path, backupSha256: b.sha256, environment: this.o.environment, maxSchemaVersion: LATEST_SCHEMA_VERSION,
        safetyBackup: safety.fileName, user
      })
      this.appendHistory({ outcome: res.outcome === 'RESTORED' ? 'RESTORED' : 'ROLLED_BACK', backupFile: fileName, safetyBackup: safety.fileName, message: res.message, user })
      return { ...res, safetyBackup: safety.fileName }
    } catch (err) {
      this.appendHistory({ outcome: 'FAILED', backupFile: fileName, safetyBackup: safety.fileName, message: (err as Error).message, user })
      throw err
    }
  }

  appendHistory(e: Omit<RestoreHistoryEntry, 'at' | 'environment'>): void {
    mkdirSync(this.o.root, { recursive: true })
    appendFileSync(join(this.o.root, HISTORY_FILE), JSON.stringify({ at: new Date().toISOString(), environment: this.o.environment, ...e }) + '\n', 'utf8')
  }

  history(): RestoreHistoryEntry[] {
    const p = join(this.o.root, HISTORY_FILE)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RestoreHistoryEntry]
        } catch {
          return []
        }
      })
      .filter((e) => e.environment === this.o.environment)
      .reverse()
  }
}
