/** Sales/Purchase module dashboards and invoice registers (all figures from posted documents). */
import { KINDS, SIDE_KINDS, type DocumentKind, type DocStatus, type ModuleSummary, type RegisterRow, type Side } from '@shared/documents'
import { financialYearOf, financialYearRange } from '@shared/india'
import { bool, type ServiceContext } from '../context'
import { childrenOf, listDocuments, paymentStatusOf } from './store'

const today = (): string => new Date().toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000)

const S = {
  SALES: { kind: 'SALES_INVOICE' as const, table: 'sales_invoices', party: 'customer_id', partyTable: 'customers', gstin: 'customer_gstin', ref: 'reference_no', ledger: 'AR', sign: 1, payTable: 'payment_receipts', payDate: 'receipt_date' },
  PURCHASE: { kind: 'PURCHASE_INVOICE' as const, table: 'purchase_invoices', party: 'supplier_id', partyTable: 'suppliers', gstin: 'supplier_gstin', ref: 'supplier_invoice_no', ledger: 'AP', sign: -1, payTable: 'payment_vouchers', payDate: 'voucher_date' }
}

export function register(
  ctx: ServiceContext,
  q: { side: Side; from?: string; to?: string; search?: string; paymentStatus?: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERDUE'; includeCancelled?: boolean },
  asOf = today()
): RegisterRow[] {
  const c = S[q.side]
  const where = ['i.company_id = @co', q.includeCancelled ? "i.status IN ('POSTED','CANCELLED')" : "i.status = 'POSTED'"]
  if (q.from) where.push('i.invoice_date >= @from')
  if (q.to) where.push('i.invoice_date <= @to')
  if (q.search) where.push(`(i.invoice_no LIKE @like OR p.name LIKE @like OR IFNULL(i.${c.ref},'') LIKE @like OR IFNULL(i.${c.gstin},'') LIKE @like)`)
  const rows = ctx.db
    .prepare(
      `SELECT i.id, i.invoice_no AS number, i.invoice_date AS date, i.due_date AS dueDate, p.id AS partyId, p.name AS partyName, i.${c.gstin} AS partyGstin,
         i.${c.ref} AS partyRef, i.status, i.is_inter_state AS isInterState, i.taxable_paise AS taxablePaise, i.cgst_paise AS cgstPaise, i.sgst_paise AS sgstPaise,
         i.igst_paise AS igstPaise, i.grand_total_paise AS grandTotalPaise,
         COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_type = '${c.kind}' AND a.invoice_id = i.id AND a.is_reversed = 0), 0) AS settledPaise
       FROM ${c.table} i JOIN ${c.partyTable} p ON p.id = i.${c.party}
       WHERE ${where.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC LIMIT 2000`
    )
    .all({ co: ctx.companyId, from: q.from ?? null, to: q.to ?? null, like: `%${q.search ?? ''}%` }) as Array<
    Omit<RegisterRow, 'kind' | 'isInterState' | 'balanceDuePaise' | 'paymentStatus' | 'overdueDays'> & { isInterState: number; status: DocStatus }
  >
  return rows
    .map((r) => {
      const balance = r.status === 'POSTED' ? r.grandTotalPaise - r.settledPaise : 0
      const overdueDays = balance > 0 && r.dueDate && r.dueDate < asOf ? daysBetween(r.dueDate, asOf) : 0
      return {
        ...r,
        kind: c.kind,
        partyRef: r.partyRef?.startsWith('~DRAFT-') ? null : r.partyRef,
        isInterState: bool(r.isInterState),
        balanceDuePaise: balance,
        paymentStatus: paymentStatusOf(c.kind, r.status, r.grandTotalPaise, r.settledPaise),
        overdueDays
      }
    })
    .filter((r) => !q.paymentStatus || (q.paymentStatus === 'OVERDUE' ? r.overdueDays > 0 : r.paymentStatus === q.paymentStatus))
}

export function moduleSummary(ctx: ServiceContext, side: Side, asOf = today()): ModuleSummary {
  const db = ctx.db
  const c = S[side]
  const { fy_start_month } = db.prepare('SELECT fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { fy_start_month: number }
  const fy = financialYearOf(asOf, fy_start_month)
  const { from, to } = financialYearRange(fy, fy_start_month)
  const month = asOf.slice(0, 7)
  const m = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(grand_total_paise),0) t FROM ${c.table} WHERE company_id = ? AND status = 'POSTED' AND invoice_date LIKE ?`).get(ctx.companyId, `${month}-%`) as { n: number; t: number }
  const y = db.prepare(`SELECT COALESCE(SUM(grand_total_paise),0) t FROM ${c.table} WHERE company_id = ? AND status = 'POSTED' AND invoice_date BETWEEN ? AND ?`).get(ctx.companyId, from, to) as { t: number }
  const outstanding = (db.prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.company_id = ? AND a.system_key = ?`).get(ctx.companyId, c.ledger) as { b: number }).b * c.sign
  const settledMonth = (db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM ${c.payTable} WHERE company_id = ? AND status = 'POSTED' AND ${c.payDate} LIKE ?`).get(ctx.companyId, `${month}-%`) as { t: number }).t
  const reg = register(ctx, { side }, asOf)
  const overdue = reg.filter((r) => r.overdueDays > 0).sort((a, b) => b.overdueDays - a.overdueDays)

  let draftCount = 0
  const pending: ModuleSummary['pending'] = []
  for (const kind of SIDE_KINDS[side]) {
    const docs = listDocuments(ctx, { kind, limit: 1000 })
    draftCount += docs.filter((d) => d.status === 'DRAFT').length
    const converts = KINDS[kind].converts.filter((t) => !t.includes('RETURN') && !t.endsWith('_NOTE'))
    if (converts.length === 0) continue
    // "Open" = posted, with nothing created from it yet (or everything created from it cancelled).
    const open = docs.filter((d) => d.status === 'POSTED' && childrenOf(db, kind, d.id).every((ch) => ch.status === 'CANCELLED'))
    pending.push({ kind: kind as DocumentKind, label: `Open ${KINDS[kind].plural.toLowerCase()}`, count: open.length, valuePaise: open.reduce((s, d) => s + d.grandTotalPaise, 0) })
  }
  const recent = SIDE_KINDS[side]
    .flatMap((kind) => listDocuments(ctx, { kind, limit: 12 }))
    .filter((d) => d.status !== 'DRAFT')
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, 10)

  return {
    side, asOf, financialYear: fy, monthTotalPaise: m.t, monthCount: m.n, fyTotalPaise: y.t, outstandingPaise: outstanding,
    overduePaise: overdue.reduce((s, r) => s + r.balanceDuePaise, 0), overdueCount: overdue.length, settledThisMonthPaise: settledMonth,
    draftCount, pending, recent, overdue: overdue.slice(0, 8)
  }
}
