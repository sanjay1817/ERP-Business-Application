import type { DB } from '../db/connection'
import type { SessionInfo } from '@shared/types'
import { writeAudit } from './audit'
import { companySummary } from './company'
import { AppError } from './errors'
import { verifyPassword } from './password'

export const MAX_FAILED_ATTEMPTS = 5
export const LOCK_MINUTES = 5

interface UserRow {
  id: number; username: string; full_name: string; password_hash: string; role_id: number; default_company_id: number | null
  is_active: number; failed_attempts: number; locked_until: string | null; role_code: string; role_name: string
}

/** Holds the single signed-in desktop session in the main process (never in the renderer). */
export class SessionStore {
  private session: SessionInfo | null = null
  get(): SessionInfo | null {
    return this.session
  }
  set(s: SessionInfo | null): void {
    this.session = s
  }
  has(permission: string): boolean {
    return !!this.session?.permissions.includes(permission)
  }
}

function permissionsFor(db: DB, roleId: number): string[] {
  return (db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.code').all(roleId) as Array<{ code: string }>).map((r) => r.code)
}

function firstActiveCompany(db: DB, preferred: number | null): number | null {
  if (preferred && db.prepare('SELECT 1 FROM companies WHERE id = ? AND is_active = 1').get(preferred)) return preferred
  const row = db.prepare('SELECT id FROM companies WHERE is_active = 1 ORDER BY is_demo DESC, id LIMIT 1').get() as { id: number } | undefined
  return row?.id ?? null
}

/** DEMO / COMPANY from the database profile (schema 6+); null when not yet set up or older schema. */
export function databaseEnvironment(db: DB): 'DEMO' | 'COMPANY' | null {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'database_profile'`).get()) return null
  const r = db.prepare('SELECT environment FROM database_profile WHERE id = 1').get() as { environment: string } | undefined
  return r?.environment === 'DEMO' || r?.environment === 'COMPANY' ? r.environment : null
}

export function buildSession(db: DB, userId: number, companyId?: number | null): SessionInfo {
  const u = db.prepare('SELECT u.*, r.code AS role_code, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(userId) as UserRow
  const cid = firstActiveCompany(db, companyId ?? u.default_company_id)
  return {
    userId: u.id,
    username: u.username,
    fullName: u.full_name,
    roleCode: u.role_code,
    roleName: u.role_name,
    permissions: permissionsFor(db, u.role_id),
    company: cid ? companySummary(db, cid) : null,
    mustChangePassword: (u as UserRow & { must_change_password?: number }).must_change_password === 1,
    environment: databaseEnvironment(db)
  }
}

const INVALID = (): AppError => new AppError('UNAUTHENTICATED', 'Invalid username or password')

export function login(db: DB, username: string, password: string, now = new Date()): SessionInfo {
  const u = db
    .prepare('SELECT u.*, r.code AS role_code, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ? COLLATE NOCASE')
    .get(username) as UserRow | undefined

  if (!u) {
    // Burn comparable time so usernames can't be probed by timing.
    verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==')
    writeAudit(db, { companyId: null, userId: null, action: 'LOGIN_FAILED', entityType: 'user', summary: `Failed sign-in for unknown user "${username.slice(0, 50)}"` })
    throw INVALID()
  }
  if (!u.is_active) {
    writeAudit(db, { companyId: null, userId: u.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: u.id, summary: `Sign-in refused: user ${u.username} is disabled` })
    throw new AppError('UNAUTHENTICATED', 'This user account is disabled')
  }
  if (u.locked_until && new Date(u.locked_until) > now) {
    throw new AppError('UNAUTHENTICATED', `Account locked after repeated failures. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-IN')}`)
  }
  if (!verifyPassword(password, u.password_hash)) {
    const attempts = u.failed_attempts + 1
    const lock = attempts >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString() : null
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : attempts, lock, u.id)
    writeAudit(db, { companyId: null, userId: u.id, action: 'LOGIN_FAILED', entityType: 'user', entityId: u.id, summary: `Failed sign-in for ${u.username}${lock ? ' — account locked' : ''}` })
    throw INVALID()
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now.toISOString(), u.id)
  const session = buildSession(db, u.id)
  writeAudit(db, { companyId: session.company?.id ?? null, userId: u.id, action: 'LOGIN', entityType: 'user', entityId: u.id, summary: `${u.username} signed in` })
  return session
}
