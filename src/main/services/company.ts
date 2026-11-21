import type { DB } from '../db/connection'
import type { Company, CompanySummary } from '@shared/types'
import type { CompanyInputT, CompanyUpdateInputT } from '@shared/schemas'
import { financialYearOf } from '@shared/india'
import { diff, writeAudit } from './audit'
import { bool, inTransaction } from './context'
import { notFound } from './errors'
import { createDefaultChartOfAccounts } from './ledger'

interface CompanyRow {
  id: number; code: string; name: string; legal_name: string | null; gstin: string | null; pan: string | null; state_code: string
  address_line1: string | null; address_line2: string | null; city: string | null; pincode: string | null; phone: string | null; email: string | null
  fy_start_month: number; is_demo: number; is_active: number; created_at: string; updated_at: string
  bank_name?: string | null; bank_account_no?: string | null; bank_ifsc?: string | null; bank_branch?: string | null; upi_id?: string | null; invoice_terms?: string | null
}

const toCompany = (r: CompanyRow): Company => ({
  id: r.id, code: r.code, name: r.name, legalName: r.legal_name, gstin: r.gstin, pan: r.pan, stateCode: r.state_code,
  addressLine1: r.address_line1, addressLine2: r.address_line2, city: r.city, pincode: r.pincode, phone: r.phone, email: r.email,
  fyStartMonth: r.fy_start_month, bankName: r.bank_name ?? null, bankAccountNo: r.bank_account_no ?? null, bankIfsc: r.bank_ifsc ?? null,
  bankBranch: r.bank_branch ?? null, upiId: r.upi_id ?? null, invoiceTerms: r.invoice_terms ?? null, isDemo: bool(r.is_demo), isActive: bool(r.is_active), createdAt: r.created_at, updatedAt: r.updated_at
})

type InvoiceSettings = Pick<CompanyInputT, 'bankName' | 'bankAccountNo' | 'bankIfsc' | 'bankBranch' | 'upiId' | 'invoiceTerms'>
const hasInvoiceSettings = (v: InvoiceSettings) => [v.bankName, v.bankAccountNo, v.bankIfsc, v.bankBranch, v.upiId, v.invoiceTerms].some((x) => x != null)

/** Bank details & default terms printed on invoices (schema v3+). */
function saveInvoiceSettings(db: DB, id: number, v: InvoiceSettings): void {
  db.prepare(`UPDATE companies SET bank_name = ?, bank_account_no = ?, bank_ifsc = ?, bank_branch = ?, upi_id = ?, invoice_terms = ? WHERE id = ?`).run(
    v.bankName ?? null, v.bankAccountNo ?? null, v.bankIfsc ?? null, v.bankBranch ?? null, v.upiId ?? null, v.invoiceTerms ?? null, id
  )
}

export function listCompanies(db: DB): Company[] {
  return (db.prepare('SELECT * FROM companies ORDER BY is_demo DESC, name').all() as CompanyRow[]).map(toCompany)
}

export function getCompany(db: DB, id: number): Company {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined
  if (!row) throw notFound('Company')
  return toCompany(row)
}

export function companySummary(db: DB, id: number, today = new Date().toISOString().slice(0, 10)): CompanySummary {
  const c = getCompany(db, id)
  return { id: c.id, code: c.code, name: c.name, stateCode: c.stateCode, gstin: c.gstin, isDemo: c.isDemo, financialYear: financialYearOf(today, c.fyStartMonth) }
}

/** Create a company with its head-office branch, main warehouse and default chart of accounts. */
export function createCompany(db: DB, userId: number | null, input: CompanyInputT, opts: { isDemo?: boolean } = {}): Company {
  return inTransaction(db, () => {
    const res = db
      .prepare(
        `INSERT INTO companies (code, name, legal_name, gstin, pan, state_code, address_line1, address_line2, city, pincode, phone, email, fy_start_month, is_demo)
         VALUES (@code, @name, @legalName, @gstin, @pan, @stateCode, @addressLine1, @addressLine2, @city, @pincode, @phone, @email, @fyStartMonth, @isDemo)`
      )
      .run({
        code: input.code, name: input.name, legalName: input.legalName, gstin: input.gstin, pan: input.pan, stateCode: input.stateCode,
        addressLine1: input.addressLine1, addressLine2: input.addressLine2, city: input.city, pincode: input.pincode, phone: input.phone,
        email: input.email, fyStartMonth: input.fyStartMonth, isDemo: opts.isDemo ? 1 : 0
      })
    const id = Number(res.lastInsertRowid)
    if (hasInvoiceSettings(input)) saveInvoiceSettings(db, id, input)
    const branch = db
      .prepare(`INSERT INTO branches (company_id, code, name, gstin, state_code, address_line1, city, pincode, is_head_office) VALUES (?, 'HO', 'Head Office', ?, ?, ?, ?, ?, 1)`)
      .run(id, input.gstin, input.stateCode, input.addressLine1, input.city, input.pincode)
    db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name, address, city, state_code, pincode) VALUES (?, ?, 'MAIN', 'Main Warehouse', ?, ?, ?, ?)`).run(
      id, Number(branch.lastInsertRowid), input.addressLine1, input.city, input.stateCode, input.pincode
    )
    createDefaultChartOfAccounts(db, id)
    // Primary GST registration (migration 005+). Older schemas get it from that migration's backfill.
    if (input.gstin && db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gst_registrations'`).get())
      db.prepare(`INSERT INTO gst_registrations (company_id, branch_id, gstin, state_code, legal_name, trade_name, address, pincode, effective_from, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2017-07-01', 1)`).run(
        id, Number(branch.lastInsertRowid), input.gstin, input.stateCode, input.legalName, input.name, [input.addressLine1, input.city].filter(Boolean).join(' ') || null, input.pincode
      )
    const company = getCompany(db, id)
    writeAudit(db, { companyId: id, userId, action: 'CREATE', entityType: 'company', entityId: id, summary: `Company ${company.code} - ${company.name} created`, details: company })
    return company
  })
}

export function updateCompany(db: DB, userId: number | null, input: CompanyUpdateInputT): Company {
  return inTransaction(db, () => {
    const before = getCompany(db, input.id)
    db.prepare(
      `UPDATE companies SET code=@code, name=@name, legal_name=@legalName, gstin=@gstin, pan=@pan, state_code=@stateCode,
         address_line1=@addressLine1, address_line2=@addressLine2, city=@city, pincode=@pincode, phone=@phone, email=@email,
         fy_start_month=@fyStartMonth, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=@id`
    ).run({
      id: input.id, code: input.code, name: input.name, legalName: input.legalName, gstin: input.gstin, pan: input.pan, stateCode: input.stateCode,
      addressLine1: input.addressLine1, addressLine2: input.addressLine2, city: input.city, pincode: input.pincode, phone: input.phone,
      email: input.email, fyStartMonth: input.fyStartMonth
    })
    saveInvoiceSettings(db, input.id, input)
    const after = getCompany(db, input.id)
    const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
    writeAudit(db, { companyId: input.id, userId, action: 'UPDATE', entityType: 'company', entityId: input.id, summary: `Company ${after.code} updated (${Object.keys(changes).join(', ') || 'no changes'})`, details: changes })
    return after
  })
}
