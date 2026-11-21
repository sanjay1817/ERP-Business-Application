import type { Customer, Supplier } from '@shared/types'
import type { CustomerInputT, CustomerUpdateInputT, ListQueryT, SupplierInputT, SupplierUpdateInputT } from '@shared/schemas'
import { financialYearOf, financialYearRange } from '@shared/india'
import { formatINR } from '@shared/money'
import { diff, writeAudit } from './audit'
import { bool, inTransaction, type ServiceContext } from './context'
import { notFound } from './errors'
import { accountId, postJournal } from './ledger'

/** Customers & suppliers share structure; this module handles both with a small config. */
type Kind = 'customer' | 'supplier'
const CFG = {
  customer: { table: 'customers', partyType: 'CUSTOMER', ledger: 'AR', sign: 1, label: 'Customer' },
  supplier: { table: 'suppliers', partyType: 'SUPPLIER', ledger: 'AP', sign: -1, label: 'Supplier' }
} as const

type Row = Record<string, unknown> & { id: number; balance_paise: number }

const baseFields = (r: Row) => ({
  id: r.id,
  code: r.code as string,
  name: r.name as string,
  gstRegistrationType: r.gst_registration_type as string,
  gstin: r.gstin as string | null,
  pan: r.pan as string | null,
  contactPerson: r.contact_person as string | null,
  phone: r.phone as string | null,
  email: r.email as string | null,
  addressLine1: r.address_line1 as string | null,
  addressLine2: r.address_line2 as string | null,
  city: r.city as string | null,
  stateCode: r.state_code as string,
  pincode: r.pincode as string | null,
  openingBalancePaise: r.opening_balance_paise as number,
  balancePaise: r.balance_paise,
  isActive: bool(r.is_active),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string
})

const toCustomer = (r: Row): Customer => ({
  ...baseFields(r),
  partyType: r.party_type as Customer['partyType'],
  shippingAddressLine1: r.shipping_address_line1 as string | null,
  shippingAddressLine2: r.shipping_address_line2 as string | null,
  shippingCity: r.shipping_city as string | null,
  shippingStateCode: r.shipping_state_code as string | null,
  shippingPincode: r.shipping_pincode as string | null,
  creditLimitPaise: r.credit_limit_paise as number,
  creditDays: r.credit_days as number
})

const toSupplier = (r: Row): Supplier => ({
  ...baseFields(r),
  paymentTermsDays: r.payment_terms_days as number,
  bankAccountName: r.bank_account_name as string | null,
  bankAccountNo: r.bank_account_no as string | null,
  bankIfsc: r.bank_ifsc as string | null
})

function selectSql(kind: Kind): string {
  const c = CFG[kind]
  // Balance comes from the ledger (single source of truth), sign-adjusted so the
  // natural balance is positive: receivable for customers, payable for suppliers.
  return `SELECT p.*, ${c.sign} * COALESCE((
            SELECT SUM(l.debit_paise - l.credit_paise) FROM journal_entry_lines l
            JOIN chart_of_accounts a ON a.id = l.account_id AND a.system_key = '${c.ledger}'
            WHERE l.party_type = '${c.partyType}' AND l.party_id = p.id), 0) AS balance_paise
          FROM ${c.table} p`
}

function list(ctx: ServiceContext, kind: Kind, q: ListQueryT): Row[] {
  const where = ['p.company_id = @companyId']
  if (!q?.includeInactive) where.push('p.is_active = 1')
  if (q?.search) where.push(`(p.name LIKE @like OR p.code LIKE @like OR IFNULL(p.gstin,'') LIKE @like OR IFNULL(p.city,'') LIKE @like OR IFNULL(p.phone,'') LIKE @like)`)
  return ctx.db
    .prepare(`${selectSql(kind)} WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT @limit OFFSET @offset`)
    .all({ companyId: ctx.companyId, like: `%${q?.search ?? ''}%`, limit: q?.limit ?? 500, offset: q?.offset ?? 0 }) as Row[]
}

function getRow(ctx: ServiceContext, kind: Kind, id: number): Row {
  const row = ctx.db.prepare(`${selectSql(kind)} WHERE p.id = ? AND p.company_id = ?`).get(id, ctx.companyId) as Row | undefined
  if (!row) throw notFound(CFG[kind].label)
  return row
}

function postOpeningBalance(ctx: ServiceContext, kind: Kind, partyId: number, name: string, amountPaise: number): void {
  if (amountPaise === 0) return
  const c = CFG[kind]
  const company = ctx.db.prepare('SELECT fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { fy_start_month: number }
  const fy = financialYearOf(new Date().toISOString().slice(0, 10), company.fy_start_month)
  const entryDate = financialYearRange(fy, company.fy_start_month).from
  const partyAcc = accountId(ctx.db, ctx.companyId, c.ledger)
  const equity = accountId(ctx.db, ctx.companyId, 'OPENING_EQUITY')
  // Natural-balance amount → debit-positive amount on the party ledger.
  const debitPositive = amountPaise * c.sign
  const abs = Math.abs(debitPositive)
  postJournal(ctx.db, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    entryDate,
    sourceType: 'OPENING',
    sourceId: partyId,
    narration: `Opening balance - ${name}`,
    lines: [
      { accountId: partyAcc, debitPaise: debitPositive > 0 ? abs : 0, creditPaise: debitPositive < 0 ? abs : 0, partyType: c.partyType, partyId },
      { accountId: equity, debitPaise: debitPositive < 0 ? abs : 0, creditPaise: debitPositive > 0 ? abs : 0 }
    ]
  })
}

// ───────────── Customers ─────────────

export const listCustomers = (ctx: ServiceContext, q: ListQueryT): Customer[] => list(ctx, 'customer', q).map(toCustomer)
export const getCustomer = (ctx: ServiceContext, id: number): Customer => toCustomer(getRow(ctx, 'customer', id))

const customerParams = (ctx: ServiceContext, v: CustomerUpdateInputT | CustomerInputT) => ({
  ...v,
  companyId: ctx.companyId,
  shippingStateCode: v.shippingStateCode ?? null
})

export function createCustomer(ctx: ServiceContext, input: CustomerInputT): Customer {
  return inTransaction(ctx.db, () => {
    const res = ctx.db
      .prepare(
        `INSERT INTO customers (company_id, code, name, party_type, gst_registration_type, gstin, pan, contact_person, phone, email,
           address_line1, address_line2, city, state_code, pincode, shipping_address_line1, shipping_address_line2, shipping_city,
           shipping_state_code, shipping_pincode, credit_limit_paise, credit_days, opening_balance_paise)
         VALUES (@companyId, @code, @name, @partyType, @gstRegistrationType, @gstin, @pan, @contactPerson, @phone, @email,
           @addressLine1, @addressLine2, @city, @stateCode, @pincode, @shippingAddressLine1, @shippingAddressLine2, @shippingCity,
           @shippingStateCode, @shippingPincode, @creditLimitPaise, @creditDays, @openingBalancePaise)`
      )
      .run(customerParams(ctx, input))
    const id = Number(res.lastInsertRowid)
    postOpeningBalance(ctx, 'customer', id, input.name, input.openingBalancePaise)
    const customer = getCustomer(ctx, id)
    writeAudit(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'CREATE', entityType: 'customer', entityId: id,
      summary: `Customer ${customer.code} - ${customer.name} created${input.openingBalancePaise ? ` with opening balance ${formatINR(input.openingBalancePaise)}` : ''}`,
      details: customer
    })
    return customer
  })
}

export function updateCustomer(ctx: ServiceContext, input: CustomerUpdateInputT): Customer {
  return inTransaction(ctx.db, () => {
    const before = getCustomer(ctx, input.id)
    ctx.db
      .prepare(
        `UPDATE customers SET code=@code, name=@name, party_type=@partyType, gst_registration_type=@gstRegistrationType, gstin=@gstin, pan=@pan,
           contact_person=@contactPerson, phone=@phone, email=@email, address_line1=@addressLine1, address_line2=@addressLine2, city=@city,
           state_code=@stateCode, pincode=@pincode, shipping_address_line1=@shippingAddressLine1, shipping_address_line2=@shippingAddressLine2,
           shipping_city=@shippingCity, shipping_state_code=@shippingStateCode, shipping_pincode=@shippingPincode,
           credit_limit_paise=@creditLimitPaise, credit_days=@creditDays, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id AND company_id=@companyId`
      )
      .run(customerParams(ctx, input))
    const after = getCustomer(ctx, input.id)
    const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'UPDATE', entityType: 'customer', entityId: input.id, summary: `Customer ${after.code} updated (${Object.keys(changes).join(', ') || 'no changes'})`, details: changes })
    return after
  })
}

export function setCustomerActive(ctx: ServiceContext, id: number, isActive: boolean): Customer {
  return inTransaction(ctx.db, () => {
    const c = getCustomer(ctx, id)
    ctx.db.prepare(`UPDATE customers SET is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(isActive ? 1 : 0, id)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: isActive ? 'ACTIVATE' : 'DEACTIVATE', entityType: 'customer', entityId: id, summary: `Customer ${c.code} ${isActive ? 'activated' : 'deactivated'}` })
    return getCustomer(ctx, id)
  })
}

// ───────────── Suppliers ─────────────

export const listSuppliers = (ctx: ServiceContext, q: ListQueryT): Supplier[] => list(ctx, 'supplier', q).map(toSupplier)
export const getSupplier = (ctx: ServiceContext, id: number): Supplier => toSupplier(getRow(ctx, 'supplier', id))

export function createSupplier(ctx: ServiceContext, input: SupplierInputT): Supplier {
  return inTransaction(ctx.db, () => {
    const res = ctx.db
      .prepare(
        `INSERT INTO suppliers (company_id, code, name, gst_registration_type, gstin, pan, contact_person, phone, email,
           address_line1, address_line2, city, state_code, pincode, payment_terms_days, bank_account_name, bank_account_no, bank_ifsc, opening_balance_paise)
         VALUES (@companyId, @code, @name, @gstRegistrationType, @gstin, @pan, @contactPerson, @phone, @email,
           @addressLine1, @addressLine2, @city, @stateCode, @pincode, @paymentTermsDays, @bankAccountName, @bankAccountNo, @bankIfsc, @openingBalancePaise)`
      )
      .run({ ...input, companyId: ctx.companyId })
    const id = Number(res.lastInsertRowid)
    postOpeningBalance(ctx, 'supplier', id, input.name, input.openingBalancePaise)
    const supplier = getSupplier(ctx, id)
    writeAudit(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'CREATE', entityType: 'supplier', entityId: id,
      summary: `Supplier ${supplier.code} - ${supplier.name} created${input.openingBalancePaise ? ` with opening balance ${formatINR(input.openingBalancePaise)}` : ''}`,
      details: supplier
    })
    return supplier
  })
}

export function updateSupplier(ctx: ServiceContext, input: SupplierUpdateInputT): Supplier {
  return inTransaction(ctx.db, () => {
    const before = getSupplier(ctx, input.id)
    ctx.db
      .prepare(
        `UPDATE suppliers SET code=@code, name=@name, gst_registration_type=@gstRegistrationType, gstin=@gstin, pan=@pan,
           contact_person=@contactPerson, phone=@phone, email=@email, address_line1=@addressLine1, address_line2=@addressLine2, city=@city,
           state_code=@stateCode, pincode=@pincode, payment_terms_days=@paymentTermsDays, bank_account_name=@bankAccountName,
           bank_account_no=@bankAccountNo, bank_ifsc=@bankIfsc, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id AND company_id=@companyId`
      )
      .run({ ...input, companyId: ctx.companyId })
    const after = getSupplier(ctx, input.id)
    const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'UPDATE', entityType: 'supplier', entityId: input.id, summary: `Supplier ${after.code} updated (${Object.keys(changes).join(', ') || 'no changes'})`, details: changes })
    return after
  })
}

export function setSupplierActive(ctx: ServiceContext, id: number, isActive: boolean): Supplier {
  return inTransaction(ctx.db, () => {
    const s = getSupplier(ctx, id)
    ctx.db.prepare(`UPDATE suppliers SET is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(isActive ? 1 : 0, id)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: isActive ? 'ACTIVATE' : 'DEACTIVATE', entityType: 'supplier', entityId: id, summary: `Supplier ${s.code} ${isActive ? 'activated' : 'deactivated'}` })
    return getSupplier(ctx, id)
  })
}
