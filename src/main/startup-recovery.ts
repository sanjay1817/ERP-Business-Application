/**
 * Startup integrity gate. A database that fails `PRAGMA quick_check` is never
 * opened for writing. Interactive start-ups offer to restore the newest verified
 * backup (the damaged file is kept beside the backups for support); automated
 * runs and a refusal stop with the data untouched.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupInfo, DbEnvironment } from '@shared/backup'
import { LATEST_SCHEMA_VERSION } from './db/migrations'
import { stamp, verifyDatabaseFile } from './services/backup/backup'
import type { BackupManager } from './services/backup/manager'
import { finalizeRestore, quickCheck, restoreDatabase } from './services/backup/restore'

export interface RecoveryLogger {
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

export class DatabaseDamagedError extends Error {}

function healthy(path: string): boolean {
  try {
    return quickCheck(path)
  } catch {
    return false
  }
}

/** Newest backup of this environment that passes full verification. */
export function newestVerifiedBackup(manager: BackupManager, env: DbEnvironment): BackupInfo | null {
  for (const b of manager.list()) {
    if (verifyDatabaseFile(b.path, { maxSchemaVersion: LATEST_SCHEMA_VERSION, expectSha256: b.sha256, expectedEnvironment: env }).ok) return b
  }
  return null
}

export async function quickCheckOrRecover(o: {
  dbPath: string
  env: DbEnvironment
  manager: BackupManager
  interactive: boolean
  logger: RecoveryLogger
  /** Defaults to an Electron message box. Returns true to restore the offered backup. */
  ask?: (backup: BackupInfo | null) => boolean
}): Promise<{ restored: BackupInfo | null }> {
  if (healthy(o.dbPath)) return { restored: null }
  o.logger.error('Database failed its integrity check', { path: o.dbPath })
  const latest = newestVerifiedBackup(o.manager, o.env)
  if (!o.interactive) throw new DatabaseDamagedError(`The database ${o.dbPath} failed its integrity check and was not opened.`)
  const ask = o.ask ?? (await electronAsk())
  if (!latest || !ask(latest)) {
    throw new DatabaseDamagedError(
      latest
        ? 'The database failed its integrity check and was not opened. No changes were made. Restore a backup from the Backup and Restore guide, or contact support.'
        : 'The database failed its integrity check and no verified backup was found. The file was not changed. Contact support with the application log.'
    )
  }
  // Keep the damaged file (and its WAL) for support before anything is replaced.
  const keep = join(o.manager.directory(), `damaged-${stamp(new Date())}.db.keep`)
  copyFileSync(o.dbPath, keep)
  if (existsSync(`${o.dbPath}-wal`)) copyFileSync(`${o.dbPath}-wal`, `${keep}-wal`)
  const res = restoreDatabase({
    livePath: o.dbPath, backupPath: latest.path, backupSha256: latest.sha256, environment: o.env, maxSchemaVersion: LATEST_SCHEMA_VERSION,
    safetyBackup: null, user: 'startup recovery'
  })
  if (res.outcome !== 'RESTORED') throw new DatabaseDamagedError(res.message)
  finalizeRestore(o.dbPath)
  o.manager.appendHistory({ outcome: 'RECOVERED', backupFile: latest.fileName, safetyBackup: null, message: `Damaged database replaced at startup; damaged copy kept as ${keep}`, user: null })
  o.logger.warn('Damaged database replaced with the newest verified backup', { backup: latest.fileName, keptAs: keep })
  return { restored: latest }
}

async function electronAsk(): Promise<(b: BackupInfo | null) => boolean> {
  const { dialog } = await import('electron')
  return (b) => {
    if (!b) return false
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Database check failed',
      message: 'The database failed its integrity check and has not been opened.',
      detail: `The newest verified backup is ${b.fileName} from ${new Date(b.createdAt).toLocaleString('en-IN')}.\n\nRestoring it replaces the damaged database; the damaged file is kept in the backup folder for support. Work done after that backup will need to be entered again.`,
      buttons: ['Restore this backup', 'Quit without changes'],
      defaultId: 1,
      cancelId: 1
    })
    return choice === 0
  }
}
