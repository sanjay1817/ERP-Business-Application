/**
 * Phase 4 — e-invoice and e-way bill workflows behind provider interfaces: eligibility,
 * DEMO results, duplicate prevention, error classification, retries, timeouts, live-mode
 * refusal, encrypted credentials, the e-way bill lifecycle and transport masters.
 */
import { describe, expect, it } from 'vitest'
import { buildGstin } from '@shared/india'
import { canExtendAt, eInvoiceEligibility, ewbRequirement, ewbValidUntil, TransporterSaveInput, VehicleSaveInput, type RuleSet } from '@shared/gst'
import { EwbGenerateInput, type EwbGenerateInputT } from '@shared/schemas'
import { toMilli } from '@shared/money'
import { DocumentSaveInput } from '@shared/documents'
import { EInvoiceService } from '../src/main/services/einvoice/service'
import { LiveEInvoiceProvider, MockEInvoiceProvider } from '../src/main/services/einvoice/provider'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { LiveEwayBillProvider, MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { callProvider, ProviderError, scrub } from '../src/main/services/integrations/runner'
import { apiLog, integrationOverview, readCredentials, saveCredentials, saveIntegration, type SecretCipher } from '../src/main/services/integrations/settings'
import { saveTransportDoc, saveTransporter, saveVehicle, listTransportDocs } from '../src/main/services/transport'
import { cancelDocument, convertDocument, postDocument, saveDraft } from '../src/main/services/documents/engine'
import { saveSettings, rulesAt } from '../src/main/services/gst/config'
import { p4Fixture, R } from './phase4-fixtures'

const NOW = new Date('2026-11-14T06:30:00Z')
const noSleep = { sleep: async () => {} }
const key = (n: number) => `test-key-${String(n).padStart(4, '0')}-4000-8000-000000000000`
const rules = (ctx: Parameters<typeof rulesAt>[0]) => rulesAt(ctx, '2026-11-14')

describe('e-invoice eligibility rules', () => {
  const base = { companyGstin: '33AAACT4321Q1Z5', einvoiceEnabled: true, exemptReason: null, aatoPaise: R(60000000), documentKind: 'SALES_INVOICE', documentStatus: 'POSTED', documentDate: '2026-11-01', partyRegType: 'REGULAR', partyGstin: '29AABCB1234F1Z1', hasOriginalReference: false, today: '2026-11-14' }
  const g = p4Fixture({ withDocs: false })
  const r: RuleSet = rules(g.ctx)
  it('applies to posted B2B, SEZ and export documents only', () => {
    expect(eInvoiceEligibility({ ...base, rules: r })).toMatchObject({ applicable: true, documentType: 'INV', supplyType: 'B2B' })
    expect(eInvoiceEligibility({ ...base, partyRegType: 'SEZ', rules: r }).supplyType).toBe('SEZ')
    expect(eInvoiceEligibility({ ...base, partyRegType: 'OVERSEAS', partyGstin: null, rules: r }).supplyType).toBe('EXP')
    expect(eInvoiceEligibility({ ...base, partyRegType: 'CONSUMER', partyGstin: null, rules: r }).blockers.join()).toMatch(/B2C/)
    expect(eInvoiceEligibility({ ...base, documentStatus: 'DRAFT', rules: r }).applicable).toBe(false)
    expect(eInvoiceEligibility({ ...base, documentKind: 'PURCHASE_INVOICE', rules: r }).applicable).toBe(false)
    expect(eInvoiceEligibility({ ...base, documentKind: 'CREDIT_NOTE', rules: r }).blockers.join()).toMatch(/original invoice/)
    expect(eInvoiceEligibility({ ...base, documentKind: 'CREDIT_NOTE', hasOriginalReference: true, rules: r })).toMatchObject({ applicable: true, documentType: 'CRN' })
  })
  it('never assumes applicability: the company must enable it; exemptions and the reporting window block it', () => {
    expect(eInvoiceEligibility({ ...base, einvoiceEnabled: false, aatoPaise: R(10000000), rules: r }).blockers.join()).toMatch(/not enabled/)
    expect(eInvoiceEligibility({ ...base, einvoiceEnabled: false, rules: r }).blockers.join()).toMatch(/at or above the e-invoicing threshold/)
    expect(eInvoiceEligibility({ ...base, exemptReason: 'Notified exempt category', rules: r }).blockers.join()).toMatch(/not applicable/)
    // ₹12 crore turnover: documents older than the configured 30-day limit are blocked; ₹6 crore: no limit.
    expect(eInvoiceEligibility({ ...base, aatoPaise: R(120000000), documentDate: '2026-10-01', rules: r }).blockers.join()).toMatch(/44 days old/)
    expect(eInvoiceEligibility({ ...base, documentDate: '2026-10-01', rules: r }).applicable).toBe(true)
    expect(eInvoiceEligibility({ ...base, aatoPaise: null, rules: r }).notes.join()).toMatch(/not recorded/)
  })
})

describe('e-invoice workflow (DEMO provider)', () => {
  it('generates a clearly DEMO IRN without a signed QR code, and prints it as DEMO', async () => {
    const f = p4Fixture()
    const svc = new EInvoiceService(() => new MockEInvoiceProvider(), noSleep)
    const e = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(1) }, NOW)
    expect(e).toMatchObject({ status: 'GENERATED', isDemo: true, environment: 'DEMO', documentType: 'INV', supplyType: 'B2B', signedQr: null, attempts: 1 })
    expect(e.irn).toMatch(/^DEMO-[0-9a-f]{40}$/)
    expect(e.irn).not.toMatch(/^[0-9a-f]{64}$/) // never shaped like a real IRN
    expect(e.ackNo).toMatch(/^DEMO\d{10}$/)
    expect(JSON.parse(e.signedInvoice!).notice).toMatch(/NOT SIGNED BY ANY INVOICE REGISTRATION PORTAL/)
    expect(e.apiRequests).toEqual([expect.objectContaining({ operation: 'GENERATE_IRN', outcome: 'SUCCESS', provider: 'DEMO' })])
    const { html } = svc.printHtml(f.ctx, e.id)
    expect(html).toContain('DEMO E-INVOICE — NOT A LEGALLY REGISTERED E-INVOICE')
    expect(html).toContain('NO QR CODE')
    expect(html).toContain(e.irn!)
    // SEZ (with and without IGST), export under LUT and a credit note get their supply / document types.
    expect((await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.C.id, requestKey: key(2) }, NOW)).supplyType).toBe('SEZWP')
    expect((await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.D.id, requestKey: key(3) }, NOW)).supplyType).toBe('SEZWOP')
    expect((await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.E.id, requestKey: key(4) }, NOW)).supplyType).toBe('EXPWOP')
    expect((await svc.generate(f.ctx, { documentKind: 'CREDIT_NOTE', documentId: f.cn.CN1.id, requestKey: key(5) }, NOW)).documentType).toBe('CRN')
    // B2C is refused before any provider call.
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.F.id, requestKey: key(6) }, NOW)).rejects.toThrow(/B2C/)
    expect(f.db.prepare(`SELECT COUNT(*) n FROM einvoices WHERE document_id = ? AND document_kind = 'SALES_INVOICE'`).get(f.inv.F.id)).toEqual({ n: 0 })
  })

  it('prevents duplicate IRNs: same request key, second request, unique index, provider duplicate and ERP cancellation', async () => {
    const f = p4Fixture()
    const mock = new MockEInvoiceProvider()
    const svc = new EInvoiceService(() => mock, noSleep)
    const first = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.B.id, requestKey: key(10) }, NOW)
    const again = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.B.id, requestKey: key(10) }, NOW)
    expect(again.id).toBe(first.id)
    expect(again.irn).toBe(first.irn)
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.B.id, requestKey: key(11) }, NOW)).rejects.toThrow(/already has an e-invoice/)
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(10) }, NOW)).rejects.toThrow(/another document/)
    expect(() => f.db.prepare(`INSERT INTO einvoices (company_id, document_kind, document_id, document_no, document_date, document_type, supply_type, seller_gstin, total_value_paise, provider, environment, status, request_key) SELECT company_id, document_kind, document_id, document_no, document_date, document_type, supply_type, seller_gstin, total_value_paise, provider, environment, 'PENDING', 'x-other-key' FROM einvoices WHERE id = ?`).run(first.id)).toThrow(/UNIQUE/)
    expect(f.db.prepare('SELECT COUNT(*) n FROM einvoices WHERE document_id = ?').get(f.inv.B.id)).toEqual({ n: 1 })
    // The IRN cannot be altered once registered.
    expect(() => f.db.prepare(`UPDATE einvoices SET irn = 'DEMO-x' WHERE id = ?`).run(first.id)).toThrow(/cannot be changed/)
    // An invoice with a live IRN cannot be cancelled in the books.
    await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.H.id, requestKey: key(13) }, NOW)
    expect(() => cancelDocument(f.ctx, 'SALES_INVOICE', f.inv.H.id, 'Wrong rate')).toThrow(/IRN/)
    // If the provider already holds an IRN for the document (e.g. our first response was lost), its
    // "duplicate" answer is resolved by fetching that IRN — never by creating a second one.
    const g = p4Fixture()
    const svcG = new EInvoiceService(() => mock, noSleep)
    const seller = f.db.prepare('SELECT seller_gstin FROM einvoices WHERE id = ?').pluck().get(first.id) as string
    expect((await mock.getIrnByDocument(seller, 'INV', first.documentNo, first.documentDate))?.irn).toBe(first.irn)
    const sameNo = g.inv.B // same company GSTIN and same document number in the second fixture
    expect(sameNo.number).toBe(first.documentNo)
    const recovered = await svcG.generate(g.ctx, { documentKind: 'SALES_INVOICE', documentId: sameNo.id, requestKey: key(12) }, NOW)
    expect(recovered.irn).toBe(first.irn)
    expect(recovered.history.at(-1)!.detail).toMatch(/already registered; existing IRN retrieved/)
  })

  it('records provider failures honestly, retries transient errors and lets the user retry', async () => {
    const f = p4Fixture()
    const mock = new MockEInvoiceProvider()
    const svc = new EInvoiceService(() => mock, noSleep)
    // Transient error then success: retried automatically (one IRN, two attempts logged).
    mock.faults.push('NETWORK')
    const ok = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(20) }, NOW)
    expect(ok.status).toBe('GENERATED')
    expect(ok.apiRequests.map((a) => [a.attempt, a.outcome, a.errorClass])).toEqual([[2, 'SUCCESS', null], [1, 'FAILED', 'NETWORK']])
    // Persistent provider errors: three attempts, stored as FAILED and reported as a failure — never as success.
    mock.faults.push('PROVIDER', 'PROVIDER', 'PROVIDER')
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.H.id, requestKey: key(21) }, NOW)).rejects.toThrow(/NOT generated.*can be retried/)
    const failed = svc.list(f.ctx).find((e) => e.documentId === f.inv.H.id)!
    expect(failed).toMatchObject({ status: 'FAILED', irn: null, errorCode: 'DEMO_PROVIDER', attempts: 3 })
    // A validation error is not retried.
    mock.faults.push('VALIDATION')
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.C.id, requestKey: key(22) }, NOW)).rejects.toThrow(/NOT generated/)
    expect(apiLog(f.ctx, { entityType: 'einvoice', entityId: svc.list(f.ctx).find((e) => e.documentId === f.inv.C.id)!.id }).length).toBe(1)
    // Retry of a failed request succeeds with the same request key.
    const retried = await svc.retry(f.ctx, failed.id, NOW)
    expect(retried).toMatchObject({ status: 'GENERATED', id: failed.id, requestKey: key(21) })
    await expect(svc.retry(f.ctx, failed.id, NOW)).rejects.toThrow(/Only failed requests/)
  })

  it('after a timeout, asks the provider before re-sending so no duplicate is created', async () => {
    const f = p4Fixture()
    const mock = new MockEInvoiceProvider()
    const svc = new EInvoiceService(() => mock, noSleep)
    mock.faults.push('TIMEOUT_AFTER_SUCCESS')
    const e = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(30) }, NOW)
    expect(e.status).toBe('GENERATED')
    expect(e.history.at(-1)!.detail).toMatch(/confirmed by status check/)
    expect(e.apiRequests.map((a) => a.operation)).toEqual(['GENERATE_IRN:STATUS_CHECK', 'GENERATE_IRN'])
    // Runner-level timeout: a provider that never answers is classified TIMEOUT.
    const slow = await callProvider(f.ctx, { service: 'EINVOICE', provider: 'T', environment: 'DEMO', operation: 'X', entityType: 't', entityId: null, requestKey: key(31), summary: 's', timeoutMs: 20, maxRetries: 1 }, () => new Promise(() => {}), noSleep)
    expect(slow).toMatchObject({ ok: false, attempts: 2 })
    expect(!slow.ok && slow.error.errorClass).toBe('TIMEOUT')
  })

  it('cancels within the window only, and checks status', async () => {
    const f = p4Fixture()
    const mock = new MockEInvoiceProvider()
    const svc = new EInvoiceService(() => mock, noSleep)
    const e = await svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(40) }, NOW)
    expect((await svc.status(f.ctx, e.id, NOW)).history.at(-1)!.detail).toMatch(/active/)
    const late = new Date(NOW.getTime() + 25 * 3600000)
    await expect(svc.cancel(f.ctx, { id: e.id, reasonCode: 2, remarks: 'Too late' }, late)).rejects.toThrow(/window has passed/)
    const c = await svc.cancel(f.ctx, { id: e.id, reasonCode: 2, remarks: 'Wrong address' }, new Date(NOW.getTime() + 3600000))
    expect(c).toMatchObject({ status: 'CANCELLED', cancelRemarks: 'Wrong address', cancelReasonCode: 2 })
    expect((await svc.status(f.ctx, e.id, NOW)).history.at(-1)!.detail).toMatch(/cancelled/)
    await expect(svc.cancel(f.ctx, { id: e.id, reasonCode: 2, remarks: 'again' }, NOW)).rejects.toThrow(/Only a generated/)
    // The cancelled IRN no longer blocks cancelling the invoice in the books.
    expect(cancelDocument(f.ctx, 'SALES_INVOICE', f.inv.A.id, 'Re-issue').status).toBe('CANCELLED')
  })

  it('live/sandbox mode sends nothing, fails safely and never reports success', async () => {
    const f = p4Fixture()
    saveIntegration(f.ctx, { service: 'EINVOICE', mode: 'LIVE', providerName: 'My GSP', apiBaseUrl: 'https://example.invalid/api', timeoutMs: 5000, maxRetries: 2 })
    const svc = new EInvoiceService(undefined, noSleep) // default resolver reads the company setting
    expect(svc.providerFor(f.ctx)).toBeInstanceOf(LiveEInvoiceProvider)
    await expect(svc.generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(50) }, NOW)).rejects.toThrow(/No authorised IRP\/GSP adapter is installed/)
    const rec = svc.list(f.ctx)[0]
    expect(rec).toMatchObject({ status: 'FAILED', irn: null, environment: 'LIVE', isDemo: false, errorCode: 'LIVE_ADAPTER_NOT_INSTALLED', attempts: 1 }) // NOT_CONFIGURED is not retried
    expect(integrationOverview(f.ctx).settings.find((s) => s.service === 'EINVOICE')).toMatchObject({ mode: 'LIVE', connected: false })
  })
})

describe('integration security', () => {
  const fake: SecretCipher = { isAvailable: () => true, encrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'), decrypt: (b) => b.toString('utf8').split('').reverse().join('') }
  it('stores credentials only encrypted, never returns them and refuses without secure storage', () => {
    const f = p4Fixture({ withDocs: false })
    expect(() => saveCredentials(f.ctx, { service: 'EINVOICE', environment: 'SANDBOX', username: 'apiuser', password: 'S3cret!' }, undefined)).toThrow(/not available/)
    const ov = saveCredentials(f.ctx, { service: 'EINVOICE', environment: 'SANDBOX', username: 'apiuser', password: 'S3cret!', clientSecret: 'cs-123' }, fake)
    expect(ov.credentials.find((c) => c.service === 'EINVOICE' && c.environment === 'SANDBOX')).toMatchObject({ stored: true, usernameHint: 'ap***r' })
    expect(JSON.stringify(ov)).not.toMatch(/S3cret|cs-123|apiuser/)
    const blob = f.db.prepare('SELECT secret_blob FROM integration_credentials').pluck().get() as Buffer
    expect(blob.toString('utf8')).not.toContain('S3cret!')
    expect(readCredentials(f.ctx, 'EINVOICE', 'SANDBOX', fake)).toMatchObject({ username: 'apiuser', password: 'S3cret!', clientSecret: 'cs-123' })
    const audit = JSON.stringify(f.db.prepare(`SELECT summary, details_json FROM audit_logs WHERE action = 'CREDENTIALS_UPDATE'`).all())
    expect(audit).not.toMatch(/S3cret|cs-123/)
    expect(scrub('auth failed: password=hunter2 token: abc.def')).toBe('auth failed: password=[REDACTED] token=[REDACTED]')
  })
  it('keeps the API log append-only', async () => {
    const f = p4Fixture()
    await new EInvoiceService(() => new MockEInvoiceProvider(), noSleep).generate(f.ctx, { documentKind: 'SALES_INVOICE', documentId: f.inv.A.id, requestKey: key(60) }, NOW)
    expect(() => f.db.prepare(`UPDATE api_requests SET outcome = 'FAILED'`).run()).toThrow(/append-only/)
    expect(() => f.db.prepare(`DELETE FROM api_requests`).run()).toThrow(/append-only/)
  })
})

describe('e-way bill workflow (DEMO provider)', () => {
  /** Unparsed form values; the service receives them as the router would after validation. */
  const body = (over: Record<string, unknown> = {}) => ({ transportMode: 'ROAD', transporterId: null, transportDocNo: null, transportDocDate: null, vehicleNo: 'TN09AB1234', vehicleType: 'REGULAR', distanceKm: 250, ...over }) as EwbGenerateInputT
  it('validates fields: vehicle number, distance, transport document and source', () => {
    expect(EwbGenerateInput.safeParse({ salesInvoiceId: 1, transportMode: 'ROAD', vehicleNo: 'TN 09 AB 1234', distanceKm: 10 }).success).toBe(true)
    expect(EwbGenerateInput.safeParse({ salesInvoiceId: 1, transportMode: 'ROAD', vehicleNo: 'XYZ', distanceKm: 10 }).success).toBe(false)
    expect(EwbGenerateInput.safeParse({ salesInvoiceId: 1, transportMode: 'ROAD', vehicleNo: 'TN09AB1234', distanceKm: 4001 }).success).toBe(false)
    expect(EwbGenerateInput.safeParse({ salesInvoiceId: 1, transportMode: 'RAIL', vehicleNo: null, distanceKm: 100 }).success).toBe(false) // RR number needed
    expect(EwbGenerateInput.safeParse({ transportMode: 'ROAD', vehicleNo: 'TN09AB1234', distanceKm: 100 }).success).toBe(false) // no source
    expect(EwbGenerateInput.safeParse({ salesInvoiceId: 1, sourceKind: 'DELIVERY_CHALLAN', sourceId: 1, transportMode: 'ROAD', vehicleNo: 'TN09AB1234', distanceKm: 100 }).success).toBe(false) // ambiguous
  })

  it('decides applicability from the configured rule and computes validity by distance', () => {
    const g = p4Fixture({ withDocs: false })
    const r = rules(g.ctx)
    expect(ewbRequirement({ goodsValuePaise: R(60000), consignmentValuePaise: R(60000), hasGoods: true, rules: r }).requirement).toBe('REQUIRED')
    expect(ewbRequirement({ goodsValuePaise: R(60000), consignmentValuePaise: R(40000), hasGoods: true, rules: r }).requirement).toBe('NOT_REQUIRED')
    expect(ewbRequirement({ goodsValuePaise: 0, consignmentValuePaise: 0, hasGoods: false, rules: r }).requirement).toBe('NOT_APPLICABLE')
    // 06:30 UTC = 12:00 IST on 14 Nov; 250 km at 200 km/day = 2 days → ends 23:59:59 IST on 16 Nov.
    expect(ewbValidUntil(NOW.toISOString(), 250, 200)).toBe('2026-11-16T18:29:59.000Z')
    expect(ewbValidUntil(NOW.toISOString(), 20, 20)).toBe('2026-11-15T18:29:59.000Z')
    expect(canExtendAt('2026-11-16T18:29:59.000Z', new Date('2026-11-16T12:00:00Z'), 8)).toBe(true)
    expect(canExtendAt('2026-11-16T18:29:59.000Z', new Date('2026-11-17T03:00:00Z'), 8)).toBe(false)
  })

  it('runs Part A → Part B, vehicle and transporter updates, extension, status and cancellation', async () => {
    const f = p4Fixture()
    const svc = new EwayBillService(new MockEwayBillProvider(), noSleep)
    const t1 = saveTransporter(f.ctx, TransporterSaveInput.parse({ name: 'Road Kings', transporterId: buildGstin('33', 'AABCR5555Q'), modes: ['ROAD'] }))[0]
    const t2 = saveTransporter(f.ctx, TransporterSaveInput.parse({ name: 'Rail Freight Co', transporterId: '33TRANSIN12345Z', modes: ['RAIL', 'ROAD'] })).find((t) => t.name === 'Rail Freight Co')!
    expect(t2.idType).toBe('TRANSIN')
    const pv = svc.preview(f.ctx, 'SALES_INVOICE', f.inv.A.id, NOW)
    expect(pv.errors).toEqual([])
    expect(pv.partA).toMatchObject({ documentType: 'TAX_INVOICE', subSupplyType: 'SUPPLY', from: expect.objectContaining({ pincode: '600002' }), to: expect.objectContaining({ pincode: '600020' }) })
    // Part A only (no vehicle, transporter given).
    const a = await svc.generate(f.ctx, { ...body({ vehicleNo: null, transporterId: t1.id }), sourceKind: 'SALES_INVOICE', sourceId: f.inv.A.id, requestKey: key(70) }, NOW)
    expect(a).toMatchObject({ status: 'PART_A_ONLY', validUpto: null, isDemo: true, sourceKind: 'SALES_INVOICE', canCancel: true })
    expect(a.ewbNo).toMatch(/^DEMO\d{10}$/)
    // Part B: validity starts from the first Part B.
    const b = await svc.updatePartB(f.ctx, { id: a.id, transportMode: 'ROAD', vehicleNo: 'TN09AB1234', transportDocNo: null, reason: 'FIRST_TIME', remarks: null }, NOW)
    expect(b).toMatchObject({ status: 'ACTIVE', vehicleNo: 'TN09AB1234', validUpto: '2026-11-16T18:29:59.000Z' })
    // Vehicle change does not extend validity.
    const later = new Date(NOW.getTime() + 5 * 3600000)
    const c = await svc.updatePartB(f.ctx, { id: a.id, transportMode: 'ROAD', vehicleNo: 'KA05MN4321', transportDocNo: null, reason: 'BREAKDOWN', remarks: 'Axle' }, later)
    expect(c).toMatchObject({ vehicleNo: 'KA05MN4321', validUpto: b.validUpto })
    const d = await svc.updateTransporter(f.ctx, { id: a.id, transporterId: t2.id }, later)
    expect(d).toMatchObject({ transporterName: 'Rail Freight Co' })
    await expect(svc.updateTransporter(f.ctx, { id: a.id, transporterId: t2.id }, later)).rejects.toThrow(/already assigned/)
    // Extension only within the window around expiry.
    const ext = { id: a.id, reasonCode: 3, remarks: 'Transshipment delay', currentPlace: 'Salem', currentStateCode: '33', remainingDistanceKm: 150, transportMode: 'ROAD' as const, vehicleNo: 'KA05MN4321' }
    await expect(svc.extend(f.ctx, ext, later)).rejects.toThrow(/within 8 hours/)
    const nearExpiry = new Date(Date.parse(b.validUpto!) - 2 * 3600000)
    const e = await svc.extend(f.ctx, ext, nearExpiry)
    expect(e).toMatchObject({ extensionCount: 1, status: 'ACTIVE', validUpto: '2026-11-17T18:29:59.000Z' })
    expect(e.history.map((h) => h.event)).toEqual(['GENERATED', 'PART_B_UPDATED', 'PART_B_UPDATED', 'TRANSPORTER_UPDATED', 'VALIDITY_EXTENDED'])
    // Expiry monitoring and status lookup.
    const afterExpiry = new Date(Date.parse(e.validUpto!) + 3600000)
    expect(svc.get(f.ctx, a.id, afterExpiry)).toMatchObject({ status: 'EXPIRED', canExtend: true })
    expect(svc.list(f.ctx, { expiringWithinHours: 3 }, nearExpiry).map((x) => x.id)).toEqual([])
    expect(svc.list(f.ctx, { expiringWithinHours: 30 }, nearExpiry).map((x) => x.id)).toEqual([a.id])
    expect((await svc.status(f.ctx, a.id, afterExpiry)).providerStatus).toBe('EXPIRED')
    await expect(svc.updatePartB(f.ctx, { id: a.id, transportMode: 'ROAD', vehicleNo: 'TN09AB1234', transportDocNo: null, reason: 'OTHERS', remarks: null }, afterExpiry)).rejects.toThrow(/expired/)
    // Cancellation only within the window after generation.
    await expect(svc.cancel(f.ctx, { id: a.id, reasonCode: 3, remarks: 'Too late' }, new Date(NOW.getTime() + 25 * 3600000))).rejects.toThrow(/within 24 hours/)
    const x = await svc.cancel(f.ctx, { id: a.id, reasonCode: 3, remarks: 'Data entry mistake' }, later)
    expect(x).toMatchObject({ status: 'CANCELLED', canCancel: false })
    await expect(svc.cancel(f.ctx, { id: a.id, reasonCode: 3, remarks: 'again' }, later)).rejects.toThrow(/already cancelled/)
    const { html } = svc.printHtml(f.ctx, a.id)
    expect(html).toContain('DEMO E-WAY BILL')
    expect(html).toContain('NOT a government-issued e-way bill')
  })

  it('prevents duplicates and supports delivery challans with masters and transport documents', async () => {
    const f = p4Fixture()
    const svc = new EwayBillService(new MockEwayBillProvider(), noSleep)
    const first = await svc.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.A.id, requestKey: key(80) }, NOW)
    expect((await svc.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.A.id, requestKey: key(80) }, NOW)).id).toBe(first.id)
    await expect(svc.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.A.id, requestKey: key(81) }, NOW)).rejects.toThrow(/active e-way bill already exists/)
    await expect(svc.generate(f.ctx, { ...body() , salesInvoiceId: f.inv.A.id }, NOW)).rejects.toThrow(/already exists/) // Phase 1 callers without a key
    expect(f.db.prepare('SELECT COUNT(*) n FROM ewaybill_records').get()).toEqual({ n: 1 })
    // Services-only invoices have no e-way bill.
    expect(svc.preview(f.ctx, 'SALES_INVOICE', f.inv.B.id, NOW).errors.join()).toMatch(/no goods/)
    // Delivery challan with a vehicle and LR from the masters.
    const so = f.post(f.save({ kind: 'SALES_ORDER', partyId: f.c.b2bInter, date: '2026-11-01', lines: [{ productId: f.p.widget, qtyMilli: toMilli(3), ratePaise: R(1000) }] }))
    const dc = postDocument(f.ctx, 'DELIVERY_CHALLAN', convertDocument(f.ctx, 'SALES_ORDER', so.id, 'DELIVERY_CHALLAN', { date: '2026-11-02', warehouseId: f.wh }).id)
    const veh = saveVehicle(f.ctx, VehicleSaveInput.parse({ vehicleNo: 'tn-01-cd-5678', vehicleType: 'ODC', bodyType: 'TRAILER', isOwn: true }))[0]
    expect(veh.vehicleNo).toBe('TN01CD5678')
    const lr = saveTransportDoc(f.ctx, { transportMode: 'ROAD', docNo: 'LR-1', docDate: '2026-11-02', vehicleId: veh.id, sourceKind: 'DELIVERY_CHALLAN', sourceId: dc.id, fromPlace: 'Chennai', toPlace: 'Bengaluru', distanceKm: 40, notes: null, transporterId: null })[0]
    expect(listTransportDocs(f.ctx, { sourceKind: 'DELIVERY_CHALLAN', sourceId: dc.id }).map((d) => d.docNo)).toEqual(['LR-1'])
    const ewb = await svc.generate(f.ctx, { ...body({ vehicleNo: null }), sourceKind: 'DELIVERY_CHALLAN', sourceId: dc.id, vehicleId: veh.id, transportDocumentId: lr.id, requestKey: key(82) }, NOW)
    expect(ewb).toMatchObject({ documentType: 'DELIVERY_CHALLAN', subSupplyType: 'OTHERS', vehicleNo: 'TN01CD5678', vehicleType: 'ODC', transportDocNo: 'LR-1', vehicleId: veh.id })
    expect(ewb.validUpto).toBe(ewbValidUntil(NOW.toISOString(), 250, 20)) // ODC: 20 km/day
    expect(listTransportDocs(f.ctx)[0].ewbNo).toBe(ewb.ewbNo)
    expect(() => cancelDocument(f.ctx, 'DELIVERY_CHALLAN', dc.id, 'x')).toThrow(/e-way bill/)
    expect(svc.sources(f.ctx, '2026-10-01', '2026-11-14').find((s) => s.kind === 'DELIVERY_CHALLAN')).toMatchObject({ activeEwbNo: ewb.ewbNo, transportDocs: 1 })
  })

  it('classifies provider errors and retries only transient ones; live mode refuses', async () => {
    const f = p4Fixture()
    const mock = new MockEwayBillProvider()
    const svc = new EwayBillService(mock, noSleep)
    mock.faults.push('RATE_LIMIT')
    const ok = await svc.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.A.id, requestKey: key(90) }, NOW)
    expect(ok.status).toBe('ACTIVE')
    expect(apiLog(f.ctx, { service: 'EWAYBILL' }).map((r) => [r.attempt, r.outcome, r.errorClass])).toEqual([[2, 'SUCCESS', null], [1, 'FAILED', 'RATE_LIMIT']])
    mock.faults.push('AUTH')
    await expect(svc.status(f.ctx, ok.id, NOW)).rejects.toThrow(/FAILED \(auth\)/)
    expect(svc.get(f.ctx, ok.id).providerStatus).toBeNull() // nothing recorded as checked
    // A consignee without PIN code is a validation failure (not retried, nothing created).
    f.db.prepare('UPDATE customers SET pincode = NULL WHERE id = ?').run(f.c.b2bIntra)
    await expect(svc.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.H.id, requestKey: key(91) }, NOW)).rejects.toThrow(/Consignee PIN code/)
    const live = new EwayBillService(new LiveEwayBillProvider('LIVE', null), noSleep)
    f.db.prepare(`UPDATE customers SET pincode = '600020' WHERE id = ?`).run(f.c.b2bIntra)
    await expect(live.generate(f.ctx, { ...body(), salesInvoiceId: f.inv.H.id, requestKey: key(92) }, NOW)).rejects.toThrow(/FAILED \(not configured\).*Nothing was generated/)
    expect(f.db.prepare('SELECT COUNT(*) n FROM ewaybill_records WHERE sales_invoice_id = ?').get(f.inv.H.id)).toEqual({ n: 0 })
  })
})

describe('transport masters', () => {
  it('validates transporter IDs, vehicles and links', () => {
    const f = p4Fixture({ withDocs: false })
    expect(TransporterSaveInput.safeParse({ name: 'X Carriers', transporterId: '33AABCR5555Q1ZX', modes: ['ROAD'] }).success).toBe(false) // GSTIN-shaped with a bad check digit
    expect(TransporterSaveInput.safeParse({ name: 'X Carriers', transporterId: 'SHORT', modes: ['ROAD'] }).success).toBe(false)
    expect(TransporterSaveInput.safeParse({ name: 'X Carriers', transporterId: buildGstin('29', 'AABCX1111Q'), modes: [] }).success).toBe(false)
    expect(VehicleSaveInput.safeParse({ vehicleNo: '1234', vehicleType: 'REGULAR', bodyType: 'TRUCK', isOwn: true }).success).toBe(false)
    const t = saveTransporter(f.ctx, TransporterSaveInput.parse({ name: 'X Carriers', transporterId: buildGstin('29', 'AABCX1111Q'), modes: ['ROAD'] }))[0]
    expect(() => saveVehicle(f.ctx, VehicleSaveInput.parse({ vehicleNo: 'KA01AB1111', vehicleType: 'REGULAR', bodyType: 'TRUCK', isOwn: true, transporterId: t.id }))).toThrow(/own vehicle/)
    expect(() => saveTransportDoc(f.ctx, { transportMode: 'ROAD', docNo: 'LR-9', docDate: '2026-11-01', transporterId: null, vehicleId: null, sourceKind: null, sourceId: null, fromPlace: null, toPlace: null, distanceKm: null, notes: null })).toThrow(/vehicle or a transporter/)
    expect(() => saveTransportDoc(f.ctx, { transportMode: 'RAIL', docNo: 'RR-1', docDate: '2026-11-01', transporterId: t.id, vehicleId: null, sourceKind: 'SALES_INVOICE', sourceId: 99999, fromPlace: null, toPlace: null, distanceKm: null, notes: null })).toThrow(/posted/)
    saveSettings(f.ctx, { aatoPaise: null, aatoFy: null, einvoiceEnabled: false, einvoiceExemptReason: null, returnFrequency: 'MONTHLY', lutNumber: null, lutValidFrom: null, lutValidUpto: null })
  })
})

describe('provider runner', () => {
  it('classifies unknown errors and does not retry non-transient failures', async () => {
    const f = p4Fixture({ withDocs: false })
    let calls = 0
    const r = await callProvider(f.ctx, { service: 'GST_RETURNS', provider: 'T', environment: 'DEMO', operation: 'X', entityType: 't', entityId: null, requestKey: key(99), summary: 'password=abc', timeoutMs: 1000, maxRetries: 3 }, async () => { calls++; throw new ProviderError('AUTH', 'BAD_LOGIN', 'Invalid token: xyz') }, noSleep)
    expect(calls).toBe(1)
    expect(r.ok).toBe(false)
    const row = apiLog(f.ctx)[0]
    expect(row).toMatchObject({ outcome: 'FAILED', errorClass: 'AUTH', retryable: false, requestSummary: 'password=[REDACTED]' })
    expect(row.errorMessage).not.toContain('xyz')
    void saveDraft
    void DocumentSaveInput
  })
})
