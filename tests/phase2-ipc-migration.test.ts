import { beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db/connection'
import { migrate, currentSchemaVersion } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import { createCompany } from '../src/main/services/company'
import { loadDocument } from '../src/main/services/documents/store'
import { createRouter, type Dispatch } from '../src/main/ipc/router'
import { createRoutes } from '../src/main/ipc/routes'
import { SessionStore } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { silentLogger } from '../src/main/logger'
import { createSenderValidator } from '../src/main/security'
import { journals, trialBalance } from '../src/main/services/reports'
import type { DocumentDetail, DocumentRow, ModuleSummary, RegisterRow } from '@shared/documents'
import { demoDb } from './helpers'

describe('migration 003 on an existing Phase 1 database', () => {
  it('upgrades schema v2 data in place: new columns, accounts, permissions; old invoices stay valid and immutable', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS.slice(0, 2))
    expect(currentSchemaVersion(db)).toBe(2)
    const company = createCompany(db, null, { code: 'OLD', name: 'Old Co', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 })
    // Simulate a Phase 1 chart of accounts (without the accounts introduced in Phase 2).
    db.prepare(`DELETE FROM chart_of_accounts WHERE company_id = ? AND code IN ('1210','2300','4300','5300','5400','5500','5600')`).run(company.id)
    const cust = Number(db.prepare(`INSERT INTO customers (company_id, code, name, gst_registration_type, state_code) VALUES (?, 'C1', 'Legacy Customer', 'UNREGISTERED', '33')`).run(company.id).lastInsertRowid)
    const prod = Number(db.prepare(`INSERT INTO products (company_id, code, name, item_type, unit_id, hsn_sac, tax_rate_id, track_inventory) VALUES (?, 'S1', 'Svc', 'SERVICE', 1, '998313', (SELECT id FROM tax_rates WHERE rate_bps = 1800), 0)`).run(company.id).lastInsertRowid)
    const inv = Number(db.prepare(`INSERT INTO sales_invoices (company_id, financial_year, invoice_no, invoice_date, customer_id, place_of_supply, taxable_paise, cgst_paise, sgst_paise, grand_total_paise) VALUES (?, '2026-27', 'INV/2026-27/0001', '2026-06-01', ?, '33', 10000, 900, 900, 11800)`).run(company.id, cust).lastInsertRowid)
    db.prepare(`INSERT INTO sales_invoice_items (invoice_id, line_no, product_id, hsn_sac, item_type, qty_milli, unit_id, rate_paise, taxable_paise, tax_rate_bps, cgst_paise, sgst_paise, line_total_paise) VALUES (?, 1, ?, '998313', 'SERVICE', 1000, 1, 10000, 10000, 1800, 900, 900, 11800)`).run(inv, prod)
    db.prepare(`UPDATE sales_invoices SET status = 'POSTED' WHERE id = ?`).run(inv)
    // Immutable Phase 1 history (guarded by triggers): a posted journal, its lines, a stock movement and audit rows.
    // Regression: migration 003 once tried to UPDATE journal_entries and failed on real databases.
    const acc = (code: string) => (db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(company.id, code) as { id: number }).id
    const je = Number(db.prepare(`INSERT INTO journal_entries (company_id, financial_year, entry_no, entry_date, source_type, source_id, narration, total_debit_paise, total_credit_paise) VALUES (?, '2026-27', 'JV/2026-27/0001', '2026-06-01', 'SALES_INVOICE', ?, 'Legacy', 11800, 11800)`).run(company.id, inv).lastInsertRowid)
    db.prepare(`INSERT INTO journal_entry_lines (journal_entry_id, line_no, account_id, debit_paise, party_type, party_id) VALUES (?, 1, ?, 11800, 'CUSTOMER', ?)`).run(je, acc('1300'), cust)
    db.prepare(`INSERT INTO journal_entry_lines (journal_entry_id, line_no, account_id, credit_paise) VALUES (?, 2, ?, 11800)`).run(je, acc('4200'))
    const goods = Number(db.prepare(`INSERT INTO products (company_id, code, name, item_type, unit_id, hsn_sac, tax_rate_id) VALUES (?, 'G1', 'Goods', 'GOODS', 1, '84713010', (SELECT id FROM tax_rates WHERE rate_bps = 1800))`).run(company.id).lastInsertRowid)
    const wh = (db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(company.id) as { id: number }).id
    db.prepare(`INSERT INTO stock_movements (company_id, product_id, warehouse_id, movement_date, movement_type, qty_in_milli, value_paise, balance_qty_milli, reference_type) VALUES (?, ?, ?, '2026-04-01', 'OPENING', 1000, 500, 1000, 'OPENING')`).run(company.id, goods, wh)
    db.prepare(`INSERT INTO audit_logs (company_id, action, entity_type, summary) VALUES (?, 'POST', 'sales_invoice', 'Legacy')`).run(company.id)
    expect(() => db.prepare('UPDATE journal_entries SET narration = ? WHERE id = ?').run('x', je)).toThrow(/cannot be edited/)

    // This test covers migration 003 (v2 → v3); later migrations have their own upgrade tests.
    const report = migrate(db, MIGRATIONS.slice(0, 3))
    expect(report.applied.map((m) => m.version)).toEqual([3])
    for (const key of ['SALES_RETURNS', 'GRNI', 'PPV', 'FREIGHT_INWARD', 'OTHER_PURCHASE_CHARGES', 'PURCHASE_ALLOWANCES'])
      expect(db.prepare('SELECT 1 FROM chart_of_accounts WHERE company_id = ? AND system_key = ?').get(company.id, key), key).toBeTruthy()
    expect(db.prepare(`SELECT is_bank FROM chart_of_accounts WHERE company_id = ? AND code = '1210'`).get(company.id)).toEqual({ is_bank: 1 })
    const perms = (db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ACCOUNTANT' AND p.code LIKE '%.cancel'`).all() as Array<{ code: string }>).map((r) => r.code).sort()
    expect(perms).toEqual(['purchase.cancel', 'sales.cancel'])

    const doc = loadDocument({ db, userId: null, companyId: company.id }, 'SALES_INVOICE', inv)
    expect(doc).toMatchObject({ status: 'POSTED', pricingMode: 'EXCLUSIVE', freightPaise: 0, paymentStatus: 'UNPAID', balanceDuePaise: 11800, source: null })
    expect(() => db.prepare('UPDATE sales_invoices SET reference_no = ? WHERE id = ?').run('x', inv)).toThrow(/cannot be edited/)
    expect(db.pragma('foreign_key_check')).toEqual([])
    // Legacy journals are untouched and still readable by the journal report (source_kind falls back to source_type).
    expect(db.prepare('SELECT source_type, source_kind, status FROM journal_entries WHERE id = ?').get(je)).toEqual({ source_type: 'SALES_INVOICE', source_kind: null, status: 'POSTED' })
    const jr = journals({ db, userId: null, companyId: company.id }, undefined)
    expect(jr[0]).toMatchObject({ entryNo: 'JV/2026-27/0001', sourceType: 'SALES_INVOICE' })
    expect(trialBalance({ db, userId: null, companyId: company.id }).reduce((s, r) => s + r.debitPaise - r.creditPaise, 0)).toBe(0)
    // Idempotent on restart.
    expect(migrate(db, MIGRATIONS.slice(0, 3)).applied).toEqual([])
  })
})

describe('document IPC channels', () => {
  let dispatch: Dispatch
  const TRUSTED = 'file:///D:/App/out/renderer/index.html'
  beforeAll(async () => {
    const { db } = await demoDb()
    dispatch = createRouter({
      db, sessions: new SessionStore(), logger: silentLogger,
      isTrustedSender: createSenderValidator({ rendererIndexPath: 'D:\\App\\out\\renderer\\index.html' }),
      routes: createRoutes({ ewayBills: new EwayBillService(new MockEwayBillProvider()), appInfo: () => ({}) as never })
    })
  })
  const call = (ch: string, input?: unknown) => dispatch(ch, input, TRUSTED)
  const login = (u: string, p: string) => call('auth:login', { username: u, password: p })

  it('enforces view / post / cancel permissions per document side', async () => {
    await login('auditor', 'Auditor@123')
    const list = await call('doc:list', { kind: 'SALES_INVOICE' })
    expect(list.ok).toBe(true)
    const save = await call('doc:saveDraft', { kind: 'SALES_QUOTATION', partyId: 1, date: '2026-10-01', lines: [] })
    expect(!save.ok && save.error.code).toBe('FORBIDDEN')
    const anyPosted = (list.ok ? (list.data as DocumentRow[]) : []).find((d) => d.status === 'POSTED')!
    const cancel = await call('doc:cancel', { kind: 'SALES_INVOICE', id: anyPosted.id, reason: 'not allowed' })
    expect(!cancel.ok && cancel.error.code).toBe('FORBIDDEN')
    const pay = await call('payment:create', { type: 'RECEIPT', partyId: 1, date: '2026-10-01', amountPaise: 100, mode: 'UPI', accountId: 1 })
    expect(!pay.ok && pay.error.code).toBe('FORBIDDEN')
    await call('auth:logout')
  })

  it('validates document input shape with field-level paths', async () => {
    await login('admin', 'Admin@123')
    const bad = await call('doc:saveDraft', { kind: 'SALES_INVOICE', partyId: 1, date: '2026-02-30', lines: [{ productId: 1, qtyMilli: 0, ratePaise: -5 }] })
    expect(!bad.ok && bad.error.code).toBe('VALIDATION')
    const fe = !bad.ok ? bad.error.fieldErrors! : {}
    expect(Object.keys(fe)).toEqual(expect.arrayContaining(['date', 'lines.0.qtyMilli', 'lines.0.ratePaise']))
    const extra = await call('doc:post', { kind: 'SALES_INVOICE', id: 1, force: true })
    expect(!extra.ok && extra.error.code).toBe('VALIDATION')
    await call('auth:logout')
  })

  it('serves documents, registers, summaries and print HTML; PDF export reports when printing is unavailable', async () => {
    await login('admin', 'Admin@123')
    const reg = await call('doc:register', { side: 'SALES' })
    expect(reg.ok).toBe(true)
    const rows = reg.ok ? (reg.data as RegisterRow[]) : []
    expect(rows.some((r) => r.paymentStatus === 'PARTIAL')).toBe(true)
    expect(rows.some((r) => r.paymentStatus === 'PAID')).toBe(true)
    expect(rows.some((r) => r.paymentStatus === 'UNPAID')).toBe(true)
    const doc = await call('doc:get', { kind: 'SALES_INVOICE', id: rows[0].id })
    expect(doc.ok && (doc.data as DocumentDetail).lines.length).toBeGreaterThan(0)
    const html = await call('doc:printHtml', { kind: 'SALES_INVOICE', id: rows[0].id })
    expect(html.ok && (html.data as { html: string }).html).toContain('TAX INVOICE')
    const pdf = await call('doc:exportPdf', { kind: 'SALES_INVOICE', id: rows[0].id })
    expect(!pdf.ok && pdf.error.message).toMatch(/Printing is not available/)
    const sum = await call('doc:summary', { side: 'PURCHASE' })
    expect(sum.ok && (sum.data as ModuleSummary).pending.length).toBeGreaterThan(0)
    await call('auth:logout')
  })
})

describe('Phase 2 demo scenario', () => {
  it('contains every document kind, partial payments, a cancellation, drafts and still balances', async () => {
    const { db, ctx } = await demoDb()
    const kinds = (db.prepare(`SELECT doc_type, status, COUNT(*) n FROM trade_documents WHERE company_id = ? GROUP BY doc_type, status`).all(ctx.companyId) as Array<{ doc_type: string; status: string }>).map((r) => `${r.doc_type}:${r.status}`)
    for (const k of ['SALES_QUOTATION:POSTED', 'SALES_QUOTATION:DRAFT', 'SALES_ORDER:POSTED', 'DELIVERY_CHALLAN:POSTED', 'SALES_RETURN:POSTED', 'CREDIT_NOTE:POSTED', 'PURCHASE_REQUISITION:POSTED', 'PURCHASE_ORDER:POSTED', 'GOODS_RECEIPT:POSTED', 'PURCHASE_RETURN:POSTED', 'DEBIT_NOTE:POSTED'])
      expect(kinds, k).toContain(k)
    expect(db.prepare(`SELECT COUNT(*) n FROM sales_invoices WHERE company_id = ? AND status = 'CANCELLED'`).get(ctx.companyId)).toEqual({ n: 1 })
    expect(db.prepare(`SELECT COUNT(*) n FROM purchase_invoices WHERE company_id = ? AND status = 'DRAFT'`).get(ctx.companyId)).toEqual({ n: 1 })
    expect((db.prepare(`SELECT COUNT(*) n FROM payment_allocations WHERE company_id = ?`).get(ctx.companyId) as { n: number }).n).toBeGreaterThan(20)
    const tb = trialBalance(ctx)
    expect(tb.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0)).toBe(0)
  })
})
