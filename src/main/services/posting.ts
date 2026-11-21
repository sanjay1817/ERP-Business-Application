/**
 * Posting helpers: one-step invoice posting (wrappers over the document engine),
 * receipts, payments, opening stock and opening funds. Every posting runs in ONE
 * database transaction; if any step fails, nothing is saved.
 */
import { z } from 'zod'
import { formatINR } from '@shared/money'
import { financialYearOf } from '@shared/india'
import { DocumentSaveInput } from '@shared/documents'
import { writeAudit } from './audit'
import { inTransaction, type ServiceContext } from './context'
import { businessRule, notFound } from './errors'
import { stockIn } from './inventory'
import { accountId, postJournal } from './ledger'
import { nextDocumentNumber } from './sequences'
import { postDocument, saveDraft } from './documents/engine'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
const lineSchema = z.object({
  productId: z.number().int().positive(),
  qtyMilli: z.number().int().positive('Quantity must be greater than zero'),
  ratePaise: z.number().int().min(0),
  discountPaise: z.number().int().min(0).default(0),
  description: z.string().max(300).optional()
})

export const SalesInvoicePostInput = z.object({
  customerId: z.number().int().positive(),
  invoiceDate: isoDate,
  dueDate: isoDate.optional(),
  warehouseId: z.number().int().positive(),
  notes: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(1, 'Add at least one line').max(200)
})
export type SalesInvoicePostInputT = z.input<typeof SalesInvoicePostInput>

export const PurchaseInvoicePostInput = z.object({
  supplierId: z.number().int().positive(),
  invoiceDate: isoDate,
  supplierInvoiceNo: z.string().trim().min(1).max(30),
  supplierInvoiceDate: isoDate,
  warehouseId: z.number().int().positive(),
  notes: z.string().max(500).optional(),
  lines: z.array(lineSchema).min(1).max(200)
})
export type PurchaseInvoicePostInputT = z.input<typeof PurchaseInvoicePostInput>

const PAY_MODES = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CARD'] as const
export const ReceiptPostInput = z.object({
  customerId: z.number().int().positive(),
  date: isoDate,
  amountPaise: z.number().int().positive(),
  mode: z.enum(PAY_MODES),
  referenceNo: z.string().max(50).optional(),
  notes: z.string().max(300).optional(),
  /** Cash/bank ledger to use; defaults to Cash for CASH mode, else the main bank account. */
  accountId: z.number().int().positive().optional()
})
export const PaymentPostInput = ReceiptPostInput.omit({ customerId: true }).extend({ supplierId: z.number().int().positive() })

interface ProductInfo {
  id: number; code: string; name: string; item_type: 'GOODS' | 'SERVICE'; hsn_sac: string; unit_id: number; rate_bps: number; track_inventory: number; is_active: number
}

function loadCompany(ctx: ServiceContext): { state_code: string; fy_start_month: number } {
  const c = ctx.db.prepare('SELECT state_code, fy_start_month, is_active FROM companies WHERE id = ?').get(ctx.companyId) as
    | { state_code: string; fy_start_month: number; is_active: number }
    | undefined
  if (!c || !c.is_active) throw notFound('Company')
  return c
}

function loadWarehouse(ctx: ServiceContext, id: number): void {
  if (!ctx.db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND company_id = ? AND is_active = 1').get(id, ctx.companyId)) throw notFound('Warehouse')
}

function loadProducts(ctx: ServiceContext, ids: number[]): Map<number, ProductInfo> {
  const stmt = ctx.db.prepare(
    `SELECT p.id, p.code, p.name, p.item_type, p.hsn_sac, p.unit_id, t.rate_bps, p.track_inventory, p.is_active
     FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.id = ? AND p.company_id = ?`
  )
  const map = new Map<number, ProductInfo>()
  for (const id of ids) {
    const p = stmt.get(id, ctx.companyId) as ProductInfo | undefined
    if (!p) throw notFound(`Product #${id}`)
    if (!p.is_active) throw businessRule(`Product ${p.code} is inactive`)
    map.set(id, p)
  }
  return map
}


/**
 * Create and post a sales invoice in one step (used by the demo seed and tests).
 * Delegates to the document engine, so the same validation and effects apply.
 */
export function postSalesInvoice(ctx: ServiceContext, raw: SalesInvoicePostInputT): { id: number; invoiceNo: string } {
  const input = SalesInvoicePostInput.parse(raw)
  return inTransaction(ctx.db, () => {
    const draft = saveDraft(ctx, DocumentSaveInput.parse({
      kind: 'SALES_INVOICE', partyId: input.customerId, date: input.invoiceDate, dueDate: input.dueDate ?? null, warehouseId: input.warehouseId,
      notes: input.notes ?? null, lines: input.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, description: l.description ?? null }))
    }), { audit: false })
    const posted = postDocument(ctx, 'SALES_INVOICE', draft.id)
    return { id: posted.id, invoiceNo: posted.number }
  })
}

/** Create and post a purchase invoice in one step (used by the demo seed and tests). */
export function postPurchaseInvoice(ctx: ServiceContext, raw: PurchaseInvoicePostInputT): { id: number; invoiceNo: string } {
  const input = PurchaseInvoicePostInput.parse(raw)
  return inTransaction(ctx.db, () => {
    const draft = saveDraft(ctx, DocumentSaveInput.parse({
      kind: 'PURCHASE_INVOICE', partyId: input.supplierId, date: input.invoiceDate, supplierRef: input.supplierInvoiceNo, supplierRefDate: input.supplierInvoiceDate,
      warehouseId: input.warehouseId, notes: input.notes ?? null,
      lines: input.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, description: l.description ?? null }))
    }), { audit: false })
    const posted = postDocument(ctx, 'PURCHASE_INVOICE', draft.id)
    return { id: posted.id, invoiceNo: posted.number }
  })
}

export function postReceipt(ctx: ServiceContext, raw: z.input<typeof ReceiptPostInput>): { id: number; receiptNo: string } {
  const input = ReceiptPostInput.parse(raw)
  return inTransaction(ctx.db, () => {
    const db = ctx.db
    const company = loadCompany(ctx)
    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ? AND company_id = ?').get(input.customerId, ctx.companyId) as { id: number; name: string } | undefined
    if (!customer) throw notFound('Customer')
    const fy = financialYearOf(input.date, company.fy_start_month)
    const receiptNo = nextDocumentNumber(db, ctx.companyId, 'RECEIPT', fy)
    const deposit = input.accountId ? cashBankAccount(ctx, input.accountId) : accountId(db, ctx.companyId, input.mode === 'CASH' ? 'CASH' : 'BANK')
    const res = db
      .prepare(`INSERT INTO payment_receipts (company_id, financial_year, receipt_no, receipt_date, customer_id, amount_paise, mode, deposit_account_id, reference_no, notes, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.companyId, fy, receiptNo, input.date, customer.id, input.amountPaise, input.mode, deposit, input.referenceNo ?? null, input.notes ?? null, ctx.userId)
    const id = Number(res.lastInsertRowid)
    const journal = postJournal(db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: input.date, sourceType: 'RECEIPT', sourceId: id, narration: `Receipt ${receiptNo} from ${customer.name}`,
      lines: [
        { accountId: deposit, debitPaise: input.amountPaise },
        { accountId: accountId(db, ctx.companyId, 'AR'), creditPaise: input.amountPaise, partyType: 'CUSTOMER', partyId: customer.id }
      ]
    })
    db.prepare('UPDATE payment_receipts SET journal_entry_id = ? WHERE id = ?').run(journal.id, id)
    writeAudit(db, { companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: 'payment_receipt', entityId: id, summary: `Receipt ${receiptNo} of ${formatINR(input.amountPaise)} from ${customer.name} (${input.mode})` })
    return { id, receiptNo }
  })
}

export function postPayment(ctx: ServiceContext, raw: z.input<typeof PaymentPostInput>): { id: number; voucherNo: string } {
  const input = PaymentPostInput.parse(raw)
  return inTransaction(ctx.db, () => {
    const db = ctx.db
    const company = loadCompany(ctx)
    const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND company_id = ?').get(input.supplierId, ctx.companyId) as { id: number; name: string } | undefined
    if (!supplier) throw notFound('Supplier')
    const fy = financialYearOf(input.date, company.fy_start_month)
    const voucherNo = nextDocumentNumber(db, ctx.companyId, 'PAYMENT', fy)
    const paidFrom = input.accountId ? cashBankAccount(ctx, input.accountId) : accountId(db, ctx.companyId, input.mode === 'CASH' ? 'CASH' : 'BANK')
    const available = (db.prepare('SELECT COALESCE(SUM(debit_paise - credit_paise),0) AS b FROM journal_entry_lines WHERE account_id = ?').get(paidFrom) as { b: number }).b
    if (available < input.amountPaise) throw businessRule(`Insufficient ${input.mode === 'CASH' ? 'cash' : 'bank'} balance: available ${formatINR(available)}`)
    const res = db
      .prepare(`INSERT INTO payment_vouchers (company_id, financial_year, voucher_no, voucher_date, supplier_id, amount_paise, mode, paid_from_account_id, reference_no, notes, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ctx.companyId, fy, voucherNo, input.date, supplier.id, input.amountPaise, input.mode, paidFrom, input.referenceNo ?? null, input.notes ?? null, ctx.userId)
    const id = Number(res.lastInsertRowid)
    const journal = postJournal(db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: input.date, sourceType: 'PAYMENT', sourceId: id, narration: `Payment ${voucherNo} to ${supplier.name}`,
      lines: [
        { accountId: accountId(db, ctx.companyId, 'AP'), debitPaise: input.amountPaise, partyType: 'SUPPLIER', partyId: supplier.id },
        { accountId: paidFrom, creditPaise: input.amountPaise }
      ]
    })
    db.prepare('UPDATE payment_vouchers SET journal_entry_id = ? WHERE id = ?').run(journal.id, id)
    writeAudit(db, { companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: 'payment_voucher', entityId: id, summary: `Payment ${voucherNo} of ${formatINR(input.amountPaise)} to ${supplier.name} (${input.mode})` })
    return { id, voucherNo }
  })
}

/** Opening stock: stock movement + Dr Stock in Hand / Cr Opening Balance Equity. */
export function postOpeningStock(ctx: ServiceContext, items: Array<{ productId: number; warehouseId: number; qtyMilli: number; valuePaise: number }>, date: string): void {
  inTransaction(ctx.db, () => {
    const products = loadProducts(ctx, [...new Set(items.map((i) => i.productId))])
    let total = 0
    for (const item of items) {
      const p = products.get(item.productId)!
      if (p.item_type !== 'GOODS' || !p.track_inventory) throw businessRule(`${p.code} does not track inventory`)
      loadWarehouse(ctx, item.warehouseId)
      stockIn(ctx.db, { companyId: ctx.companyId, productId: p.id, warehouseId: item.warehouseId, date, qtyMilli: item.qtyMilli, type: 'OPENING', valuePaise: item.valuePaise, referenceType: 'OPENING', referenceId: null, referenceNo: 'OPENING', userId: ctx.userId })
      total += item.valuePaise
    }
    postJournal(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: date, sourceType: 'OPENING', narration: 'Opening stock',
      lines: [
        { accountId: accountId(ctx.db, ctx.companyId, 'INVENTORY'), debitPaise: total },
        { accountId: accountId(ctx.db, ctx.companyId, 'OPENING_EQUITY'), creditPaise: total }
      ]
    })
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: 'opening_stock', summary: `Opening stock posted: ${items.length} lines, ${formatINR(total)}` })
  })
}

/** Opening cash/bank balances: Dr Cash/Bank, Cr Capital. */
export function postOpeningFunds(ctx: ServiceContext, date: string, cashPaise: number, bankPaise: number): void {
  inTransaction(ctx.db, () => {
    const A = (k: Parameters<typeof accountId>[2]) => accountId(ctx.db, ctx.companyId, k)
    postJournal(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: date, sourceType: 'OPENING', narration: 'Opening cash and bank balances (capital introduced)',
      lines: [
        { accountId: A('CASH'), debitPaise: cashPaise },
        { accountId: A('BANK'), debitPaise: bankPaise },
        { accountId: A('CAPITAL'), creditPaise: cashPaise + bankPaise }
      ]
    })
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: 'opening_funds', summary: `Opening funds posted: cash ${formatINR(cashPaise)}, bank ${formatINR(bankPaise)}` })
  })
}

function cashBankAccount(ctx: ServiceContext, id: number): number {
  const row = ctx.db.prepare('SELECT id FROM chart_of_accounts WHERE id = ? AND company_id = ? AND is_bank = 1 AND is_active = 1').get(id, ctx.companyId) as { id: number } | undefined
  if (!row) throw businessRule('Select a valid cash or bank account')
  return row.id
}

