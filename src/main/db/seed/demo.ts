/**
 * DEMO company seed. All transactions go through the real posting engine, so
 * stock, ledgers and dashboard figures are derived exactly as in production.
 * The business profile is a generic IT products & services trader.
 */
import type { DB } from '../connection'
import { buildGstin, financialYearOf, financialYearRange } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { createCompany } from '../../services/company'
import type { ServiceContext } from '../../services/context'
import { EwayBillService } from '../../services/ewaybill/service'
import { MockEwayBillProvider } from '../../services/ewaybill/mock-provider'
import { createCustomer, createSupplier } from '../../services/parties'
import { postOpeningFunds, postOpeningStock, postPurchaseInvoice, postSalesInvoice } from '../../services/posting'
import { createPayment } from '../../services/documents/payments'
import { accountId } from '../../services/ledger'
import { phase2Flows } from './flows'
import { financeFlows } from './finance-flows'
import { gstAsyncFlows, gstFlows } from './gst-flows'
import { createProduct } from '../../services/products'
import { writeAudit } from '../../services/audit'
import { CustomerInput, ProductInput, SupplierInput } from '@shared/schemas'

export const DEMO_COMPANY_CODE = 'DEMO'

/** Small deterministic PRNG so demo data is identical on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CUSTOMERS = [
  { code: 'C001', name: 'Vertex Software Solutions Pvt Ltd', state: '33', city: 'Chennai', pan: 'AAFCV2231K', type: 'REGULAR', credit: 500000, days: 30, opening: 85000 },
  { code: 'C002', name: 'Kaveri Engineering Works', state: '33', city: 'Coimbatore', pan: 'AAKFK7712D', type: 'REGULAR', credit: 300000, days: 30, opening: 0 },
  { code: 'C003', name: 'Bluewave Logistics LLP', state: '29', city: 'Bengaluru', pan: 'AAPFB4410Q', type: 'REGULAR', credit: 400000, days: 45, opening: 42500 },
  { code: 'C004', name: 'Sunrise Hospitals Ltd', state: '32', city: 'Kochi', pan: 'AABCS9087M', type: 'REGULAR', credit: 800000, days: 45, opening: 0 },
  { code: 'C005', name: 'Deccan Retail Ventures Pvt Ltd', state: '36', city: 'Hyderabad', pan: 'AAGCD5521H', type: 'REGULAR', credit: 600000, days: 30, opening: 0 },
  { code: 'C006', name: 'Pinnacle Academy of Learning', state: '33', city: 'Madurai', pan: 'AAATP3324B', type: 'REGULAR', credit: 150000, days: 15, opening: 0 },
  { code: 'C007', name: 'Coastal Agro Exports', state: '37', city: 'Visakhapatnam', pan: 'AAOFC8865L', type: 'REGULAR', credit: 250000, days: 30, opening: 0 },
  { code: 'C008', name: 'Metro Design Studio', state: '27', city: 'Pune', pan: 'AHNPM6612R', type: 'COMPOSITION', credit: 100000, days: 15, opening: 0 },
  { code: 'C009', name: 'Greenfield Textiles Pvt Ltd', state: '33', city: 'Tiruppur', pan: 'AADCG1198E', type: 'REGULAR', credit: 350000, days: 30, opening: 0 },
  { code: 'C010', name: 'Ravi Kumar (Walk-in)', state: '33', city: 'Chennai', pan: null, type: 'CONSUMER', credit: 0, days: 0, opening: 0 }
] as const

/** Representative PIN codes so DEMO e-invoice / e-way bill validations have complete addresses. */
const CITY_PIN: Record<string, string> = {
  Chennai: '600002', Coimbatore: '641001', Bengaluru: '560001', Kochi: '682011', Hyderabad: '500001', Madurai: '625001', Visakhapatnam: '530001',
  Pune: '411001', Tiruppur: '641601', Mumbai: '400001', Sivakasi: '626123'
}

const SUPPLIERS = [
  { code: 'S001', name: 'Nexa Computer Distributors Pvt Ltd', state: '33', city: 'Chennai', pan: 'AADCN4471P', terms: 30, opening: 120000 },
  { code: 'S002', name: 'Prime Peripherals India Pvt Ltd', state: '27', city: 'Mumbai', pan: 'AAGCP8823J', terms: 45, opening: 0 },
  { code: 'S003', name: 'Southern Networking Supplies', state: '29', city: 'Bengaluru', pan: 'ABBFS2290N', terms: 30, opening: 0 },
  { code: 'S004', name: 'Comfort Office Furniture Co', state: '33', city: 'Chennai', pan: 'AAJFC6634G', terms: 15, opening: 0 },
  { code: 'S005', name: 'Paperline Stationery Mart', state: '33', city: 'Sivakasi', pan: 'AAIFP1157C', terms: 15, opening: 0 }
] as const

// [code, name, type, category, unit, hsn/sac, gst%, sale ₹, purchase ₹, reorder, opening qty, supplier]
type P = [string, string, 'GOODS' | 'SERVICE', string, string, string, number, number, number, number, number, string | null]
const PRODUCTS: P[] = [
  ['LAP-14I5', 'Business Laptop 14" (i5, 16GB, 512GB SSD)', 'GOODS', 'Computers', 'NOS', '84713010', 18, 62500, 54200, 5, 18, 'S001'],
  ['DT-I5', 'Desktop PC (i5, 16GB, 1TB)', 'GOODS', 'Computers', 'NOS', '84714190', 18, 48900, 42100, 4, 12, 'S001'],
  ['MON-24', '24" Full HD LED Monitor', 'GOODS', 'Peripherals', 'NOS', '85285200', 18, 11800, 9650, 8, 30, 'S002'],
  ['KBM-WL', 'Wireless Keyboard & Mouse Combo', 'GOODS', 'Peripherals', 'NOS', '84716060', 18, 1650, 1180, 20, 80, 'S002'],
  ['PRN-LJ', 'Mono Laser Printer (Duplex, Wi-Fi)', 'GOODS', 'Peripherals', 'NOS', '84433100', 18, 18900, 15600, 3, 9, 'S002'],
  ['TNR-88A', 'Laser Toner Cartridge (Black)', 'GOODS', 'Office Supplies', 'NOS', '84439959', 18, 2450, 1790, 25, 60, 'S005'],
  ['UPS-1K', 'Line-Interactive UPS 1 kVA', 'GOODS', 'Peripherals', 'NOS', '85044010', 18, 6200, 4950, 6, 22, 'S002'],
  ['SSD-1TB', 'Portable SSD 1 TB (USB-C)', 'GOODS', 'Peripherals', 'NOS', '85235100', 18, 7900, 6350, 10, 24, 'S002'],
  ['SW-24G', '24-Port Gigabit Managed Switch', 'GOODS', 'Networking', 'NOS', '85176290', 18, 21500, 17200, 3, 8, 'S003'],
  ['RTR-AX', 'Wi-Fi 6 Business Router', 'GOODS', 'Networking', 'NOS', '85176290', 18, 9800, 7650, 5, 14, 'S003'],
  ['CAB-C6', 'CAT6 UTP Cable Box (305 m)', 'GOODS', 'Networking', 'BOX', '85444299', 18, 8600, 6900, 6, 4, 'S003'],
  ['CHR-ERG', 'Ergonomic Office Chair (Mesh)', 'GOODS', 'Furniture', 'NOS', '94013000', 18, 9400, 7100, 6, 25, 'S004'],
  ['DSK-1460', 'Office Workstation Desk 1400x600', 'GOODS', 'Furniture', 'NOS', '94033090', 18, 12800, 9900, 4, 10, 'S004'],
  ['PPR-A4', 'A4 Copier Paper 75 GSM (Ream)', 'GOODS', 'Office Supplies', 'NOS', '48025690', 18, 320, 248, 100, 400, 'S005'],
  ['SVC-AMC', 'Annual Maintenance Contract (per device)', 'SERVICE', 'Services', 'NOS', '998713', 18, 4500, 0, 0, 0, null],
  ['SVC-INST', 'Installation & Configuration', 'SERVICE', 'Services', 'NOS', '998732', 18, 2500, 0, 0, 0, null],
  ['SVC-NET', 'Network Design & Cabling Labour', 'SERVICE', 'Services', 'HRS', '998717', 18, 1200, 0, 0, 0, null],
  ['SVC-CONS', 'IT Consulting', 'SERVICE', 'Services', 'HRS', '998313', 18, 3500, 0, 0, 0, null],
  ['SVC-TRN', 'End-User Training Session', 'SERVICE', 'Services', 'NOS', '999293', 18, 8000, 0, 0, 0, null],
  ['SVC-CLD', 'Managed Cloud Backup (monthly)', 'SERVICE', 'Services', 'NOS', '998315', 18, 3200, 0, 0, 0, null]
]

const iso = (d: Date): string => d.toISOString().slice(0, 10)

export interface DemoSeedResult {
  companyId: number
  customers: number
  suppliers: number
  products: number
  warehouses: number
  salesInvoices: number
  purchaseInvoices: number
  receipts: number
  payments: number
  ewayBills: number
}

export async function seedDemoCompany(db: DB, userId: number, today = new Date()): Promise<DemoSeedResult> {
  const todayIso = iso(today)
  const fy = financialYearOf(todayIso)
  const fyStart = financialYearRange(fy).from
  const rand = mulberry32(20260401)
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
  const between = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1))

  const companyGstin = buildGstin('33', 'AAKCS4821M')
  const company = createCompany(
    db,
    userId,
    {
      code: DEMO_COMPANY_CODE,
      name: 'SA Demo Enterprises (DEMO)',
      legalName: 'SA Demo Enterprises Private Limited — DEMONSTRATION DATA',
      gstin: companyGstin,
      pan: 'AAKCS4821M',
      stateCode: '33',
      addressLine1: '12, Demo Tech Park, Anna Salai',
      addressLine2: 'Teynampet',
      city: 'Chennai',
      pincode: '600018',
      phone: '044-40000000',
      email: 'demo@example.com',
      fyStartMonth: 4,
      bankName: 'Demo Bank Ltd (DEMO)',
      bankAccountNo: '000011112222',
      bankIfsc: 'DEMO0001234',
      bankBranch: 'Anna Salai, Chennai',
      upiId: 'sademo@demobank',
      invoiceTerms: [
        '1. Payment due within the agreed credit period; interest at 18% p.a. on overdue amounts.',
        '2. Goods once sold will be taken back only as per warranty terms.',
        '3. Subject to Chennai jurisdiction.'
      ].join('\n')
    },
    { isDemo: true }
  )
  const ctx: ServiceContext = { db, userId, companyId: company.id }

  const result = db.transaction(() => {
    // Warehouses (MAIN is created with the company).
    db.prepare(`INSERT INTO warehouses (company_id, code, name, city, state_code, pincode) VALUES (?, 'CBE', 'Coimbatore Depot', 'Coimbatore', '33', '641018')`).run(company.id)
    db.prepare(`INSERT INTO warehouses (company_id, code, name, city, state_code, pincode) VALUES (?, 'SVC', 'Service Spares Store', 'Chennai', '33', '600032')`).run(company.id)
    const wh = db.prepare('SELECT id, code FROM warehouses WHERE company_id = ? ORDER BY id').all(company.id) as Array<{ id: number; code: string }>
    const whId = (code: string) => wh.find((w) => w.code === code)!.id

    db.prepare(`INSERT INTO transporters (company_id, name, transporter_id, phone) VALUES (?, 'Swift Road Carriers', ?, '9840000001')`).run(company.id, buildGstin('33', 'ABCFS7781K'))
    db.prepare(`INSERT INTO transporters (company_id, name, transporter_id, phone) VALUES (?, 'Deccan Express Logistics', ?, '9840000002')`).run(company.id, buildGstin('29', 'AADCD3349L'))

    const catId = new Map<string, number>()
    for (const name of [...new Set(PRODUCTS.map((p) => p[3]))]) {
      catId.set(name, Number(db.prepare('INSERT INTO categories (company_id, name) VALUES (?, ?)').run(company.id, name).lastInsertRowid))
    }
    const unitId = (code: string) => (db.prepare('SELECT id FROM units WHERE code = ?').get(code) as { id: number }).id
    const taxId = (pct: number) => (db.prepare('SELECT id FROM tax_rates WHERE rate_bps = ?').get(pct * 100) as { id: number }).id

    const customers = CUSTOMERS.map((c) =>
      createCustomer(ctx, CustomerInput.parse({
        code: c.code, name: c.name, partyType: c.type === 'CONSUMER' ? 'INDIVIDUAL' : 'BUSINESS', gstRegistrationType: c.type,
        gstin: c.pan ? buildGstin(c.state, c.pan) : null, pan: c.pan, contactPerson: c.type === 'CONSUMER' ? null : 'Accounts Department',
        phone: `98${String(between(10000000, 99999999))}`, email: c.type === 'CONSUMER' ? null : `accounts@${c.code.toLowerCase()}.example.com`,
        addressLine1: `${between(1, 250)}, Main Road`, addressLine2: null, city: c.city, stateCode: c.state, pincode: CITY_PIN[c.city] ?? null,
        shippingAddressLine1: null, shippingAddressLine2: null, shippingCity: null, shippingStateCode: null, shippingPincode: null,
        creditLimitPaise: toPaise(c.credit), creditDays: c.days, openingBalancePaise: toPaise(c.opening)
      }))
    )
    const suppliers = SUPPLIERS.map((s) =>
      createSupplier(ctx, SupplierInput.parse({
        code: s.code, name: s.name, gstRegistrationType: 'REGULAR', gstin: buildGstin(s.state, s.pan), pan: s.pan, contactPerson: 'Sales Desk',
        phone: `99${String(between(10000000, 99999999))}`, email: `sales@${s.code.toLowerCase()}.example.com`, addressLine1: `${between(1, 99)}, Industrial Estate`,
        addressLine2: null, city: s.city, stateCode: s.state, pincode: CITY_PIN[s.city] ?? null, paymentTermsDays: s.terms, bankAccountName: null, bankAccountNo: null, bankIfsc: null,
        openingBalancePaise: toPaise(s.opening)
      }))
    )
    const products = PRODUCTS.map((p) =>
      createProduct(ctx, ProductInput.parse({
        code: p[0], name: p[1], description: null, itemType: p[2], categoryId: catId.get(p[3]) ?? null, unitId: unitId(p[4]), hsnSac: p[5], taxRateId: taxId(p[6]),
        salePricePaise: toPaise(p[7]), purchasePricePaise: toPaise(p[8]), mrpPaise: null, reorderLevelMilli: toMilli(p[9]), trackInventory: p[2] === 'GOODS'
      }))
    )
    const productByCode = new Map(products.map((p) => [p.code, p]))

    // Opening funds & stock at the start of the financial year.
    postOpeningFunds(ctx, fyStart, toPaise(250000), toPaise(2500000))
    const opening: Array<{ productId: number; warehouseId: number; qtyMilli: number; valuePaise: number }> = []
    for (const p of PRODUCTS.filter((x) => x[2] === 'GOODS')) {
      const prod = productByCode.get(p[0])!
      const total = p[10]
      const cbe = Math.floor(total * 0.25)
      const main = total - cbe
      opening.push({ productId: prod.id, warehouseId: whId('MAIN'), qtyMilli: toMilli(main), valuePaise: toPaise(main * p[8]) })
      if (cbe > 0) opening.push({ productId: prod.id, warehouseId: whId('CBE'), qtyMilli: toMilli(cbe), valuePaise: toPaise(cbe * p[8]) })
    }
    // Service spares store holds a few spare units for AMC work.
    opening.push({ productId: productByCode.get('KBM-WL')!.id, warehouseId: whId('SVC'), qtyMilli: toMilli(10), valuePaise: toPaise(10 * 1180) })
    opening.push({ productId: productByCode.get('UPS-1K')!.id, warehouseId: whId('SVC'), qtyMilli: toMilli(3), valuePaise: toPaise(3 * 4950) })
    postOpeningStock(ctx, opening, fyStart)

    // Spread transactions over the last ~150 days, never before FY start or after today.
    const start = new Date(Math.max(new Date(`${fyStart}T00:00:00Z`).getTime(), today.getTime() - 150 * 86400000))
    const span = Math.max(1, Math.floor((today.getTime() - start.getTime()) / 86400000))
    const dateAt = (frac: number) => iso(new Date(start.getTime() + Math.floor(frac * span) * 86400000))

    type Event = { date: string; kind: 'PUR' | 'SALE'; seq: number }
    const events: Event[] = []
    for (let i = 0; i < 10; i++) events.push({ date: dateAt((i + rand() * 0.8) / 10), kind: 'PUR', seq: i })
    for (let i = 0; i < 36; i++) events.push({ date: dateAt(Math.min(0.999, (i + 0.5 + rand() * 0.5) / 36)), kind: 'SALE', seq: i })
    events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'PUR' ? -1 : 1))

    const goods = products.filter((p) => p.itemType === 'GOODS')
    const services = products.filter((p) => p.itemType === 'SERVICE')
    const available = (productId: number, warehouseId: number) =>
      (db.prepare('SELECT COALESCE(qty_milli,0) q FROM stock_balances WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId) as { q: number } | undefined)?.q ?? 0

    let salesCount = 0
    let purchaseCount = 0
    const salesDocs: Array<{ id: number; customerId: number; date: string; total: number; days: number }> = []
    const purchaseDocs: Array<{ id: number; supplierId: number; date: string; total: number; days: number }> = []
    const lowStockCodes = new Set(['CAB-C6', 'PRN-LJ', 'SW-24G'])

    for (const ev of events) {
      if (ev.kind === 'PUR') {
        const supplierRow = SUPPLIERS[ev.seq % SUPPLIERS.length]
        const supplier = suppliers.find((s) => s.code === supplierRow.code)!
        const items = PRODUCTS.filter((p) => p[11] === supplierRow.code && !lowStockCodes.has(p[0]))
        if (items.length === 0) continue
        const lines = items.slice(0, between(1, Math.min(3, items.length))).map((p) => ({
          productId: productByCode.get(p[0])!.id,
          qtyMilli: toMilli(p[8] < 1000 ? between(25, 60) : p[8] > 30000 ? between(2, 4) : between(3, 6)),
          ratePaise: toPaise(p[8]),
          discountPaise: 0
        }))
        const res = postPurchaseInvoice(ctx, {
          supplierId: supplier.id, invoiceDate: ev.date, supplierInvoiceNo: `${supplierRow.code.slice(1)}/${ev.date.slice(2, 4)}-${String(1000 + ev.seq * 7)}`,
          supplierInvoiceDate: ev.date, warehouseId: whId('MAIN'), lines
        })
        const total = (db.prepare('SELECT grand_total_paise t FROM purchase_invoices WHERE id = ?').get(res.id) as { t: number }).t
        purchaseDocs.push({ id: res.id, supplierId: supplier.id, date: ev.date, total, days: supplier.paymentTermsDays })
        purchaseCount++
      } else {
        const customer = customers[ev.seq % customers.length]
        const wid = ev.seq % 5 === 4 ? whId('CBE') : whId('MAIN')
        const lines: Array<{ productId: number; qtyMilli: number; ratePaise: number; discountPaise: number }> = []
        const used = new Set<number>()
        const goodsLines = customer.gstRegistrationType === 'CONSUMER' ? 1 : between(1, 3)
        for (let i = 0; i < goodsLines; i++) {
          const p = pick(goods)
          if (used.has(p.id)) continue
          const want = toMilli(p.salePricePaise < toPaise(1000) ? between(15, 50) : between(2, 5))
          const qty = Math.min(want, available(p.id, wid) - (lowStockCodes.has(p.code) ? 0 : toMilli(1)))
          if (qty < toMilli(1)) continue
          used.add(p.id)
          const gross = Math.round((qty * p.salePricePaise) / 1000)
          lines.push({ productId: p.id, qtyMilli: Math.floor(qty / 1000) * 1000, ratePaise: p.salePricePaise, discountPaise: rand() < 0.3 ? Math.round(gross * 0.05) : 0 })
        }
        if (rand() < 0.55 || lines.length === 0) {
          const s = pick(services)
          lines.push({ productId: s.id, qtyMilli: toMilli(s.unitCode === 'HRS' ? between(4, 16) : between(1, 6)), ratePaise: s.salePricePaise, discountPaise: 0 })
        }
        const sale = postSalesInvoice(ctx, { customerId: customer.id, invoiceDate: ev.date, warehouseId: wid, lines })
        const total = (db.prepare('SELECT grand_total_paise t FROM sales_invoices WHERE id = ?').get(sale.id) as { t: number }).t
        salesDocs.push({ id: sale.id, customerId: customer.id, date: ev.date, total, days: customer.creditDays })
        salesCount++
      }
    }

    // Settlements follow each document's credit terms: most invoices are collected
    // on or a little after their due date; a few customers are slow payers.
    // Every receipt/payment is allocated to the invoice it settles.
    const plusDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)
    const bankId = accountId(db, company.id, 'BANK')
    const cashId = accountId(db, company.id, 'CASH')
    const collectionsId = (db.prepare(`SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = '1210'`).get(company.id) as { id: number }).id
    let receipts = 0
    const modes = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'BANK_TRANSFER'] as const
    const settlements: Array<() => void> = []
    for (const s of salesDocs) {
      const c = customers.find((x) => x.id === s.customerId)!
      const slow = c.id % 3 === 0
      const date = plusDays(s.date, s.days + between(0, slow ? 40 : 12))
      if (date > todayIso || rand() < (slow ? 0.5 : 0.1)) continue
      const amount = c.gstRegistrationType === 'CONSUMER' || !slow ? s.total : Math.floor(s.total * 0.6)
      const consumer = c.gstRegistrationType === 'CONSUMER'
      const mode = consumer ? 'CASH' : pick(modes)
      const account = consumer ? cashId : s.id % 3 === 0 ? collectionsId : bankId
      settlements.push(() => {
        createPayment(ctx, {
          type: 'RECEIPT', partyId: c.id, date, amountPaise: amount, mode, accountId: account,
          referenceNo: consumer ? null : mode === 'CHEQUE' ? `CHQ${between(100000, 999999)}` : `UTR${between(100000, 999999)}`,
          allocations: [{ invoiceId: s.id, amountPaise: amount }]
        })
        receipts++
      })
    }
    let payments = 0
    for (const p of purchaseDocs) {
      const date = plusDays(p.date, p.days + between(-3, 5))
      if (date > todayIso || rand() < 0.15) continue
      settlements.push(() => {
        createPayment(ctx, {
          type: 'PAYMENT', partyId: p.supplierId, date, amountPaise: p.total, mode: 'BANK_TRANSFER', accountId: bankId,
          referenceNo: `NEFT${between(100000, 999999)}`, allocations: [{ invoiceId: p.id, amountPaise: p.total }]
        })
        payments++
      })
    }
    // Receipts first so the bank balance can always fund supplier payments.
    settlements.forEach((post) => post())
    phase2Flows({ ctx, todayIso, fyStart, plusDays, between, productByCode, customers, suppliers, whId, bankId, cashId, collectionsId })
    financeFlows({ ctx, todayIso, fyStart, plusDays, bankId, cashId, customerId: (code) => customers.find((c) => c.code === code)!.id })
    gstFlows({ ctx, todayIso, fyStart, plusDays, productByCode, customers, suppliers })

    writeAudit(db, { companyId: company.id, userId, action: 'SEED', entityType: 'company', entityId: company.id, summary: 'DEMO company populated with sample masters and transactions' })
    const posted = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE company_id = ? AND status = 'POSTED'`).get(company.id) as { n: number }).n
    salesCount = posted('sales_invoices')
    purchaseCount = posted('purchase_invoices')
    receipts = (db.prepare('SELECT COUNT(*) n FROM payment_receipts WHERE company_id = ?').get(company.id) as { n: number }).n
    payments = (db.prepare('SELECT COUNT(*) n FROM payment_vouchers WHERE company_id = ?').get(company.id) as { n: number }).n
    return { warehouses: wh.length, salesCount, purchaseCount, receipts, payments }
  })()

  // Two DEMO e-way bills so the module has data to show (clearly flagged as DEMO).
  const ewb = new EwayBillService(new MockEwayBillProvider())
  const eligible = ewb.eligibleInvoices(ctx).filter((i) => i.grandTotalPaise >= toPaise(50000))
  const transporter = db.prepare('SELECT id FROM transporters WHERE company_id = ? ORDER BY id LIMIT 1').get(company.id) as { id: number }
  const ROAD_KM_FROM_CHENNAI: Record<string, number> = { '33': 480, '29': 350, '32': 690, '36': 630, '37': 790, '27': 1190 }
  const km = (invoiceId: number): number =>
    ROAD_KM_FROM_CHENNAI[(db.prepare('SELECT place_of_supply p FROM sales_invoices WHERE id = ?').get(invoiceId) as { p: string }).p] ?? 500
  let ewayBills = 0
  if (eligible[0]) {
    await ewb.generate(ctx, { salesInvoiceId: eligible[0].id, transportMode: 'ROAD', transporterId: transporter.id, transportDocNo: null, transportDocDate: null, vehicleNo: 'TN09AB1234', vehicleType: 'REGULAR', distanceKm: km(eligible[0].id) }, today)
    ewayBills++
  }
  if (eligible[1]) {
    await ewb.generate(ctx, { salesInvoiceId: eligible[1].id, transportMode: 'ROAD', transporterId: transporter.id, transportDocNo: null, transportDocDate: null, vehicleNo: null, vehicleType: 'REGULAR', distanceKm: km(eligible[1].id) }, today)
    ewayBills++
  }

  const gst = await gstAsyncFlows(ctx, today)
  ewayBills += gst.ewayBills

  return {
    companyId: company.id,
    customers: CUSTOMERS.length,
    suppliers: SUPPLIERS.length,
    products: PRODUCTS.length,
    warehouses: result.warehouses,
    salesInvoices: result.salesCount,
    purchaseInvoices: result.purchaseCount,
    receipts: result.receipts,
    payments: result.payments,
    ewayBills
  }
}
