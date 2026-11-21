/**
 * First-run company setup: turns a freshly migrated, empty database into the
 * company (production) database — one administrator chosen by the user, the
 * company with its default chart of accounts, and the profile marked COMPANY.
 * No demo users, demo passwords or sample data are created.
 */
import type { z } from 'zod'
import type { WorkspaceSetupInput } from '@shared/backup'
import type { DB } from '../db/connection'
import { markEnvironment, profileEnvironment } from '../db/bootstrap'
import { writeAudit } from './audit'
import { createCompany } from './company'
import { inTransaction } from './context'
import { businessRule } from './errors'
import { hashPassword } from './password'

export function setupCompanyDatabase(db: DB, input: z.infer<typeof WorkspaceSetupInput>): { companyId: number; adminId: number } {
  return inTransaction(db, () => {
    const env = profileEnvironment(db)
    if (env !== 'UNSET') throw businessRule('This database has already been set up')
    const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
    const companies = (db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n
    if (users || companies) throw businessRule('This database is not empty')
    const r = db
      .prepare(`INSERT INTO users (username, full_name, password_hash, role_id, must_change_password, password_changed_at) VALUES (?, ?, ?, (SELECT id FROM roles WHERE code = 'ADMIN'), 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(input.adminUsername, input.adminFullName, hashPassword(input.adminPassword))
    const adminId = Number(r.lastInsertRowid)
    writeAudit(db, { companyId: null, userId: adminId, action: 'CREATE', entityType: 'user', entityId: adminId, summary: `Administrator ${input.adminUsername} created during company setup` })
    const company = createCompany(db, adminId, input.company, { isDemo: false })
    db.prepare('UPDATE users SET default_company_id = ? WHERE id = ?').run(company.id, adminId)
    markEnvironment(db, 'COMPANY')
    writeAudit(db, { companyId: company.id, userId: adminId, action: 'DATABASE_SETUP', entityType: 'database', summary: `Company database set up for ${company.name}` })
    return { companyId: company.id, adminId }
  })
}
