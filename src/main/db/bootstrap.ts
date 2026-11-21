import type { DB } from './connection'
import { currentSchemaVersion, migrate, type MigrationReport } from './migrator'
import { MIGRATIONS } from './migrations'
import { DEMO_COMPANY_CODE, seedDemoCompany, type DemoSeedResult } from './seed/demo'
import { hashPassword } from '../services/password'
import { writeAudit } from '../services/audit'

/** Demo credentials shown on the login screen while the DEMO company exists (DEMO database only). */
export const DEMO_USERS = [
  { username: 'admin', password: 'Admin@123', fullName: 'System Administrator', role: 'ADMIN' },
  { username: 'accounts', password: 'Accounts@123', fullName: 'Priya Accountant', role: 'ACCOUNTANT' },
  { username: 'auditor', password: 'Auditor@123', fullName: 'External Auditor', role: 'AUDITOR' }
] as const

export interface InitReport {
  migrations: MigrationReport
  usersCreated: number
  demo: DemoSeedResult | null
  /** Accounts in company data that must change a published demo password (named so the log redaction keeps it readable). */
  demoCredentialsFlagged?: string[]
}

export interface InitOptions {
  seedDemo: boolean
  today?: Date
  /**
   * DEMO: demo users + DEMO company, profile marked DEMO.
   * COMPANY: company books — no demo users, no demo seed; accounts still on a demo password must change it.
   * Omitted: pre-Phase 5 behaviour (demo users; DEMO company when seedDemo).
   */
  environment?: 'DEMO' | 'COMPANY'
  /** Called with the pending migration versions before an existing database is upgraded (automatic backup). */
  beforeMigrate?: (info: { fromVersion: number; pending: number[] }) => Promise<void> | void
}

function ensureUsers(db: DB): number {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  if (count > 0) return 0
  const insert = db.prepare('INSERT INTO users (username, full_name, password_hash, role_id) VALUES (?, ?, ?, (SELECT id FROM roles WHERE code = ?))')
  db.transaction(() => {
    for (const u of DEMO_USERS) {
      const r = insert.run(u.username, u.fullName, hashPassword(u.password), u.role)
      writeAudit(db, { companyId: null, userId: null, action: 'CREATE', entityType: 'user', entityId: Number(r.lastInsertRowid), summary: `Initial user ${u.username} (${u.role}) created` })
    }
  })()
  return DEMO_USERS.length
}

const hasProfile = (db: DB) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='database_profile'`).get()

/** Mark a fresh (UNSET) database. The database refuses to change an environment once set. */
export function markEnvironment(db: DB, env: 'DEMO' | 'COMPANY'): void {
  if (!hasProfile(db)) return
  db.prepare(`UPDATE database_profile SET environment = ?, set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1 AND environment = 'UNSET'`).run(env)
}

export function profileEnvironment(db: DB): 'UNSET' | 'DEMO' | 'COMPANY' | null {
  if (!hasProfile(db)) return null
  return ((db.prepare('SELECT environment FROM database_profile WHERE id = 1').get() as { environment: 'UNSET' | 'DEMO' | 'COMPANY' } | undefined)?.environment) ?? null
}

/**
 * Bring a database to a usable state: run migrations, create initial users,
 * and (optionally) seed the DEMO company once. Safe to call on every start.
 */
export async function initializeDatabase(db: DB, opts: InitOptions): Promise<InitReport> {
  const fromVersion = currentSchemaVersion(db)
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version))
  const pending = MIGRATIONS.map((m) => m.version).filter((v) => !applied.has(v))
  if (opts.beforeMigrate && fromVersion > 0 && pending.length) await opts.beforeMigrate({ fromVersion, pending })
  const migrations = migrate(db, MIGRATIONS)

  const env = opts.environment
  const profile = profileEnvironment(db)
  if (env && profile && profile !== 'UNSET' && profile !== env)
    throw new Error(`This database file holds ${profile === 'DEMO' ? 'DEMO sample data' : 'company books'} and cannot be opened as the ${env === 'DEMO' ? 'demo' : 'company'} database`)

  if (env === 'COMPANY') {
    const { flagPublishedPasswords } = await import('../services/users')
    return { migrations, usersCreated: 0, demo: null, demoCredentialsFlagged: flagPublishedPasswords(db) }
  }

  const usersCreated = ensureUsers(db)
  let demo: DemoSeedResult | null = null
  const hasDemo = db.prepare('SELECT 1 FROM companies WHERE code = ?').get(DEMO_COMPANY_CODE)
  if (opts.seedDemo && !hasDemo) {
    const admin = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: number } | undefined
    demo = await seedDemoCompany(db, admin?.id ?? 1, opts.today)
    db.prepare('UPDATE users SET default_company_id = ? WHERE default_company_id IS NULL').run(demo.companyId)
  }
  if (env === 'DEMO' || (opts.seedDemo && env === undefined)) markEnvironment(db, 'DEMO')
  return { migrations, usersCreated, demo }
}

export function demoCredentialsVisible(db: DB): boolean {
  if (profileEnvironment(db) === 'COMPANY') return false
  return !!db.prepare('SELECT 1 FROM companies WHERE is_demo = 1 AND is_active = 1').get()
}
