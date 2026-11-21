/**
 * Customer receipts and supplier payments with invoice allocation.
 * A payment always posts Dr/Cr cash-or-bank vs the party ledger; allocations
 * only record which invoices it settles (unallocated = advance on account).
 */
import type { OpenInvoice, PaymentCreateInputT, PaymentDetail, PaymentRow } from '@shared/documents'
import { PaymentCreateInput } from '@shared/documents'
import { formatINR } from '@shared/money'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { notFound, validation } from '../errors'
import { postPayment, postReceipt } from '../posting'
import { priorRequest, recordRequest } from '../finance/vouchers'

const today = (): string => new Date().toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000)

const CFG = {
  RECEIPT: { table: 'payment_receipts', no: 'receipt_no', date: 'receipt_date', party: 'customer_id', partyTable: 'customers', account: 'deposit_account_id', invoice: 'SALES_INVOICE', invoiceTable: 'sales_invoices', invoiceParty: 'customer_id', ref: 'customer_gstin' },
  PAYMENT: { table: 'payment_vouchers', no: 'voucher_no', date: 'voucher_date', party: 'supplier_id', partyTable: 'suppliers', account: 'paid_from_account_id', invoice: 'PURCHASE_INVOICE', invoiceTable: 'purchase_invoices', invoiceParty: 'supplier_id', ref: 'supplier_invoice_no' }
} as const

export function openInvoices(ctx: ServiceContext, type: 'RECEIPT' | 'PAYMENT', partyId: number, asOf = today()): OpenInvoice[] {
  const c = CFG[type]
  const rows = ctx.db
    .prepare(
      `SELECT i.id AS invoiceId, i.invoice_no AS number, i.invoice_date AS date, i.due_date AS dueDate, i.${c.ref} AS partyRef, i.grand_total_paise AS grandTotalPaise,
         i.grand_total_paise - COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_type = '${c.invoice}' AND a.invoice_id = i.id AND a.is_reversed = 0), 0) AS balancePaise
       FROM ${c.invoiceTable} i WHERE i.company_id = ? AND i.${c.invoiceParty} = ? AND i.status = 'POSTED'
       ORDER BY COALESCE(i.due_date, i.invoice_date), i.invoice_date, i.id`
    )
    .all(ctx.companyId, partyId) as Array<Omit<OpenInvoice, 'overdueDays'>>
  return rows
    .filter((r) => r.balancePaise > 0)
    .map((r) => ({ ...r, overdueDays: r.dueDate && r.dueDate < asOf ? daysBetween(r.dueDate, asOf) : 0 }))
}

export function createPayment(ctx: ServiceContext, raw: PaymentCreateInputT): PaymentDetail {
  const input = PaymentCreateInput.parse(raw)
  const c = CFG[input.type]
  const entity = input.type === 'RECEIPT' ? 'payment_receipt' : 'payment_voucher'
  // Idempotent resubmission (double-click, retry after a lost response): return the first posting.
  const prior = priorRequest(ctx, input.requestKey, entity)
  if (prior) return getPayment(ctx, input.type, prior)
  return inTransaction(ctx.db, () => {
    const db = ctx.db
    const party = db.prepare(`SELECT id, name, is_active FROM ${c.partyTable} WHERE id = ? AND company_id = ?`).get(input.partyId, ctx.companyId) as { id: number; name: string; is_active: number } | undefined
    if (!party) throw validation('Please correct the highlighted fields', { partyId: `Select a valid ${input.type === 'RECEIPT' ? 'customer' : 'supplier'}` })
    const account = db.prepare('SELECT id, name FROM chart_of_accounts WHERE id = ? AND company_id = ? AND is_bank = 1 AND is_active = 1').get(input.accountId, ctx.companyId) as { id: number; name: string } | undefined
    if (!account) throw validation('Please correct the highlighted fields', { accountId: 'Select a cash or bank account' })
    if (input.date > today()) throw validation('Please correct the highlighted fields', { date: 'Payment date cannot be in the future' })

    // The same bank/UTR/cheque reference must not be posted twice for the same party.
    if (input.referenceNo) {
      const norm = input.referenceNo.toUpperCase().replace(/[^A-Z0-9]/g, '')
      const dupe = (db
        .prepare(`SELECT ${c.no} AS no, ${c.date} AS date, reference_no FROM ${c.table} WHERE company_id = ? AND ${c.party} = ? AND status = 'POSTED' AND reference_no IS NOT NULL`)
        .all(ctx.companyId, party.id) as Array<{ no: string; date: string; reference_no: string }>).find((r) => r.reference_no.toUpperCase().replace(/[^A-Z0-9]/g, '') === norm)
      if (dupe) throw validation('Please correct the highlighted fields', { referenceNo: `Reference already used on ${dupe.no} dated ${dupe.date}` })
    }

    const open = new Map(openInvoices(ctx, input.type, party.id).map((o) => [o.invoiceId, o]))
    input.allocations.forEach((a, i) => {
      const inv = open.get(a.invoiceId)
      if (!inv) throw validation('Please correct the highlighted fields', { [`allocations.${i}.invoiceId`]: 'Invoice is not open for this party' })
      if (a.amountPaise > inv.balancePaise) throw validation('Please correct the highlighted fields', { [`allocations.${i}.amountPaise`]: `Exceeds the balance of ${inv.number} (${formatINR(inv.balancePaise)})` })
    })

    const posted =
      input.type === 'RECEIPT'
        ? postReceipt(ctx, { customerId: party.id, date: input.date, amountPaise: input.amountPaise, mode: input.mode, accountId: account.id, referenceNo: input.referenceNo ?? undefined, notes: input.notes ?? undefined })
        : postPayment(ctx, { supplierId: party.id, date: input.date, amountPaise: input.amountPaise, mode: input.mode, accountId: account.id, referenceNo: input.referenceNo ?? undefined, notes: input.notes ?? undefined })
    const ins = db.prepare(`INSERT INTO payment_allocations (company_id, source_type, source_id, invoice_type, invoice_id, amount_paise, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const a of input.allocations) ins.run(ctx.companyId, input.type, posted.id, c.invoice, a.invoiceId, a.amountPaise, ctx.userId)
    recordRequest(ctx, input.requestKey, entity, posted.id)
    const allocated = input.allocations.reduce((s, a) => s + a.amountPaise, 0)
    writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'ALLOCATE', entityType: input.type === 'RECEIPT' ? 'payment_receipt' : 'payment_voucher', entityId: posted.id,
      summary: `${formatINR(allocated)} of ${formatINR(input.amountPaise)} allocated to ${input.allocations.length} invoice(s)${allocated < input.amountPaise ? `; ${formatINR(input.amountPaise - allocated)} on account` : ''}`,
      details: { allocations: input.allocations.map((a) => ({ invoice: open.get(a.invoiceId)?.number, amountPaise: a.amountPaise })) }
    })
    return getPayment(ctx, input.type, posted.id)
  })
}

export function getPayment(ctx: ServiceContext, type: 'RECEIPT' | 'PAYMENT', id: number): PaymentDetail {
  const c = CFG[type]
  const r = ctx.db
    .prepare(
      `SELECT p.*, p.${c.no} AS number, p.${c.date} AS date, p.${c.party} AS party_id, x.name AS party_name, a.id AS account_id, a.name AS account_name, je.entry_no
       FROM ${c.table} p JOIN ${c.partyTable} x ON x.id = p.${c.party} JOIN chart_of_accounts a ON a.id = p.${c.account}
       LEFT JOIN journal_entries je ON je.id = p.journal_entry_id WHERE p.id = ? AND p.company_id = ?`
    )
    .get(id, ctx.companyId) as Record<string, unknown> | undefined
  if (!r) throw notFound(type === 'RECEIPT' ? 'Receipt' : 'Payment')
  const allocations = ctx.db
    .prepare(
      `SELECT al.invoice_id AS invoiceId, i.invoice_no AS number, i.invoice_date AS date, al.amount_paise AS amountPaise
       FROM payment_allocations al JOIN ${c.invoiceTable} i ON i.id = al.invoice_id
       WHERE al.source_type = ? AND al.source_id = ? AND al.is_reversed = 0 ORDER BY al.id`
    )
    .all(type, id) as PaymentDetail['allocations']
  const allocated = allocations.reduce((s, a) => s + a.amountPaise, 0)
  return {
    id, type, number: r.number as string, date: r.date as string, partyId: r.party_id as number, partyName: r.party_name as string, amountPaise: r.amount_paise as number,
    mode: r.mode as string, accountId: r.account_id as number, accountName: r.account_name as string, referenceNo: (r.reference_no as string | null) ?? null,
    notes: (r.notes as string | null) ?? null, status: r.status as string, allocatedPaise: allocated, unallocatedPaise: (r.amount_paise as number) - allocated,
    journalEntryNo: (r.entry_no as string | null) ?? null, allocations, createdAt: r.created_at as string
  }
}

export function listPayments(ctx: ServiceContext, q: { type: 'RECEIPT' | 'PAYMENT'; search?: string; partyId?: number }): PaymentRow[] {
  const c = CFG[q.type]
  return (
    ctx.db
      .prepare(
        `SELECT p.id, p.${c.no} AS number, p.${c.date} AS date, x.name AS partyName, p.amount_paise AS amountPaise, p.mode, a.name AS accountName, p.reference_no AS referenceNo,
           COALESCE((SELECT SUM(al.amount_paise) FROM payment_allocations al WHERE al.source_type = @t AND al.source_id = p.id AND al.is_reversed = 0), 0) AS allocatedPaise
         FROM ${c.table} p JOIN ${c.partyTable} x ON x.id = p.${c.party} JOIN chart_of_accounts a ON a.id = p.${c.account}
         WHERE p.company_id = @c ${q.partyId ? `AND p.${c.party} = @party` : ''} ${q.search ? `AND (p.${c.no} LIKE @like OR x.name LIKE @like OR IFNULL(p.reference_no,'') LIKE @like)` : ''}
         ORDER BY p.${c.date} DESC, p.id DESC LIMIT 500`
      )
      .all({ t: q.type, c: ctx.companyId, party: q.partyId ?? null, like: `%${q.search ?? ''}%` }) as Array<Omit<PaymentRow, 'type' | 'unallocatedPaise'>>
  ).map((r) => ({ ...r, type: q.type, unallocatedPaise: r.amountPaise - r.allocatedPaise }))
}
