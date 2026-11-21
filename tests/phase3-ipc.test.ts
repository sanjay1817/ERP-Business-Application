/**
 * Phase 3 — auditor workspace and report exports through the real IPC router:
 * role permissions (auditor read-only), audit exception report, PDF/Excel/print
 * exports, and the migration 004 upgrade of an existing Phase 2 database.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { openDatabase, type DB } from '../src/main/db/connection'
import { currentSchemaVersion, migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import { createRouter, type Dispatch } from '../src/main/ipc/router'
import { createRoutes, type PrintingDeps } from '../src/main/ipc/routes'
import { SessionStore } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { silentLogger } from '../src/main/logger'
import { createSenderValidator } from '../src/main/security'
import { hashPassword } from '../src/main/services/password'
import { createCompany } from '../src/main/services/company'
import { createCustomer } from '../src/main/services/parties'
import { createProduct, getLookups } from '../src/main/services/products'
import { postOpeningFunds, postSalesInvoice } from '../src/main/services/posting'
import { createPayment } from '../src/main/services/documents/payments'
import { postJournal, accountId } from '../src/main/services/ledger'
import { auditExceptions } from '../src/main/services/finance/audit-checks'
import { createVoucher } from '../src/main/services/finance/vouchers'
import { balanceSheet, profitAndLoss, trialBalanceReport } from '../src/main/services/finance/statements'
import { integrityReport } from '../src/main/services/finance/audit-checks'
import { reportToXlsx, crc32 } from '../src/main/services/reports/xlsx'
import { buildReport } from '../src/main/services/reports/report-docs'
import { CustomerInput, ProductInput } from '@shared/schemas'
import { buildGstin } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { REPORT_KINDS, type AuditExceptionReport, type ReportDoc, type ReportKind, type TrialBalanceReport } from '@shared/finance'
import { demoDb } from './helpers'
import { fixture } from './phase2-fixtures'

const TRUSTED = 'file:///D:/App/out/renderer/index.html'
const R = toPaise

/** Reads every entry of a ZIP (as written by the xlsx exporter) and verifies CRCs. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let o = 0
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8)
    const crc = buf.readUInt32LE(o + 14)
    const size = buf.readUInt32LE(o + 18)
    const nameLen = buf.readUInt16LE(o + 26)
    const extra = buf.readUInt16LE(o + 28)
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString('utf8')
    const raw = buf.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + size)
    const data = method === 8 ? inflateRawSync(raw) : raw
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`)
    out.set(name, data.toString('utf8'))
    o += 30 + nameLen + extra + size
  }
  return out
}

describe('auditor workspace and reports over IPC', () => {
  let dispatch: Dispatch
  let db: DB
  let companyId: number
  const printed: { pdfHtml: string[]; files: Array<{ name: string; data: Buffer }>; printHtml: string[]; savePath: string | null } = { pdfHtml: [], files: [], printHtml: [], savePath: 'C:\\Exports\\report.pdf' }
  const printing: PrintingDeps = {
    toPdf: async (html) => (printed.pdfHtml.push(html), Buffer.from('%PDF-1.7 mock')),
    print: async (html) => (printed.printHtml.push(html), true),
    savePdf: async () => printed.savePath,
    saveFile: async (name, data) => (printed.files.push({ name, data }), 'C:\\Exports\\report.xlsx')
  }
  const call = (ch: string, input?: unknown) => dispatch(ch, input, TRUSTED)
  const login = async (u: string, p: string) => {
    const r = await call('auth:login', { username: u, password: p })
    expect(r.ok, `login ${u}`).toBe(true)
  }
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n

  beforeAll(async () => {
    const demo = await demoDb()
    db = demo.db
    companyId = demo.ctx.companyId
    dispatch = createRouter({
      db, sessions: new SessionStore(), logger: silentLogger,
      isTrustedSender: createSenderValidator({ rendererIndexPath: 'D:\\App\\out\\renderer\\index.html' }),
      routes: createRoutes({ ewayBills: new EwayBillService(new MockEwayBillProvider()), appInfo: () => ({}) as never, printing })
    })
    db.prepare(`INSERT INTO users (username, full_name, password_hash, role_id, default_company_id) VALUES ('seller', 'Sales Exec', ?, (SELECT id FROM roles WHERE code = 'SALES'), ?)`).run(hashPassword('Seller@123'), companyId)
  })

  it('auditor can read every financial record, inspect journals and stock, and export reports', async () => {
    await login('auditor', 'Auditor@123')
    const period = { from: '2026-04-01', to: '2026-11-14' }
    for (const [ch, input] of [
      ['finance:dashboard', period], ['finance:trialBalanceReport', period], ['finance:profitLoss', period], ['finance:balanceSheet', { asOf: period.to }],
      ['finance:dayBook', period], ['finance:accounts', undefined], ['finance:ageing', { side: 'CUSTOMER', asOf: period.to }], ['voucher:list', undefined],
      ['bankrec:list', undefined], ['inventory:movements', { limit: 50 }], ['audit:list', { limit: 20 }], ['audit:exceptions', undefined], ['audit:integrity', undefined],
      ['doc:list', { kind: 'PURCHASE_INVOICE' }], ['finance:journals', { limit: 5 }]
    ] as const) {
      const r = await call(ch, input)
      expect(r.ok, `${ch}: ${!r.ok ? r.error.message : ''}`).toBe(true)
    }
    // Drill from a ledger line to its journal and source document.
    const bank = (await call('lookup:all')) as { ok: true; data: { cashBankAccounts: Array<{ id: number; systemKey: string | null }> } }
    const gl = await call('finance:ledger', { accountId: bank.data.cashBankAccounts.find((a) => a.systemKey === 'BANK')!.id, ...period })
    expect(gl.ok).toBe(true)
    const line = (gl as { ok: true; data: { lines: Array<{ journalId: number; route: string | null }> } }).data.lines.find((l) => l.route?.startsWith('/sales/receipts/'))!
    const j = await call('finance:journal', { id: line.journalId })
    expect(j.ok && (j.data as { source: { route: string } }).source.route).toBe(line.route)
    // Every report can be previewed and exported by the auditor.
    for (const kind of Object.keys(REPORT_KINDS) as ReportKind[]) {
      const params = REPORT_KINDS[kind].period === 'range' ? { report: kind, ...period } : { report: kind, asOf: period.to }
      const recId = (db.prepare('SELECT id FROM bank_reconciliations WHERE company_id = ? ORDER BY id LIMIT 1').get(companyId) as { id: number }).id
      const withAccount =
        kind === 'GENERAL_LEDGER' || kind === 'BANK_BOOK' ? { ...params, accountId: bank.data.cashBankAccounts.find((a) => a.systemKey === 'BANK')!.id }
        : kind === 'BANK_RECONCILIATION' ? { report: kind, reconciliationId: recId }
        : params
      const r = await call('report:run', withAccount)
      expect(r.ok, `${kind}: ${!r.ok ? r.error.message : ''}`).toBe(true)
      expect((r as { ok: true; data: ReportDoc }).data.rows.length, kind).toBeGreaterThan(0)
    }
    const pdf = await call('report:exportPdf', { report: 'TRIAL_BALANCE', ...period })
    expect(pdf).toMatchObject({ ok: true, data: { path: 'C:\\Exports\\report.pdf' } })
    await call('auth:logout')
  })

  it('auditor cannot edit, post, cancel, reconcile or change masters — and nothing changes', async () => {
    const before = { je: count('SELECT COUNT(*) n FROM journal_entries'), sm: count('SELECT COUNT(*) n FROM stock_movements'), v: count('SELECT COUNT(*) n FROM vouchers'), bsl: count('SELECT COUNT(*) n FROM bank_statement_lines') }
    await login('auditor', 'Auditor@123')
    const anyInvoice = (db.prepare(`SELECT id FROM sales_invoices WHERE company_id = ? AND status = 'POSTED' LIMIT 1`).get(companyId) as { id: number }).id
    const anyVoucher = (db.prepare(`SELECT id FROM vouchers WHERE company_id = ? AND status = 'POSTED' LIMIT 1`).get(companyId) as { id: number }).id
    const rec = (db.prepare(`SELECT id FROM bank_reconciliations WHERE company_id = ? AND status = 'IN_PROGRESS'`).get(companyId) as { id: number }).id
    const forbidden: Array<[string, unknown]> = [
      ['voucher:create', { type: 'JOURNAL', date: '2026-10-01', narration: 'Not allowed', lines: [{ accountId: 1, debitPaise: 1 }, { accountId: 2, creditPaise: 1 }] }],
      ['voucher:cancel', { id: anyVoucher, reason: 'Not allowed' }],
      ['bankrec:create', { accountId: 1, statementDate: '2026-10-01', statementBalancePaise: 0 }],
      ['bankrec:autoMatch', { id: rec }],
      ['bankrec:addLines', { id: rec, csv: '2026-10-01,X,,1,' }],
      ['doc:post', { kind: 'SALES_INVOICE', id: anyInvoice }],
      ['doc:cancel', { kind: 'SALES_INVOICE', id: anyInvoice, reason: 'Not allowed' }],
      ['doc:saveDraft', { kind: 'SALES_INVOICE', partyId: 1, date: '2026-10-01', lines: [] }],
      ['payment:create', { type: 'PAYMENT', partyId: 1, date: '2026-10-01', amountPaise: 100, mode: 'UPI', accountId: 1 }],
      ['customer:setActive', { id: 1, isActive: false }],
      ['product:setActive', { id: 1, isActive: false }]
    ]
    for (const [ch, input] of forbidden) {
      const r = await call(ch, input)
      expect(!r.ok && r.error.code, ch).toBe('FORBIDDEN')
    }
    await call('auth:logout')
    expect({ je: count('SELECT COUNT(*) n FROM journal_entries'), sm: count('SELECT COUNT(*) n FROM stock_movements'), v: count('SELECT COUNT(*) n FROM vouchers'), bsl: count('SELECT COUNT(*) n FROM bank_statement_lines') }).toEqual(before)
  })

  it('other roles: accountants post vouchers but cannot open the audit workspace; sales staff see no finance', async () => {
    await login('accounts', 'Accounts@123')
    const accs = (await call('finance:accounts')) as { ok: true; data: Array<{ id: number; code: string }> }
    const id = (code: string) => accs.data.find((a) => a.code === code)!.id
    const v = await call('voucher:create', { type: 'JOURNAL', date: '2026-11-02', narration: 'Courier charges', requestKey: 'abcdabcd-0000-1111-2222-333344445555', lines: [{ accountId: id('6600'), debitPaise: 25000 }, { accountId: id('1200'), creditPaise: 25000 }] })
    expect(v.ok).toBe(true)
    const again = await call('voucher:create', { type: 'JOURNAL', date: '2026-11-02', narration: 'Courier charges', requestKey: 'abcdabcd-0000-1111-2222-333344445555', lines: [{ accountId: id('6600'), debitPaise: 25000 }, { accountId: id('1200'), creditPaise: 25000 }] })
    expect(again.ok && (again.data as { id: number }).id).toBe((v as { ok: true; data: { id: number } }).data.id)
    const audit = await call('audit:exceptions')
    expect(!audit.ok && audit.error.code).toBe('FORBIDDEN')
    const unbalanced = await call('voucher:create', { type: 'JOURNAL', date: '2026-11-02', narration: 'Oops', lines: [{ accountId: id('6600'), debitPaise: 100 }, { accountId: id('1200'), creditPaise: 90 }] })
    expect(!unbalanced.ok && unbalanced.error.code).toBe('VALIDATION')
    await call('auth:logout')
    await login('seller', 'Seller@123')
    for (const ch of ['finance:ledger', 'finance:trialBalanceReport', 'audit:exceptions', 'report:run', 'voucher:list'] as const) {
      const r = await call(ch, ch === 'finance:ledger' ? { accountId: 1, from: '2026-04-01', to: '2026-11-14' } : ch === 'report:run' ? { report: 'SALES_REGISTER', from: '2026-04-01', to: '2026-11-14' } : ch === 'finance:trialBalanceReport' ? { from: '2026-04-01', to: '2026-11-14' } : undefined)
      expect(!r.ok && r.error.code, ch).toBe('FORBIDDEN')
    }
    await call('auth:logout')
  })

  it('exception report lists unusual items for review — never as fraud — on the DEMO company', async () => {
    await login('auditor', 'Auditor@123')
    const r = (await call('audit:exceptions')) as { ok: true; data: AuditExceptionReport }
    expect(r.ok).toBe(true)
    const rep = r.data
    expect(rep.counts.UNBALANCED_ATTEMPT).toBeGreaterThanOrEqual(1)
    expect(rep.counts.MANUAL_JOURNAL).toBeGreaterThanOrEqual(2)
    expect(rep.counts.CANCELLED).toBeGreaterThanOrEqual(1)
    expect(rep.counts.REVERSED).toBeGreaterThanOrEqual(1)
    expect(rep.counts.STOCK_ADJUSTMENT).toBeGreaterThanOrEqual(1)
    expect(rep.items.find((i) => i.category === 'MANUAL_JOURNAL' && /AR/.test(i.detail))?.detail).toMatch(/adjusts control account/)
    expect(rep.items.some((i) => i.category === 'MANUAL_JOURNAL' && /large amount|round amount/.test(i.detail))).toBe(true)
    expect(JSON.stringify(rep.items)).not.toMatch(/fraud/i)
    expect(rep.disclaimer).toMatch(/not .*fraud/)
    await call('auth:logout')
  })

  it('PDF export renders the escaped report HTML, writes an audit entry, and reports cancelled saves honestly', async () => {
    await login('accounts', 'Accounts@123')
    const auditBefore = count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'EXPORT_PDF' AND entity_type = 'report'`)
    printed.pdfHtml.length = 0
    const ok = await call('report:exportPdf', { report: 'PROFIT_LOSS', from: '2026-04-01', to: '2026-11-14' })
    expect(ok.ok).toBe(true)
    const html = printed.pdfHtml[0]
    expect(html).toContain('Profit &amp; Loss')
    expect(html).toContain('GROSS PROFIT')
    expect(html).toContain('NET PROFIT')
    expect(html).toContain('DEMO')
    expect(html).not.toMatch(/<script/i)
    expect(count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'EXPORT_PDF' AND entity_type = 'report'`)).toBe(auditBefore + 1)
    printed.savePath = null
    const cancelled = await call('report:exportPdf', { report: 'BALANCE_SHEET', asOf: '2026-11-14' })
    expect(cancelled).toMatchObject({ ok: true, data: { path: null } })
    expect(count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'EXPORT_PDF' AND entity_type = 'report'`)).toBe(auditBefore + 1)
    printed.savePath = 'C:\\Exports\\report.pdf'
    const prn = await call('report:print', { report: 'DAY_BOOK', from: '2026-11-01', to: '2026-11-14' })
    expect(prn).toMatchObject({ ok: true, data: { printed: true } })
    const bad = await call('report:exportPdf', { report: 'GENERAL_LEDGER', from: '2026-04-01', to: '2026-11-14' })
    expect(!bad.ok && bad.error.code).toBe('VALIDATION')
    await call('auth:logout')
  })

  it('Excel export produces a valid .xlsx workbook whose numbers equal the trial balance', async () => {
    await login('accounts', 'Accounts@123')
    printed.files.length = 0
    const period = { from: '2026-04-01', to: '2026-11-14' }
    const r = await call('report:exportExcel', { report: 'TRIAL_BALANCE', ...period })
    expect(r).toMatchObject({ ok: true, data: { path: 'C:\\Exports\\report.xlsx' } })
    const file = printed.files[0]
    expect(file.name).toMatch(/^Trial Balance \d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(file.data.subarray(0, 2).toString('latin1')).toBe('PK')
    const parts = unzip(file.data)
    expect([...parts.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
    const sheet = parts.get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('<sheetData>')
    const tb = (await call('finance:trialBalanceReport', period)) as { ok: true; data: TrialBalanceReport }
    const totalRupees = (tb.data.totals.closingDebitPaise / 100).toFixed(2)
    expect(sheet).toContain(`<v>${totalRupees}</v>`)
    expect(sheet).toContain('Sundry Debtors')
    expect(parts.get('xl/workbook.xml')).toContain('name="Trial Balance"')
    // Escaping: XML-special characters in names stay well-formed.
    const doc = buildReport({ db, userId: null, companyId }, { report: 'TRIAL_BALANCE', ...period })
    doc.rows[0].cells.name = 'A & B <Co> "x"'
    const xml = unzip(reportToXlsx(doc)).get('xl/worksheets/sheet1.xml')!
    expect(xml).toContain('A &amp; B &lt;Co&gt; &quot;x&quot;')
    await call('auth:logout')
  })
})

describe('audit exceptions — detection rules', () => {
  it('flags missing sources, duplicate references, manual journals, reversals and cancelled documents', () => {
    const f = fixture()
    const acc = (code: string) => (f.db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(f.ctx.companyId, code) as { id: number }).id
    // Legacy-style manual journal with no source document.
    postJournal(f.db, { companyId: f.ctx.companyId, userId: f.ctx.userId, entryDate: '2026-10-02', sourceType: 'MANUAL', narration: 'Unexplained adjustment', lines: [{ accountId: acc('6400'), debitPaise: R(10) }, { accountId: f.bank, creditPaise: R(10) }] })
    // Two identical invoices on the same day (possible double billing).
    for (let i = 0; i < 2; i++) f.post(f.save({ kind: 'SALES_INVOICE', partyId: f.inter, date: '2026-10-03', lines: [{ productId: f.service, qtyMilli: toMilli(1), ratePaise: R(500) }] }))
    // Legacy duplicate bank reference recorded before the Phase 3 check existed.
    const r1 = createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: '2026-10-04', amountPaise: R(100), mode: 'UPI', accountId: f.bank, referenceNo: 'UTR-9', allocations: [] })
    f.db.prepare(`INSERT INTO payment_receipts (company_id, financial_year, receipt_no, receipt_date, customer_id, amount_paise, mode, deposit_account_id, reference_no) VALUES (?, '2026-27', 'RCT/LEGACY/1', '2026-10-05', ?, 10000, 'UPI', ?, 'utr 9')`).run(f.ctx.companyId, f.intra, f.bank)
    // Large round manual journal, back-dated, touching a control account.
    const v = createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-04', narration: 'Year-end adjustment', lines: [{ accountId: acc('6100'), debitPaise: R(200000) }, { accountId: acc('1300'), creditPaise: R(200000), partyType: 'CUSTOMER', partyId: f.intra }] })
    // Unbalanced attempt.
    expect(() => createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-04', narration: 'Typo', lines: [{ accountId: acc('6100'), debitPaise: 100 }, { accountId: f.bank, creditPaise: 10 }] })).toThrow()
    const rep = auditExceptions(f.ctx)
    const by = (c: string) => rep.items.filter((i) => i.category === c)
    expect(by('MISSING_SOURCE').map((i) => i.title)).toContain('Journal without a source document')
    expect(by('DUPLICATE_REFERENCE').map((i) => i.title)).toEqual(expect.arrayContaining(['Possible duplicate sales invoice', 'Same bank reference on more than one receipt']))
    const mj = by('MANUAL_JOURNAL').find((i) => i.reference === v.number)!
    expect(mj.detail).toMatch(/large amount/)
    expect(mj.detail).toMatch(/adjusts control account\(s\): AR/)
    expect(mj.detail).toMatch(/entered \d+ days after its voucher date/)
    expect(by('UNBALANCED_ATTEMPT')).toHaveLength(1)
    expect(rep.items.every((i) => i.severity === 'info' || i.severity === 'review')).toBe(true)
    expect(r1.number).toBeTruthy()
    // Date filter narrows the report.
    expect(auditExceptions(f.ctx, { from: '2026-10-03', to: '2026-10-03' }).items.every((i) => i.date === '2026-10-03')).toBe(true)
  })
})

describe('migration 004 on an existing Phase 2 database', () => {
  it('classifies accounts, adds Phase 3 accounts and permissions, and leaves posted history untouched', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS.slice(0, 3))
    expect(currentSchemaVersion(db)).toBe(3)
    const company = createCompany(db, null, { code: 'P2', name: 'Phase Two Co', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 })
    const ctx = { db, userId: null, companyId: company.id }
    expect(db.prepare(`SELECT COUNT(*) n FROM chart_of_accounts WHERE company_id = ? AND code IN ('3200','6200','1600')`).get(company.id)).toEqual({ n: 0 })
    const L = getLookups(ctx)
    const cust = createCustomer(ctx, CustomerInput.parse({ code: 'C1', name: 'Old Customer', partyType: 'BUSINESS', gstRegistrationType: 'REGULAR', gstin: buildGstin('33', 'AABCZ1234F'), pan: 'AABCZ1234F', contactPerson: null, phone: null, email: null, addressLine1: 'X', addressLine2: null, city: 'Chennai', stateCode: '33', pincode: null, creditLimitPaise: 0, creditDays: 30, openingBalancePaise: R(1000) })).id
    const svc = createProduct(ctx, ProductInput.parse({ code: 'S', name: 'Service', description: null, itemType: 'SERVICE', categoryId: null, unitId: L.units[0].id, hsnSac: '998313', taxRateId: L.taxRates.find((t) => t.rateBps === 1800)!.id, salePricePaise: R(100), purchasePricePaise: 0, mrpPaise: null, reorderLevelMilli: 0, trackInventory: false })).id
    postOpeningFunds(ctx, '2026-04-01', R(5000), R(10000))
    const inv = postSalesInvoice(ctx, { customerId: cust, invoiceDate: '2026-09-01', warehouseId: L.warehouses[0].id, lines: [{ productId: svc, qtyMilli: toMilli(10), ratePaise: R(100) }] })
    createPayment(ctx, { type: 'RECEIPT', partyId: cust, date: '2026-09-10', amountPaise: R(500), mode: 'CASH', accountId: accountId(db, company.id, 'CASH'), allocations: [{ invoiceId: inv.id, amountPaise: R(500) }] })
    const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM journal_entries ORDER BY id').all(), db.prepare('SELECT * FROM journal_entry_lines ORDER BY id').all(), db.prepare('SELECT * FROM sales_invoices ORDER BY id').all(), db.prepare('SELECT * FROM payment_allocations ORDER BY id').all()])
    const before = snapshot()

    // Pinned to migrations 1–4: this test covers the 004 upgrade (005 has its own upgrade test).
    const report = migrate(db, MIGRATIONS.slice(0, 4))
    expect(report.applied.map((m) => m.version)).toEqual([4])
    expect(snapshot()).toBe(before)
    expect(db.prepare(`SELECT COUNT(*) n FROM chart_of_accounts WHERE company_id = ? AND is_group = 0 AND report_group IS NULL`).get(company.id)).toEqual({ n: 0 })
    const group = (code: string) => (db.prepare('SELECT report_group g FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(company.id, code) as { g: string }).g
    expect([group('1100'), group('1200'), group('1210'), group('1300'), group('2200'), group('4300'), group('5400'), group('6200'), group('6800'), group('3200')]).toEqual(['CASH', 'BANK', 'BANK', 'RECEIVABLES', 'TAX_LIABILITY', 'SALES', 'COGS', 'ADMIN_EXPENSE', 'FINANCE_EXPENSE', 'RETAINED_EARNINGS'])
    const perms = (role: string) => (db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.code = ? AND p.code IN ('finance.manage','reports.view','reports.export') ORDER BY p.code`).all(role) as Array<{ code: string }>).map((x) => x.code)
    expect(perms('ADMIN')).toEqual(['finance.manage', 'reports.export', 'reports.view'])
    expect(perms('ACCOUNTANT')).toEqual(['finance.manage', 'reports.export', 'reports.view'])
    expect(perms('AUDITOR')).toEqual(['reports.export', 'reports.view'])
    expect(perms('SALES')).toEqual([])
    // Reports work on the upgraded data, and the books still reconcile.
    expect(trialBalanceReport(ctx, '2026-04-01', '2026-10-31').balanced).toBe(true)
    expect(profitAndLoss(ctx, '2026-04-01', '2026-10-31').salesRevenuePaise).toBe(R(1000))
    expect(balanceSheet(ctx, '2026-10-31').balanced).toBe(true)
    expect(integrityReport(ctx, '2026-10-31').checks.filter((c) => !c.ok)).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(migrate(db, MIGRATIONS.slice(0, 4)).applied).toEqual([])
  })
})
