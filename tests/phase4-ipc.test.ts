/**
 * Phase 4 over the real IPC router with the DEMO company: every new channel is wired,
 * role permissions hold (auditor read-only, sales limited, integrations admin-only),
 * exports go through the printing layer and are labelled DEMO / NOT FILED.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../src/main/db/connection'
import { createRouter, type Dispatch } from '../src/main/ipc/router'
import { createRoutes, type PrintingDeps } from '../src/main/ipc/routes'
import { SessionStore } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { EInvoiceService } from '../src/main/services/einvoice/service'
import { MockEInvoiceProvider } from '../src/main/services/einvoice/provider'
import { silentLogger } from '../src/main/logger'
import { createSenderValidator } from '../src/main/security'
import { hashPassword } from '../src/main/services/password'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { ipcInputSchemas } from '@shared/ipc-contract'
import type { EInvoiceWorkspace, GstOverview, GstSalesRegister, ReturnPreparation } from '@shared/gst'
import { demoDb, TEST_TODAY } from './helpers'

const TRUSTED = 'file:///D:/App/out/renderer/index.html'
type Ok<T> = { ok: true; data: T }

describe('Phase 4 over IPC', () => {
  let dispatch: Dispatch
  let db: DB
  let companyId: number
  const out = { pdf: [] as string[], files: [] as Array<{ name: string; data: Buffer }>, printed: [] as string[] }
  const printing: PrintingDeps = {
    toPdf: async (html) => (out.pdf.push(html), Buffer.from('%PDF-1.7 mock')),
    print: async (html) => (out.printed.push(html), true),
    savePdf: async () => 'C:\\Exports\\doc.pdf',
    saveFile: async (name, data) => (out.files.push({ name, data }), `C:\\Exports\\${name}`)
  }
  const call = (ch: string, input?: unknown) => dispatch(ch, input, TRUSTED)
  const ok = async <T,>(ch: string, input?: unknown): Promise<T> => {
    const r = await call(ch, input)
    expect(r.ok, `${ch}: ${!r.ok ? r.error.message : ''}`).toBe(true)
    return (r as Ok<T>).data
  }
  const login = (u: string, p: string) => ok('auth:login', { username: u, password: p })
  const period = TEST_TODAY.toISOString().slice(0, 7)
  const range = { from: `${period}-01`, to: TEST_TODAY.toISOString().slice(0, 10) }

  beforeAll(async () => {
    const demo = await demoDb()
    db = demo.db
    companyId = demo.ctx.companyId
    dispatch = createRouter({
      db, sessions: new SessionStore(), logger: silentLogger,
      isTrustedSender: createSenderValidator({ rendererIndexPath: 'D:\\App\\out\\renderer\\index.html' }),
      routes: createRoutes({ ewayBills: new EwayBillService(new MockEwayBillProvider(), { sleep: async () => {} }), einvoices: new EInvoiceService(() => new MockEInvoiceProvider(), { sleep: async () => {} }), appInfo: () => ({}) as never, printing })
    })
    db.prepare(`INSERT OR IGNORE INTO users (username, full_name, password_hash, role_id, default_company_id) VALUES ('seller4', 'Sales Exec', ?, (SELECT id FROM roles WHERE code = 'SALES'), ?)`).run(hashPassword('Seller@123'), companyId)
  })

  it('wires every channel with an input schema and keeps the allow-list unique', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length)
    for (const ch of IPC_CHANNELS) expect(ipcInputSchemas[ch], ch).toBeDefined()
    for (const ch of ['gst:gstr1', 'gst:gstr3b', 'gst:prepare', 'einvoice:generate', 'ewaybill:extend', 'transport:saveVehicle', 'integration:saveCredentials'])
      expect(IPC_CHANNELS as readonly string[]).toContain(ch)
  })

  it('the demo data reconciles: registers agree with the GST ledgers and include every GSTR-1 section', async () => {
    await login('accounts', 'Accounts@123')
    const fyFrom = '2026-04-01'
    const sales = await ok<GstSalesRegister>('gst:salesRegister', { from: fyFrom, to: range.to })
    expect(sales.ledger.agrees).toBe(true)
    for (const s of ['B2B', 'B2CL', 'B2CS', 'SEZWP', 'SEZWOP', 'EXPWOP', 'CDNR']) expect(Object.keys(sales.bySection), s).toContain(s)
    const purchases = await ok<{ ledger: { agrees: boolean }; byEligibility: Record<string, unknown> }>('gst:purchaseRegister', { from: fyFrom, to: range.to })
    expect(purchases.ledger.agrees).toBe(true)
    expect(Object.keys(purchases.byEligibility)).toEqual(expect.arrayContaining(['ELIGIBLE', 'PENDING', 'INELIGIBLE']))
    const ov = await ok<GstOverview>('gst:overview', { period })
    expect(ov.einvoice).toMatchObject({ enabled: true })
    expect(ov.einvoice.generated).toBeGreaterThan(0)
    expect(ov.einvoice.failed).toBe(1)
    const ws = await ok<EInvoiceWorkspace>('einvoice:workspace', { from: '2026-10-15', to: range.to })
    expect(ws.isDemo).toBe(true)
    expect(ws.records.every((r) => r.isDemo && (!r.irn || r.irn.startsWith('DEMO-')))).toBe(true)
    const ewbs = await ok<Array<{ ewbNo: string; isDemo: boolean; sourceKind: string }>>('ewaybill:list')
    expect(ewbs.every((e) => e.isDemo && e.ewbNo.startsWith('DEMO'))).toBe(true)
    expect(ewbs.some((e) => e.sourceKind === 'DELIVERY_CHALLAN')).toBe(true)
    expect((await ok<Array<{ batch?: unknown; counts: Record<string, number> }>>('gst:reconList'))[0].counts).toMatchObject({ MATCHED: expect.any(Number), NOT_IN_BOOKS: 1 })
    await call('auth:logout')
  })

  it('accountant prepares and exports returns (Excel / JSON) marked "not filed"', async () => {
    await login('accounts', 'Accounts@123')
    const v = await ok<{ errors: number; issues: Array<{ severity: string; message: string }> }>('gst:validate', range)
    expect(v.issues.filter((i) => i.severity === 'ERROR')).toEqual([])
    const p = await ok<ReturnPreparation>('gst:prepare', { returnType: 'GSTR3B', period })
    expect(p.status).toBe('PREPARED')
    const prev = await ok<{ subtitle: string; notes: string[] }>('gst:previewPreparation', { id: p.id })
    expect(prev.subtitle).toMatch(/NOT FILED/)
    const x = await ok<{ path: string }>('gst:exportPreparation', { id: p.id, format: 'XLSX' })
    expect(x.path).toMatch(/GSTR-3B .*\(prepared, not filed\)\.xlsx$/)
    expect(out.files.at(-1)!.data.subarray(0, 2).toString()).toBe('PK')
    await ok('gst:exportPreparation', { id: p.id, format: 'JSON' })
    expect(JSON.parse(out.files.at(-1)!.data.toString('utf8')).notice).toMatch(/NOT been filed/)
    expect((await ok<ReturnPreparation>('gst:preparation', { id: p.id })).status).toBe('EXPORTED')
    // E-invoice print / PDF of a DEMO IRN.
    const generated = (db.prepare(`SELECT id FROM einvoices WHERE company_id = ? AND status = 'GENERATED' LIMIT 1`).get(companyId) as { id: number }).id
    await ok('einvoice:exportPdf', { id: generated })
    expect(out.pdf.at(-1)).toContain('DEMO E-INVOICE')
    const ewb = (db.prepare(`SELECT id FROM ewaybill_records WHERE company_id = ? LIMIT 1`).get(companyId) as { id: number }).id
    await ok('ewaybill:print', { id: ewb })
    expect(out.printed.at(-1)).toContain('NOT a government-issued e-way bill')
    // Integrations are admin-only.
    const denied = await call('integration:save', { service: 'EINVOICE', mode: 'LIVE', providerName: 'x', apiBaseUrl: 'https://x.invalid', timeoutMs: 5000, maxRetries: 1 })
    expect(!denied.ok && denied.error.code).toBe('FORBIDDEN')
    expect((await ok<{ settings: Array<{ mode: string }>; notice: string }>('integration:overview')).notice).toMatch(/No government system is connected/)
    await call('auth:logout')
  })

  it('auditor views GST, e-invoice and e-way bill data but cannot change anything', async () => {
    const counts = () => JSON.stringify(['purchase_itc', 'gst_return_preparations', 'einvoices', 'ewaybill_records', 'gst_recon_lines', 'compliance_rules', 'vehicles', 'integration_credentials'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
    await login('auditor', 'Auditor@123')
    for (const [ch, input] of [['gst:overview', { period }], ['gst:config', undefined], ['gst:salesRegister', range], ['gst:purchaseRegister', range], ['gst:validate', range], ['gst:gstr1', { period }], ['gst:gstr3b', { period }], ['gst:preparations', undefined], ['gst:reconList', undefined], ['einvoice:workspace', range], ['einvoice:list', undefined], ['ewaybill:list', undefined], ['transport:masters', undefined], ['integration:apiLog', { limit: 5 }]] as const)
      await ok(ch, input)
    const before = counts()
    const inv = (db.prepare(`SELECT id FROM sales_invoices WHERE company_id = ? AND status = 'POSTED' ORDER BY id DESC LIMIT 1`).get(companyId) as { id: number }).id
    const pur = (db.prepare(`SELECT id FROM purchase_invoices WHERE company_id = ? AND status = 'POSTED' LIMIT 1`).get(companyId) as { id: number }).id
    const einv = (db.prepare(`SELECT id FROM einvoices WHERE company_id = ? AND status = 'GENERATED' LIMIT 1`).get(companyId) as { id: number }).id
    const failed = (db.prepare(`SELECT id FROM einvoices WHERE company_id = ? AND status = 'FAILED' LIMIT 1`).get(companyId) as { id: number }).id
    const ewb = (db.prepare(`SELECT id FROM ewaybill_records WHERE company_id = ? AND status = 'ACTIVE' LIMIT 1`).get(companyId) as { id: number }).id
    const forbidden: Array<[string, unknown]> = [
      ['gst:classifyItc', { documents: [{ kind: 'PURCHASE_INVOICE', id: pur }], eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null }],
      ['gst:prepare', { returnType: 'GSTR1', period }],
      ['gst:saveSettings', { aatoPaise: null, aatoFy: null, einvoiceEnabled: false, einvoiceExemptReason: null, returnFrequency: 'MONTHLY', lutNumber: null, lutValidFrom: null, lutValidUpto: null }],
      ['gst:saveRule', { ruleKey: 'EWB_MAX_DISTANCE_KM', valueNum: 1, effectiveFrom: '2026-01-01', effectiveTo: null, sourceNote: null }],
      ['gst:reconImport', { label: 'Auditor attempt', source: 'OTHER', periodFrom: '2026-10-01', periodTo: '2026-10-31', csv: 'invoice_no,invoice_date,taxable\nA,2026-10-01,1' }],
      ['einvoice:generate', { documentKind: 'SALES_INVOICE', documentId: inv, requestKey: 'auditor-attempt-0000-4000-8000' }],
      ['einvoice:retry', { id: failed }],
      ['einvoice:cancel', { id: einv, reasonCode: 1, remarks: 'Not allowed' }],
      ['ewaybill:cancel', { id: ewb, reasonCode: 1, remarks: 'Not allowed' }],
      ['ewaybill:extend', { id: ewb, reasonCode: 1, remarks: 'Not allowed', currentPlace: 'Salem', currentStateCode: '33', remainingDistanceKm: 10, transportMode: 'ROAD', vehicleNo: 'TN09AB1234' }],
      ['transport:saveVehicle', { vehicleNo: 'TN09ZZ9999', vehicleType: 'REGULAR', bodyType: 'TRUCK', isOwn: true }],
      ['integration:saveCredentials', { service: 'EINVOICE', environment: 'LIVE', username: 'x', password: 'y' }]
    ]
    for (const [ch, input] of forbidden) {
      const r = await call(ch, input)
      expect(r.ok, ch).toBe(false)
      expect(!r.ok && r.error.code, ch).toBe('FORBIDDEN')
    }
    // An auditor may export a preparation for review; it does not change its status.
    const prep = (db.prepare('SELECT id FROM gst_return_preparations WHERE company_id = ? LIMIT 1').get(companyId) as { id: number }).id
    await ok('gst:exportPreparation', { id: prep, format: 'XLSX' })
    expect(counts()).toBe(before)
    await call('auth:logout')
  })

  it('a sales user sees e-invoices but not GST returns or integrations', async () => {
    await login('seller4', 'Seller@123')
    await ok('einvoice:list')
    for (const ch of ['gst:gstr1', 'gst:config', 'einvoice:generate', 'integration:save']) {
      const input = ch === 'gst:gstr1' ? { period } : ch === 'einvoice:generate' ? { documentKind: 'SALES_INVOICE', documentId: 1, requestKey: 'seller-attempt-000-4000-8000' } : ch === 'integration:save' ? { service: 'EWAYBILL', mode: 'DEMO', providerName: null, apiBaseUrl: null, timeoutMs: 5000, maxRetries: 1 } : undefined
      const r = await call(ch, input)
      expect(!r.ok && r.error.code, ch).toBe('FORBIDDEN')
    }
    // Connection status is visible (no secrets in it).
    const ov = await ok<{ credentials: Array<{ stored: boolean }> }>('integration:overview')
    expect(JSON.stringify(ov)).not.toMatch(/password|secret_blob/i)
    await call('auth:logout')
  })
})
