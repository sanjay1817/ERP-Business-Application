/**
 * Phase 5 — large datasets. Builds a company through the real posting engine in
 * a file database (WAL, as in the app), then times every heavy read path, backup,
 * verification, restore and the startup integrity check, and proves the books
 * still reconcile.
 *
 * Size: SA_ERP_SCALE_SALES / SA_ERP_SCALE_PURCHASES (defaults keep the regular
 * suite fast). The production-readiness report quotes a 20 000-invoice run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/db/connection'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { trialBalanceReport, profitAndLoss, balanceSheet, dayBook, generalLedger, financeDashboard } from '../src/main/services/finance/statements'
import { ageing } from '../src/main/services/finance/ageing'
import { auditExceptions, integrityReport } from '../src/main/services/finance/audit-checks'
import { salesRegister, purchaseRegister } from '../src/main/services/gst/registers'
import { gstr1, gstr3b, validateGst } from '../src/main/services/gst/returns'
import { dashboardSummary, globalSearch } from '../src/main/services/reports'
import { buildReport } from '../src/main/services/reports/report-docs'
import { reportToXlsx } from '../src/main/services/reports/xlsx'
import { register } from '../src/main/services/documents/summary'
import { BackupManager } from '../src/main/services/backup/manager'
import { finalizeRestore, quickCheck, recoverInterruptedRestore } from '../src/main/services/backup/restore'
import { buildScaleData, setupScaleCompany, type ScaleCompany } from './scale-data'
import { tempDir } from './helpers'

const SALES = Number(process.env.SA_ERP_SCALE_SALES ?? 600)
const PURCHASES = Number(process.env.SA_ERP_SCALE_PURCHASES ?? Math.round(SALES / 5))
const LIMIT_MS = Number(process.env.SA_ERP_SCALE_LIMIT_MS ?? 5000)

describe(`large dataset (${SALES} sales invoices, ${PURCHASES} purchase bills)`, () => {
  const t = tempDir()
  const dbPath = join(t.dir, 'data', 'company', 'scale.db')
  let sc: ScaleCompany
  const timings: Record<string, number> = {}
  const time = <T,>(name: string, fn: () => T): T => {
    const s = performance.now()
    const v = fn()
    timings[name] = Math.round(performance.now() - s)
    return v
  }
  const FROM = '2026-04-01'
  const TO = '2026-11-14'

  beforeAll(async () => {
    sc = setupScaleCompany(dbPath)
    const g = await buildScaleData(sc, { sales: SALES, purchases: PURCHASES })
    Object.assign(timings, g)
    timings.postPerDocMs = Math.round(((g.salesMs + g.purchasesMs) / (SALES + PURCHASES)) * 10) / 10
  }, 3_600_000)

  afterAll(() => {
    console.log(`SCALE_TIMINGS ${JSON.stringify({ sales: SALES, purchases: PURCHASES, ...timings })}`)
    closeDatabase(sc?.db)
    t.cleanup()
  })

  it('the books still reconcile at scale', () => {
    const ctx = sc.ctx
    const counts = sc.db.prepare(`SELECT (SELECT COUNT(*) FROM sales_invoices) si, (SELECT COUNT(*) FROM journal_entry_lines) jl, (SELECT COUNT(*) FROM stock_movements) sm, (SELECT COUNT(*) FROM audit_logs) al`).get() as Record<string, number>
    Object.assign(timings, { salesInvoices: counts.si, journalLines: counts.jl, stockMovements: counts.sm, auditRows: counts.al })
    expect(counts.si).toBe(SALES)
    const integrity = time('integrityReportMs', () => integrityReport(ctx, TO))
    expect(integrity.checks.filter((c) => !c.ok)).toEqual([])
    const tb = time('trialBalanceMs', () => trialBalanceReport(ctx, FROM, TO))
    expect(tb.balanced).toBe(true)
    const bs = time('balanceSheetMs', () => balanceSheet(ctx, TO))
    expect(bs.balanced).toBe(true)
    const ar = time('receivablesAgeingMs', () => ageing(ctx, 'CUSTOMER', TO))
    expect(ar.agrees).toBe(true)
    const ap = time('payablesAgeingMs', () => ageing(ctx, 'SUPPLIER', TO))
    expect(ap.agrees).toBe(true)
    const sr = time('gstSalesRegisterMs', () => salesRegister(ctx, { from: FROM, to: TO }))
    expect(sr.ledger.agrees).toBe(true)
    const pr = time('gstPurchaseRegisterMs', () => purchaseRegister(ctx, { from: FROM, to: TO }))
    expect(pr.ledger.agrees).toBe(true)
    // Posted sales numbers are gap-free per financial year.
    const nums = (sc.db.prepare(`SELECT invoice_no n FROM sales_invoices WHERE status <> 'DRAFT' ORDER BY id`).all() as Array<{ n: string }>).map((r) => Number(r.n.split('/').pop()))
    expect(nums).toEqual(nums.map((_, i) => i + 1))
  })

  it('heavy screens and reports stay responsive', () => {
    const ctx = sc.ctx
    time('profitLossMs', () => profitAndLoss(ctx, FROM, TO))
    time('dayBookMonthMs', () => dayBook(ctx, '2026-10-01', '2026-10-31'))
    time('generalLedgerDebtorsFyMs', () => generalLedger(ctx, { accountId: (sc.db.prepare(`SELECT id FROM chart_of_accounts WHERE system_key='AR' AND company_id=?`).get(ctx.companyId) as { id: number }).id, from: FROM, to: TO }))
    time('financeDashboardMs', () => financeDashboard(ctx, FROM, TO))
    time('dashboardMs', () => dashboardSummary(ctx, TO))
    time('salesRegisterScreenMs', () => register(ctx, { side: 'SALES', from: FROM, to: TO }))
    time('gstr1MonthMs', () => gstr1(ctx, '2026-10'))
    time('gstr3bMonthMs', () => gstr3b(ctx, '2026-10'))
    time('gstValidationMonthMs', () => validateGst(ctx, '2026-10-01', '2026-10-31'))
    time('auditExceptionsMs', () => auditExceptions(ctx, { from: FROM, to: TO }))
    time('globalSearchMs', () => globalSearch(ctx, 'Customer 12'))
    const doc = time('salesRegisterReportFyMs', () => buildReport(ctx, { report: 'SALES_REGISTER', from: FROM, to: TO }))
    time('salesRegisterXlsxMs', () => reportToXlsx(doc))
    time('dayBookReportFyMs', () => buildReport(ctx, { report: 'DAY_BOOK', from: FROM, to: TO }))
    const slow = Object.entries(timings).filter(([k, v]) => k.endsWith('Ms') && !/^(sales|purchases)Ms$|^post|FyMs$|Xlsx|integrity/.test(k) && v > LIMIT_MS)
    expect(slow, `slower than ${LIMIT_MS} ms`).toEqual([])
  })

  it('backup, verification, restore and the startup check at scale', async () => {
    timings.databaseBytes = statSync(dbPath).size
    let db: typeof sc.db | null = sc.db
    const m = new BackupManager({ root: t.dir, environment: 'COMPANY', dbPath, appVersion: 'scale', getDb: () => db, closeDb: () => (closeDatabase(db), (db = null)) })
    let s = performance.now()
    const b = await m.backupNow('MANUAL')
    timings.backupMs = Math.round(performance.now() - s)
    s = performance.now()
    expect(m.verify(b.fileName).ok).toBe(true)
    timings.verifyMs = Math.round(performance.now() - s)
    s = performance.now()
    const r = await m.restore(b.fileName, 'owner')
    expect(r.outcome).toBe('RESTORED')
    expect(recoverInterruptedRestore(dbPath, 'COMPANY', 99).action).toBe('COMPLETED')
    finalizeRestore(dbPath)
    timings.restoreIncludingSafetyBackupMs = Math.round(performance.now() - s)
    s = performance.now()
    expect(quickCheck(dbPath)).toBe(true)
    timings.startupQuickCheckMs = Math.round(performance.now() - s)
    s = performance.now()
    const conn = openDatabase({ filePath: dbPath })
    await initializeDatabase(conn, { seedDemo: false, environment: 'COMPANY' })
    timings.startupOpenAndMigrateCheckMs = Math.round(performance.now() - s)
    sc.db = conn
    sc.ctx = { ...sc.ctx, db: conn }
    expect(integrityReport(sc.ctx, TO).checks.filter((c) => !c.ok)).toEqual([])
  }, 600_000)
})
