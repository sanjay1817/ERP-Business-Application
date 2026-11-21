import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type DB } from '../src/main/db/connection'
import { initializeDatabase, type InitReport } from '../src/main/db/bootstrap'
import { migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import type { ServiceContext } from '../src/main/services/context'
import { createCompany } from '../src/main/services/company'

/** Fixed "today" so demo data and FY calculations are deterministic in tests. */
export const TEST_TODAY = new Date('2026-11-14T06:30:00Z')

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sa-erp-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Migrated database with one plain (non-demo) company in Tamil Nadu. */
export function emptyCompanyDb(): { db: DB; ctx: ServiceContext } {
  const db = openDatabase({ filePath: ':memory:' })
  migrate(db, MIGRATIONS)
  const company = createCompany(db, null, {
    code: 'TEST', name: 'Test Traders', legalName: null, gstin: null, pan: null, stateCode: '33',
    addressLine1: null, addressLine2: null, city: 'Chennai', pincode: null, phone: null, email: null, fyStartMonth: 4
  })
  return { db, ctx: { db, userId: null, companyId: company.id } }
}

let cached: { db: DB; report: InitReport } | null = null
/** Fully initialised database with the DEMO company (built once per test file). */
export async function demoDb(): Promise<{ db: DB; report: InitReport; ctx: ServiceContext }> {
  if (!cached) {
    const db = openDatabase({ filePath: ':memory:' })
    const report = await initializeDatabase(db, { seedDemo: true, today: TEST_TODAY })
    cached = { db, report }
  }
  const companyId = cached.report.demo!.companyId
  const admin = cached.db.prepare(`SELECT id FROM users WHERE username='admin'`).get() as { id: number }
  return { ...cached, ctx: { db: cached.db, userId: admin.id, companyId } }
}
