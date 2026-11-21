/**
 * Phase 4 fixture: a GST-registered company (Tamil Nadu) with one document of every
 * GSTR-1 / GSTR-3B kind in October 2026, posted through the real engine. Amounts are
 * small round numbers so expected return figures can be worked out by hand.
 *
 *  Outward (Oct 2026)                                         Inward (Oct 2026)
 *  INV-A  B2B intra   widget 2 × 1,000  @18%                  P1  TN vendor   widget 5 × 600 @18%   ELIGIBLE
 *  INV-B  B2B inter   service 5 × 2,000 @18% (KA)             P2  MH vendor   gear 10 × 150 @5%     (pending)
 *  INV-C  SEZ + IGST  service 1 × 2,000 @18%                  P3  TN vendor   service 1 × 1,000     INELIGIBLE
 *  INV-D  SEZ, LUT    service 2 × 2,000 @0%                   P4  advocate (unregistered) legal 10,000 @0% → RCM 18%
 *  INV-E  Export, LUT service 3 × 2,000 @0%                   DN1 debit note on P1: widget 1 × 100 @18%
 *  INV-F  B2C Large   service 60 × 2,000 @18% (KA consumer)
 *  INV-G  B2C Small   service 1 × 2,000 @18% (KA consumer)
 *  INV-H  B2B intra   widget 1 × 1,000 @18% + exempt book 10 × 450
 *  CN1    credit note on INV-B: service 1 × 2,000
 *  CN2    credit note on INV-G: service 0.5 × 2,000
 */
import { buildGstin } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { CustomerInput, ProductInput, SupplierInput } from '@shared/schemas'
import { DocumentSaveInput, type DocumentDetail, type DocumentSaveInputT } from '@shared/documents'
import { HsnRateSaveInput } from '@shared/gst'
import { openDatabase, type DB } from '../src/main/db/connection'
import { migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import type { ServiceContext } from '../src/main/services/context'
import { createCompany } from '../src/main/services/company'
import { createCustomer, createSupplier } from '../src/main/services/parties'
import { createProduct, getLookups } from '../src/main/services/products'
import { postOpeningFunds, postOpeningStock } from '../src/main/services/posting'
import { convertDocument, postDocument, saveDraft } from '../src/main/services/documents/engine'
import { importHsnFromProducts, saveHsn, saveHsnRate, saveSettings } from '../src/main/services/gst/config'
import { classifyItc } from '../src/main/services/gst/itc'

export const R = toPaise
export const COMPANY_GSTIN = buildGstin('33', 'AAACT4321Q')

export interface P4 {
  db: DB
  ctx: ServiceContext
  c: Record<'b2bIntra' | 'b2bInter' | 'sez' | 'overseas' | 'consumer', number>
  s: Record<'vendor' | 'vendorOut' | 'advocate', number>
  p: Record<'widget' | 'gear' | 'service' | 'book' | 'legal', number>
  inv: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H', DocumentDetail>
  cn: Record<'CN1' | 'CN2', DocumentDetail>
  pur: Record<'P1' | 'P2' | 'P3' | 'P4' | 'DN1', DocumentDetail>
  wh: number
  save: (input: DocumentSaveInputT) => DocumentDetail
  post: (d: DocumentDetail) => DocumentDetail
}

export function p4Fixture(opts: { aatoCrore?: number; withDocs?: boolean } = {}): P4 {
  const db = openDatabase({ filePath: ':memory:' })
  migrate(db, MIGRATIONS)
  const admin = Number(db.prepare(`INSERT INTO users (username, full_name, password_hash, role_id) VALUES ('gstadmin', 'GST Admin', 'x', (SELECT id FROM roles WHERE code='ADMIN'))`).run().lastInsertRowid)
  const company = createCompany(db, admin, {
    code: 'GST', name: 'GST Test Traders', legalName: 'GST Test Traders Pvt Ltd', gstin: COMPANY_GSTIN, pan: 'AAACT4321Q', stateCode: '33',
    addressLine1: '5 Mount Road', addressLine2: null, city: 'Chennai', pincode: '600002', phone: null, email: null, fyStartMonth: 4
  })
  const ctx: ServiceContext = { db, userId: admin, companyId: company.id }
  const L = getLookups(ctx)
  const tax = (bps: number) => L.taxRates.find((t) => t.rateBps === bps)!.id
  const unit = (code: string) => L.units.find((u) => u.code === code)!.id
  const cust = (code: string, reg: string, state: string, pan: string | null, pin: string | null, individual = false) =>
    createCustomer(ctx, CustomerInput.parse({
      code, name: `Customer ${code}`, partyType: individual ? 'INDIVIDUAL' : 'BUSINESS', gstRegistrationType: reg, gstin: pan ? buildGstin(state, pan) : null, pan, contactPerson: null, phone: null, email: null,
      addressLine1: '1 Test Street', addressLine2: null, city: 'City', stateCode: state, pincode: pin, shippingAddressLine1: null, shippingAddressLine2: null, shippingCity: null,
      shippingStateCode: null, shippingPincode: null, creditLimitPaise: 0, creditDays: 30, openingBalancePaise: 0
    })).id
  const supp = (code: string, reg: string, state: string, pan: string | null) =>
    createSupplier(ctx, SupplierInput.parse({
      code, name: `Supplier ${code}`, gstRegistrationType: reg, gstin: pan ? buildGstin(state, pan) : null, pan, contactPerson: null, phone: null, email: null,
      addressLine1: '9 Supply Lane', addressLine2: null, city: 'City', stateCode: state, pincode: '600010', paymentTermsDays: 30, bankAccountName: null, bankAccountNo: null, bankIfsc: null, openingBalancePaise: 0
    })).id
  const prod = (code: string, type: 'GOODS' | 'SERVICE', hsn: string, bps: number, sale: number, purchase: number, track: boolean) =>
    createProduct(ctx, ProductInput.parse({
      code, name: `Item ${code}`, description: null, itemType: type, categoryId: null, unitId: unit(type === 'GOODS' ? 'NOS' : 'HRS'), hsnSac: hsn, taxRateId: tax(bps),
      salePricePaise: toPaise(sale), purchasePricePaise: toPaise(purchase), mrpPaise: null, reorderLevelMilli: 0, trackInventory: track
    })).id
  const c = {
    b2bIntra: cust('C1', 'REGULAR', '33', 'AABCA1234F', '600020'),
    b2bInter: cust('C2', 'REGULAR', '29', 'AABCB1234F', '560001'),
    sez: cust('C3', 'SEZ', '33', 'AABCC1234F', '600119'),
    overseas: cust('C4', 'OVERSEAS', '96', null, null),
    consumer: cust('C5', 'CONSUMER', '29', null, '560034', true)
  }
  const s = { vendor: supp('S1', 'REGULAR', '33', 'AABCD1234F'), vendorOut: supp('S2', 'REGULAR', '27', 'AABCE1234F'), advocate: supp('S3', 'UNREGISTERED', '33', null) }
  const p = {
    widget: prod('WID', 'GOODS', '84713010', 1800, 1000, 600, true),
    gear: prod('GEAR', 'GOODS', '84831099', 500, 250, 150, true),
    service: prod('SVC', 'SERVICE', '998313', 1800, 2000, 1000, false),
    book: prod('BOOK', 'GOODS', '49011010', 0, 450, 0, false),
    legal: prod('LEGAL', 'SERVICE', '998211', 1800, 0, 10000, false)
  }
  importHsnFromProducts(ctx)
  for (const [code, cat, bps, rcm] of [['84713010', 'TAXABLE', 1800, false], ['84831099', 'TAXABLE', 500, false], ['998313', 'TAXABLE', 1800, false], ['49011010', 'EXEMPT', 0, false], ['998211', 'TAXABLE', 1800, true]] as const)
    saveHsnRate(ctx, HsnRateSaveInput.parse({ hsnCode: code, effectiveFrom: '2017-07-01', taxCategory: cat, rateBps: bps, reverseCharge: rcm }))
  saveSettings(ctx, { aatoPaise: toPaise((opts.aatoCrore ?? 6) * 10000000), aatoFy: '2025-26', einvoiceEnabled: true, einvoiceExemptReason: null, returnFrequency: 'MONTHLY', lutNumber: 'AD330326000001', lutValidFrom: '2026-04-01', lutValidUpto: '2027-03-31' })
  void saveHsn
  const wh = (db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(ctx.companyId) as { id: number }).id
  postOpeningFunds(ctx, '2026-04-01', 0, toPaise(500000))
  postOpeningStock(ctx, [{ productId: p.widget, warehouseId: wh, qtyMilli: toMilli(10), valuePaise: toPaise(6000) }], '2026-04-01')
  const save = (input: DocumentSaveInputT) => saveDraft(ctx, DocumentSaveInput.parse(input))
  const post = (d: DocumentDetail) => postDocument(ctx, d.kind, d.id)
  const out: P4 = { db, ctx, c, s, p, wh, save, post, inv: {} as P4['inv'], cn: {} as P4['cn'], pur: {} as P4['pur'] }
  if (opts.withDocs === false) return out
  const L1 = (productId: number, qty: number, rate: number, taxRateBps?: number) => ({ productId, qtyMilli: toMilli(qty), ratePaise: toPaise(rate), ...(taxRateBps !== undefined ? { taxRateBps } : {}) })
  const sale = (date: string, partyId: number, lines: ReturnType<typeof L1>[]) => post(save({ kind: 'SALES_INVOICE', partyId, date, warehouseId: wh, lines }))
  const buy = (date: string, partyId: number, ref: string, lines: ReturnType<typeof L1>[]) => post(save({ kind: 'PURCHASE_INVOICE', partyId, date, warehouseId: wh, supplierRef: ref, supplierRefDate: date, lines }))
  out.pur.P1 = buy('2026-10-02', s.vendor, 'V1/101', [L1(p.widget, 5, 600)])
  out.pur.P2 = buy('2026-10-03', s.vendorOut, 'MH/2210', [L1(p.gear, 10, 150)])
  out.pur.P3 = buy('2026-10-04', s.vendor, 'V1/102', [L1(p.service, 1, 1000)])
  out.pur.P4 = buy('2026-10-05', s.advocate, 'ADV-17', [L1(p.legal, 1, 10000, 0)])
  out.pur.DN1 = post(convertDocument(ctx, 'PURCHASE_INVOICE', out.pur.P1.id, 'DEBIT_NOTE', { date: '2026-10-20', supplierRef: 'V1/CN/9', reason: 'Rate difference', lines: [{ productId: p.widget, qtyMilli: toMilli(1), ratePaise: toPaise(100), sourceLineId: out.pur.P1.lines[0].id }] }))
  out.inv.A = sale('2026-10-06', c.b2bIntra, [L1(p.widget, 2, 1000)])
  out.inv.B = sale('2026-10-07', c.b2bInter, [L1(p.service, 5, 2000)])
  out.inv.C = sale('2026-10-08', c.sez, [L1(p.service, 1, 2000)])
  out.inv.D = sale('2026-10-09', c.sez, [L1(p.service, 2, 2000, 0)])
  out.inv.E = sale('2026-10-10', c.overseas, [L1(p.service, 3, 2000, 0)])
  out.inv.F = sale('2026-10-11', c.consumer, [L1(p.service, 60, 2000)])
  out.inv.G = sale('2026-10-12', c.consumer, [L1(p.service, 1, 2000)])
  out.inv.H = sale('2026-10-13', c.b2bIntra, [L1(p.widget, 1, 1000), L1(p.book, 10, 450)])
  out.cn.CN1 = post(convertDocument(ctx, 'SALES_INVOICE', out.inv.B.id, 'CREDIT_NOTE', { date: '2026-10-21', reason: 'Discount after sale', lines: [L1(p.service, 1, 2000)] }))
  out.cn.CN2 = post(convertDocument(ctx, 'SALES_INVOICE', out.inv.G.id, 'CREDIT_NOTE', { date: '2026-10-22', reason: 'Partial service credit', lines: [L1(p.service, 0.5, 2000)] }))
  classifyItc(ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: out.pur.P1.id }], eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null })
  classifyItc(ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: out.pur.P3.id }], eligibility: 'INELIGIBLE', itcType: 'INPUT_SERVICES', reverseCharge: false, reason: 'Used for exempt supplies' })
  classifyItc(ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: out.pur.P4.id }], eligibility: 'ELIGIBLE', itcType: 'INPUT_SERVICES', reverseCharge: true, reason: null })
  return out
}
