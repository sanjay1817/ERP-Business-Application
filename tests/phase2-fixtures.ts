import { buildGstin } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { CustomerInput, ProductInput, SupplierInput } from '@shared/schemas'
import { DocumentSaveInput, type DocumentDetail, type DocumentKind, type DocumentSaveInputT } from '@shared/documents'
import type { DB } from '../src/main/db/connection'
import type { ServiceContext } from '../src/main/services/context'
import { createCustomer, createSupplier, getCustomer, getSupplier } from '../src/main/services/parties'
import { createProduct, getLookups } from '../src/main/services/products'
import { postOpeningFunds, postOpeningStock } from '../src/main/services/posting'
import { postDocument, saveDraft } from '../src/main/services/documents/engine'
import { accountId } from '../src/main/services/ledger'
import { emptyCompanyDb } from './helpers'

/** Dates safely in the past within FY 2026-27. */
export const D1 = '2026-10-01'
export const D2 = '2026-10-05'
export const D3 = '2026-10-10'

export interface Fixture {
  db: DB
  ctx: ServiceContext
  wh: number
  bank: number
  cash: number
  intra: number // customer in Tamil Nadu (same state as company)
  inter: number // customer in Karnataka
  sez: number // SEZ customer in Tamil Nadu
  vendor: number // supplier in Tamil Nadu
  vendorOut: number // supplier in Maharashtra
  widget: number // goods, 18 %, stocked
  gear: number // goods, 5 %, stocked
  service: number // service, 18 %
  save: (input: DocumentSaveInputT) => DocumentDetail
  post: (doc: DocumentDetail) => DocumentDetail
  stock: (productId: number) => number
  stockValue: () => number
  ledger: (key: Parameters<typeof accountId>[2]) => number
  customerBalance: (id: number) => number
  supplierBalance: (id: number) => number
  count: (sql: string, ...p: unknown[]) => number
}

export function fixture(): Fixture {
  const { db, ctx: base } = emptyCompanyDb()
  const admin = Number(db.prepare(`INSERT INTO users (username, full_name, password_hash, role_id) VALUES ('tester', 'Test User', 'x', (SELECT id FROM roles WHERE code='ADMIN'))`).run().lastInsertRowid)
  const ctx: ServiceContext = { ...base, userId: admin }
  const L = getLookups(ctx)
  const tax = (bps: number) => L.taxRates.find((t) => t.rateBps === bps)!.id
  const unit = (code: string) => L.units.find((u) => u.code === code)!.id
  const party = (code: string, state: string, pan: string, reg = 'REGULAR') => ({
    code, name: `Party ${code}`, gstRegistrationType: reg, gstin: buildGstin(state, pan), pan, contactPerson: null, phone: null, email: null,
    addressLine1: '1 Test Street', addressLine2: null, city: 'City', stateCode: state, pincode: null
  })
  const cust = (code: string, state: string, pan: string, reg = 'REGULAR') =>
    createCustomer(ctx, CustomerInput.parse({ ...party(code, state, pan, reg), partyType: 'BUSINESS', creditLimitPaise: 0, creditDays: 30, openingBalancePaise: 0 })).id
  const supp = (code: string, state: string, pan: string) =>
    createSupplier(ctx, SupplierInput.parse({ ...party(code, state, pan), paymentTermsDays: 30, bankAccountName: null, bankAccountNo: null, bankIfsc: null, openingBalancePaise: 0 })).id
  const prod = (code: string, type: 'GOODS' | 'SERVICE', bps: number, sale: number, purchase: number) =>
    createProduct(ctx, ProductInput.parse({
      code, name: `Item ${code}`, description: null, itemType: type, categoryId: null, unitId: unit(type === 'GOODS' ? 'NOS' : 'HRS'),
      hsnSac: type === 'GOODS' ? '84713010' : '998313', taxRateId: tax(bps), salePricePaise: toPaise(sale), purchasePricePaise: toPaise(purchase),
      mrpPaise: null, reorderLevelMilli: 0, trackInventory: type === 'GOODS'
    })).id

  const f = {
    db, ctx,
    wh: (db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(ctx.companyId) as { id: number }).id,
    bank: accountId(db, ctx.companyId, 'BANK'),
    cash: accountId(db, ctx.companyId, 'CASH'),
    intra: cust('C1', '33', 'AABCA1234F'),
    inter: cust('C2', '29', 'AABCB1234F'),
    sez: cust('C3', '33', 'AABCC1234F', 'SEZ'),
    vendor: supp('S1', '33', 'AABCD1234F'),
    vendorOut: supp('S2', '27', 'AABCE1234F'),
    widget: prod('WID', 'GOODS', 1800, 1000, 600),
    gear: prod('GEAR', 'GOODS', 500, 250, 150),
    service: prod('SVC', 'SERVICE', 1800, 2000, 0)
  }
  postOpeningFunds(ctx, '2026-04-01', 0, toPaise(500000))
  postOpeningStock(ctx, [{ productId: f.widget, warehouseId: f.wh, qtyMilli: toMilli(10), valuePaise: toPaise(6000) }], '2026-04-01')
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Record<string, number>
  return {
    ...f,
    save: (input) => saveDraft(ctx, DocumentSaveInput.parse(input)),
    post: (doc) => postDocument(ctx, doc.kind as DocumentKind, doc.id),
    stock: (productId) => one('SELECT COALESCE(SUM(qty_milli),0) q FROM stock_balances WHERE product_id = ?', productId).q,
    stockValue: () => one('SELECT COALESCE(SUM(value_paise),0) v FROM stock_balances WHERE company_id = ?', ctx.companyId).v,
    ledger: (key) => one('SELECT COALESCE(SUM(debit_paise - credit_paise),0) b FROM journal_entry_lines WHERE account_id = ?', accountId(db, ctx.companyId, key)).b,
    customerBalance: (id) => getCustomer(ctx, id).balancePaise,
    supplierBalance: (id) => getSupplier(ctx, id).balancePaise,
    count: (sql, ...p) => (db.prepare(sql).get(...p) as { n: number }).n
  }
}
