/**
 * E-invoice workflow: eligibility → document validation → IRN request → (cancel).
 *
 * Duplicate prevention, in layers:
 *  1. Request key: resubmitting the same request returns the existing record.
 *  2. One live (PENDING/GENERATED) e-invoice per document — enforced by a unique index.
 *  3. After a timeout, the provider is asked whether the IRN was created before anything is re-sent.
 *  4. A provider "duplicate" response is resolved by fetching the IRN already registered.
 * A failure is stored as FAILED and reported as a failure; it is never shown as success.
 */
import { docRoute, type DocumentDetail } from '@shared/documents'
import { eInvoiceEligibility, type EInvoiceCandidate, type EInvoiceDetail, type EInvoiceEligibility, type EInvoiceRow, type EInvoiceWorkspace, IRN_CANCEL_REASONS } from '@shared/gst'
import { formatINR } from '@shared/money'
import { writeAudit } from '../audit'
import { bool, type ServiceContext } from '../context'
import { AppError, businessRule, conflict, notFound } from '../errors'
import { loadDocument } from '../documents/store'
import { buildDocumentHtml } from '../documents/print'
import { getSettings, primaryGstin, rulesAt, todayIso } from '../gst/config'
import { callProvider, type ProviderError } from '../integrations/runner'
import { apiLog, integrationSetting } from '../integrations/settings'
import { LiveEInvoiceProvider, MockEInvoiceProvider, type EInvoicePayload, type EInvoiceProvider, type IrnResult } from './provider'

type Kind = 'SALES_INVOICE' | 'CREDIT_NOTE' | 'SALES_RETURN'
type Row = Record<string, unknown>

const sharedMock = new MockEInvoiceProvider()
/** Provider for the company's configured mode (DEMO → mock; SANDBOX/LIVE → placeholder that refuses). */
export function defaultEInvoiceProvider(ctx: ServiceContext): EInvoiceProvider {
  const s = integrationSetting(ctx, 'EINVOICE')
  return s.mode === 'DEMO' ? sharedMock : new LiveEInvoiceProvider(s.mode, s.providerName)
}

const toRow = (r: Row): EInvoiceRow => ({
  id: r.id as number, documentKind: r.document_kind as string, documentId: r.document_id as number, documentNo: r.document_no as string, documentDate: r.document_date as string,
  documentType: r.document_type as string, supplyType: r.supply_type as string, buyerName: (r.buyer_name as string | null) ?? null, buyerGstin: r.buyer_gstin as string | null,
  totalValuePaise: r.total_value_paise as number, provider: r.provider as string, environment: r.environment as string, isDemo: bool(r.is_demo), status: r.status as EInvoiceRow['status'],
  irn: r.irn as string | null, ackNo: r.ack_no as string | null, ackDate: r.ack_date as string | null, errorCode: r.error_code as string | null, errorMessage: r.error_message as string | null,
  attempts: r.attempts as number, lastAttemptAt: r.last_attempt_at as string | null, cancelledAt: r.cancelled_at as string | null, createdAt: r.created_at as string,
  route: docRoute(r.document_kind as Kind, r.document_id as number)
})
const SELECT = `SELECT e.*, c.name AS buyer_name FROM einvoices e
  LEFT JOIN sales_invoices si ON e.document_kind = 'SALES_INVOICE' AND si.id = e.document_id
  LEFT JOIN trade_documents td ON e.document_kind <> 'SALES_INVOICE' AND td.id = e.document_id
  LEFT JOIN customers c ON c.id = COALESCE(si.customer_id, td.customer_id)`

export class EInvoiceService {
  constructor(private readonly resolve: (ctx: ServiceContext) => EInvoiceProvider = defaultEInvoiceProvider, private readonly opts: { sleep?: (ms: number) => Promise<void> } = {}) {}

  providerFor(ctx: ServiceContext): EInvoiceProvider {
    return this.resolve(ctx)
  }

  list(ctx: ServiceContext, f: { from?: string; to?: string; status?: string } = {}): EInvoiceRow[] {
    const where = ['e.company_id = ?']
    const args: unknown[] = [ctx.companyId]
    if (f.from) { where.push('e.document_date >= ?'); args.push(f.from) }
    if (f.to) { where.push('e.document_date <= ?'); args.push(f.to) }
    if (f.status) { where.push('e.status = ?'); args.push(f.status) }
    return (ctx.db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.id DESC`).all(...args) as Row[]).map(toRow)
  }

  get(ctx: ServiceContext, id: number, now = new Date()): EInvoiceDetail {
    const r = ctx.db.prepare(`${SELECT} WHERE e.id = ? AND e.company_id = ?`).get(id, ctx.companyId) as Row | undefined
    if (!r) throw notFound('E-invoice')
    const row = toRow(r)
    const hours = rulesAt(ctx, todayIso()).IRN_CANCEL_WINDOW_HOURS
    const deadline = row.ackDate ? new Date(Date.parse(row.ackDate) + hours * 3600000).toISOString() : null
    return {
      ...row, requestKey: r.request_key as string, signedInvoice: r.signed_invoice as string | null, signedQr: r.signed_qr as string | null, responseRef: r.response_ref as string | null,
      cancelReasonCode: r.cancel_reason_code as number | null, cancelRemarks: r.cancel_remarks as string | null,
      cancellable: row.status === 'GENERATED' && !!deadline && now.toISOString() <= deadline, cancelDeadline: deadline,
      history: JSON.parse(r.history_json as string), apiRequests: apiLog(ctx, { entityType: 'einvoice', entityId: id, limit: 100 })
    }
  }

  private doc(ctx: ServiceContext, kind: Kind, id: number): DocumentDetail {
    return loadDocument(ctx, kind, id)
  }

  eligibility(ctx: ServiceContext, kind: Kind, id: number, today = todayIso()): EInvoiceEligibility {
    const d = this.doc(ctx, kind, id)
    const s = getSettings(ctx)
    return eInvoiceEligibility({
      companyGstin: primaryGstin(ctx), einvoiceEnabled: s.einvoiceEnabled, exemptReason: s.einvoiceExemptReason, aatoPaise: s.aatoPaise,
      documentKind: kind, documentStatus: d.status, documentDate: d.date, partyRegType: d.partyRegistrationType, partyGstin: d.partyGstin,
      hasOriginalReference: !!d.source, today, rules: rulesAt(ctx, today)
    })
  }

  /** Builds the IRN request from the posted document, and lists anything that would be rejected. */
  payload(ctx: ServiceContext, kind: Kind, id: number): { payload: EInvoicePayload; errors: string[] } {
    const d = this.doc(ctx, kind, id)
    const company = ctx.db.prepare('SELECT * FROM companies WHERE id = ?').get(ctx.companyId) as Row
    const buyer = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(d.partyId) as Row
    const sellerGstin = primaryGstin(ctx)
    const errors: string[] = []
    const igst = d.igstPaise
    const supplyType = d.partyRegistrationType === 'OVERSEAS' ? (igst > 0 ? 'EXPWP' : 'EXPWOP') : d.partyRegistrationType === 'SEZ' ? (igst > 0 ? 'SEZWP' : 'SEZWOP') : 'B2B'
    const join = (...p: unknown[]) => p.filter(Boolean).join(', ')
    const payload: EInvoicePayload = {
      supplyType, documentType: kind === 'SALES_INVOICE' ? 'INV' : 'CRN', documentNo: d.number, documentDate: d.date, placeOfSupply: d.placeOfSupply,
      seller: { gstin: sellerGstin, legalName: (company.legal_name as string) ?? (company.name as string), address: join(company.address_line1, company.address_line2), place: (company.city as string) ?? '', pincode: company.pincode as string | null, stateCode: company.state_code as string },
      buyer: { gstin: d.partyGstin, legalName: buyer.name as string, address: join(buyer.address_line1, buyer.address_line2), place: (buyer.city as string) ?? '', pincode: buyer.pincode as string | null, stateCode: buyer.state_code as string },
      items: d.lines.map((l, i) => ({ slNo: i + 1, description: l.description ?? l.productName, hsn: l.hsnSac, isService: l.itemType === 'SERVICE', qtyMilli: l.qtyMilli, unit: l.unitCode, taxablePaise: l.taxablePaise, gstRateBps: l.taxRateBps, igstPaise: l.igstPaise, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, cessPaise: 0, totalPaise: l.totalPaise })),
      totals: { taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, cessPaise: 0, roundOffPaise: d.roundOffPaise, totalPaise: d.grandTotalPaise },
      precedingDocument: d.source ? { number: d.source.number, date: d.source.date } : null
    }
    if (!payload.seller.pincode) errors.push('Company PIN code is missing (Masters → Companies)')
    if (!payload.seller.address) errors.push('Company address is missing')
    if (!supplyType.startsWith('EXP')) {
      if (!payload.buyer.pincode) errors.push(`Buyer PIN code is missing for ${buyer.name as string}`)
      if (!payload.buyer.address) errors.push(`Buyer address is missing for ${buyer.name as string}`)
    }
    try {
      sharedMock.validate(payload)
    } catch (e) {
      errors.push((e as Error).message)
    }
    return { payload, errors }
  }

  workspace(ctx: ServiceContext, from: string, to: string, today = todayIso()): EInvoiceWorkspace {
    const s = integrationSetting(ctx, 'EINVOICE')
    const provider = this.resolve(ctx)
    const docs = [
      ...(ctx.db.prepare(`SELECT 'SALES_INVOICE' AS kind, si.id FROM sales_invoices si JOIN customers c ON c.id = si.customer_id WHERE si.company_id = ? AND si.status = 'POSTED' AND si.invoice_date BETWEEN ? AND ? AND (c.gstin IS NOT NULL OR c.gst_registration_type IN ('SEZ','OVERSEAS')) ORDER BY si.invoice_date DESC`).all(ctx.companyId, from, to) as Array<{ kind: Kind; id: number }>),
      ...(ctx.db.prepare(`SELECT td.doc_type AS kind, td.id FROM trade_documents td JOIN customers c ON c.id = td.customer_id WHERE td.company_id = ? AND td.doc_type IN ('CREDIT_NOTE','SALES_RETURN') AND td.status = 'POSTED' AND td.doc_date BETWEEN ? AND ? AND (c.gstin IS NOT NULL OR c.gst_registration_type IN ('SEZ','OVERSEAS')) ORDER BY td.doc_date DESC`).all(ctx.companyId, from, to) as Array<{ kind: Kind; id: number }>)
    ]
    const live = new Map((ctx.db.prepare(`SELECT id, document_kind, document_id, status, irn FROM einvoices WHERE company_id = ? ORDER BY id`).all(ctx.companyId) as Row[]).map((r) => [`${r.document_kind}:${r.document_id}`, { id: r.id as number, status: r.status as string, irn: r.irn as string | null }]))
    const candidates: EInvoiceCandidate[] = docs.map(({ kind, id }) => {
      const d = this.doc(ctx, kind, id)
      const el = this.eligibility(ctx, kind, id, today)
      const v = el.applicable ? this.payload(ctx, kind, id).errors : []
      return {
        documentKind: kind, documentId: id, documentNo: d.number, documentDate: d.date, buyerName: d.partyName ?? '', buyerGstin: d.partyGstin, partyRegType: d.partyRegistrationType ?? '',
        totalValuePaise: d.grandTotalPaise, route: docRoute(kind, id), eligibility: el, validation: v, einvoice: live.get(`${kind}:${id}`) ?? null
      }
    })
    const records = this.list(ctx)
    const counts: Record<string, number> = { PENDING: 0, GENERATED: 0, FAILED: 0, CANCELLED: 0 }
    for (const r of records) counts[r.status] += 1
    return { enabled: getSettings(ctx).einvoiceEnabled, mode: s.mode, provider: provider.id, isDemo: provider.isDemo, candidates, records, counts }
  }

  private history(id: number, ctx: ServiceContext): Array<{ at: string; event: string; detail: string }> {
    return JSON.parse((ctx.db.prepare('SELECT history_json h FROM einvoices WHERE id = ?').get(id) as { h: string }).h)
  }

  async generate(ctx: ServiceContext, input: { documentKind: Kind; documentId: number; requestKey: string }, now = new Date()): Promise<EInvoiceDetail> {
    const db = ctx.db
    const byKey = db.prepare('SELECT id, document_kind, document_id, status FROM einvoices WHERE company_id = ? AND request_key = ?').get(ctx.companyId, input.requestKey) as Row | undefined
    if (byKey) {
      if (byKey.document_kind !== input.documentKind || byKey.document_id !== input.documentId) throw conflict('This request key was already used for another document')
      return this.get(ctx, byKey.id as number, now) // same request resubmitted: no second IRN request
    }
    const live = db.prepare(`SELECT id, status, irn FROM einvoices WHERE company_id = ? AND document_kind = ? AND document_id = ? AND status IN ('PENDING','GENERATED')`).get(ctx.companyId, input.documentKind, input.documentId) as Row | undefined
    if (live) throw conflict(live.status === 'GENERATED' ? `This document already has an e-invoice (IRN ${live.irn as string})` : 'An IRN request for this document is already in progress')
    const el = this.eligibility(ctx, input.documentKind, input.documentId, now.toISOString().slice(0, 10))
    if (!el.applicable) throw businessRule(`Not eligible for e-invoicing: ${el.blockers.join(' · ')}`)
    const { payload, errors } = this.payload(ctx, input.documentKind, input.documentId)
    if (errors.length) throw businessRule(`Document validation failed: ${errors.join(' · ')}`)
    const provider = this.resolve(ctx)
    const setting = integrationSetting(ctx, 'EINVOICE')
    const id = Number(
      db.prepare(
        `INSERT INTO einvoices (company_id, document_kind, document_id, document_no, document_date, document_type, supply_type, seller_gstin, buyer_gstin, total_value_paise, provider, environment, is_demo, status, request_key, history_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
      ).run(ctx.companyId, input.documentKind, input.documentId, payload.documentNo, payload.documentDate, payload.documentType, payload.supplyType, payload.seller.gstin, payload.buyer.gstin,
        payload.totals.totalPaise, provider.id, provider.environment, provider.isDemo ? 1 : 0, input.requestKey, JSON.stringify([{ at: now.toISOString(), event: 'REQUESTED', detail: `${provider.isDemo ? 'DEMO ' : ''}IRN requested from ${provider.id}` }]), ctx.userId).lastInsertRowid
    )
    return this.send(ctx, id, provider, payload, input.requestKey, setting, now)
  }

  /** Re-sends a FAILED request with the same request key (the provider can recognise it). */
  async retry(ctx: ServiceContext, id: number, now = new Date()): Promise<EInvoiceDetail> {
    const r = ctx.db.prepare('SELECT * FROM einvoices WHERE id = ? AND company_id = ?').get(id, ctx.companyId) as Row | undefined
    if (!r) throw notFound('E-invoice')
    if (r.status !== 'FAILED') throw businessRule(`Only failed requests can be retried (this one is ${String(r.status).toLowerCase()})`)
    const live = ctx.db.prepare(`SELECT 1 FROM einvoices WHERE company_id = ? AND document_kind = ? AND document_id = ? AND status IN ('PENDING','GENERATED')`).get(ctx.companyId, r.document_kind, r.document_id)
    if (live) throw conflict('Another e-invoice for this document is already generated or in progress')
    const { payload, errors } = this.payload(ctx, r.document_kind as Kind, r.document_id as number)
    if (errors.length) throw businessRule(`Document validation failed: ${errors.join(' · ')}`)
    const provider = this.resolve(ctx)
    ctx.db.prepare(`UPDATE einvoices SET status = 'PENDING', provider = ?, environment = ?, is_demo = ?, error_code = NULL, error_message = NULL, history_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(provider.id, provider.environment, provider.isDemo ? 1 : 0, JSON.stringify([...this.history(id, ctx), { at: now.toISOString(), event: 'RETRY', detail: 'Request re-sent with the same request key' }]), id)
    return this.send(ctx, id, provider, payload, r.request_key as string, integrationSetting(ctx, 'EINVOICE'), now)
  }

  private async send(ctx: ServiceContext, id: number, provider: EInvoiceProvider, payload: EInvoicePayload, requestKey: string, setting: { timeoutMs: number; maxRetries: number }, now: Date): Promise<EInvoiceDetail> {
    const meta = { service: 'EINVOICE' as const, provider: provider.id, environment: provider.environment, operation: 'GENERATE_IRN', entityType: 'einvoice', entityId: id, requestKey, summary: `${payload.documentType} ${payload.documentNo} · ${formatINR(payload.totals.totalPaise)}`, timeoutMs: setting.timeoutMs, maxRetries: setting.maxRetries }
    const lookup = () => provider.getIrnByDocument(payload.seller.gstin!, payload.documentType, payload.documentNo, payload.documentDate)
    let res = await callProvider<IrnResult>(ctx, meta, () => provider.generateIrn(payload, requestKey, now), { reconcile: lookup, sleep: this.opts.sleep, responseRef: (v) => v.responseRef })
    let note = ''
    if (!res.ok && res.error.errorClass === 'DUPLICATE') {
      // The IRP already has this document: fetch its IRN instead of creating another.
      const found = await callProvider<IrnResult | null>(ctx, { ...meta, operation: 'GET_IRN_BY_DOCUMENT', maxRetries: 1 }, lookup, { sleep: this.opts.sleep })
      if (found.ok && found.value) {
        res = { ok: true, value: found.value, attempts: res.attempts + found.attempts, reconciled: true }
        note = ' (already registered; existing IRN retrieved)'
      }
    }
    const attempts = (ctx.db.prepare(`SELECT COUNT(*) n FROM api_requests WHERE entity_type = 'einvoice' AND entity_id = ? AND operation LIKE 'GENERATE_IRN%'`).get(id) as { n: number }).n
    const history = this.history(id, ctx)
    if (res.ok) {
      const v = res.value
      ctx.db.transaction(() => {
        ctx.db.prepare(`UPDATE einvoices SET status='GENERATED', irn=?, ack_no=?, ack_date=?, signed_invoice=?, signed_qr=?, response_ref=?, attempts=?, last_attempt_at=?, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(v.irn, v.ackNo, v.ackDate, v.signedInvoice, v.signedQr, v.responseRef, attempts, now.toISOString(), JSON.stringify([...history, { at: now.toISOString(), event: 'GENERATED', detail: `${provider.isDemo ? 'DEMO IRN (not registered with the IRP)' : 'IRN'} ${v.irn}${res.ok && res.reconciled ? ' — confirmed by status check' : ''}${note}` }]), id)
        writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EINVOICE_GENERATE', entityType: 'einvoice', entityId: id, summary: `${provider.isDemo ? 'DEMO ' : ''}IRN for ${payload.documentNo} (${formatINR(payload.totals.totalPaise)})${note}`, details: { provider: provider.id, ackNo: v.ackNo, attempts } })
      })()
      return this.get(ctx, id, now)
    }
    const err: ProviderError = res.error
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE einvoices SET status='FAILED', error_code=?, error_message=?, attempts=?, last_attempt_at=?, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(err.code, err.message, attempts, now.toISOString(), JSON.stringify([...history, { at: now.toISOString(), event: 'FAILED', detail: `${err.errorClass}: ${err.message}` }]), id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EINVOICE_FAILED', entityType: 'einvoice', entityId: id, summary: `IRN request for ${payload.documentNo} failed (${err.errorClass}): ${err.message}` })
    })()
    throw new AppError('BUSINESS_RULE', `IRN was NOT generated for ${payload.documentNo}: ${err.message}. The attempt is recorded as failed${err.retryable ? ' and can be retried' : ''}.`)
  }

  async cancel(ctx: ServiceContext, input: { id: number; reasonCode: 1 | 2 | 3 | 4; remarks: string }, now = new Date()): Promise<EInvoiceDetail> {
    const e = this.get(ctx, input.id, now)
    if (e.status !== 'GENERATED') throw businessRule(`Only a generated e-invoice can be cancelled (this one is ${e.status.toLowerCase()})`)
    if (!e.cancellable) throw businessRule(`The cancellation window has passed (${rulesAt(ctx, todayIso()).IRN_CANCEL_WINDOW_HOURS} hours after acknowledgement). Issue a credit note instead.`)
    const provider = this.resolve(ctx)
    if (provider instanceof MockEInvoiceProvider) {
      const r = ctx.db.prepare('SELECT seller_gstin FROM einvoices WHERE id = ?').get(e.id) as { seller_gstin: string }
      provider.remember({ sellerGstin: r.seller_gstin, documentType: e.documentType, documentNo: e.documentNo, documentDate: e.documentDate, irn: e.irn!, ackNo: e.ackNo!, ackDate: e.ackDate!, cancelledAt: null })
    }
    const s = integrationSetting(ctx, 'EINVOICE')
    const res = await callProvider(ctx, { service: 'EINVOICE', provider: provider.id, environment: provider.environment, operation: 'CANCEL_IRN', entityType: 'einvoice', entityId: e.id, requestKey: `${e.requestKey}-cnl`, summary: `Cancel ${e.documentNo}`, timeoutMs: s.timeoutMs, maxRetries: s.maxRetries },
      () => provider.cancelIrn({ irn: e.irn!, reasonCode: input.reasonCode, remarks: input.remarks }, now), { sleep: this.opts.sleep, responseRef: (v) => v.responseRef })
    if (!res.ok) throw new AppError('BUSINESS_RULE', `The IRN was NOT cancelled: ${res.error.message}`)
    const reason = IRN_CANCEL_REASONS[input.reasonCode]
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE einvoices SET status='CANCELLED', cancel_reason_code=?, cancel_remarks=?, cancelled_at=?, cancelled_by=?, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(input.reasonCode, input.remarks, res.value.cancelledAt, ctx.userId, JSON.stringify([...e.history, { at: res.value.cancelledAt, event: 'CANCELLED', detail: `${reason}: ${input.remarks}` }]), e.id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EINVOICE_CANCEL', entityType: 'einvoice', entityId: e.id, summary: `${e.isDemo ? 'DEMO ' : ''}IRN for ${e.documentNo} cancelled: ${reason}` })
    })()
    return this.get(ctx, e.id, now)
  }

  async status(ctx: ServiceContext, id: number, now = new Date()): Promise<EInvoiceDetail> {
    const e = this.get(ctx, id, now)
    if (!e.irn) throw businessRule('This request has no IRN to look up')
    const provider = this.resolve(ctx)
    if (provider instanceof MockEInvoiceProvider) {
      const r = ctx.db.prepare('SELECT seller_gstin FROM einvoices WHERE id = ?').get(e.id) as { seller_gstin: string }
      provider.remember({ sellerGstin: r.seller_gstin, documentType: e.documentType, documentNo: e.documentNo, documentDate: e.documentDate, irn: e.irn, ackNo: e.ackNo!, ackDate: e.ackDate!, cancelledAt: e.cancelledAt })
    }
    const s = integrationSetting(ctx, 'EINVOICE')
    const res = await callProvider(ctx, { service: 'EINVOICE', provider: provider.id, environment: provider.environment, operation: 'GET_IRN_STATUS', entityType: 'einvoice', entityId: e.id, requestKey: `${e.requestKey}-st`, summary: `Status ${e.documentNo}`, timeoutMs: s.timeoutMs, maxRetries: s.maxRetries }, () => provider.getIrnStatus(e.irn!), { sleep: this.opts.sleep })
    if (!res.ok) throw new AppError('BUSINESS_RULE', `Status could not be retrieved: ${res.error.message}`)
    ctx.db.prepare(`UPDATE einvoices SET history_json = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(JSON.stringify([...e.history, { at: now.toISOString(), event: 'STATUS_CHECKED', detail: `Provider reports ${res.value.status.toLowerCase().replace('_', ' ')}` }]), e.id)
    return this.get(ctx, e.id, now)
  }

  /** Invoice print with the e-invoice block. DEMO prints carry no QR code and say so. */
  printHtml(ctx: ServiceContext, id: number): { html: string; fileName: string } {
    const e = this.get(ctx, id)
    if (e.status !== 'GENERATED' && e.status !== 'CANCELLED') throw businessRule('Only generated e-invoices can be printed')
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    const base = buildDocumentHtml(ctx, e.documentKind as Kind, e.documentId)
    const qr = e.signedQr
      ? `<div style="width:120px;height:120px;border:1px solid #94a3b8;display:flex;align-items:center;justify-content:center;font-size:8px;text-align:center;padding:4px">Signed QR stored (${e.signedQr.length} chars). QR image rendering requires the provider adapter.</div>`
      : `<div style="width:120px;height:120px;border:2px dashed #b45309;display:flex;align-items:center;justify-content:center;font-size:8.5px;text-align:center;padding:6px;color:#92400e;font-weight:700">NO QR CODE<br>DEMO e-invoice — not registered with the IRP</div>`
    const block = `<div style="display:flex;gap:12px;align-items:flex-start;border:1px solid ${e.isDemo ? '#b45309' : '#0f1f45'};background:${e.isDemo ? '#fffbeb' : '#f8fafc'};border-radius:6px;padding:8px 10px;margin-bottom:10px;font-family:'Segoe UI',Arial,sans-serif;font-size:10px">
      <div style="flex:1">
        <div style="font-weight:800;font-size:11px;color:${e.isDemo ? '#92400e' : '#0f1f45'};letter-spacing:.5px">${e.isDemo ? 'DEMO E-INVOICE — NOT A LEGALLY REGISTERED E-INVOICE' : 'E-INVOICE'}${e.status === 'CANCELLED' ? ' · IRN CANCELLED' : ''}</div>
        <div><b>IRN:</b> <span style="font-family:Consolas,monospace;word-break:break-all">${esc(e.irn)}</span></div>
        <div><b>Ack No.:</b> ${esc(e.ackNo)} &nbsp; <b>Ack Date:</b> ${esc(e.ackDate ? new Date(e.ackDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '')}</div>
        <div><b>Provider:</b> ${esc(e.provider)} (${esc(e.environment)}) &nbsp; <b>Supply type:</b> ${esc(e.supplyType)}</div>
      </div>${qr}</div>`
    const html = base.replace('<div class="doc">', `<div class="doc">${block}`).replace('</body>', e.isDemo ? '<div class="wm" style="position:fixed;top:60%;left:0;right:0;text-align:center;transform:rotate(-24deg);font-size:40px;font-weight:900;color:rgba(180,83,9,0.10);font-family:Arial">DEMO E-INVOICE</div></body>' : '</body>')
    return { html, fileName: `E-Invoice ${e.documentNo}`.replace(/[\\/:*?"<>|]+/g, '-') + '.pdf' }
  }
}
