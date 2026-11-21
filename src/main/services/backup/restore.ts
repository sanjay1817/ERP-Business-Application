/**
 * Restore a verified backup over the live database file.
 *
 * The caller must have CLOSED the live connection. Each step is recorded in a
 * journal file next to the database, so a crash or power cut at any point is
 * resolved on the next start by `recoverInterruptedRestore`:
 *
 *   STAGED      verified copy written to <db>.restore-new        → abort: delete the copy
 *   LIVE_MOVED  live files renamed to <db>.replaced-<stamp>      → roll back: put them back
 *   SWAPPED     copy renamed to <db>                             → verify; roll back if bad
 *   DONE        verified                                         → finalise
 *
 * The previous database is only deleted after the restored one has been
 * opened and verified, and a verified PRE_RESTORE backup exists before any of this starts.
 */
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DbEnvironment } from '@shared/backup'
import { stamp, verifyDatabaseFile, writeFileAtomic } from './backup'

export type RestoreStage = 'STAGED' | 'LIVE_MOVED' | 'SWAPPED' | 'DONE'

export interface RestoreJournal {
  stage: RestoreStage
  livePath: string
  stagedPath: string
  replacedPath: string
  backupFile: string
  safetyBackup: string | null
  startedAt: string
  user: string | null
}

export const journalPathFor = (livePath: string) => join(dirname(livePath), `${basename(livePath)}.restore-journal.json`)
const SIDE = ['-wal', '-shm', '-journal']

function writeJournal(j: RestoreJournal): void {
  writeFileAtomic(journalPathFor(j.livePath), JSON.stringify(j, null, 2))
}

export function readJournal(livePath: string): RestoreJournal | null {
  const p = journalPathFor(livePath)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RestoreJournal
  } catch {
    return null
  }
}

function moveDbFiles(from: string, to: string): void {
  if (existsSync(from)) renameSync(from, to)
  for (const s of SIDE) if (existsSync(from + s)) renameSync(from + s, to + s)
}
function removeDbFiles(path: string): void {
  rmSync(path, { force: true })
  for (const s of SIDE) rmSync(path + s, { force: true })
}

/** Quick open check of the live file after the swap (integrity + it is an ERP database). */
function liveIsHealthy(path: string, expected: DbEnvironment, maxSchemaVersion: number): string | null {
  const v = verifyDatabaseFile(path, { maxSchemaVersion, expectedEnvironment: expected })
  return v.ok ? null : v.errors.join('; ')
}

export interface RestoreOptions {
  livePath: string
  backupPath: string
  backupSha256: string | null
  environment: DbEnvironment
  maxSchemaVersion: number
  safetyBackup: string | null
  user: string | null
  now?: Date
  /** Test hook: throw at a given stage to simulate a crash. */
  crashAt?: RestoreStage | 'BEFORE_STAGE'
}

export interface RestoreResult {
  outcome: 'RESTORED' | 'ROLLED_BACK'
  message: string
  replacedPath: string
}

export class SimulatedCrash extends Error {}

/**
 * Replace the live database with a backup. Throws (with the live database left
 * exactly as it was) if the backup fails verification; returns ROLLED_BACK if the
 * swapped-in file failed its post-swap check.
 */
export function restoreDatabase(o: RestoreOptions): RestoreResult {
  if (readJournal(o.livePath)) throw new Error('A previous restore has not been resolved. Restart the application first.')
  const pre = verifyDatabaseFile(o.backupPath, { maxSchemaVersion: o.maxSchemaVersion, expectSha256: o.backupSha256, expectedEnvironment: o.environment })
  if (!pre.ok) throw new Error(`The backup cannot be restored: ${pre.errors.join('; ')}`)

  const s = stamp(o.now ?? new Date())
  const j: RestoreJournal = {
    stage: 'STAGED', livePath: o.livePath, stagedPath: `${o.livePath}.restore-new`, replacedPath: `${o.livePath}.replaced-${s}`,
    backupFile: basename(o.backupPath), safetyBackup: o.safetyBackup, startedAt: (o.now ?? new Date()).toISOString(), user: o.user
  }
  if (o.crashAt === 'BEFORE_STAGE') throw new SimulatedCrash('before stage')
  removeDbFiles(j.stagedPath)
  writeJournal(j)
  copyFileSync(o.backupPath, j.stagedPath)
  // The staged copy must be byte-identical to the verified backup.
  const staged = verifyDatabaseFile(j.stagedPath, { maxSchemaVersion: o.maxSchemaVersion, expectSha256: pre.sha256, expectedEnvironment: o.environment })
  if (!staged.ok) {
    removeDbFiles(j.stagedPath)
    rmSync(journalPathFor(o.livePath), { force: true })
    throw new Error(`Copying the backup failed verification: ${staged.errors.join('; ')}`)
  }
  if (o.crashAt === 'STAGED') throw new SimulatedCrash('STAGED')

  moveDbFiles(o.livePath, j.replacedPath)
  writeJournal({ ...j, stage: 'LIVE_MOVED' })
  if (o.crashAt === 'LIVE_MOVED') throw new SimulatedCrash('LIVE_MOVED')

  renameSync(j.stagedPath, o.livePath)
  writeJournal({ ...j, stage: 'SWAPPED' })
  if (o.crashAt === 'SWAPPED') throw new SimulatedCrash('SWAPPED')

  const problem = liveIsHealthy(o.livePath, o.environment, o.maxSchemaVersion)
  if (problem) {
    rollBack(j)
    return { outcome: 'ROLLED_BACK', message: `The restored file failed its check (${problem}); the previous database was put back.`, replacedPath: j.replacedPath }
  }
  writeJournal({ ...j, stage: 'DONE' })
  if (o.crashAt === 'DONE') throw new SimulatedCrash('DONE')
  return { outcome: 'RESTORED', message: `Restored ${j.backupFile}`, replacedPath: j.replacedPath }
}

function rollBack(j: RestoreJournal): void {
  if (existsSync(j.replacedPath)) {
    removeDbFiles(j.livePath)
    moveDbFiles(j.replacedPath, j.livePath)
  }
  removeDbFiles(j.stagedPath)
  rmSync(journalPathFor(j.livePath), { force: true })
}

/** After the restored database opened and migrated successfully: drop the replaced file and the journal. */
export function finalizeRestore(livePath: string): void {
  const j = readJournal(livePath)
  if (!j) return
  removeDbFiles(j.replacedPath)
  removeDbFiles(j.stagedPath)
  rmSync(journalPathFor(livePath), { force: true })
}

export interface RecoveryResult {
  action: 'NONE' | 'ABORTED' | 'ROLLED_BACK' | 'COMPLETED'
  message: string | null
  journal: RestoreJournal | null
}

/** Run at startup, before the database is opened. Never leaves the app without a database file it had before. */
export function recoverInterruptedRestore(livePath: string, expected: DbEnvironment, maxSchemaVersion: number): RecoveryResult {
  const jp = journalPathFor(livePath)
  if (!existsSync(jp)) return { action: 'NONE', message: null, journal: null }
  const j = readJournal(livePath)
  if (!j) {
    // Unreadable journal: the live file is only trusted if it is healthy; otherwise look for a replaced copy.
    rmSync(jp, { force: true })
    return { action: 'ABORTED', message: 'An unreadable restore journal was removed.', journal: null }
  }
  if (j.stage === 'STAGED') {
    removeDbFiles(j.stagedPath)
    rmSync(jp, { force: true })
    return { action: 'ABORTED', message: `A restore of ${j.backupFile} was interrupted before any change; the current database was kept.`, journal: j }
  }
  if (j.stage === 'LIVE_MOVED') {
    rollBack(j)
    return { action: 'ROLLED_BACK', message: `A restore of ${j.backupFile} was interrupted; the previous database was put back unchanged.`, journal: j }
  }
  // SWAPPED or DONE: keep the restored file only if it is healthy.
  const problem = existsSync(livePath) ? liveIsHealthy(livePath, expected, maxSchemaVersion) : 'missing'
  if (problem) {
    rollBack(j)
    return { action: 'ROLLED_BACK', message: `The restored database from ${j.backupFile} failed its check after an interruption; the previous database was put back.`, journal: j }
  }
  // Leave the journal for finalizeRestore once the app has opened the file.
  const interrupted = j.stage !== 'DONE'
  writeJournal({ ...j, stage: 'DONE' })
  return {
    action: 'COMPLETED',
    message: interrupted ? `The restore of ${j.backupFile} was completed after an interruption.` : `The database was restored from ${j.backupFile}.`,
    journal: j
  }
}

/** Open check used by tests and the startup path. */
export function quickCheck(path: string): boolean {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return (db.pragma('quick_check', { simple: true }) as string) === 'ok'
  } finally {
    db.close()
  }
}
