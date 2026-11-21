import { describe, expect, it } from 'vitest'
import { CustomerInput, CustomerUpdateInput, ProductInput } from '@shared/schemas'
import { buildGstin } from '@shared/india'
import { toMilli, toPaise } from '@shared/money'
import { createCustomer, getCustomer, listCustomers, setCustomerActive, updateCustomer, createSupplier } from '../src/main/services/parties'
import { createProduct, getLookups, updateProduct } from '../src/main/services/products'
import { postOpeningStock } from '../src/main/services/posting'
import { trialBalance } from '../src/main/services/reports'
import { fromSqliteError } from '../src/main/services/errors'
import { emptyCompanyDb } from './helpers'

const customerInput = (over: Record<string, unknown> = {}) => ({
  code: 'cust-01', name: 'Acme Industries Pvt Ltd', partyType: 'BUSINESS', gstRegistrationType: 'REGULAR',
  gstin: buildGstin('33', 'AABCA1234F'), pan: 'aabca1234f', contactPerson: 'R. Kumar', phone: '9840012345', email: 'ap@acme.example.com',
  addressLine1: '1 Main Road', addressLine2: '', city: 'Chennai', stateCode: '33', pincode: '600001',
  shippingAddressLine1: '', shippingAddressLine2: '', shippingCity: '', shippingStateCode: '', shippingPincode: '',
  creditLimitPaise: toPaise('250000'), creditDays: 30, openingBalancePaise: toPaise('15000.50'), ...over
})

describe('customer creation', () => {
  it('creates a customer, normalises input, posts the opening balance and audits it', () => {
    const { db, ctx } = emptyCompanyDb()
    const c = createCustomer(ctx, CustomerInput.parse(customerInput()))
    expect(c.id).toBeGreaterThan(0)
    expect(c.code).toBe('CUST-01')
    expect(c.pan).toBe('AABCA1234F')
    expect(c.addressLine2).toBeNull()
    expect(c.balancePaise).toBe(1500050)
    const je = db.prepare(`SELECT total_debit_paise, total_credit_paise, source_type FROM journal_entries WHERE source_id = ? AND source_type='OPENING'`).get(c.id) as Record<string, unknown>
    expect(je).toEqual({ total_debit_paise: 1500050, total_credit_paise: 1500050, source_type: 'OPENING' })
    const audit = db.prepare(`SELECT action, summary FROM audit_logs WHERE entity_type='customer' AND entity_id=?`).get(c.id) as { action: string; summary: string }
    expect(audit.action).toBe('CREATE')
    expect(audit.summary).toContain('CUST-01')
    const tb = trialBalance(ctx)
    expect(tb.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0)).toBe(0)
  })

  it('rejects invalid GST data with field-level messages', () => {
    const bad = CustomerInput.safeParse(customerInput({ gstin: '33AABCA1234F1Z0' }))
    expect(bad.success).toBe(false)
    expect(bad.error!.issues.some((i) => i.path[0] === 'gstin')).toBe(true)

    const missing = CustomerInput.safeParse(customerInput({ gstin: '' }))
    expect(missing.error!.issues.find((i) => i.path[0] === 'gstin')?.message).toMatch(/required/)

    const stateMismatch = CustomerInput.safeParse(customerInput({ stateCode: '29' }))
    expect(stateMismatch.error!.issues.some((i) => i.path[0] === 'stateCode')).toBe(true)

    const panMismatch = CustomerInput.safeParse(customerInput({ pan: 'ZZZZZ9999Z' }))
    expect(panMismatch.error!.issues.some((i) => i.path[0] === 'pan')).toBe(true)

    expect(CustomerInput.safeParse(customerInput({ email: 'not-an-email' })).success).toBe(false)
    expect(CustomerInput.safeParse(customerInput({ name: '' })).success).toBe(false)
    expect(CustomerInput.safeParse(customerInput({ creditDays: -1 })).success).toBe(false)
  })

  it('allows unregistered customers without GSTIN', () => {
    const { ctx } = emptyCompanyDb()
    const c = createCustomer(ctx, CustomerInput.parse(customerInput({ code: 'WALKIN', gstRegistrationType: 'CONSUMER', gstin: '', pan: '', partyType: 'INDIVIDUAL', openingBalancePaise: 0 })))
    expect(c.gstin).toBeNull()
    expect(c.balancePaise).toBe(0)
  })

  it('prevents duplicate codes within a company (case-insensitive)', () => {
    const { ctx } = emptyCompanyDb()
    createCustomer(ctx, CustomerInput.parse(customerInput({ openingBalancePaise: 0 })))
    let err: unknown
    try {
      createCustomer(ctx, CustomerInput.parse(customerInput({ code: 'CUST-01', name: 'Other', openingBalancePaise: 0 })))
    } catch (e) {
      err = e
    }
    const mapped = fromSqliteError(err)
    expect(mapped?.code).toBe('CONFLICT')
    expect(mapped?.fieldErrors?.code).toBeTruthy()
  })

  it('rolls back the customer if the opening balance cannot be posted', () => {
    const { db, ctx } = emptyCompanyDb()
    db.prepare(`UPDATE chart_of_accounts SET is_active = 0 WHERE system_key = 'OPENING_EQUITY'`).run()
    expect(() => createCustomer(ctx, CustomerInput.parse(customerInput()))).toThrow(/inactive account/)
    expect((db.prepare('SELECT COUNT(*) n FROM customers').get() as { n: number }).n).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE entity_type='customer'`).get() as { n: number }).n).toBe(0)
  })

  it('updates with a field-level audit diff and supports deactivation', () => {
    const { db, ctx } = emptyCompanyDb()
    const c = createCustomer(ctx, CustomerInput.parse(customerInput()))
    const { openingBalancePaise: _ob, ...rest } = customerInput({ city: 'Coimbatore', creditDays: 45 })
    const u = updateCustomer(ctx, CustomerUpdateInput.parse({ ...rest, id: c.id }))
    expect(u.city).toBe('Coimbatore')
    expect(u.balancePaise).toBe(c.balancePaise)
    const details = JSON.parse((db.prepare(`SELECT details_json d FROM audit_logs WHERE action='UPDATE' AND entity_id=?`).get(c.id) as { d: string }).d)
    expect(details).toEqual({ city: { from: 'Chennai', to: 'Coimbatore' }, creditDays: { from: 30, to: 45 } })
    expect(CustomerUpdateInput.safeParse({ ...rest, id: c.id, openingBalancePaise: 1 }).success).toBe(false)

    setCustomerActive(ctx, c.id, false)
    expect(listCustomers(ctx, {})).toHaveLength(0)
    expect(listCustomers(ctx, { includeInactive: true })).toHaveLength(1)
    expect(getCustomer(ctx, c.id).isActive).toBe(false)
  })

  it('scopes customers to their company', () => {
    const a = emptyCompanyDb()
    const c = createCustomer(a.ctx, CustomerInput.parse(customerInput({ openingBalancePaise: 0 })))
    expect(() => getCustomer({ ...a.ctx, companyId: a.ctx.companyId + 99 }, c.id)).toThrow(/not found/)
  })

  it('creates suppliers with payable opening balances', () => {
    const { ctx } = emptyCompanyDb()
    const s = createSupplier(ctx, {
      code: 'S1', name: 'Vendor', gstRegistrationType: 'UNREGISTERED', gstin: null, pan: null, contactPerson: null, phone: null, email: null,
      addressLine1: null, addressLine2: null, city: null, stateCode: '33', pincode: null, paymentTermsDays: 30, bankAccountName: null, bankAccountNo: null, bankIfsc: null,
      openingBalancePaise: toPaise(5000)
    })
    expect(s.balancePaise).toBe(500000)
  })
})

describe('product & service creation', () => {
  const productInput = (ctx: ReturnType<typeof emptyCompanyDb>['ctx'], over: Record<string, unknown> = {}) => {
    const L = getLookups(ctx)
    return {
      code: 'sku-1', name: 'Widget', description: '', itemType: 'GOODS', categoryId: null, unitId: L.units.find((u) => u.code === 'NOS')!.id,
      hsnSac: '84713010', taxRateId: L.taxRates.find((t) => t.rateBps === 1800)!.id, salePricePaise: toPaise('999.99'), purchasePricePaise: toPaise(700),
      mrpPaise: null, reorderLevelMilli: toMilli(5), trackInventory: true, ...over
    }
  }

  it('creates a stocked product with an audit entry', () => {
    const { db, ctx } = emptyCompanyDb()
    const p = createProduct(ctx, ProductInput.parse(productInput(ctx)))
    expect(p.code).toBe('SKU-1')
    expect(p.taxRateBps).toBe(1800)
    expect(p.unitCode).toBe('NOS')
    expect(p.trackInventory).toBe(true)
    expect(p.stockQtyMilli).toBe(0)
    expect((db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE entity_type='product' AND entity_id=?`).get(p.id) as { n: number }).n).toBe(1)
  })

  it('creates a non-stock service with a SAC code', () => {
    const { ctx } = emptyCompanyDb()
    const s = createProduct(ctx, ProductInput.parse(productInput(ctx, { code: 'SVC-1', name: 'Consulting', itemType: 'SERVICE', hsnSac: '998313', trackInventory: false, reorderLevelMilli: 0 })))
    expect(s.itemType).toBe('SERVICE')
    expect(s.trackInventory).toBe(false)
  })

  it('validates goods vs service rules', () => {
    const { ctx } = emptyCompanyDb()
    const issues = (o: Record<string, unknown>) => ProductInput.safeParse(productInput(ctx, o)).error?.issues.map((i) => String(i.path[0])) ?? []
    expect(issues({ itemType: 'SERVICE', hsnSac: '998313', trackInventory: true, reorderLevelMilli: 0 })).toContain('trackInventory')
    expect(issues({ itemType: 'SERVICE', hsnSac: '84713010', trackInventory: false, reorderLevelMilli: 0 })).toContain('hsnSac')
    expect(issues({ hsnSac: '998313' })).toContain('hsnSac')
    expect(issues({ hsnSac: '12' })).toContain('hsnSac')
    expect(issues({ salePricePaise: -1 })).toContain('salePricePaise')
    expect(issues({ salePricePaise: 10.5 })).toContain('salePricePaise')
    expect(issues({ mrpPaise: 50000 })).toContain('salePricePaise')
  })

  it('rejects references to another company\'s category and unknown tax rates', () => {
    const a = emptyCompanyDb()
    const otherCat = Number(a.db.prepare(`INSERT INTO companies (code, name, state_code) VALUES ('X','X','33')`).run().lastInsertRowid)
    const catId = Number(a.db.prepare(`INSERT INTO categories (company_id, name) VALUES (?, 'Foreign')`).run(otherCat).lastInsertRowid)
    expect(() => createProduct(a.ctx, ProductInput.parse(productInput(a.ctx, { categoryId: catId })))).toThrow(/highlighted/)
    expect(() => createProduct(a.ctx, ProductInput.parse(productInput(a.ctx, { taxRateId: 9999 })))).toThrow(/highlighted/)
  })

  it('locks item type once stock movements exist', () => {
    const { ctx } = emptyCompanyDb()
    const p = createProduct(ctx, ProductInput.parse(productInput(ctx)))
    const wh = (ctx.db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(ctx.companyId) as { id: number }).id
    postOpeningStock(ctx, [{ productId: p.id, warehouseId: wh, qtyMilli: toMilli(10), valuePaise: toPaise(7000) }], '2026-04-01')
    const asService = ProductInput.parse(productInput(ctx, { itemType: 'SERVICE', hsnSac: '998313', trackInventory: false, reorderLevelMilli: 0 }))
    expect(() => updateProduct(ctx, { ...asService, id: p.id })).toThrow(/cannot be changed/)
  })
})
