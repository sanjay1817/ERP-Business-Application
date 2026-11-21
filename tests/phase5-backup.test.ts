/**
 * Phase 5 — backup and restore on real database files (temp folders only).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { closeDatabase, openDatabase, type DB } from '../src/main/db/connection'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { currentSchemaVersion, migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import {
  cleanupInterrupted, createBackup, databaseCounts, importBackupFile, listBackups, manifestPath, nextAutomaticDue, pruneBackups, sha256File, verifyDatabaseFile
} from '../src/main/services/backup/backup'
import { finalizeRestore, journalPathFor, quickCheck, readJournal, recoverInterruptedRestore, restoreDatabase, SimulatedCrash } from '../src/main/services/backup/restore'
import { BackupManager } from '../src/main/services/backup/manager'
import { setupCompanyDatabase } from '../src/main/services/setup'
import { DEFAULT_BACKUP_SETTINGS } from '../src/shared/backup'
import { TEST_TODAY, tempDir } from './helpers'

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version

let t: ReturnType<typeof tempDir>
beforeEach(() => (t = tempDir()))
afterEach(() => t.cleanup())

async function demoFileDb(path: string): Promise<DB> {
  const db = openDatabase({ filePath: path })
  await initializeDatabase(db, { seedDemo: true, environment: 'DEMO', today: TEST_TODAY })
  return db
}

function companyFileDb(path: string): DB {
  const db = openDatabase({ filePath: path })
  migrate(db, MIGRATIONS)
  setupCompanyDatabase(db, {
    company: { code: 'REAL', name: 'Real Traders', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: 'Chennai', pincode: null, phone: null, email: null, fyStartMonth: 4 },
    adminUsername: 'owner', adminFullName: 'Owner', adminPassword: 'Str0ngPassw0rd', confirmPassword: 'Str0ngPassw0rd'
  })
  return db
}

/** Stable fingerprint of every user table (row counts + content hash). */
function fingerprint(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true })
  try {
    const out: Record<string, string> = {}
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).raw().all()
      out[name] = `${rows.length}:${createHash('sha1').update(JSON.stringify(rows, (_k, v) => (Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'bigint' ? String(v) : v))).digest('hex')}`
    }
    return out
  } finally {
    db.close()
  }
}

describe('backup', () => {
  it('creates a verified, self-contained, timestamped backup with a manifest while the database is open (WAL)', async () => {
    const live = join(t.dir, 'data', 'live.db')
    const db = await demoFileDb(live)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    const dir = join(t.dir, 'backups')
    const info = await createBackup(db, { dir, reason: 'MANUAL', appVersion: '9.9.9', now: new Date(2026, 10, 21, 9, 5, 7) })
    expect(info.fileName).toBe('sa-erp-demo-20261121-090507-manual.db')
    expect(info.environment).toBe('DEMO')
    expect(info.schemaVersion).toBe(LATEST)
    expect(info.sha256).toBe(sha256File(info.path))
    expect(info.counts).toEqual(databaseCounts(db))
    expect(info.counts.journalLines).toBeGreaterThan(100)
    expect(existsSync(`${info.path}-wal`)).toBe(false)
    // Readable on its own, rollback-journal mode, identical data to the live database.
    const copy = new Database(info.path, { readonly: true })
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete')
    copy.close()
    closeDatabase(db)
    const a = fingerprint(live)
    const b = fingerprint(info.path)
    expect(b).toEqual(a)
    expect(JSON.parse(readFileSync(manifestPath(info.path), 'utf8')).sha256).toBe(info.sha256)
    expect(listBackups(dir).map((x) => x.fileName)).toEqual([info.fileName])
  })

  it('an interrupted backup never appears as a backup and is cleaned up; the live database is untouched', async () => {
    const live = join(t.dir, 'live.db')
    const db = await demoFileDb(live)
    const dir = join(t.dir, 'backups')
    await expect(createBackup(db, { dir, reason: 'AUTO', appVersion: '1', afterCopy: () => { throw new Error('power cut') } })).rejects.toThrow('power cut')
    expect(readdirSync(dir)).toEqual([])
    // Simulate a hard crash leaving a partial copy and an orphan manifest behind.
    writeFileSync(join(dir, 'sa-erp-demo-20260101-000000-auto.db.partial'), 'half a file')
    writeFileSync(join(dir, 'sa-erp-demo-20260101-000000-auto.json'), '{}')
    expect(listBackups(dir)).toEqual([])
    expect(cleanupInterrupted(dir).sort()).toEqual(['sa-erp-demo-20260101-000000-auto.db.partial', 'sa-erp-demo-20260101-000000-auto.json'])
    expect(readdirSync(dir)).toEqual([])
    expect((db.pragma('quick_check', { simple: true }) as string)).toBe('ok')
    closeDatabase(db)
  })

  it('verification rejects damaged, foreign, newer-version and wrong-environment files', async () => {
    const live = join(t.dir, 'live.db')
    const db = await demoFileDb(live)
    const dir = join(t.dir, 'b')
    const good = await createBackup(db, { dir, reason: 'MANUAL', appVersion: '1' })
    closeDatabase(db)
    expect(verifyDatabaseFile(good.path, { maxSchemaVersion: LATEST, expectSha256: good.sha256, expectedEnvironment: 'DEMO' }).ok).toBe(true)

    const tampered = join(t.dir, 'tampered.db')
    copyFileSync(good.path, tampered)
    const buf = readFileSync(tampered)
    buf[buf.length - 100] ^= 0xff
    writeFileSync(tampered, buf)
    expect(verifyDatabaseFile(tampered, { maxSchemaVersion: LATEST, expectSha256: good.sha256 }).errors.join()).toMatch(/Checksum/)

    const truncated = join(t.dir, 'trunc.db')
    writeFileSync(truncated, readFileSync(good.path).subarray(0, 4096 * 3))
    expect(verifyDatabaseFile(truncated, { maxSchemaVersion: LATEST }).ok).toBe(false)

    const text = join(t.dir, 'notes.db')
    writeFileSync(text, 'hello')
    expect(verifyDatabaseFile(text, { maxSchemaVersion: LATEST }).errors[0]).toMatch(/not an SQLite database/)

    const other = join(t.dir, 'other.db')
    const o = new Database(other)
    o.exec('CREATE TABLE x (a)')
    o.close()
    expect(verifyDatabaseFile(other, { maxSchemaVersion: LATEST }).errors.join()).toMatch(/Not an SA Business ERP database/)

    const newer = join(t.dir, 'newer.db')
    copyFileSync(good.path, newer)
    const n = new Database(newer)
    n.prepare(`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')`).run()
    n.close()
    expect(verifyDatabaseFile(newer, { maxSchemaVersion: LATEST }).errors.join()).toMatch(/newer version/)

    expect(verifyDatabaseFile(good.path, { maxSchemaVersion: LATEST, expectedEnvironment: 'COMPANY' }).errors.join()).toMatch(/DEMO backup; it cannot be restored into the company database/)
  })

  it('retention prunes old automatic and safety backups but never manual ones', async () => {
    const db = await demoFileDb(join(t.dir, 'live.db'))
    const dir = join(t.dir, 'b')
    for (let i = 0; i < 4; i++) await createBackup(db, { dir, reason: 'AUTO', appVersion: '1', now: new Date(2026, 0, 1 + i) })
    for (let i = 0; i < 3; i++) await createBackup(db, { dir, reason: 'PRE_UPGRADE', appVersion: '1', now: new Date(2026, 1, 1 + i) })
    for (let i = 0; i < 2; i++) await createBackup(db, { dir, reason: 'MANUAL', appVersion: '1', now: new Date(2025, 0, 1 + i) })
    const removed = pruneBackups(dir, { keepAutomatic: 2, keepSafety: 1 })
    expect(removed.sort()).toEqual(['sa-erp-demo-20260101-000000-auto.db', 'sa-erp-demo-20260102-000000-auto.db', 'sa-erp-demo-20260201-000000-pre-upgrade.db', 'sa-erp-demo-20260202-000000-pre-upgrade.db'])
    const left = listBackups(dir)
    expect(left.filter((b) => b.reason === 'MANUAL')).toHaveLength(2)
    expect(left.filter((b) => b.reason === 'AUTO').map((b) => b.createdAt.slice(0, 10))).toEqual([new Date(2026, 0, 4).toISOString().slice(0, 10), new Date(2026, 0, 3).toISOString().slice(0, 10)])
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(left.length)
    // Next automatic backup is due one interval after the newest AUTO backup.
    const due = nextAutomaticDue(dir, { ...DEFAULT_BACKUP_SETTINGS, intervalHours: 24 }).due!
    expect(due.getTime()).toBe(new Date(2026, 0, 5).getTime())
    expect(nextAutomaticDue(dir, { ...DEFAULT_BACKUP_SETTINGS, autoEnabled: false }).due).toBeNull()
    closeDatabase(db)
  })

  it('imports an external WAL-mode database file consistently (including its -wal contents)', async () => {
    const src = join(t.dir, 'ext', 'erp.db')
    const db = await demoFileDb(src)
    db.prepare(`INSERT INTO audit_logs (company_id, user_id, action, entity_type, summary) VALUES (NULL, NULL, 'NOTE', 'test', 'written only to the WAL')`).run()
    const expected = databaseCounts(db)
    const info = importBackupFile(src, join(t.dir, 'b'), { appVersion: '1', maxSchemaVersion: LATEST })
    expect(info.reason).toBe('IMPORTED')
    expect(info.sourceName).toBe('erp.db')
    expect(info.counts).toEqual(expected)
    closeDatabase(db)
  })
})

describe('restore (separate database copies)', () => {
  it('restores a backup over a changed database, keeps a verified safety backup, and the result matches the backup exactly', async () => {
    const root = t.dir
    const live = join(root, 'data', 'sa-business-erp.db')
    let db: DB | null = await demoFileDb(live)
    const mgr = new BackupManager({ root, environment: 'DEMO', dbPath: live, appVersion: '1', getDb: () => db, closeDb: () => { closeDatabase(db); db = null } })
    const before = await mgr.backupNow('MANUAL', 'known good')
    const snapshot = fingerprint(before.path)

    // Work continues after the backup…
    db!.prepare(`INSERT INTO audit_logs (company_id, user_id, action, entity_type, summary) VALUES (NULL, NULL, 'NOTE', 'test', 'after backup')`).run()
    const changedCount = databaseCounts(db!).auditLogs

    const res = await mgr.restore(before.fileName, 'admin')
    expect(res.outcome).toBe('RESTORED')
    expect(db).toBeNull() // connection was closed before the swap
    expect(readJournal(live)?.stage).toBe('DONE')
    // Startup path: recover → open → migrate → finalise.
    const rec = recoverInterruptedRestore(live, 'DEMO', LATEST)
    expect(rec.action).toBe('COMPLETED')
    expect(rec.message).toMatch(/restored from/)
    finalizeRestore(live)
    expect(existsSync(journalPathFor(live))).toBe(false)
    expect(readdirSync(join(root, 'data')).filter((f) => f.includes('replaced') || f.includes('restore-new'))).toEqual([])
    expect(quickCheck(live)).toBe(true)
    expect(fingerprint(live)).toEqual(snapshot)

    // The pre-restore safety backup holds the state we replaced.
    const safety = listBackups(mgr.directory()).find((b) => b.reason === 'PRE_RESTORE')!
    expect(safety.fileName).toBe(res.safetyBackup)
    expect(safety.counts.auditLogs).toBe(changedCount)
    expect(verifyDatabaseFile(safety.path, { maxSchemaVersion: LATEST, expectSha256: safety.sha256, expectedEnvironment: 'DEMO' }).ok).toBe(true)
    expect(mgr.history()[0]).toMatchObject({ outcome: 'RESTORED', backupFile: before.fileName, user: 'admin' })

    // Reopens as a normal application database.
    const reopened = openDatabase({ filePath: live })
    const r = await initializeDatabase(reopened, { seedDemo: true, environment: 'DEMO', today: TEST_TODAY })
    expect(r.demo).toBeNull()
    expect(currentSchemaVersion(reopened)).toBe(LATEST)
    closeDatabase(reopened)
  })

  it('a failed restore (damaged backup) leaves the live database exactly as it was', async () => {
    const live = join(t.dir, 'data', 'erp.db')
    let db: DB | null = await demoFileDb(live)
    const mgr = new BackupManager({ root: t.dir, environment: 'DEMO', dbPath: live, appVersion: '1', getDb: () => db, closeDb: () => { closeDatabase(db); db = null } })
    const b = await mgr.backupNow('MANUAL')
    const buf = readFileSync(b.path)
    buf[5000] ^= 0xff
    writeFileSync(b.path, buf)
    closeDatabase(db)
    const liveBefore = fingerprint(live)
    db = openDatabase({ filePath: live })
    await expect(mgr.restore(b.fileName, 'admin')).rejects.toThrow(/cannot be restored/)
    expect(db).not.toBeNull() // never closed: nothing was touched
    closeDatabase(db)
    expect(fingerprint(live)).toEqual(liveBefore)
    expect(mgr.history()[0].outcome).toBe('FAILED')
  })

  it('refuses to restore DEMO data into the company database', async () => {
    const demoLive = join(t.dir, 'demo.db')
    const demo = await demoFileDb(demoLive)
    const demoBackup = await createBackup(demo, { dir: join(t.dir, 'b', 'company'), reason: 'MANUAL', appVersion: '1' })
    closeDatabase(demo)
    const live = join(t.dir, 'data', 'company.db')
    let db: DB | null = companyFileDb(live)
    const mgr = new BackupManager({ root: t.dir, environment: 'COMPANY', dbPath: live, appVersion: '1', getDb: () => db, closeDb: () => { closeDatabase(db); db = null } })
    mgr.saveSettings({ directory: join(t.dir, 'b') })
    // A DEMO file dropped into the company folder is not even offered…
    expect(mgr.list().map((x) => x.fileName)).not.toContain(demoBackup.fileName)
    // …and restoreDatabase refuses it directly too.
    closeDatabase(db)
    db = null
    expect(() => restoreDatabase({ livePath: live, backupPath: demoBackup.path, backupSha256: demoBackup.sha256, environment: 'COMPANY', maxSchemaVersion: LATEST, safetyBackup: null, user: null })).toThrow(/DEMO backup/)
    expect(quickCheck(live)).toBe(true)
  })

  it.each(['BEFORE_STAGE', 'STAGED', 'LIVE_MOVED', 'SWAPPED', 'DONE'] as const)('recovers from a crash at %s without losing the database', async (stage) => {
    const live = join(t.dir, 'data', 'erp.db')
    const db = await demoFileDb(live)
    const backup = await createBackup(db, { dir: join(t.dir, 'b'), reason: 'MANUAL', appVersion: '1' })
    db.prepare(`INSERT INTO audit_logs (company_id, user_id, action, entity_type, summary) VALUES (NULL, NULL, 'NOTE', 'test', 'newer than the backup')`).run()
    closeDatabase(db)
    const current = fingerprint(live)
    const target = fingerprint(backup.path)
    expect(current).not.toEqual(target)

    expect(() => restoreDatabase({ livePath: live, backupPath: backup.path, backupSha256: backup.sha256, environment: 'DEMO', maxSchemaVersion: LATEST, safetyBackup: null, user: 'admin', crashAt: stage })).toThrow(SimulatedCrash)
    const rec = recoverInterruptedRestore(live, 'DEMO', LATEST)
    finalizeRestore(live)
    expect(existsSync(journalPathFor(live))).toBe(false)
    expect(quickCheck(live)).toBe(true)
    const after = fingerprint(live)
    if (stage === 'BEFORE_STAGE' || stage === 'STAGED' || stage === 'LIVE_MOVED') {
      expect(after).toEqual(current) // previous database kept / put back
      expect(rec.action).toBe(stage === 'BEFORE_STAGE' ? 'NONE' : stage === 'STAGED' ? 'ABORTED' : 'ROLLED_BACK')
    } else {
      expect(after).toEqual(target) // swap had completed and the file is healthy
      expect(rec.action).toBe('COMPLETED')
    }
    expect(readdirSync(join(t.dir, 'data')).filter((f) => /replaced|restore-new|journal/.test(f))).toEqual([])
  })

  it('rolls back after an interruption when the swapped-in file is damaged', async () => {
    const live = join(t.dir, 'data', 'erp.db')
    const db = await demoFileDb(live)
    const backup = await createBackup(db, { dir: join(t.dir, 'b'), reason: 'MANUAL', appVersion: '1' })
    closeDatabase(db)
    const current = fingerprint(live)
    expect(() => restoreDatabase({ livePath: live, backupPath: backup.path, backupSha256: backup.sha256, environment: 'DEMO', maxSchemaVersion: LATEST, safetyBackup: null, user: null, crashAt: 'SWAPPED' })).toThrow(SimulatedCrash)
    writeFileSync(live, 'disk error') // the swapped-in file got damaged
    const rec = recoverInterruptedRestore(live, 'DEMO', LATEST)
    expect(rec.action).toBe('ROLLED_BACK')
    expect(fingerprint(live)).toEqual(current)
  })

  it('backs up and restores a pre-Phase 5 (schema 3) database, which is then upgraded', async () => {
    const live = join(t.dir, 'old.db')
    const old = openDatabase({ filePath: live })
    migrate(old, MIGRATIONS.slice(0, 3))
    old.prepare(`INSERT INTO users (username, full_name, password_hash, role_id) VALUES ('admin', 'A', 'x', (SELECT id FROM roles WHERE code='ADMIN'))`).run()
    old.prepare(`INSERT INTO companies (code, name, state_code, is_demo) VALUES ('DEMO', 'Demo', '33', 1)`).run()
    const b = await createBackup(old, { dir: join(t.dir, 'b'), reason: 'PRE_UPGRADE', appVersion: '0.1.0' })
    expect(b.schemaVersion).toBe(3)
    expect(b.environment).toBe('DEMO') // classified by content (no profile table before schema 6)
    closeDatabase(old)
    const fresh = join(t.dir, 'restored.db')
    copyFileSync(b.path, fresh)
    const db = openDatabase({ filePath: fresh })
    const r = migrate(db, MIGRATIONS)
    expect(r.fromVersion).toBe(3)
    expect(r.toVersion).toBe(LATEST)
    expect((db.prepare('SELECT environment FROM database_profile').get() as { environment: string }).environment).toBe('DEMO')
    closeDatabase(db)
  })
})

describe('pre-upgrade backup hook', () => {
  it('runs before pending migrations on an existing database, and not for a brand-new one', async () => {
    const calls: Array<{ fromVersion: number; pending: number[] }> = []
    const fresh = openDatabase({ filePath: join(t.dir, 'fresh.db') })
    await initializeDatabase(fresh, { seedDemo: false, environment: 'DEMO', beforeMigrate: (i) => void calls.push(i) })
    expect(calls).toEqual([])
    closeDatabase(fresh)

    const path = join(t.dir, 'v5.db')
    const v5 = openDatabase({ filePath: path })
    migrate(v5, MIGRATIONS.slice(0, 5))
    let backupVersion = -1
    await initializeDatabase(v5, {
      seedDemo: false,
      beforeMigrate: async (i) => {
        calls.push(i)
        backupVersion = (await createBackup(v5, { dir: join(t.dir, 'b'), reason: 'PRE_UPGRADE', appVersion: '1' })).schemaVersion
      }
    })
    expect(calls).toEqual([{ fromVersion: 5, pending: [6, 7] }])
    expect(backupVersion).toBe(5)
    expect(currentSchemaVersion(v5)).toBe(LATEST)
    closeDatabase(v5)
  })
})
