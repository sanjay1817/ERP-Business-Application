import { createHash } from 'node:crypto'
import type { DB } from './connection'

export interface Migration {
  version: number
  name: string
  /** SQL executed inside a transaction. */
  sql: string
}

export interface MigrationReport {
  fromVersion: number
  toVersion: number
  applied: Array<{ version: number; name: string }>
}

export class MigrationError extends Error {}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex')

function ensureTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )`)
}

export function currentSchemaVersion(db: DB): number {
  ensureTable(db)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return row.v ?? 0
}

/**
 * Apply pending migrations in version order. Each migration runs in its own
 * transaction, so a failure leaves the database at the previous version.
 * Already-applied migrations are verified by checksum to detect drift.
 */
export function migrate(db: DB, migrations: readonly Migration[]): MigrationReport {
  ensureTable(db)
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, i) => {
    if (i > 0 && sorted[i - 1].version === m.version) throw new MigrationError(`Duplicate migration version ${m.version}`)
  })

  const applied = new Map(
    (db.prepare('SELECT version, name, checksum FROM schema_migrations').all() as Array<{ version: number; name: string; checksum: string }>).map((r) => [r.version, r])
  )
  const known = new Set(sorted.map((m) => m.version))
  for (const v of applied.keys()) {
    if (!known.has(v)) throw new MigrationError(`Database has migration ${v} which this application version does not know. Upgrade the application.`)
  }

  const fromVersion = currentSchemaVersion(db)
  const report: MigrationReport = { fromVersion, toVersion: fromVersion, applied: [] }
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')

  for (const m of sorted) {
    const existing = applied.get(m.version)
    if (existing) {
      if (existing.checksum !== checksum(m.sql)) {
        throw new MigrationError(`Migration ${m.version} (${m.name}) was modified after it was applied`)
      }
      continue
    }
    const run = db.transaction(() => {
      db.exec(m.sql)
      insert.run(m.version, m.name, checksum(m.sql), new Date().toISOString())
    })
    try {
      run()
    } catch (err) {
      throw new MigrationError(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`)
    }
    report.applied.push({ version: m.version, name: m.name })
    report.toVersion = m.version
  }
  return report
}
