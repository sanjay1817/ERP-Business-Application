/**
 * User administration (Phase 5): create users with a temporary password, edit
 * role and status, reset passwords, unlock accounts, and change one's own
 * password. Passwords are only ever stored as scrypt hashes and are never
 * written to the audit log or the application log.
 */
import type { z } from 'zod'
import type { ChangePasswordInput, UserCreateInput, UserResetPasswordInput, UserUpdateInput } from '@shared/backup'
import type { UserAdminRow } from '@shared/types'
import type { DB } from '../db/connection'
import { DEMO_USERS } from '../db/bootstrap'
import { writeAudit } from './audit'
import { bool, inTransaction } from './context'
import { AppError, businessRule, notFound } from './errors'
import { hashPassword, verifyPassword } from './password'

type Row = Record<string, unknown>
const hasColumn = (db: DB, table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col)

export function listUserAdmin(db: DB, now = new Date()): UserAdminRow[] {
  return (
    db
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.last_login_at, u.locked_until, u.must_change_password, u.password_changed_at, u.created_at,
                r.code AS role_code, r.name AS role_name
           FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username`
      )
      .all() as Row[]
  ).map((r) => ({
    id: r.id as number, username: r.username as string, fullName: r.full_name as string, email: (r.email as string | null) ?? null,
    roleCode: r.role_code as string, roleName: r.role_name as string, isActive: bool(r.is_active), lastLoginAt: (r.last_login_at as string | null) ?? null,
    isLocked: !!r.locked_until && new Date(r.locked_until as string) > now, mustChangePassword: bool(r.must_change_password),
    passwordChangedAt: (r.password_changed_at as string | null) ?? null, createdAt: r.created_at as string
  }))
}

const roleId = (db: DB, code: string) => {
  const r = db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number } | undefined
  if (!r) throw notFound('Role')
  return r.id
}
const activeAdmins = (db: DB, exceptId?: number) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'ADMIN' AND u.is_active = 1 AND u.id <> ?`).get(exceptId ?? 0) as { n: number }).n

export function createUser(db: DB, actorId: number, input: z.infer<typeof UserCreateInput>): UserAdminRow {
  return inTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(input.username)) throw businessRule(`The username ${input.username} is already taken`)
    const r = db
      .prepare('INSERT INTO users (username, full_name, email, password_hash, role_id, must_change_password, default_company_id) VALUES (?, ?, ?, ?, ?, 1, (SELECT default_company_id FROM users WHERE id = ?))')
      .run(input.username, input.fullName, input.email ?? null, hashPassword(input.temporaryPassword), roleId(db, input.roleCode), actorId)
    const id = Number(r.lastInsertRowid)
    writeAudit(db, { companyId: null, userId: actorId, action: 'USER_CREATE', entityType: 'user', entityId: id, summary: `User ${input.username} (${input.roleCode}) created; must change the temporary password at first sign-in` })
    return listUserAdmin(db).find((u) => u.id === id)!
  })
}

export function updateUser(db: DB, actorId: number, input: z.infer<typeof UserUpdateInput>): UserAdminRow {
  return inTransaction(db, () => {
    const before = listUserAdmin(db).find((u) => u.id === input.id)
    if (!before) throw notFound('User')
    if (input.id === actorId && !input.isActive) throw businessRule('You cannot deactivate your own account')
    if (input.id === actorId && input.roleCode !== before.roleCode) throw businessRule('You cannot change your own role; ask another administrator')
    const losesAdmin = before.roleCode === 'ADMIN' && before.isActive && (input.roleCode !== 'ADMIN' || !input.isActive)
    if (losesAdmin && activeAdmins(db, input.id) === 0) throw businessRule('At least one active administrator is required')
    db.prepare(`UPDATE users SET full_name = ?, email = ?, role_id = ?, is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
      input.fullName, input.email ?? null, roleId(db, input.roleCode), input.isActive ? 1 : 0, input.id
    )
    const changes: string[] = []
    if (before.roleCode !== input.roleCode) changes.push(`role ${before.roleCode} → ${input.roleCode}`)
    if (before.isActive !== input.isActive) changes.push(input.isActive ? 'reactivated' : 'deactivated')
    if (before.fullName !== input.fullName) changes.push('name changed')
    if ((before.email ?? null) !== (input.email ?? null)) changes.push('email changed')
    writeAudit(db, { companyId: null, userId: actorId, action: 'USER_UPDATE', entityType: 'user', entityId: input.id, summary: `User ${before.username} updated${changes.length ? `: ${changes.join(', ')}` : ''}` })
    return listUserAdmin(db).find((u) => u.id === input.id)!
  })
}

export function resetPassword(db: DB, actorId: number, input: z.infer<typeof UserResetPasswordInput>): UserAdminRow {
  return inTransaction(db, () => {
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(input.id) as { username: string } | undefined
    if (!u) throw notFound('User')
    if (input.id === actorId) throw businessRule('Use "Change my password" for your own account')
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, failed_attempts = 0, locked_until = NULL, password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(
      hashPassword(input.temporaryPassword), input.id
    )
    writeAudit(db, { companyId: null, userId: actorId, action: 'PASSWORD_RESET', entityType: 'user', entityId: input.id, summary: `Password reset for ${u.username}; a new password must be set at next sign-in` })
    return listUserAdmin(db).find((x) => x.id === input.id)!
  })
}

export function unlockUser(db: DB, actorId: number, id: number): UserAdminRow {
  return inTransaction(db, () => {
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined
    if (!u) throw notFound('User')
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(id)
    writeAudit(db, { companyId: null, userId: actorId, action: 'USER_UNLOCK', entityType: 'user', entityId: id, summary: `Account ${u.username} unlocked` })
    return listUserAdmin(db).find((x) => x.id === id)!
  })
}

export function changeOwnPassword(db: DB, userId: number, input: z.infer<typeof ChangePasswordInput>): void {
  inTransaction(db, () => {
    const u = db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(userId) as { username: string; password_hash: string } | undefined
    if (!u) throw notFound('User')
    if (!verifyPassword(input.currentPassword, u.password_hash)) {
      writeAudit(db, { companyId: null, userId, action: 'PASSWORD_CHANGE_FAILED', entityType: 'user', entityId: userId, summary: `Password change for ${u.username} refused: current password incorrect` })
      throw new AppError('VALIDATION', 'The current password is incorrect', { currentPassword: 'Incorrect password' })
    }
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hashPassword(input.newPassword), userId)
    writeAudit(db, { companyId: null, userId, action: 'PASSWORD_CHANGE', entityType: 'user', entityId: userId, summary: `${u.username} changed their password` })
  })
}

/** Re-authentication for sensitive actions (restore). Does not count towards lock-out. */
export function confirmPassword(db: DB, userId: number, password: string): boolean {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId) as { password_hash: string } | undefined
  return !!u && verifyPassword(password, u.password_hash)
}

/**
 * In company data, any account still using a published demo password must change it at
 * next sign-in (e.g. a pre-Phase 5 database where a real company was added beside the demo).
 */
export function flagPublishedPasswords(db: DB): string[] {
  if (!hasColumn(db, 'users', 'must_change_password')) return []
  const flagged: string[] = []
  for (const d of DEMO_USERS) {
    const u = db.prepare('SELECT id, password_hash, must_change_password FROM users WHERE username = ?').get(d.username) as { id: number; password_hash: string; must_change_password: number } | undefined
    if (u && !u.must_change_password && verifyPassword(d.password, u.password_hash)) {
      db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(u.id)
      flagged.push(d.username)
    }
  }
  if (flagged.length) writeAudit(db, { companyId: null, userId: null, action: 'PASSWORD_POLICY', entityType: 'user', summary: `Published demo passwords must be changed at next sign-in: ${flagged.join(', ')}` })
  return flagged
}
