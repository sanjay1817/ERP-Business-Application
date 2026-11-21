/**
 * Large-dataset generator for Phase 5 reliability checks. Everything is posted
 * through the real services (posting engine, payments, cancellations), so the
 * data has the same shape — journals, stock movements, allocations, audit rows —
 * as data entered through the application.
 */
import { buildGstin } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { CustomerInput, ProductInput, SupplierInput } from '@shared/schemas'
import { DocumentSaveInput, type DocumentKind } from '@shared/documents'
import { openDatabase, type DB } from '../src/main/db/connection'
import { migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import type { ServiceContext } from '../src/main/services/context'
import { createCompany } from '../src/main/services/company'
import { markEnvironment } from '../src/main/db/bootstrap'
import { createCustomer, createSupplier } from '../src/main/services/parties'
import { createProduct, getLookups } from '../src/main/services/products'
import { postOpeningFunds, postOpeningStock } from '../src/main/services/posting'
import { cancelDocument, convertDocument, postDocument, saveDraft } from '../src/main/services/documents/engine'
import { createPayment } from '../src/main/services/documents/payments'
import { accountId } from '../src/main/services/ledger'
import { hashPassword } from '../src/main/services/password'

export interface ScaleOptions {
  sales: number
  purchases: number
  customers?: number
  suppliers?: number
  products?: number
  /** Last date used; documents are spread from 1 April of that financial year. */
  lastDate?: string
  onProgress?: (done: number, total: number) => void
}

export interface ScaleCompany {
  db: DB
  ctx: ServiceContext
  bank: number
  wh: number
  customers: number[]
  goods: number[]
  services: number[]
  suppliers: number[]
  /** Post one more sales invoice (used by the interruption test). */
  postSale: (i: number) => number
}

/** Deterministic pseudo-random sequence so runs are comparable. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const pan = (prefix: string, i: number) => `${prefix}${String.fromCharCode(65 + (i % 26))}${String(i % 10000).padStart(4, '0')}${String.fromCharCode(65 + ((i * 7) % 26))}`

export function setupScaleCompany(path: string, o: Pick<ScaleOptions, 'customers' | 'suppliers' | 'products'> = {}): ScaleCompany {
  const db = openDatabase({ filePath: path })
  migrate(db, MIGRATIONS)
  const userId = Number(db.prepare(`INSERT INTO users (username, full_name, password_hash, role_id) VALUES ('owner', 'Owner', ?, (SELECT id FROM roles WHERE code='ADMIN'))`).run(hashPassword('ScaleTest2026')).lastInsertRowid)
  const company = createCompany(db, userId, {
    code: 'SCALE', name: 'Scale Test Traders', legalName: 'Scale Test Traders Pvt Ltd', gstin: buildGstin('33', 'AABCS9999K'), pan: 'AABCS9999K', stateCode: '33',
    addressLine1: '1 Test Road', addressLine2: null, city: 'Chennai', pincode: '600001', phone: null, email: null, fyStartMonth: 4
  })
  db.prepare('UPDATE users SET default_company_id = ? WHERE id = ?').run(company.id, userId)
  markEnvironment(db, 'COMPANY')
  const ctx: ServiceContext = { db, userId, companyId: company.id }
  const L = getLookups(ctx)
  const tax = (bps: number) => L.taxRates.find((t) => t.rateBps === bps)!.id
  const unit = (code: string) => L.units.find((u) => u.code === code)!.id
  const nCust = o.customers ?? 300
  const nSupp = o.suppliers ?? 60
  const nProd = o.products ?? 150
  const customers: number[] = []
  for (let i = 0; i < nCust; i++) {
    const consumer = i % 10 === 9
    const state = i % 5 === 4 ? '29' : '33'
    const p = pan('AABC', i + 100)
    customers.push(
      createCustomer(ctx, CustomerInput.parse({
        code: `C${String(i).padStart(5, '0')}`, name: `Customer ${i}`, gstRegistrationType: consumer ? 'CONSUMER' : 'REGULAR', gstin: consumer ? null : buildGstin(state, p), pan: consumer ? null : p,
        contactPerson: null, phone: null, email: null, addressLine1: `${i} Market Street`, addressLine2: null, city: 'City', stateCode: state, pincode: state === '33' ? '600002' : '560001',
        partyType: consumer ? 'INDIVIDUAL' : 'BUSINESS', creditLimitPaise: 0, creditDays: 30, openingBalancePaise: 0
      })).id
    )
  }
  const suppliers: number[] = []
  for (let i = 0; i < nSupp; i++) {
    const state = i % 4 === 3 ? '27' : '33'
    const p = pan('AABS', i + 300)
    suppliers.push(
      createSupplier(ctx, SupplierInput.parse({
        code: `S${String(i).padStart(4, '0')}`, name: `Supplier ${i}`, gstRegistrationType: 'REGULAR', gstin: buildGstin(state, p), pan: p, contactPerson: null, phone: null, email: null,
        addressLine1: `${i} Industrial Estate`, addressLine2: null, city: 'City', stateCode: state, pincode: null, paymentTermsDays: 30, bankAccountName: null, bankAccountNo: null, bankIfsc: null, openingBalancePaise: 0
      })).id
    )
  }
  const goods: number[] = []
  const services: number[] = []
  const rates = [500, 1800, 1800, 1800, 4000]
  for (let i = 0; i < nProd; i++) {
    const service = i % 6 === 5
    const id = createProduct(ctx, ProductInput.parse({
      code: `P${String(i).padStart(5, '0')}`, name: `${service ? 'Service' : 'Item'} ${i}`, description: null, itemType: service ? 'SERVICE' : 'GOODS', categoryId: null,
      unitId: unit(service ? 'HRS' : 'NOS'), hsnSac: service ? '998313' : '84713010', taxRateId: tax(service ? 1800 : rates[i % rates.length]),
      salePricePaise: toPaise(100 + (i % 50) * 37), purchasePricePaise: toPaise(60 + (i % 50) * 21), mrpPaise: null, reorderLevelMilli: 0, trackInventory: !service
    })).id
    ;(service ? services : goods).push(id)
  }
  const wh = (db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(company.id) as { id: number }).id
  postOpeningFunds(ctx, '2026-04-01', toPaise(500000), toPaise(1_000_000_000))
  postOpeningStock(ctx, goods.map((g, i) => ({ productId: g, warehouseId: wh, qtyMilli: toMilli(100000), valuePaise: toPaise(100000 * (60 + (i % 50) * 21)) })), '2026-04-01')
  const bank = accountId(db, company.id, 'BANK')
  const r = rng(7)
  const postSale = (i: number): number => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
      const svc = r() < 0.15
      const list = svc ? services : goods
      return { productId: list[Math.floor(r() * list.length)], qtyMilli: toMilli(1 + Math.floor(r() * 9)), ratePaise: toPaise(150 + Math.floor(r() * 4000)) }
    })
    const draft = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: customers[i % customers.length], date: '2026-11-14', warehouseId: wh, lines }))
    return postDocument(ctx, 'SALES_INVOICE', draft.id).id
  }
  return { db, ctx, bank, wh, customers, goods, services, suppliers, postSale }
}

/** Let the event loop breathe during long synchronous posting runs (test runners time out otherwise). */
const yieldNow = () => new Promise<void>((r) => setImmediate(r))

/** Build the full dataset. Returns per-phase timings in ms. */
export async function buildScaleData(sc: ScaleCompany, o: ScaleOptions): Promise<Record<string, number>> {
  const { ctx, wh, bank } = sc
  const r = rng(42)
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const last = new Date(`${o.lastDate ?? '2026-11-14'}T00:00:00Z`).getTime()
  const first = new Date('2026-04-02T00:00:00Z').getTime()
  const dateAt = (i: number, n: number) => new Date(first + Math.floor(((last - first) * i) / Math.max(1, n - 1))).toISOString().slice(0, 10)
  const total = o.sales + o.purchases
  const t: Record<string, number> = {}

  let t0 = Date.now()
  for (let i = 0; i < o.purchases; i++) {
    const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({ productId: pick(sc.goods), qtyMilli: toMilli(10 + Math.floor(r() * 90)), ratePaise: toPaise(50 + Math.floor(r() * 1500)) }))
    const d = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'PURCHASE_INVOICE', partyId: sc.suppliers[i % sc.suppliers.length], date: dateAt(i, o.purchases), supplierRef: `BILL-${i}`, warehouseId: wh, lines }))
    const p = postDocument(ctx, 'PURCHASE_INVOICE', d.id)
    if (i % 3 === 0) createPayment(ctx, { type: 'PAYMENT', partyId: sc.suppliers[i % sc.suppliers.length], date: dateAt(i, o.purchases), amountPaise: p.grandTotalPaise, mode: 'BANK_TRANSFER', accountId: bank, referenceNo: `PAY-${i}`, allocations: [{ invoiceId: p.id, amountPaise: p.grandTotalPaise }] })
    o.onProgress?.(i + 1, total)
    if (i % 50 === 49) await yieldNow()
  }
  t.purchasesMs = Date.now() - t0

  t0 = Date.now()
  let receipts = 0, credits = 0, cancels = 0
  for (let i = 0; i < o.sales; i++) {
    const date = dateAt(i, o.sales)
    const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
      const svc = r() < 0.15
      return { productId: pick(svc ? sc.services : sc.goods), qtyMilli: toMilli(1 + Math.floor(r() * 9)), ratePaise: toPaise(150 + Math.floor(r() * 4000)) }
    })
    const cust = sc.customers[i % sc.customers.length]
    const d = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: cust, date, warehouseId: wh, lines }))
    const inv = postDocument(ctx, 'SALES_INVOICE' as DocumentKind, d.id)
    if (i % 100 === 37) {
      cancelDocument(ctx, 'SALES_INVOICE', inv.id, 'Raised in error (scale test)')
      cancels++
    } else if (i % 50 === 11) {
      const cn = convertDocument(ctx, 'SALES_INVOICE', inv.id, 'CREDIT_NOTE', { date, reason: 'Rate difference', lines: [{ productId: sc.services[0], qtyMilli: toMilli(1), ratePaise: toPaise(100) }] })
      postDocument(ctx, 'CREDIT_NOTE', cn.id)
      credits++
    } else if (r() < 0.6) {
      const amt = r() < 0.7 ? inv.grandTotalPaise : Math.max(100, Math.floor(inv.grandTotalPaise / 2))
      createPayment(ctx, { type: 'RECEIPT', partyId: cust, date, amountPaise: amt, mode: 'UPI', accountId: bank, referenceNo: `RCPT-${i}`, allocations: [{ invoiceId: inv.id, amountPaise: amt }] })
      receipts++
    }
    o.onProgress?.(o.purchases + i + 1, total)
    if (i % 50 === 49) await yieldNow()
  }
  t.salesMs = Date.now() - t0
  t.receipts = receipts
  t.creditNotes = credits
  t.cancellations = cancels
  return t
}
