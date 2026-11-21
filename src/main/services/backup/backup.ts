/**
 * Database backups.
 *
 * A backup is taken with SQLite's online backup API (consistent even while the
 * app is writing, unlike a file copy of a WAL database), written to
 * `<name>.db.partial`, converted to a self-contained rollback-journal file,
 * verified (integrity_check, foreign_key_check, schema version), hashed, and
 * only then given its final name. The manifest (`<name>.json`) is written
 * before the rename, so every `.db` in the folder has a manifest; anything
 * still called `.partial` was interrupted and is removed on the next run.
 */
import Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  BACKUP_FORMAT, type BackupCounts, type BackupInfo, type BackupManifest, type BackupReason, type BackupSettings, type BackupVerifyResult,
  type DbProfileEnvironment
} from '@shared/backup'
import type { DB } from '../../db/connection'
import { MIGRATIONS } from '../../db/migrations'

export const PARTIAL_SUFFIX = '.partial'

export function sha256File(path: string): string {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let n: number
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

export function isSqliteFile(path: string): boolean {
  try {
    const fd = openSync(path, 'r')
    try {
      const b = Buffer.alloc(16)
      return readSync(fd, b, 0, 16, 0) === 16 && b.toString('latin1') === 'SQLite format 3\u0000'
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

const tableExists = (db: DB, name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
const count = (db: DB, table: string) => (tableExists(db, table) ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n : 0)

export function databaseCounts(db: DB): BackupCounts {
  return {
    companies: count(db, 'companies'),
    users: count(db, 'users'),
    documents: count(db, 'trade_documents'),
    journalLines: count(db, 'journal_entry_lines'),
    stockMovements: count(db, 'stock_movements'),
    auditLogs: count(db, 'audit_logs')
  }
}

export function schemaVersionOf(db: DB): number {
  if (!tableExists(db, 'schema_migrations')) return 0
  return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0
}

/**
 * What the database says it is. Schema 6+ records it in `database_profile`; older
 * files are classified by content (only the flagged DEMO company → DEMO).
 */
export function environmentOf(db: DB): { environment: DbProfileEnvironment; uid: string | null } {
  if (tableExists(db, 'database_profile')) {
    const r = db.prepare('SELECT environment, database_uid FROM database_profile WHERE id = 1').get() as { environment: DbProfileEnvironment; database_uid: string } | undefined
    if (r) return { environment: r.environment, uid: r.database_uid }
  }
  if (!tableExists(db, 'companies')) return { environment: 'UNSET', uid: null }
  const c = db.prepare('SELECT SUM(is_demo = 1) AS demo, SUM(is_demo = 0) AS real FROM companies').get() as { demo: number | null; real: number | null }
  if ((c.real ?? 0) > 0) return { environment: 'COMPANY', uid: null }
  if ((c.demo ?? 0) > 0) return { environment: 'DEMO', uid: null }
  return { environment: 'UNKNOWN', uid: null }
}

const pad = (n: number) => String(n).padStart(2, '0')
export function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function uniqueName(dir: string, base: string): string {
  let name = `${base}.db`
  for (let i = 2; existsSync(join(dir, name)) || existsSync(join(dir, name + PARTIAL_SUFFIX)); i++) name = `${base}-${i}.db`
  return name
}

/** Atomic small-file write: temp file in the same folder, then rename. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, path)
}

/** Known migration checksums, to detect a backup made by a different (modified) build. */
const knownChecksums = new Map(MIGRATIONS.map((m) => [m.version, createHash('sha256').update(m.sql).digest('hex')]))

/**
 * Verify a database file without changing it (opened read-only).
 * `expectedEnvironment` rejects e.g. a DEMO backup offered for restore over company data.
 */
export function verifyDatabaseFile(
  path: string,
  opts: { maxSchemaVersion: number; expectSha256?: string | null; expectedEnvironment?: 'DEMO' | 'COMPANY' } = { maxSchemaVersion: MIGRATIONS.length }
): BackupVerifyResult {
  const res: BackupVerifyResult = { ok: false, fileName: basename(path), errors: [], warnings: [], schemaVersion: null, environment: 'UNKNOWN', sha256: null, counts: null, foreignKeyViolations: 0 }
  if (!existsSync(path)) return { ...res, errors: ['The backup file does not exist'] }
  if (statSync(path).size === 0 || !isSqliteFile(path)) return { ...res, errors: ['The file is not an SQLite database (it may be damaged or incomplete)'] }
  if (existsSync(`${path}-wal`)) res.warnings.push('A write-ahead log file sits next to this backup; it was ignored')
  res.sha256 = sha256File(path)
  if (opts.expectSha256 && opts.expectSha256 !== res.sha256) res.errors.push('Checksum does not match the manifest — the file was changed or damaged after the backup was made')
  let db: DB | null = null
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check)
    if (integrity.length !== 1 || integrity[0] !== 'ok') res.errors.push(`Integrity check failed: ${integrity.slice(0, 3).join('; ')}`)
    const fk = db.prepare('PRAGMA foreign_key_check').all().length
    res.foreignKeyViolations = fk
    if (fk) res.warnings.push(`${fk} foreign key reference(s) do not resolve`)
    for (const t of ['schema_migrations', 'companies', 'users']) if (!tableExists(db, t)) res.errors.push(`Not an SA Business ERP database (table ${t} is missing)`)
    if (!res.errors.length) {
      res.schemaVersion = schemaVersionOf(db)
      if (res.schemaVersion > opts.maxSchemaVersion) res.errors.push(`The backup was made by a newer version of the application (schema ${res.schemaVersion}; this version supports up to ${opts.maxSchemaVersion}). Upgrade the application first.`)
      for (const r of db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: number; checksum: string }>) {
        const known = knownChecksums.get(r.version)
        if (known && known !== r.checksum) res.errors.push(`Migration ${r.version} in the backup differs from this application's version`)
      }
      res.environment = environmentOf(db).environment
      if (opts.expectedEnvironment && res.environment !== opts.expectedEnvironment) {
        if (res.environment === 'DEMO' || res.environment === 'COMPANY')
          res.errors.push(`This is a ${res.environment === 'DEMO' ? 'DEMO' : 'company'} backup; it cannot be restored into the ${opts.expectedEnvironment === 'DEMO' ? 'DEMO' : 'company'} database`)
        else res.errors.push('The backup could not be identified as company or demo data')
      }
      res.counts = databaseCounts(db)
    }
  } catch (err) {
    res.errors.push(`The database could not be read: ${(err as Error).message}`)
  } finally {
    db?.close()
  }
  res.ok = res.errors.length === 0
  return res
}

export interface CreateBackupOptions {
  dir: string
  reason: BackupReason
  appVersion: string
  label?: string | null
  now?: Date
  /** Test hook: runs after the copy and before verification (e.g. simulate a crash). */
  afterCopy?: (partialPath: string) => void
}

let running: Promise<unknown> | null = null

/** Create a verified backup of an open database. One backup runs at a time. */
export async function createBackup(db: DB, o: CreateBackupOptions): Promise<BackupInfo> {
  while (running) await running.catch(() => undefined)
  const job = doCreate(db, o)
  running = job
  try {
    return await job
  } finally {
    running = null
  }
}

async function doCreate(db: DB, o: CreateBackupOptions): Promise<BackupInfo> {
  mkdirSync(o.dir, { recursive: true })
  const now = o.now ?? new Date()
  const { environment, uid } = environmentOf(db)
  const env = environment === 'COMPANY' ? 'company' : environment === 'DEMO' ? 'demo' : 'db'
  const fileName = uniqueName(o.dir, `sa-erp-${env}-${stamp(now)}-${o.reason.toLowerCase().replace('_', '-')}`)
  const finalPath = join(o.dir, fileName)
  const partial = finalPath + PARTIAL_SUFFIX
  try {
    // Large steps: copy up to 16 MB of pages per step instead of better-sqlite3's default 100 pages.
    await db.backup(partial, { progress: () => 4096 })
    // Make the copy a single self-contained file (no -wal needed to read it).
    const copy = new Database(partial)
    try {
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    o.afterCopy?.(partial)
    const v = verifyDatabaseFile(partial, { maxSchemaVersion: Number.MAX_SAFE_INTEGER })
    if (!v.ok) throw new Error(`Backup verification failed: ${v.errors.join('; ')}`)
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, fileName, createdAt: now.toISOString(), reason: o.reason, label: o.label ?? null, environment, databaseUid: uid,
      schemaVersion: v.schemaVersion ?? 0, appVersion: o.appVersion, sizeBytes: statSync(partial).size, sha256: v.sha256!, integrity: 'ok',
      foreignKeyViolations: v.foreignKeyViolations,
      counts: v.counts!
    }
    writeFileAtomic(manifestPath(finalPath), JSON.stringify(manifest, null, 2))
    renameSync(partial, finalPath)
    return { ...manifest, path: finalPath }
  } catch (err) {
    rmSync(partial, { force: true })
    rmSync(manifestPath(finalPath), { force: true })
    throw err
  }
}

export const manifestPath = (dbPath: string) => dbPath.replace(/\.db$/, '.json')

export function readManifest(dbPath: string): BackupManifest | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath(dbPath), 'utf8')) as BackupManifest
    return m.format === BACKUP_FORMAT && m.fileName === basename(dbPath) ? m : null
  } catch {
    return null
  }
}

/** Completed backups (newest first). Files without a valid manifest are not offered. */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return []
  const out: BackupInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.db')) continue
    const p = join(dir, f)
    const m = readManifest(p)
    if (m) out.push({ ...m, path: p })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.fileName.localeCompare(a.fileName))
}

/** Remove leftovers of interrupted backups: *.partial files, orphan manifests and temp files. */
export function cleanupInterrupted(dir: string): string[] {
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const orphanManifest = f.endsWith('.json') && !existsSync(p.replace(/\.json$/, '.db'))
    if (f.endsWith(PARTIAL_SUFFIX) || f.endsWith('.tmp') || f.includes('.partial-') || orphanManifest) {
      rmSync(p, { force: true })
      removed.push(f)
    }
  }
  return removed
}

/**
 * Retention: keep the newest `keepAutomatic` automatic backups and the newest
 * `keepSafety` pre-upgrade / pre-restore backups. Manual and imported backups are never pruned.
 */
export function pruneBackups(dir: string, s: Pick<BackupSettings, 'keepAutomatic' | 'keepSafety'>): string[] {
  const all = listBackups(dir)
  const removed: string[] = []
  const prune = (list: BackupInfo[], keep: number) => {
    for (const b of list.slice(keep)) {
      rmSync(b.path, { force: true })
      rmSync(manifestPath(b.path), { force: true })
      removed.push(b.fileName)
    }
  }
  prune(all.filter((b) => b.reason === 'AUTO'), s.keepAutomatic)
  prune(all.filter((b) => b.reason === 'PRE_UPGRADE' || b.reason === 'PRE_RESTORE'), s.keepSafety)
  return removed
}

/** Copy an external database file into the backup folder as an IMPORTED backup, after verification. */
export function importBackupFile(source: string, dir: string, o: { appVersion: string; maxSchemaVersion: number; now?: Date }): BackupInfo {
  mkdirSync(dir, { recursive: true })
  const now = o.now ?? new Date()
  const fileName = uniqueName(dir, `sa-erp-import-${stamp(now)}`)
  const finalPath = join(dir, fileName)
  const partial = finalPath + PARTIAL_SUFFIX
  try {
    if (!isSqliteFile(source)) throw new Error('The selected file is not an SQLite database')
    // Copy through SQLite so a WAL-mode source with its -wal file is captured consistently.
    const src = new Database(source, { readonly: true, fileMustExist: true })
    try {
      src.prepare('VACUUM INTO ?').run(partial)
    } finally {
      src.close()
    }
    const v = verifyDatabaseFile(partial, { maxSchemaVersion: o.maxSchemaVersion })
    if (!v.ok) throw new Error(v.errors.join('; '))
    const probe = new Database(partial, { readonly: true })
    let uid: string | null
    try {
      uid = environmentOf(probe).uid
    } finally {
      probe.close()
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, fileName, createdAt: now.toISOString(), reason: 'IMPORTED', label: null, environment: v.environment, databaseUid: uid,
      schemaVersion: v.schemaVersion ?? 0, appVersion: o.appVersion, sizeBytes: statSync(partial).size, sha256: v.sha256!, integrity: 'ok',
      foreignKeyViolations: v.foreignKeyViolations, counts: v.counts!, sourceName: basename(source)
    }
    writeFileAtomic(manifestPath(finalPath), JSON.stringify(manifest, null, 2))
    renameSync(partial, finalPath)
    return { ...manifest, path: finalPath }
  } catch (err) {
    rmSync(partial, { force: true })
    rmSync(manifestPath(finalPath), { force: true })
    throw err
  }
}

/** When the next automatic backup is due (null = disabled). */
export function nextAutomaticDue(dir: string, s: BackupSettings): { last: string | null; due: Date | null } {
  const last = listBackups(dir).find((b) => b.reason === 'AUTO')?.createdAt ?? null
  if (!s.autoEnabled) return { last, due: null }
  return { last, due: last ? new Date(new Date(last).getTime() + s.intervalHours * 3600_000) : new Date(0) }
}
