/**
 * Development-only Phase 4 end-to-end check (`--e2e-gst`): drives the REAL renderer through
 * the preload bridge and IPC. As the accountant: GST registers reconcile with the ledgers,
 * validation passes, GSTR-1 / GSTR-3B are prepared (never filed), a DEMO IRN is generated
 * once despite a resubmission, a DEMO e-way bill runs Part A → transporter change → cancel.
 * As the admin: live mode fails safely and is recorded as a failure. As the auditor: read-only.
 * The main side renders the DEMO e-invoice and e-way bill to real PDFs and the GSTR-3B to .xlsx.
 * Prints `E2E_GST_RESULT {json}` and exits.
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReportDoc } from '@shared/finance'
import type { PrintingDeps } from './ipc/routes'
import { reportToXlsx } from './services/reports/xlsx'

const FLOW = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const inv = async (ch, input) => {
    const r = await call(ch, input)
    if (!r.ok) throw new Error(ch + ': ' + r.error.message + ' ' + JSON.stringify(r.error.fieldErrors || {}))
    return r.data
  }
  const out = {}
  const today = new Date().toISOString().slice(0, 10)
  const period = today.slice(0, 7)
  const monthFrom = period + '-01'
  const uuid = () => crypto.randomUUID()
  await inv('auth:login', { username: 'accounts', password: 'Accounts@123' })
  const periods = await inv('finance:periods')
  const fy = periods.years.find((y) => y.fy === periods.currentFy)
  const sales = await inv('gst:salesRegister', { from: fy.from, to: today })
  const purchases = await inv('gst:purchaseRegister', { from: fy.from, to: today })
  out.salesAgreesWithLedger = sales.ledger.agrees
  out.purchasesAgreeWithLedger = purchases.ledger.agrees
  out.sections = Object.keys(sales.bySection).sort()
  const v = await inv('gst:validate', { from: monthFrom, to: today })
  out.validationErrors = v.errors
  out.validationErrorList = v.issues.filter((i) => i.severity === 'ERROR').slice(0, 5).map((i) => i.number + ': ' + i.message)
  const g1 = await inv('gst:prepare', { returnType: 'GSTR1', period })
  const g3 = await inv('gst:prepare', { returnType: 'GSTR3B', period })
  out.preparedStatuses = [g1.status, g3.status]
  out.anyFiledWording = /"FILED"|status":"FILED/.test(JSON.stringify([g1, g3]))
  out.g3Doc = await inv('gst:previewPreparation', { id: g3.id })

  // E-invoice: one IRN for a resubmitted request; a second request for the same document is refused.
  const from25 = new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10)
  const ws = await inv('einvoice:workspace', { from: from25, to: today })
  out.einvoiceIsDemo = ws.isDemo
  const ready = ws.candidates.filter((c) => c.eligibility.applicable && !c.einvoice && c.validation.length === 0)
  out.readyCandidates = ready.length
  const target = ready[0]
  const key = uuid()
  const e1 = await inv('einvoice:generate', { documentKind: target.documentKind, documentId: target.documentId, requestKey: key })
  const e2 = await inv('einvoice:generate', { documentKind: target.documentKind, documentId: target.documentId, requestKey: key })
  const dup = await call('einvoice:generate', { documentKind: target.documentKind, documentId: target.documentId, requestKey: uuid() })
  out.einvoiceIdempotent = e1.id === e2.id && e1.irn === e2.irn
  out.einvoiceDuplicateRefused = dup.ok === false && /already has an e-invoice/.test(dup.error.message)
  out.irnIsDemo = /^DEMO-/.test(e1.irn) && e1.signedQr === null && e1.isDemo === true
  out.einvoiceId = e1.id
  out.einvoiceHtml = (await inv('einvoice:printHtml', { id: e1.id })).html

  // E-way bill for a source without one: Part A only, then transporter change, status and cancel.
  const sources = await inv('ewaybill:sources', { from: fy.from, to: today })
  const src = sources.find((s) => !s.activeEwbNo && s.kind === 'SALES_INVOICE')
  const masters = await inv('transport:masters')
  const tr = masters.transporters.filter((t) => t.isActive)
  const pv = await inv('ewaybill:preview', { kind: src.kind, id: src.id })
  out.ewbPreviewErrors = pv.errors
  const ekey = uuid()
  const body = { sourceKind: src.kind, sourceId: src.id, requestKey: ekey, transportMode: 'ROAD', transporterId: tr[0].id, vehicleNo: null, vehicleType: 'REGULAR', transportDocNo: null, transportDocDate: null, distanceKm: 120 }
  const w1 = await inv('ewaybill:generate', body)
  const w2 = await inv('ewaybill:generate', body)
  out.ewbIdempotent = w1.id === w2.id
  out.ewbPartAOnly = w1.status === 'PART_A_ONLY' && /^DEMO/.test(w1.ewbNo)
  const w3 = await inv('ewaybill:updateTransporter', { id: w1.id, transporterId: tr[1].id })
  out.ewbTransporterChanged = w3.transporterId === tr[1].id
  const w4 = await inv('ewaybill:updatePartB', { id: w1.id, transportMode: 'ROAD', vehicleNo: 'TN01CD5678', transportDocNo: null, reason: 'FIRST_TIME', remarks: null })
  out.ewbActiveAfterPartB = w4.status === 'ACTIVE' && !!w4.validUpto
  const w5 = await inv('ewaybill:status', { id: w1.id })
  out.ewbStatus = w5.providerStatus
  out.ewbHtml = (await inv('ewaybill:printHtml', { id: w1.id })).html
  const w6 = await inv('ewaybill:cancel', { id: w1.id, reasonCode: 3, remarks: 'E2E data entry check' })
  out.ewbCancelled = w6.status === 'CANCELLED'
  const integrationDenied = await call('integration:save', { service: 'EINVOICE', mode: 'LIVE', providerName: 'x', apiBaseUrl: 'https://x.invalid', timeoutMs: 5000, maxRetries: 1 })
  out.accountantIntegrationForbidden = integrationDenied.ok === false && integrationDenied.error.code === 'FORBIDDEN'
  await inv('auth:logout')

  // Admin: live mode without an adapter fails safely and is recorded as failed (never success).
  await inv('auth:login', { username: 'admin', password: 'Admin@123' })
  await inv('integration:save', { service: 'EINVOICE', mode: 'LIVE', providerName: 'E2E GSP', apiBaseUrl: 'https://example.invalid/api', timeoutMs: 5000, maxRetries: 1 })
  // The DEMO data holds one request that failed at the provider; retrying it in LIVE mode must fail too.
  const seededFailed = (await inv('einvoice:list', { status: 'FAILED' }))[0]
  const live = await call('einvoice:retry', { id: seededFailed.id })
  out.liveRefused = live.ok === false && /No authorised IRP\\/GSP adapter/.test(live.error.message)
  const failed = await inv('einvoice:get', { id: seededFailed.id })
  out.liveRecordedFailed = failed.status === 'FAILED' && failed.irn === null && failed.environment === 'LIVE' && failed.apiRequests.some((a) => a.errorClass === 'NOT_CONFIGURED')
  await inv('integration:save', { service: 'EINVOICE', mode: 'DEMO', providerName: null, apiBaseUrl: null, timeoutMs: 30000, maxRetries: 2 })
  const retried = await inv('einvoice:retry', { id: failed.id })
  out.retryAfterDemoGenerated = retried.status === 'GENERATED' && /^DEMO-/.test(retried.irn)
  await inv('auth:logout')

  // Auditor: read-only.
  await inv('auth:login', { username: 'auditor', password: 'Auditor@123' })
  await inv('gst:gstr3b', { period })
  const ap = await call('gst:prepare', { returnType: 'GSTR1', period })
  const ag = await call('einvoice:cancel', { id: e1.id, reasonCode: 2, remarks: 'auditor attempt' })
  out.auditorForbidden = ap.ok === false && ap.error.code === 'FORBIDDEN' && ag.ok === false && ag.error.code === 'FORBIDDEN'
  const checks = await inv('audit:integrity')
  out.integrityAllOk = checks.allOk
  out.failedChecks = checks.checks.filter((c) => !c.ok).map((c) => c.label + ': ' + c.detail)
  await inv('auth:logout')
  return out
})()`

export async function runGstE2E(win: BrowserWindow, printing: PrintingDeps, outDir: string): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  await new Promise((r) => setTimeout(r, 1200))
  const r = (await win.webContents.executeJavaScript(FLOW)) as Record<string, unknown> & { g3Doc: ReportDoc; einvoiceHtml: string; ewbHtml: string }
  const { g3Doc, einvoiceHtml, ewbHtml, ...rest } = r
  const einvPdf = await printing.toPdf(einvoiceHtml)
  const einvoicePdfPath = join(outDir, 'e2e-demo-einvoice.pdf')
  writeFileSync(einvoicePdfPath, einvPdf)
  const ewbPdf = await printing.toPdf(ewbHtml)
  const ewbPdfPath = join(outDir, 'e2e-demo-ewaybill.pdf')
  writeFileSync(ewbPdfPath, ewbPdf)
  const xlsx = reportToXlsx(g3Doc)
  const gstr3bXlsxPath = join(outDir, 'e2e-gstr3b-prepared.xlsx')
  writeFileSync(gstr3bXlsxPath, xlsx)
  const out: Record<string, unknown> = {
    ...rest,
    einvoiceHtmlDemo: einvoiceHtml.includes('DEMO E-INVOICE — NOT A LEGALLY REGISTERED E-INVOICE') && einvoiceHtml.includes('NO QR CODE'),
    ewbHtmlDemo: ewbHtml.includes('NOT a government-issued e-way bill'),
    g3Subtitle: g3Doc.subtitle,
    einvoicePdfHeader: einvPdf.subarray(0, 5).toString('latin1'), einvoicePdfPath, einvoicePdfBytes: einvPdf.length,
    ewbPdfHeader: ewbPdf.subarray(0, 5).toString('latin1'), ewbPdfPath,
    xlsxHeader: xlsx.subarray(0, 2).toString('latin1'), gstr3bXlsxPath
  }
  const pass =
    out.salesAgreesWithLedger === true && out.purchasesAgreeWithLedger === true && out.validationErrors === 0 && out.anyFiledWording === false &&
    JSON.stringify(out.preparedStatuses) === '["PREPARED","PREPARED"]' && out.einvoiceIsDemo === true && out.einvoiceIdempotent === true && out.einvoiceDuplicateRefused === true &&
    out.irnIsDemo === true && out.ewbIdempotent === true && out.ewbPartAOnly === true && out.ewbTransporterChanged === true && out.ewbActiveAfterPartB === true &&
    out.ewbStatus === 'ACTIVE' && out.ewbCancelled === true && out.accountantIntegrationForbidden === true && out.liveRefused === true && out.liveRecordedFailed === true &&
    out.retryAfterDemoGenerated === true && out.auditorForbidden === true && out.integrityAllOk === true && out.einvoiceHtmlDemo === true && out.ewbHtmlDemo === true &&
    out.einvoicePdfHeader === '%PDF-' && out.ewbPdfHeader === '%PDF-' && out.xlsxHeader === 'PK' && /NOT FILED/.test(String(out.g3Subtitle))
  return { pass, result: out }
}
