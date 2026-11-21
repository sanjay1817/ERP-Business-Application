/**
 * DEMO scenario — Phase 4 (GST, e-invoice, e-way bill). Everything goes through the
 * real services, so registers, returns and statuses are derived exactly as in use.
 *
 *  - GST settings (turnover, LUT), HSN master with effective-dated rates (incl. a rate
 *    change and a reverse-charge SAC), an exempt product.
 *  - SEZ (with and without IGST), export under LUT, a B2C Large invoice and an exempt sale.
 *  - ITC: earlier months classified, the current month left for review, one ineligible bill.
 *  - A supplier-statement reconciliation with matches and differences for review.
 *  - Vehicles and a transport document; DEMO e-invoices (incl. a failed and a cancelled one)
 *    and a DEMO e-way bill for a delivery challan.
 */
import { DocumentSaveInput, type DocumentSaveInputT } from '@shared/documents'
import { buildGstin, financialYearOf, financialYearRange } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { CustomerInput, ProductInput } from '@shared/schemas'
import { HsnRateSaveInput } from '@shared/gst'
import type { Customer, Product, Supplier } from '@shared/types'
import type { ServiceContext } from '../../services/context'
import { postDocument, saveDraft } from '../../services/documents/engine'
import { createCustomer } from '../../services/parties'
import { createProduct } from '../../services/products'
import { importHsnFromProducts, saveHsn, saveHsnRate, saveSettings } from '../../services/gst/config'
import { classifyItc } from '../../services/gst/itc'
import { inwardDocs } from '../../services/gst/registers'
import { importRecon, reviewRecon } from '../../services/gst/recon'
import { saveTransportDoc, saveVehicle } from '../../services/transport'
import { EInvoiceService } from '../../services/einvoice/service'
import { MockEInvoiceProvider } from '../../services/einvoice/provider'
import { EwayBillService } from '../../services/ewaybill/service'
import { MockEwayBillProvider } from '../../services/ewaybill/mock-provider'

export interface GstFlowDeps {
  ctx: ServiceContext
  todayIso: string
  fyStart: string
  plusDays: (iso: string, n: number) => string
  productByCode: Map<string, Product>
  customers: Customer[]
  suppliers: Supplier[]
}

const csvAmount = (p: number) => (p / 100).toFixed(2)

export function gstFlows(f: GstFlowDeps): void {
  const { ctx, todayIso, plusDays } = f
  const db = ctx.db
  const day = (n: number) => {
    const x = plusDays(todayIso, -n)
    return x < f.fyStart ? f.fyStart : x
  }
  const fy = financialYearOf(todayIso)
  const prevFy = `${Number(fy.slice(0, 4)) - 1}-${fy.slice(2, 4)}`
  const fyRange = financialYearRange(fy)

  // ── Settings: turnover above the e-invoice thresholds, LUT for zero-rated supplies without IGST.
  saveSettings(ctx, { aatoPaise: toPaise(120000000), aatoFy: prevFy, einvoiceEnabled: true, einvoiceExemptReason: null, returnFrequency: 'MONTHLY', lutNumber: 'AD330326DEMO001', lutValidFrom: fyRange.from, lutValidUpto: fyRange.to })

  // ── Exempt product (printed manuals) and the HSN master with effective-dated rates.
  const taxId = (bps: number) => (db.prepare('SELECT id FROM tax_rates WHERE rate_bps = ?').get(bps) as { id: number }).id
  const unitId = (code: string) => (db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id
  const manual = createProduct(ctx, ProductInput.parse({
    code: 'MAN-TRN', name: 'Printed Training Manual (book)', description: 'Printed book supplied with training', itemType: 'GOODS', categoryId: null, unitId: unitId('NOS'),
    hsnSac: '49011010', taxRateId: taxId(0), salePricePaise: toPaise(450), purchasePricePaise: 0, mrpPaise: null, reorderLevelMilli: 0, trackInventory: false
  }))
  importHsnFromProducts(ctx)
  const codes = db.prepare(`SELECT h.code, (SELECT MAX(t.rate_bps) FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.company_id = h.company_id AND p.hsn_sac = h.code) AS bps FROM hsn_codes h WHERE h.company_id = ?`).all(ctx.companyId) as Array<{ code: string; bps: number }>
  for (const c of codes) {
    if (c.code === '85285200') {
      // Example of an effective-dated change (illustrative DEMO dates — verify real notifications).
      saveHsnRate(ctx, HsnRateSaveInput.parse({ hsnCode: c.code, effectiveFrom: '2017-07-01', taxCategory: 'TAXABLE', rateBps: 2800, notes: 'DEMO: earlier rate (illustrative)' }))
      saveHsnRate(ctx, HsnRateSaveInput.parse({ hsnCode: c.code, effectiveFrom: '2025-09-22', taxCategory: 'TAXABLE', rateBps: 1800, notes: 'DEMO: revised rate (illustrative)' }))
      continue
    }
    const exempt = c.code === '49011010'
    saveHsnRate(ctx, HsnRateSaveInput.parse({ hsnCode: c.code, effectiveFrom: '2017-07-01', taxCategory: exempt ? 'EXEMPT' : c.bps === 0 ? 'NIL_RATED' : 'TAXABLE', rateBps: exempt ? 0 : c.bps, notes: 'DEMO rate — verify against the current rate notification' }))
  }
  saveHsn(ctx, { code: '998211', description: 'Legal advisory and representation services', kind: 'SERVICE', defaultUqc: 'OTH', isActive: true })
  saveHsnRate(ctx, HsnRateSaveInput.parse({ hsnCode: '998211', effectiveFrom: '2017-07-01', taxCategory: 'TAXABLE', rateBps: 1800, reverseCharge: true, notes: 'DEMO: services of an advocate to a business entity are taxed under reverse charge (verify)' }))

  // ── Customers for zero-rated and B2C Large supplies.
  const mk = (code: string, name: string, type: 'SEZ' | 'OVERSEAS' | 'CONSUMER', state: string, city: string, pin: string | null, pan: string | null) =>
    createCustomer(ctx, CustomerInput.parse({
      code, name, partyType: type === 'CONSUMER' ? 'INDIVIDUAL' : 'BUSINESS', gstRegistrationType: type, gstin: pan ? buildGstin(state, pan) : null, pan,
      contactPerson: null, phone: null, email: null, addressLine1: type === 'OVERSEAS' ? 'Office 1204, Business Bay' : '14, Sector Road', addressLine2: null, city, stateCode: state, pincode: pin,
      shippingAddressLine1: null, shippingAddressLine2: null, shippingCity: null, shippingStateCode: null, shippingPincode: null, creditLimitPaise: 0, creditDays: 30, openingBalancePaise: 0
    }))
  const sez = mk('C011', 'Nova Electronics (SEZ Unit)', 'SEZ', '33', 'Chennai', '600119', 'AAHCN5521Q')
  const exporter = mk('C012', 'Gulf Horizon Trading LLC (Dubai)', 'OVERSEAS', '96', 'Dubai', null, null)
  const consumer = mk('C013', 'Anitha Rao', 'CONSUMER', '29', 'Bengaluru', '560034', null)
  const P = (code: string) => (code === 'MAN-TRN' ? manual : f.productByCode.get(code)!)
  const line = (code: string, qty: number, taxRateBps?: number) => ({ productId: P(code).id, qtyMilli: toMilli(qty), ratePaise: P(code).salePricePaise, ...(taxRateBps !== undefined ? { taxRateBps } : {}) })
  const sell = (input: Omit<DocumentSaveInputT, 'kind'>) => {
    const d = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', ...input }), { audit: false })
    return postDocument(ctx, 'SALES_INVOICE', d.id)
  }
  sell({ partyId: sez.id, date: day(6), notes: 'Supply to SEZ unit with payment of IGST', lines: [line('SVC-INST', 10), line('SVC-AMC', 10)] })
  sell({ partyId: sez.id, date: day(5), notes: 'Supply to SEZ unit under LUT (without payment of IGST)', lines: [line('SVC-CONS', 20, 0)] })
  sell({ partyId: exporter.id, date: day(4), notes: 'Export of services under LUT (without payment of IGST)', lines: [line('SVC-CONS', 40, 0), line('SVC-CLD', 12, 0)] })
  sell({ partyId: consumer.id, date: day(3), notes: 'Inter-state supply to an unregistered person (B2C Large)', lines: [line('SVC-CONS', 35)] })
  const academy = f.customers.find((c) => c.code === 'C006')!
  sell({ partyId: academy.id, date: day(2), notes: 'Training session with exempt printed manuals', lines: [line('SVC-TRN', 2), line('MAN-TRN', 30)] })

  // ── ITC: earlier months reviewed; the current month is left pending; one bill ineligible.
  const monthStart = `${todayIso.slice(0, 7)}-01`
  const purchases = inwardDocs(ctx, { from: f.fyStart, to: todayIso, status: 'POSTED' }).filter((d) => d.kind === 'PURCHASE_INVOICE')
  const earlier = purchases.filter((d) => d.date < monthStart)
  const ineligible = earlier.filter((d) => d.partyName.startsWith('Paperline')).slice(-1)
  const eligible = earlier.filter((d) => !ineligible.includes(d) && d.partyGstin)
  if (eligible.length) classifyItc(ctx, { documents: eligible.map((d) => ({ kind: d.kind, id: d.id })), eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null })
  if (ineligible.length) classifyItc(ctx, { documents: ineligible.map((d) => ({ kind: d.kind, id: d.id })), eligibility: 'INELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: 'DEMO: stationery used for exempt training manuals (proportionate reversal to be computed)' })

  // ── Supplier statement for the previous month: matches, a value difference, a GSTIN difference,
  //    a duplicate row, a document missing from the books and one missing from the statement.
  // Statement window: the two months before the current one (enough bills for every case).
  const prevMonthEnd = plusDays(monthStart, -1)
  const startOfPrev = `${prevMonthEnd.slice(0, 7)}-01`
  const prevMonthStart = `${plusDays(startOfPrev, -1).slice(0, 7)}-01` < f.fyStart ? startOfPrev : `${plusDays(startOfPrev, -1).slice(0, 7)}-01`
  const prev = inwardDocs(ctx, { from: prevMonthStart, to: prevMonthEnd, status: 'POSTED' }).filter((d) => d.kind === 'PURCHASE_INVOICE' && d.partyGstin && d.supplierRef)
  if (prev.length >= 4) {
    const rows = prev.slice(0, -1).map((d, i) => {
      let taxable = d.taxablePaise
      let igst = d.igstPaise, cgst = d.cgstPaise, sgst = d.sgstPaise
      let gstin = d.partyGstin!
      if (i === 0) { taxable += 50000; if (igst) igst += 9000; else { cgst += 4500; sgst += 4500 } }
      if (i === 2) gstin = f.suppliers.find((s) => s.gstin && s.gstin !== d.partyGstin)!.gstin!
      return [gstin, d.partyName, d.supplierRef!, d.supplierRefDate ?? d.date, 'INVOICE', csvAmount(taxable), csvAmount(igst), csvAmount(cgst), csvAmount(sgst), '0.00']
    })
    rows.splice(2, 0, rows[1])
    const s2 = f.suppliers.find((s) => s.code === 'S002')!
    rows.push([s2.gstin!, s2.name, 'PPI/26-27/9999', prevMonthEnd, 'INVOICE', '12000.00', '2160.00', '0.00', '0.00', '0.00'])
    const csv = ['supplier_gstin,supplier_name,invoice_no,invoice_date,type,taxable,igst,cgst,sgst,cess', ...rows.map((r) => r.map((v) => (/[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))].join('\n')
    const rec = importRecon(ctx, { label: `DEMO supplier statements ${prevMonthStart.slice(0, 7)} to ${prevMonthEnd.slice(0, 7)}`, source: 'GSTR2B_CSV', periodFrom: prevMonthStart, periodTo: prevMonthEnd, csv })
    const diff = rec.lines.find((l) => l.matchStatus === 'VALUE_DIFFERENCE')
    if (diff) reviewRecon(ctx, [diff.id], 'ON_HOLD', 'DEMO: asked the supplier to confirm the invoice value')
  }

  // ── Transport masters linked to a delivery challan.
  db.prepare(`UPDATE transporters SET modes = 'ROAD,RAIL', state_code = '33', contact_person = 'Dispatch Desk' WHERE company_id = ? AND name LIKE 'Swift%'`).run(ctx.companyId)
  db.prepare(`UPDATE transporters SET modes = 'ROAD,AIR', state_code = '29', contact_person = 'Booking Office' WHERE company_id = ? AND name LIKE 'Deccan%'`).run(ctx.companyId)
  const tr = db.prepare('SELECT id FROM transporters WHERE company_id = ? ORDER BY id').all(ctx.companyId) as Array<{ id: number }>
  saveVehicle(ctx, { vehicleNo: 'TN09AB1234', vehicleType: 'REGULAR', bodyType: 'TRUCK', transporterId: tr[0].id, capacityKg: 9000, isOwn: false, isActive: true })
  saveVehicle(ctx, { vehicleNo: 'KA05MN4321', vehicleType: 'REGULAR', bodyType: 'CONTAINER', transporterId: tr[1].id, capacityKg: 16000, isOwn: false, isActive: true })
  saveVehicle(ctx, { vehicleNo: 'TN01CD5678', vehicleType: 'REGULAR', bodyType: 'TEMPO', transporterId: null, capacityKg: 1500, isOwn: true, isActive: true })
  const challan = db.prepare(`SELECT id, doc_date FROM trade_documents WHERE company_id = ? AND doc_type = 'DELIVERY_CHALLAN' AND status = 'POSTED' ORDER BY doc_date DESC, id DESC LIMIT 1`).get(ctx.companyId) as { id: number; doc_date: string } | undefined
  if (challan) {
    const veh = db.prepare(`SELECT id FROM vehicles WHERE company_id = ? AND vehicle_no = 'TN09AB1234'`).get(ctx.companyId) as { id: number }
    saveTransportDoc(ctx, { transportMode: 'ROAD', docNo: 'LR-DEMO-4471', docDate: challan.doc_date, transporterId: tr[0].id, vehicleId: veh.id, sourceKind: 'DELIVERY_CHALLAN', sourceId: challan.id, fromPlace: 'Chennai', toPlace: 'Coimbatore', distanceKm: 510, notes: 'DEMO lorry receipt' })
  }
}

/** Provider calls (async): DEMO IRNs and a DEMO e-way bill for the delivery challan. */
export async function gstAsyncFlows(ctx: ServiceContext, today: Date): Promise<{ einvoices: number; ewayBills: number }> {
  const db = ctx.db
  const mock = new MockEInvoiceProvider()
  const svc = new EInvoiceService(() => mock, { sleep: async () => {} })
  const key = (n: number) => `demo-irn-${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`
  const todayIso = today.toISOString().slice(0, 10)
  const from = new Date(today.getTime() - 25 * 86400000).toISOString().slice(0, 10)
  const ws = svc.workspace(ctx, from, todayIso, todayIso)
  const ready = ws.candidates.filter((c) => c.eligibility.applicable && c.validation.length === 0 && !c.einvoice)
  let n = 0
  let made = 0
  const invoices = ready.filter((c) => c.documentKind === 'SALES_INVOICE')
  const notes = ready.filter((c) => c.documentKind !== 'SALES_INVOICE')
  // Leave a couple of eligible invoices without IRN so the workspace shows pending work.
  const toRegister = [...invoices.slice(0, Math.max(0, invoices.length - 3)), ...notes.slice(0, 1)]
  for (const c of toRegister) {
    await svc.generate(ctx, { documentKind: c.documentKind as 'SALES_INVOICE', documentId: c.documentId, requestKey: key(++n) }, today)
    made++
  }
  const rest = invoices.slice(Math.max(0, invoices.length - 3))
  if (rest[0]) {
    // A request that fails at the provider (three attempts) — shown as FAILED, retryable.
    mock.faults.push('PROVIDER', 'PROVIDER', 'PROVIDER')
    await svc.generate(ctx, { documentKind: 'SALES_INVOICE', documentId: rest[0].documentId, requestKey: key(++n) }, today).catch(() => null)
    made++
  }
  if (rest[1]) {
    // Registered and then cancelled within the window.
    const e = await svc.generate(ctx, { documentKind: 'SALES_INVOICE', documentId: rest[1].documentId, requestKey: key(++n) }, today)
    await svc.cancel(ctx, { id: e.id, reasonCode: 2, remarks: 'DEMO: wrong buyer address on the invoice' }, new Date(today.getTime() + 3600000))
    made++
  }

  let ewayBills = 0
  const challan = db.prepare(`SELECT d.id, d.doc_date, t.id AS tdoc, t.transporter_id, t.vehicle_id, t.distance_km FROM trade_documents d JOIN transport_documents t ON t.source_kind = 'DELIVERY_CHALLAN' AND t.source_id = d.id WHERE d.company_id = ? ORDER BY d.id DESC LIMIT 1`).get(ctx.companyId) as { id: number; tdoc: number; transporter_id: number; vehicle_id: number; distance_km: number } | undefined
  if (challan) {
    const ewb = new EwayBillService(new MockEwayBillProvider(), { sleep: async () => {} })
    await ewb.generate(ctx, { sourceKind: 'DELIVERY_CHALLAN', sourceId: challan.id, requestKey: 'demo-ewb-challan-0000-4000-8000-000000000001', transportMode: 'ROAD', transporterId: challan.transporter_id, vehicleId: challan.vehicle_id, transportDocumentId: challan.tdoc, transportDocNo: null, transportDocDate: null, vehicleNo: null, vehicleType: 'REGULAR', distanceKm: challan.distance_km }, today)
    ewayBills++
  }
  return { einvoices: made, ewayBills }
}
