/**
 * E-way bill workflow (Phase 4 upgrade of the Phase 1 mock module).
 *
 * Source: a posted sales invoice or delivery challan with goods → validate consignor /
 * consignee → transporter / vehicle / transport document → Part A + Part B → submit →
 * status, vehicle update, transporter update, validity extension, cancellation, print.
 *
 * Applicability is indicative and rule-driven (never assumed for every transaction).
 * Every provider call goes through the integration runner (timeout, retry, API log), and
 * duplicates are prevented by request key and by one active e-way bill per source document.
 */
import type { EwayBill, EwbEligibleInvoice } from '@shared/types'
import { EWB_CANCEL_REASONS, type EwbCancelInputT, type EwbGenerateInputT, type EwbPartBInputT } from '@shared/schemas'
import { docRoute } from '@shared/documents'
import { canExtendAt, ewbRequirement, EWB_EXTEND_REASONS, type EwbPreview, type EwbSourceCandidate } from '@shared/gst'
import { formatINR } from '@shared/money'
import { stateName } from '@shared/india'
import { writeAudit } from '../audit'
import { bool, type ServiceContext } from '../context'
import { AppError, businessRule, conflict, notFound } from '../errors'
import { rulesAt, todayIso } from '../gst/config'
import { callProvider, ProviderError, type CallMeta } from '../integrations/runner'
import { integrationSetting } from '../integrations/settings'
import { LiveEwayBillProvider, MockEwayBillProvider } from './mock-provider'
import { EwbProviderError, type EwayBillProvider, type EwbGenerateRequest, type EwbItem, type KmPerDay } from './provider'

export type EwbMode = 'DEMO' | 'LIVE'

export function createEwayBillProvider(mode: EwbMode): EwayBillProvider {
  if (mode === 'DEMO') return new MockEwayBillProvider()
  throw new AppError('BUSINESS_RULE', 'Live E-Way Bill integration is not configured.')
}

const sharedMock = new MockEwayBillProvider()
/** Provider for the company's configured mode (DEMO → mock; SANDBOX/LIVE → placeholder that refuses). */
export function defaultEwayBillProvider(ctx: ServiceContext): EwayBillProvider {
  const s = integrationSetting(ctx, 'EWAYBILL')
  return s.mode === 'DEMO' ? sharedMock : new LiveEwayBillProvider(s.mode, s.providerName)
}

type Row = Record<string, unknown>
type SourceKind = 'SALES_INVOICE' | 'DELIVERY_CHALLAN'

const SELECT = `SELECT e.*, t.name AS transporter_name, t.transporter_id AS transporter_gstin FROM ewaybill_records e LEFT JOIN transporters t ON t.id = e.transporter_id`
const hasPhase4 = (ctx: ServiceContext) => !!ctx.db.prepare(`SELECT 1 FROM pragma_table_info('ewaybill_records') WHERE name = 'source_kind'`).get()

/** Maps provider errors (old and new style) to classified provider errors. */
function asProviderError(e: unknown): unknown {
  if (e instanceof EwbProviderError) return new ProviderError('VALIDATION', 'EWB_VALIDATION', e.message, e.field)
  return e
}

export class EwayBillService {
  private readonly resolveProvider: (ctx: ServiceContext) => EwayBillProvider
  constructor(provider: EwayBillProvider | ((ctx: ServiceContext) => EwayBillProvider), private readonly opts: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.resolveProvider = typeof provider === 'function' ? provider : () => provider
  }

  private rules(ctx: ServiceContext, date = todayIso()) {
    const r = rulesAt(ctx, date)
    return { kmPerDay: { regular: r.EWB_KM_PER_DAY_REGULAR, odc: r.EWB_KM_PER_DAY_ODC } as KmPerDay, cancelHours: r.EWB_CANCEL_WINDOW_HOURS, extendHours: r.EWB_EXTENSION_WINDOW_HOURS, maxKm: r.EWB_MAX_DISTANCE_KM, all: r }
  }

  private toEwb(ctx: ServiceContext, r: Row, now = new Date()): EwayBill {
    const status = r.status as EwayBill['status']
    const validUpto = r.valid_upto as string | null
    const expired = status === 'ACTIVE' && typeof validUpto === 'string' && new Date(validUpto) < now
    const p4 = 'source_kind' in r
    let rules: ReturnType<EwayBillService['rules']> | null = null
    try { rules = p4 ? this.rules(ctx) : null } catch { rules = null }
    const cancelHours = rules?.cancelHours ?? 24
    const cancelDeadline = r.ewb_date ? new Date(Date.parse(r.ewb_date as string) + cancelHours * 3600000).toISOString() : null
    const live = status === 'ACTIVE' || status === 'PART_A_ONLY'
    const sourceKind = (p4 ? (r.source_kind as string | null) : null) ?? (r.sales_invoice_id ? 'SALES_INVOICE' : null)
    const sourceId = (p4 ? (r.source_id as number | null) : null) ?? (r.sales_invoice_id as number | null)
    return {
      id: r.id as number, provider: r.provider as string, isDemo: bool(r.is_demo), ewbNo: r.ewb_no as string | null, ewbDate: r.ewb_date as string | null,
      validUpto, status: expired ? 'EXPIRED' : status, documentType: r.document_type as string, documentNo: r.document_no as string,
      documentDate: r.document_date as string, salesInvoiceId: r.sales_invoice_id as number | null, supplyType: r.supply_type as string,
      subSupplyType: r.sub_supply_type as string, transactionType: r.transaction_type as string,
      fromGstin: r.from_gstin as string | null, fromName: r.from_name as string, fromAddress: r.from_address as string, fromStateCode: r.from_state_code as string, fromPincode: r.from_pincode as string | null,
      toGstin: r.to_gstin as string | null, toName: r.to_name as string, toAddress: r.to_address as string, toStateCode: r.to_state_code as string, toPincode: r.to_pincode as string | null,
      taxablePaise: r.taxable_paise as number, cgstPaise: r.cgst_paise as number, sgstPaise: r.sgst_paise as number, igstPaise: r.igst_paise as number,
      totalValuePaise: r.total_value_paise as number, items: JSON.parse(r.items_json as string) as EwbItem[],
      transportMode: r.transport_mode as string, transporterName: r.transporter_name as string | null, transporterGstin: r.transporter_gstin as string | null,
      transportDocNo: r.transport_doc_no as string | null, transportDocDate: r.transport_doc_date as string | null, vehicleNo: r.vehicle_no as string | null,
      vehicleType: r.vehicle_type as string, distanceKm: r.distance_km as number, partBUpdatedAt: r.part_b_updated_at as string | null,
      cancelReason: r.cancel_reason as string | null, cancelRemarks: r.cancel_remarks as string | null, cancelledAt: r.cancelled_at as string | null,
      createdAt: r.created_at as string, history: JSON.parse(r.history_json as string) as EwayBill['history'],
      sourceKind, sourceId, sourceRoute: sourceKind && sourceId ? docRoute(sourceKind as SourceKind, sourceId) : null,
      transporterId: r.transporter_id as number | null, vehicleId: (r.vehicle_id as number | null) ?? null, transportDocumentId: (r.transport_document_id as number | null) ?? null,
      environment: (r.environment as string) ?? (bool(r.is_demo) ? 'DEMO' : 'LIVE'), extensionCount: (r.extension_count as number) ?? 0,
      lastStatusCheckAt: (r.last_status_check_at as string | null) ?? null, providerStatus: (r.provider_status as string | null) ?? null,
      hoursToExpiry: validUpto ? Math.round(((Date.parse(validUpto) - now.getTime()) / 3600000) * 10) / 10 : null,
      canCancel: live && !!cancelDeadline && now.toISOString() <= cancelDeadline,
      canExtend: !!validUpto && (status === 'ACTIVE') && canExtendAt(validUpto, now, rules?.extendHours ?? 8),
      cancelDeadline
    }
  }

  list(ctx: ServiceContext, f: { status?: string; from?: string; to?: string; expiringWithinHours?: number } = {}, now = new Date()): EwayBill[] {
    let rows = (ctx.db.prepare(`${SELECT} WHERE e.company_id = ? ORDER BY e.id DESC`).all(ctx.companyId) as Row[]).map((r) => this.toEwb(ctx, r, now))
    if (f.status) rows = rows.filter((e) => e.status === f.status)
    if (f.from) rows = rows.filter((e) => (e.ewbDate ?? e.createdAt).slice(0, 10) >= f.from!)
    if (f.to) rows = rows.filter((e) => (e.ewbDate ?? e.createdAt).slice(0, 10) <= f.to!)
    if (f.expiringWithinHours) rows = rows.filter((e) => e.status === 'ACTIVE' && e.hoursToExpiry !== null && e.hoursToExpiry >= 0 && e.hoursToExpiry <= f.expiringWithinHours!)
    return rows
  }

  get(ctx: ServiceContext, id: number, now = new Date()): EwayBill {
    const row = ctx.db.prepare(`${SELECT} WHERE e.id = ? AND e.company_id = ?`).get(id, ctx.companyId) as Row | undefined
    if (!row) throw notFound('E-way bill')
    return this.toEwb(ctx, row, now)
  }

  /** Phase 1 API (kept): posted invoices with goods. */
  eligibleInvoices(ctx: ServiceContext): EwbEligibleInvoice[] {
    return (
      ctx.db
        .prepare(`SELECT si.id, si.invoice_no AS invoiceNo, si.invoice_date AS invoiceDate, c.name AS customerName, si.grand_total_paise AS grandTotalPaise,
                    EXISTS(SELECT 1 FROM ewaybill_records e WHERE e.sales_invoice_id = si.id AND e.status IN ('ACTIVE','PART_A_ONLY')) AS hasEwayBill
                  FROM sales_invoices si JOIN customers c ON c.id = si.customer_id
                  WHERE si.company_id = ? AND si.status = 'POSTED' AND EXISTS(SELECT 1 FROM sales_invoice_items it WHERE it.invoice_id = si.id AND it.item_type = 'GOODS')
                  ORDER BY si.invoice_date DESC, si.id DESC`)
        .all(ctx.companyId) as Array<Omit<EwbEligibleInvoice, 'hasEwayBill'> & { hasEwayBill: number }>
    ).map((r) => ({ ...r, hasEwayBill: bool(r.hasEwayBill) }))
  }

  /** Loads the source document header, its goods lines and party addresses. */
  private source(ctx: ServiceContext, kind: SourceKind, id: number) {
    const db = ctx.db
    const isInv = kind === 'SALES_INVOICE'
    const h = db
      .prepare(
        isInv
          ? `SELECT si.id, si.invoice_no AS number, si.invoice_date AS date, si.status, si.customer_id, si.customer_gstin AS party_gstin, si.place_of_supply, si.is_inter_state, si.shipping_address FROM sales_invoices si WHERE si.id = ? AND si.company_id = ?`
          : `SELECT td.id, td.doc_no AS number, td.doc_date AS date, td.status, td.customer_id, td.party_gstin, td.place_of_supply, td.is_inter_state, td.shipping_address FROM trade_documents td WHERE td.id = ? AND td.company_id = ? AND td.doc_type = 'DELIVERY_CHALLAN'`
      )
      .get(id, ctx.companyId) as Row | undefined
    if (!h) throw notFound(isInv ? 'Sales invoice' : 'Delivery challan')
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(h.customer_id) as Row
    const goods = db
      .prepare(`SELECT it.*, p.name AS product_name, u.code AS unit FROM ${isInv ? 'sales_invoice_items' : 'trade_document_lines'} it JOIN products p ON p.id = it.product_id JOIN units u ON u.id = it.unit_id
                WHERE it.${isInv ? 'invoice_id' : 'document_id'} = ? AND it.item_type = 'GOODS' ORDER BY it.line_no`)
      .all(id) as Row[]
    return { h, c, goods }
  }

  private activeFor(ctx: ServiceContext, kind: SourceKind, id: number): Row | undefined {
    return hasPhase4(ctx)
      ? (ctx.db.prepare(`SELECT id, ewb_no FROM ewaybill_records WHERE company_id = ? AND ((source_kind = ? AND source_id = ?) OR (? = 'SALES_INVOICE' AND sales_invoice_id = ?)) AND status IN ('ACTIVE','PART_A_ONLY')`).get(ctx.companyId, kind, id, kind, id) as Row | undefined)
      : (ctx.db.prepare(`SELECT id, ewb_no FROM ewaybill_records WHERE sales_invoice_id = ? AND status IN ('ACTIVE','PART_A_ONLY')`).get(id) as Row | undefined)
  }

  /** Posted invoices and challans with goods, with the indicative e-way bill requirement. */
  sources(ctx: ServiceContext, from: string, to: string): EwbSourceCandidate[] {
    const rows = [
      ...(ctx.db.prepare(`SELECT 'SALES_INVOICE' AS kind, si.id FROM sales_invoices si WHERE si.company_id = ? AND si.status = 'POSTED' AND si.invoice_date BETWEEN ? AND ? AND EXISTS(SELECT 1 FROM sales_invoice_items it WHERE it.invoice_id = si.id AND it.item_type = 'GOODS') ORDER BY si.invoice_date DESC`).all(ctx.companyId, from, to) as Array<{ kind: SourceKind; id: number }>),
      ...(ctx.db.prepare(`SELECT 'DELIVERY_CHALLAN' AS kind, td.id FROM trade_documents td WHERE td.company_id = ? AND td.doc_type = 'DELIVERY_CHALLAN' AND td.status = 'POSTED' AND td.doc_date BETWEEN ? AND ? ORDER BY td.doc_date DESC`).all(ctx.companyId, from, to) as Array<{ kind: SourceKind; id: number }>)
    ]
    return rows.map(({ kind, id }) => this.candidate(ctx, kind, id))
  }

  private candidate(ctx: ServiceContext, kind: SourceKind, id: number): EwbSourceCandidate {
    const { h, c, goods } = this.source(ctx, kind, id)
    const rateOf = (hsn: string) => ctx.db.prepare(`SELECT tax_category FROM hsn_rate_rules WHERE company_id = ? AND ? LIKE hsn_code || '%' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY LENGTH(hsn_code) DESC LIMIT 1`).get(ctx.companyId, hsn, h.date, h.date) as { tax_category: string } | undefined
    const goodsValue = goods.reduce((s, g) => s + (g.line_total_paise as number), 0)
    const consignment = goods.filter((g) => { const r = rateOf(g.hsn_sac as string); return !r || r.tax_category === 'TAXABLE' || r.tax_category === 'ZERO_RATED' }).reduce((s, g) => s + (g.line_total_paise as number), 0)
    const req = ewbRequirement({ goodsValuePaise: goodsValue, consignmentValuePaise: consignment, hasGoods: goods.length > 0, rules: rulesAt(ctx, h.date as string) })
    const active = this.activeFor(ctx, kind, id)
    const tdocs = hasPhase4(ctx) ? (ctx.db.prepare('SELECT COUNT(*) n FROM transport_documents WHERE company_id = ? AND source_kind = ? AND source_id = ?').get(ctx.companyId, kind, id) as { n: number }).n : 0
    return {
      kind, id, number: h.number as string, date: h.date as string, partyName: c.name as string, partyGstin: (h.party_gstin as string | null) ?? null, route: docRoute(kind, id),
      goodsValuePaise: goodsValue, consignmentValuePaise: consignment, requirement: req.requirement, reason: req.reason, activeEwbNo: (active?.ewb_no as string | null) ?? null, transportDocs: tdocs
    }
  }

  /** Part A built from the source, with consignor/consignee/GSTIN/address checks. */
  preview(ctx: ServiceContext, kind: SourceKind, id: number, now = new Date()): EwbPreview {
    const { h, c, goods } = this.source(ctx, kind, id)
    const company = ctx.db.prepare('SELECT * FROM companies WHERE id = ?').get(ctx.companyId) as Row
    const errors: string[] = []
    const warnings: string[] = []
    if (h.status !== 'POSTED') errors.push(`The ${kind === 'SALES_INVOICE' ? 'invoice' : 'challan'} is ${String(h.status).toLowerCase()}; only posted documents can carry an e-way bill`)
    if (!goods.length) errors.push('There are no goods on this document; e-way bills apply only to the movement of goods')
    const join = (...p: unknown[]) => p.filter(Boolean).join(', ')
    const hasShip = !!c.shipping_address_line1
    const ship = hasShip ? { a: join(c.shipping_address_line1, c.shipping_city), state: (c.shipping_state_code as string) ?? (c.state_code as string), pin: c.shipping_pincode as string | null } : { a: join(c.address_line1, c.city), state: c.state_code as string, pin: c.pincode as string | null }
    const isExport = c.gst_registration_type === 'OVERSEAS'
    const from = { gstin: company.gstin as string | null, name: company.name as string, address: join(company.address_line1, company.city), stateCode: company.state_code as string, pincode: company.pincode as string | null }
    const to = { gstin: (h.party_gstin as string | null) ?? null, name: c.name as string, address: ship.a, stateCode: ship.state, pincode: ship.pin ?? null }
    if (!from.gstin) errors.push('Consignor (company) GSTIN is missing')
    if (!from.address) errors.push('Consignor address is missing')
    if (!from.pincode) errors.push('Consignor PIN code is missing (Masters → Companies)')
    if (!to.address) errors.push(`Consignee address is missing for ${c.name as string}`)
    if (!isExport && !to.pincode) errors.push(`Consignee PIN code is missing for ${c.name as string} (Masters → Customers)`)
    if (['REGULAR', 'COMPOSITION', 'SEZ'].includes(c.gst_registration_type as string) && !to.gstin) errors.push(`${c.name as string} is registered but the document has no GSTIN`)
    if (!to.gstin) warnings.push('Consignee is unregistered (URP)')
    for (const g of goods) if (!/^[0-9]{4,8}$/.test(g.hsn_sac as string)) errors.push(`${g.product_name as string}: HSN must be 4–8 digits`)
    if ((h.date as string) > now.toISOString().slice(0, 10)) errors.push('Document date is in the future')
    const active = this.activeFor(ctx, kind, id)
    if (active) errors.push(`An active e-way bill ${active.ewb_no as string} already exists for this document`)
    const cand = this.candidate(ctx, kind, id)
    if (cand.requirement === 'NOT_REQUIRED') warnings.push('Consignment value is within the configured limit; an e-way bill may not be required (check the state rules)')
    const sum = (k: string) => goods.reduce((s, g) => s + (g[k] as number), 0)
    return {
      source: cand,
      partA: {
        supplyType: 'OUTWARD', subSupplyType: kind === 'DELIVERY_CHALLAN' ? 'OTHERS' : isExport ? 'EXPORT' : 'SUPPLY', documentType: kind === 'DELIVERY_CHALLAN' ? 'DELIVERY_CHALLAN' : 'TAX_INVOICE',
        documentNo: h.number as string, documentDate: h.date as string, transactionType: hasShip ? 'BILL_TO_SHIP_TO' : 'REGULAR', from, to,
        items: goods.map((g) => ({ productName: g.product_name as string, hsn: g.hsn_sac as string, qtyMilli: g.qty_milli as number, unit: g.unit as string, taxablePaise: g.taxable_paise as number, taxRateBps: g.tax_rate_bps as number })),
        taxablePaise: sum('taxable_paise'), cgstPaise: sum('cgst_paise'), sgstPaise: sum('sgst_paise'), igstPaise: sum('igst_paise'), totalValuePaise: sum('line_total_paise')
      },
      errors, warnings
    }
  }

  private meta(ctx: ServiceContext, provider: EwayBillProvider, operation: string, entityId: number | null, requestKey: string, summary: string): CallMeta {
    const s = integrationSetting(ctx, 'EWAYBILL')
    return { service: 'EWAYBILL', provider: provider.id, environment: provider.environment ?? (provider.isDemo ? 'DEMO' : 'LIVE'), operation, entityType: 'ewaybill', entityId, requestKey, summary, timeoutMs: s.timeoutMs, maxRetries: s.maxRetries }
  }

  private async run<T>(ctx: ServiceContext, meta: CallMeta, fn: () => Promise<T>): Promise<T> {
    const r = await callProvider<T>(ctx, meta, async () => { try { return await fn() } catch (e) { throw asProviderError(e) } }, { sleep: this.opts.sleep })
    if (r.ok) return r.value
    const e = r.error
    if (e.errorClass === 'VALIDATION' || e.errorClass === 'BUSINESS') throw businessRule(e.message, e.field ? { [e.field]: e.message } : undefined)
    throw new AppError('BUSINESS_RULE', `The e-way bill request FAILED (${e.errorClass.toLowerCase().replace('_', ' ')}): ${e.message}. Nothing was generated or changed.`)
  }

  async generate(ctx: ServiceContext, input: EwbGenerateInputT, now = new Date()): Promise<EwayBill> {
    const db = ctx.db
    const p4 = hasPhase4(ctx)
    const kind: SourceKind = (input.sourceKind ?? 'SALES_INVOICE') as SourceKind
    const sourceId = (input.sourceId ?? input.salesInvoiceId)!
    if (p4 && input.requestKey) {
      const prior = db.prepare('SELECT id, source_kind, source_id FROM ewaybill_records WHERE company_id = ? AND request_key = ?').get(ctx.companyId, input.requestKey) as Row | undefined
      if (prior) {
        if (prior.source_kind !== kind || prior.source_id !== sourceId) throw conflict('This request key was already used for another document')
        return this.get(ctx, prior.id as number, now)
      }
    }
    const pv = this.preview(ctx, kind, sourceId, now)
    if (this.activeFor(ctx, kind, sourceId)) throw businessRule('An active e-way bill already exists for this document', { sourceId: 'Already has an active e-way bill', salesInvoiceId: 'Already has an active e-way bill' })
    if (pv.errors.length) throw businessRule(`E-way bill cannot be prepared: ${pv.errors.join(' · ')}`)
    let transporter: { name: string; transporter_id: string } | undefined
    if (input.transporterId) {
      transporter = db.prepare('SELECT name, transporter_id FROM transporters WHERE id = ? AND company_id = ? AND is_active = 1').get(input.transporterId, ctx.companyId) as typeof transporter
      if (!transporter) throw notFound('Transporter')
    }
    let vehicleNo = input.vehicleNo ? input.vehicleNo.replace(/[\s-]/g, '') : null
    let vehicleType = input.vehicleType
    if (input.vehicleId) {
      const v = db.prepare('SELECT vehicle_no, vehicle_type FROM vehicles WHERE id = ? AND company_id = ? AND is_active = 1').get(input.vehicleId, ctx.companyId) as { vehicle_no: string; vehicle_type: 'REGULAR' | 'ODC' } | undefined
      if (!v) throw notFound('Vehicle')
      vehicleNo = v.vehicle_no
      vehicleType = v.vehicle_type
    }
    let transportDocNo = input.transportDocNo
    let transportDocDate = input.transportDocDate
    if (input.transportDocumentId) {
      const t = db.prepare('SELECT doc_no, doc_date, source_kind, source_id FROM transport_documents WHERE id = ? AND company_id = ?').get(input.transportDocumentId, ctx.companyId) as Row | undefined
      if (!t) throw notFound('Transport document')
      if (t.source_kind && (t.source_kind !== kind || t.source_id !== sourceId)) throw businessRule('The transport document belongs to another sales document')
      transportDocNo = t.doc_no as string
      transportDocDate = t.doc_date as string
    }
    const rules = this.rules(ctx, now.toISOString().slice(0, 10))
    if (input.distanceKm > rules.maxKm) throw businessRule(`Approximate distance cannot exceed ${rules.maxKm} km`, { distanceKm: `At most ${rules.maxKm} km` })
    const req: EwbGenerateRequest = {
      ...pv.partA, supplyType: 'OUTWARD', subSupplyType: pv.partA.subSupplyType as EwbGenerateRequest['subSupplyType'], documentType: pv.partA.documentType as EwbGenerateRequest['documentType'],
      transactionType: pv.partA.transactionType as EwbGenerateRequest['transactionType'], transportMode: input.transportMode, distanceKm: input.distanceKm,
      transporterGstin: transporter?.transporter_id ?? null, transporterName: transporter?.name ?? null, transportDocNo, transportDocDate, vehicleNo, vehicleType,
      kmPerDay: rules.kmPerDay, maxDistanceKm: rules.maxKm, requestKey: input.requestKey
    }
    const provider = this.resolveProvider(ctx)
    const key = input.requestKey ?? `ewb-${kind}-${sourceId}-${now.getTime()}`
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_GENERATE', null, key, `${req.documentType} ${req.documentNo} · ${formatINR(req.totalValuePaise)} · ${req.distanceKm} km`), () => provider.generate(req, now))
    const status = res.validUpto ? 'ACTIVE' : 'PART_A_ONLY'
    const history = [{ at: res.ewbDate, event: 'GENERATED', detail: `${provider.isDemo ? 'DEMO ' : ''}e-way bill generated${res.validUpto ? '' : ' (Part A only)'}` }]
    const id = db.transaction(() => {
      if (this.activeFor(ctx, kind, sourceId)) throw conflict('An active e-way bill was created for this document in the meantime')
      const cols = ['company_id', 'provider', 'is_demo', 'ewb_no', 'ewb_date', 'valid_upto', 'status', 'document_type', 'document_no', 'document_date', 'sales_invoice_id',
        'supply_type', 'sub_supply_type', 'transaction_type', 'from_gstin', 'from_name', 'from_address', 'from_state_code', 'from_pincode',
        'to_gstin', 'to_name', 'to_address', 'to_state_code', 'to_pincode', 'taxable_paise', 'cgst_paise', 'sgst_paise', 'igst_paise', 'total_value_paise', 'items_json',
        'transport_mode', 'transporter_id', 'transport_doc_no', 'transport_doc_date', 'vehicle_no', 'vehicle_type', 'distance_km', 'part_b_updated_at', 'history_json', 'created_by']
      const vals: unknown[] = [ctx.companyId, provider.id, provider.isDemo ? 1 : 0, res.ewbNo, res.ewbDate, res.validUpto, status, req.documentType, req.documentNo, req.documentDate, kind === 'SALES_INVOICE' ? sourceId : null,
        req.supplyType, req.subSupplyType, req.transactionType, req.from.gstin, req.from.name, req.from.address, req.from.stateCode, req.from.pincode,
        req.to.gstin, req.to.name, req.to.address, req.to.stateCode, req.to.pincode, req.taxablePaise, req.cgstPaise, req.sgstPaise, req.igstPaise, req.totalValuePaise, JSON.stringify(req.items),
        req.transportMode, input.transporterId ?? null, req.transportDocNo, req.transportDocDate, req.vehicleNo, req.vehicleType, req.distanceKm, res.validUpto ? res.ewbDate : null, JSON.stringify(history), ctx.userId]
      if (p4) {
        cols.push('source_kind', 'source_id', 'vehicle_id', 'transport_document_id', 'request_key', 'environment')
        vals.push(kind, sourceId, input.vehicleId ?? null, input.transportDocumentId ?? null, input.requestKey ?? null, provider.environment ?? (provider.isDemo ? 'DEMO' : 'LIVE'))
      }
      const newId = Number(db.prepare(`INSERT INTO ewaybill_records (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid)
      writeAudit(db, {
        companyId: ctx.companyId, userId: ctx.userId, action: 'EWB_GENERATE', entityType: 'ewaybill', entityId: newId,
        summary: `${provider.isDemo ? 'DEMO ' : ''}E-way bill ${res.ewbNo} for ${req.documentNo} (${formatINR(req.totalValuePaise)}) — ${status === 'ACTIVE' ? 'Part A + B' : 'Part A only'}`,
        details: { provider: provider.id, ewbNo: res.ewbNo, vehicleNo: req.vehicleNo, distanceKm: req.distanceKm, requestKey: key }
      })
      return newId
    })()
    return this.get(ctx, id, now)
  }

  private live(ewb: EwayBill, action: string): void {
    if (ewb.status === 'CANCELLED') throw businessRule(`Cannot ${action}: the e-way bill is cancelled`)
    if (ewb.status === 'EXPIRED') throw businessRule(`Cannot ${action}: the e-way bill has expired`)
  }

  async updatePartB(ctx: ServiceContext, input: EwbPartBInputT, now = new Date()): Promise<EwayBill> {
    const ewb = this.get(ctx, input.id, now)
    this.live(ewb, 'update Part B')
    const vehicleNo = input.vehicleNo ? input.vehicleNo.replace(/[\s-]/g, '') : null
    const provider = this.resolveProvider(ctx)
    const rules = hasPhase4(ctx) ? this.rules(ctx) : null
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_UPDATE_PART_B', ewb.id, `${ewb.ewbNo}-pb-${now.getTime()}`, `${ewb.ewbNo} → ${vehicleNo ?? input.transportDocNo}`), () =>
      provider.updatePartB({ ewbNo: ewb.ewbNo!, generatedAt: ewb.ewbDate!, distanceKm: ewb.distanceKm, vehicleType: ewb.vehicleType as 'REGULAR' | 'ODC', transportMode: input.transportMode, vehicleNo, transportDocNo: input.transportDocNo, reason: input.reason, remarks: input.remarks, kmPerDay: rules?.kmPerDay }, now)
    )
    // Validity starts from the first Part B entry and is not extended by later vehicle changes.
    const validUpto = ewb.validUpto ?? res.validUpto
    const history = [...ewb.history, { at: res.updatedAt, event: 'PART_B_UPDATED', detail: `${input.transportMode} ${vehicleNo ?? input.transportDocNo ?? ''} (${input.reason.replace('_', ' ').toLowerCase()})` }]
    ctx.db.transaction(() => {
      ctx.db
        .prepare(`UPDATE ewaybill_records SET status='ACTIVE', transport_mode=?, vehicle_no=?, transport_doc_no=?, valid_upto=?, part_b_updated_at=?, history_json=?,
                    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(input.transportMode, vehicleNo, input.transportDocNo, validUpto, res.updatedAt, JSON.stringify(history), ewb.id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EWB_PART_B', entityType: 'ewaybill', entityId: ewb.id, summary: `Part B updated for ${ewb.ewbNo}: ${vehicleNo ?? input.transportDocNo}` })
    })()
    return this.get(ctx, ewb.id, now)
  }

  async updateTransporter(ctx: ServiceContext, input: { id: number; transporterId: number }, now = new Date()): Promise<EwayBill> {
    const ewb = this.get(ctx, input.id, now)
    this.live(ewb, 'change the transporter')
    const t = ctx.db.prepare('SELECT id, name, transporter_id FROM transporters WHERE id = ? AND company_id = ? AND is_active = 1').get(input.transporterId, ctx.companyId) as { id: number; name: string; transporter_id: string } | undefined
    if (!t) throw notFound('Transporter')
    if (t.id === ewb.transporterId) throw businessRule('This transporter is already assigned')
    const provider = this.resolveProvider(ctx)
    if (!provider.updateTransporter) throw businessRule('The provider does not support transporter updates')
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_UPDATE_TRANSPORTER', ewb.id, `${ewb.ewbNo}-tr-${now.getTime()}`, `${ewb.ewbNo} → ${t.name}`), () => provider.updateTransporter!({ ewbNo: ewb.ewbNo!, transporterGstin: t.transporter_id }, now))
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE ewaybill_records SET transporter_id=?, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(t.id, JSON.stringify([...ewb.history, { at: res.updatedAt, event: 'TRANSPORTER_UPDATED', detail: `${ewb.transporterName ?? 'none'} → ${t.name} (${t.transporter_id})` }]), ewb.id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EWB_TRANSPORTER', entityType: 'ewaybill', entityId: ewb.id, summary: `Transporter of ${ewb.ewbNo} changed to ${t.name}` })
    })()
    return this.get(ctx, ewb.id, now)
  }

  async extend(ctx: ServiceContext, input: { id: number; reasonCode: number; remarks: string; currentPlace: string; currentStateCode: string; remainingDistanceKm: number; transportMode: 'ROAD' | 'RAIL' | 'AIR' | 'SHIP'; vehicleNo: string | null }, now = new Date()): Promise<EwayBill> {
    const row = ctx.db.prepare(`${SELECT} WHERE e.id = ? AND e.company_id = ?`).get(input.id, ctx.companyId) as Row | undefined
    if (!row) throw notFound('E-way bill')
    const ewb = this.toEwb(ctx, row, now)
    if (ewb.status === 'CANCELLED') throw businessRule('A cancelled e-way bill cannot be extended')
    if (ewb.status === 'PART_A_ONLY' || !ewb.validUpto) throw businessRule('Enter Part B first; a Part A-only e-way bill has no validity to extend')
    const rules = this.rules(ctx)
    if (!canExtendAt(ewb.validUpto, now, rules.extendHours)) throw businessRule(`Validity can be extended only within ${rules.extendHours} hours before or after expiry (expires ${new Date(ewb.validUpto).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})`)
    const provider = this.resolveProvider(ctx)
    if (!provider.extendValidity) throw businessRule('The provider does not support validity extension')
    const vehicleNo = input.vehicleNo ? input.vehicleNo.replace(/[\s-]/g, '') : ewb.vehicleNo
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_EXTEND', ewb.id, `${ewb.ewbNo}-ext-${ewb.extensionCount + 1}`, `${ewb.ewbNo} +${input.remainingDistanceKm} km`), () =>
      provider.extendValidity!({ ewbNo: ewb.ewbNo!, validUpto: ewb.validUpto!, remainingDistanceKm: input.remainingDistanceKm, vehicleType: ewb.vehicleType as 'REGULAR' | 'ODC', transportMode: input.transportMode, vehicleNo, reasonCode: input.reasonCode, remarks: input.remarks, currentPlace: input.currentPlace, currentStateCode: input.currentStateCode, windowHours: rules.extendHours, kmPerDay: rules.kmPerDay }, now)
    )
    const reason = EWB_EXTEND_REASONS[input.reasonCode as keyof typeof EWB_EXTEND_REASONS] ?? 'Others'
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE ewaybill_records SET status='ACTIVE', valid_upto=?, vehicle_no=?, transport_mode=?, extension_count=extension_count+1, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(res.validUpto, vehicleNo, input.transportMode, JSON.stringify([...ewb.history, { at: res.updatedAt, event: 'VALIDITY_EXTENDED', detail: `${reason}: ${input.remarks} — at ${input.currentPlace}, ${stateName(input.currentStateCode)}; ${input.remainingDistanceKm} km remaining; valid until ${res.validUpto}` }]), ewb.id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EWB_EXTEND', entityType: 'ewaybill', entityId: ewb.id, summary: `Validity of ${ewb.ewbNo} extended (${reason})` })
    })()
    return this.get(ctx, ewb.id, now)
  }

  async cancel(ctx: ServiceContext, input: EwbCancelInputT, now = new Date()): Promise<EwayBill> {
    const ewb = this.get(ctx, input.id, now)
    if (ewb.status === 'CANCELLED') throw businessRule('This e-way bill is already cancelled')
    const provider = this.resolveProvider(ctx)
    const hours = hasPhase4(ctx) ? this.rules(ctx).cancelHours : 24
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_CANCEL', ewb.id, `${ewb.ewbNo}-cnl`, `Cancel ${ewb.ewbNo}`), () => provider.cancel({ ewbNo: ewb.ewbNo!, generatedAt: ewb.ewbDate!, reasonCode: input.reasonCode, remarks: input.remarks, windowHours: hours }, now))
    const reason = EWB_CANCEL_REASONS[input.reasonCode]
    const history = [...ewb.history, { at: res.cancelledAt, event: 'CANCELLED', detail: `${reason}: ${input.remarks}` }]
    ctx.db.transaction(() => {
      ctx.db
        .prepare(`UPDATE ewaybill_records SET status='CANCELLED', cancel_reason=?, cancel_remarks=?, cancelled_at=?, cancelled_by=?, history_json=?,
                    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(reason, input.remarks, res.cancelledAt, ctx.userId, JSON.stringify(history), ewb.id)
      writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EWB_CANCEL', entityType: 'ewaybill', entityId: ewb.id, summary: `E-way bill ${ewb.ewbNo} cancelled: ${reason}` })
    })()
    return this.get(ctx, ewb.id, now)
  }

  async status(ctx: ServiceContext, id: number, now = new Date()): Promise<EwayBill> {
    const ewb = this.get(ctx, id, now)
    const provider = this.resolveProvider(ctx)
    if (!provider.getStatus) throw businessRule('The provider does not support status lookup')
    const res = await this.run(ctx, this.meta(ctx, provider, 'EWB_STATUS', ewb.id, `${ewb.ewbNo}-st-${now.getTime()}`, `Status ${ewb.ewbNo}`), () => provider.getStatus!({ ewbNo: ewb.ewbNo!, validUpto: ewb.validUpto, cancelled: ewb.status === 'CANCELLED' }, now))
    ctx.db.prepare(`UPDATE ewaybill_records SET last_status_check_at=?, provider_status=?, history_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(res.checkedAt, res.status, JSON.stringify([...ewb.history, { at: res.checkedAt, event: 'STATUS_CHECKED', detail: `Provider reports ${res.status.toLowerCase()}` }]), ewb.id)
    return this.get(ctx, ewb.id, now)
  }

  /** Printable e-way bill (Part A + Part B). DEMO prints are watermarked and carry no barcode. */
  printHtml(ctx: ServiceContext, id: number): { html: string; fileName: string } {
    const e = this.get(ctx, id)
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    const inr = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—')
    const kv = (k: string, v: unknown) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`
    const items = e.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.productName)}</td><td>${esc(i.hsn)}</td><td class="r">${(i.qtyMilli / 1000).toLocaleString('en-IN')} ${esc(i.unit)}</td><td class="r">${inr(i.taxablePaise)}</td><td class="r">${i.taxRateBps / 100}%</td></tr>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>E-Way Bill ${esc(e.ewbNo)}</title><style>
      @page { size: A4; margin: 12mm; } body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5px; color: #0f172a; margin: 0 }
      h1 { font-size: 18px; margin: 0 } h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: #475569; margin: 14px 0 4px; border-bottom: 1px solid #cbd5e1; padding-bottom: 2px }
      table { width: 100%; border-collapse: collapse } th { text-align: left; width: 32%; color: #475569; font-weight: 600; padding: 3px 4px; vertical-align: top } td { padding: 3px 4px }
      .items th, .items td { border-bottom: 1px solid #e2e8f0; width: auto } .r { text-align: right } .demo { border: 2px dashed #b45309; color: #92400e; background: #fffbeb; padding: 6px 8px; font-weight: 700; margin: 8px 0 }
      .wm { position: fixed; top: 40%; left: 0; right: 0; text-align: center; transform: rotate(-24deg); font-size: 60px; font-weight: 900; color: rgba(180,83,9,.09) }
    </style></head><body>
    ${e.isDemo ? '<div class="wm">DEMO — NOT VALID</div>' : ''}
    <h1>E-Way Bill</h1>
    ${e.isDemo ? '<div class="demo">DEMO E-WAY BILL — generated locally by the demo provider. NOT a government-issued e-way bill and NOT valid for the movement of goods. No barcode is printed.</div>' : ''}
    <table>${kv('E-way bill no.', e.ewbNo)}${kv('Generated', dt(e.ewbDate))}${kv('Valid until', e.validUpto ? dt(e.validUpto) : 'Part B not entered — not valid for movement')}${kv('Status', e.status)}${kv('Provider', `${e.provider} (${e.environment})`)}</table>
    <h2>Part A</h2>
    <table>${kv('Document', `${e.documentType.replace(/_/g, ' ')} ${e.documentNo} dated ${e.documentDate}`)}${kv('Supply type', `${e.supplyType} / ${e.subSupplyType} / ${e.transactionType.replace(/_/g, ' ')}`)}
      ${kv('From (consignor)', `${e.fromName}, ${e.fromGstin ?? 'URP'}, ${e.fromAddress}, ${stateName(e.fromStateCode)} ${e.fromPincode ?? ''}`)}
      ${kv('To (consignee)', `${e.toName}, ${e.toGstin ?? 'URP'}, ${e.toAddress}, ${stateName(e.toStateCode)} ${e.toPincode ?? ''}`)}
      ${kv('Value of goods', `Taxable ${inr(e.taxablePaise)} · CGST ${inr(e.cgstPaise)} · SGST ${inr(e.sgstPaise)} · IGST ${inr(e.igstPaise)} · Total ${inr(e.totalValuePaise)}`)}
      ${kv('Approx. distance', `${e.distanceKm} km`)}${kv('Transporter', e.transporterName ? `${e.transporterName} (${e.transporterGstin})` : '—')}</table>
    <table class="items" style="margin-top:6px"><tr><th>#</th><th>Product</th><th>HSN</th><th class="r">Qty</th><th class="r">Taxable</th><th class="r">Rate</th></tr>${items}</table>
    <h2>Part B</h2>
    <table>${kv('Mode', e.transportMode)}${kv('Vehicle no.', e.vehicleNo ?? '—')}${kv('Vehicle type', e.vehicleType)}${kv('Transport doc.', e.transportDocNo ? `${e.transportDocNo}${e.transportDocDate ? ` dated ${e.transportDocDate}` : ''}` : '—')}${kv('Part B updated', dt(e.partBUpdatedAt))}</table>
    <h2>History</h2>
    <table>${e.history.map((h) => kv(dt(h.at), `${h.event.replace(/_/g, ' ')} — ${h.detail}`)).join('')}</table>
    </body></html>`
    return { html, fileName: `E-Way Bill ${e.ewbNo ?? e.id}`.replace(/[\\/:*?"<>|]+/g, '-') + '.pdf' }
  }
}
