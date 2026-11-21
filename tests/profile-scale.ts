/**
 * Profiling helper for large databases (not a test). Usage:
 *   node node_modules/vite-node/vite-node.mjs --config vitest.config.ts tests/profile-scale.ts <db> [fn,fn,...]
 * Prints each read path's time as soon as it finishes, with its slowest SQL statements.
 */
import { closeDatabase, openDatabase } from '../src/main/db/connection'
import { integrityReport, auditExceptions } from '../src/main/services/finance/audit-checks'
import { trialBalanceReport, profitAndLoss, balanceSheet, dayBook, financeDashboard } from '../src/main/services/finance/statements'
import { ageing } from '../src/main/services/finance/ageing'
import { dashboardSummary, globalSearch } from '../src/main/services/reports'
import { gstr1, gstr3b, validateGst } from '../src/main/services/gst/returns'
import { salesRegister, purchaseRegister } from '../src/main/services/gst/registers'
import { register } from '../src/main/services/documents/summary'
import { buildReport } from '../src/main/services/reports/report-docs'

const db = openDatabase({ filePath: process.argv[2] })
const only = process.argv[3]?.split(',')
const stats = new Map<string, { n: number; ms: number }>()
const orig = db.prepare.bind(db)
;(db as unknown as { prepare: unknown }).prepare = (sql: string) => {
  const st = orig(sql)
  for (const m of ['all', 'get', 'run', 'iterate'] as const) {
    const f = (st as unknown as Record<string, (...a: unknown[]) => unknown>)[m].bind(st)
    ;(st as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      const s = performance.now()
      const r = f(...a)
      const k = sql.replace(/\s+/g, ' ').slice(0, 200)
      const e = stats.get(k) ?? { n: 0, ms: 0 }
      e.n++
      e.ms += performance.now() - s
      stats.set(k, e)
      return r
    }
  }
  return st
}
const companyId = (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: number }).id
const ctx = { db, userId: 1, companyId }
const F = '2026-04-01'
const T = '2026-11-14'
const steps: Array<[string, () => unknown]> = [
  ['trialBalance', () => trialBalanceReport(ctx, F, T)],
  ['profitLoss', () => profitAndLoss(ctx, F, T)],
  ['balanceSheet', () => balanceSheet(ctx, T)],
  ['receivables', () => ageing(ctx, 'CUSTOMER', T)],
  ['payables', () => ageing(ctx, 'SUPPLIER', T)],
  ['dayBookMonth', () => dayBook(ctx, '2026-10-01', '2026-10-31')],
  ['dashboard', () => dashboardSummary(ctx, T)],
  ['financeDashboard', () => financeDashboard(ctx, F, T)],
  ['salesRegisterScreen', () => register(ctx, { side: 'SALES', from: F, to: T })],
  ['search', () => globalSearch(ctx, 'Customer 12')],
  ['gstSalesRegister', () => salesRegister(ctx, { from: F, to: T })],
  ['gstPurchaseRegister', () => purchaseRegister(ctx, { from: F, to: T })],
  ['gstr1Month', () => gstr1(ctx, '2026-10')],
  ['gstr3bMonth', () => gstr3b(ctx, '2026-10')],
  ['gstValidationMonth', () => validateGst(ctx, '2026-10-01', '2026-10-31')],
  ['salesRegisterReportFy', () => buildReport(ctx, { report: 'SALES_REGISTER', from: F, to: T })],
  ['dayBookReportFy', () => buildReport(ctx, { report: 'DAY_BOOK', from: F, to: T })],
  ['auditExceptions', () => auditExceptions(ctx, { from: F, to: T })],
  ['integrity', () => integrityReport(ctx, T)]
]
for (const [name, fn] of steps) {
  if (only && !only.includes(name)) continue
  stats.clear()
  const s = performance.now()
  fn()
  const ms = Math.round(performance.now() - s)
  const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, Number(process.env.TOP ?? 3))
  process.stdout.write(`${name}: ${ms} ms\n${top.map(([k, v]) => `    ${Math.round(v.ms)} ms x${v.n}: ${k}`).join('\n')}\n`)
}
closeDatabase(db)
