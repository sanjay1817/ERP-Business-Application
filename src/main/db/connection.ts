import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

export interface OpenOptions {
  /** Absolute path to the database file, or ':memory:' for tests. */
  filePath: string
  readonly?: boolean
}

/** Open the SQLite database with the pragmas the ERP relies on. */
export function openDatabase({ filePath, readonly = false }: OpenOptions): DB {
  const inMemory = filePath === ':memory:'
  if (!inMemory) mkdirSync(dirname(filePath), { recursive: true })

  const db = new Database(filePath, { readonly, fileMustExist: readonly })
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  if (!inMemory && !readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
  }
  // Fail fast if the build lacks FK support or the pragma was rejected.
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    db.close()
    throw new Error('SQLite foreign key enforcement could not be enabled')
  }
  return db
}

export function closeDatabase(db: DB | null | undefined): void {
  if (db && db.open) {
    try {
      if (db.pragma('journal_mode', { simple: true }) === 'wal') db.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
