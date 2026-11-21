/**
 * Accounts receivable / payable: open items, advances and ageing as of a date.
 *
 * Open items are rebuilt from the documents (invoices, opening balances, journal
 * vouchers), and credits from receipts/payments and returns/notes, using the
 * allocations that were live on the date. The result is compared with the party
 * balances in the control ledger (Sundry Debtors / Creditors), which is computed
 * independently from journal lines, so any disagreement is reported, not hidden.
 *
 * A document cancelled AFTER the as-of date is still live on that date (its
 * reversal journal is dated on the cancellation day), exactly like the ledger.
 */
import { AGEING_BUCKETS, bucketFor, type AgeingItem, type AgeingReport, type OnAccountItem, type PartyAgeingRow, type PartyStatement } from '@shared/finance'
import { docRoute, type DocumentKind } from '@shared/documents'
import type { ServiceContext } from '../context'
import { notFound } from '../errors'
import { daysBetween } from './periods'

type Side = 'CUSTOMER' | 'SUPPLIER'

const CFG = {
  CUSTOMER: {
    partyTable: 'customers', invoiceTable: 'sales_invoices', invoiceKind: 'SALES_INVOICE' as DocumentKind, partyCol: 'customer_id', controlKey: 'AR', sign: 1,
    payTable: 'payment_receipts', payNo: 'receipt_no', payDate: 'receipt_date', payKind: 'RECEIPT' as const, payRoute: '/sales/receipts',
    notes: ['SALES_RETURN', 'CREDIT_NOTE'] as DocumentKind[], creditDays: 'credit_days', creditLimit: 'credit_limit_paise'
  },
  SUPPLIER: {
    partyTable: 'suppliers', invoiceTable: 'purchase_invoices', invoiceKind: 'PURCHASE_INVOICE' as DocumentKind, partyCol: 'supplier_id', controlKey: 'AP', sign: -1,
    payTable: 'payment_vouchers', payNo: 'voucher_no', payDate: 'voucher_date', payKind: 'PAYMENT' as const, payRoute: '/purchase/payments',
    notes: ['PURCHASE_RETURN', 'DEBIT_NOTE'] as DocumentKind[], creditDays: 'payment_terms_days', creditLimit: null
  }
}

interface PartyData {
  items: AgeingItem[]
  onAccount: OnAccountItem[]
}

const emptyBuckets = () => Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Record<(typeof AGEING_BUCKETS)[number], number>

/** Open items and on-account credits per party as of `asOf` (optionally one party). */
function collect(ctx: ServiceContext, side: Side, asOf: string, partyId?: number): Map<number, PartyData> {
  const c = CFG[side]
  const db = ctx.db
  const P = { co: ctx.companyId, d: asOf, pid: partyId ?? null }
  const partyFilter = (col: string) => (partyId ? `AND ${col} = @pid` : '')
  const out = new Map<number, PartyData>()
  const party = (id: number) => {
    let v = out.get(id)
    if (!v) out.set(id, (v = { items: [], onAccount: [] }))
    return v
  }
  const control = db.prepare(`SELECT id FROM chart_of_accounts WHERE company_id = ? AND system_key = ?`).get(ctx.companyId, c.controlKey) as { id: number } | undefined
  if (!control) return out
  const noteList = c.notes.map((n) => `'${n}'`).join(',')

  // Allocations live on the date: source and invoice both dated on/before it, and not reversed by then.
  const allocs = db
    .prepare(
      `SELECT a.source_type, a.source_id, a.invoice_id, a.amount_paise FROM payment_allocations a
       JOIN ${c.invoiceTable} i ON i.id = a.invoice_id
       LEFT JOIN ${c.payTable} p ON a.source_type = '${c.payKind}' AND p.id = a.source_id
       LEFT JOIN trade_documents d ON a.source_type IN (${noteList}) AND d.id = a.source_id
       WHERE a.company_id = @co AND a.invoice_type = '${c.invoiceKind}' AND i.invoice_date <= @d
         AND COALESCE(p.${c.payDate}, d.doc_date) <= @d
         AND (a.is_reversed = 0 OR substr(a.reversed_at, 1, 10) > @d) ${partyFilter(`i.${c.partyCol}`)}`
    )
    .all(P) as Array<{ source_type: string; source_id: number; invoice_id: number; amount_paise: number }>
  const settledByInvoice = new Map<number, number>()
  const allocatedBySource = new Map<string, number>()
  for (const a of allocs) {
    settledByInvoice.set(a.invoice_id, (settledByInvoice.get(a.invoice_id) ?? 0) + a.amount_paise)
    const k = `${a.source_type}#${a.source_id}`
    allocatedBySource.set(k, (allocatedBySource.get(k) ?? 0) + a.amount_paise)
  }

  const item = (kind: AgeingItem['kind'], id: number, number: string, date: string, due: string, amount: number, settled: number, route: string | null): AgeingItem => {
    const daysOverdue = due < asOf ? daysBetween(due, asOf) : 0
    return { kind, id, number, date, dueDate: due, daysOverdue, bucket: bucketFor(daysOverdue), amountPaise: amount, settledPaise: settled, balancePaise: amount - settled, route }
  }

  // Invoices live on the date (posted, or cancelled after it).
  const invoices = db
    .prepare(
      `SELECT i.id, i.invoice_no AS number, i.invoice_date AS date, COALESCE(i.due_date, i.invoice_date) AS due, i.grand_total_paise AS amount, i.${c.partyCol} AS party_id
       FROM ${c.invoiceTable} i LEFT JOIN journal_entries rj ON rj.id = i.reversal_journal_entry_id
       WHERE i.company_id = @co AND i.invoice_date <= @d
         AND (i.status = 'POSTED' OR (i.status = 'CANCELLED' AND COALESCE(rj.entry_date, substr(i.cancelled_at, 1, 10)) > @d)) ${partyFilter(`i.${c.partyCol}`)}`
    )
    .all(P) as Array<{ id: number; number: string; date: string; due: string; amount: number; party_id: number }>
  for (const i of invoices) {
    const settled = settledByInvoice.get(i.id) ?? 0
    if (i.amount - settled !== 0) party(i.party_id).items.push(item('INVOICE', i.id, i.number, i.date, i.due, i.amount, settled, docRoute(c.invoiceKind, i.id)))
  }

  // Receipts / payments: the unallocated part is on account (advance).
  const pays = db
    .prepare(`SELECT id, ${c.payNo} AS number, ${c.payDate} AS date, ${c.partyCol} AS party_id, amount_paise AS amount FROM ${c.payTable}
              WHERE company_id = @co AND status = 'POSTED' AND ${c.payDate} <= @d ${partyFilter(c.partyCol)}`)
    .all(P) as Array<{ id: number; number: string; date: string; party_id: number; amount: number }>
  for (const p of pays) {
    const unallocated = p.amount - (allocatedBySource.get(`${c.payKind}#${p.id}`) ?? 0)
    if (unallocated !== 0) party(p.party_id).onAccount.push({ kind: c.payKind, id: p.id, number: p.number, date: p.date, amountPaise: p.amount, unallocatedPaise: unallocated, route: `${c.payRoute}/${p.id}` })
  }

  // Returns and credit/debit notes live on the date: the part not set against an invoice is on account.
  const notes = db
    .prepare(
      `SELECT d.id, d.doc_type, d.doc_no AS number, d.doc_date AS date, d.${c.partyCol} AS party_id, d.grand_total_paise AS amount
       FROM trade_documents d LEFT JOIN journal_entries rj ON rj.id = d.reversal_journal_entry_id
       WHERE d.company_id = @co AND d.doc_type IN (${noteList}) AND d.doc_date <= @d AND d.journal_entry_id IS NOT NULL
         AND (d.status = 'POSTED' OR (d.status = 'CANCELLED' AND COALESCE(rj.entry_date, substr(d.cancelled_at, 1, 10)) > @d)) ${partyFilter(`d.${c.partyCol}`)}`
    )
    .all(P) as Array<{ id: number; doc_type: DocumentKind; number: string; date: string; party_id: number; amount: number }>
  for (const n of notes) {
    const unallocated = n.amount - (allocatedBySource.get(`${n.doc_type}#${n.id}`) ?? 0)
    if (unallocated !== 0) party(n.party_id).onAccount.push({ kind: n.doc_type as OnAccountItem['kind'], id: n.id, number: n.number, date: n.date, amountPaise: n.amount, unallocatedPaise: unallocated, route: docRoute(n.doc_type, n.id) })
  }

  // Opening balances and any other control-account postings with a party (journal vouchers etc.).
  const handled = [
    `'${c.invoiceKind}'`, `'CANCEL:${c.invoiceKind}'`, `'${c.payKind}'`, ...c.notes.flatMap((n) => [`'${n}'`, `'CANCEL:${n}'`]),
    `'JOURNAL_VOUCHER'`, `'CANCEL:JOURNAL_VOUCHER'`
  ].join(',')
  const others = db
    .prepare(
      `SELECT je.id, je.entry_no, je.entry_date AS date, COALESCE(je.source_kind, je.source_type) AS kind, l.party_id, SUM(l.debit_paise - l.credit_paise) AS b
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE je.company_id = @co AND l.account_id = ${control.id} AND l.party_type = '${side}' AND je.entry_date <= @d
         AND COALESCE(je.source_kind, je.source_type) NOT IN (${handled}) ${partyFilter('l.party_id')}
       GROUP BY je.id, l.party_id`
    )
    .all(P) as Array<{ id: number; entry_no: string; date: string; kind: string; party_id: number; b: number }>
  for (const o of others) {
    const natural = o.b * c.sign
    if (natural === 0) continue
    const opening = o.kind === 'OPENING'
    const label = opening ? 'Opening balance' : o.entry_no
    if (natural > 0) party(o.party_id).items.push(item(opening ? 'OPENING' : 'ADJUSTMENT', o.id, label, o.date, o.date, natural, 0, null))
    else party(o.party_id).onAccount.push({ kind: 'ADJUSTMENT', id: o.id, number: opening ? 'Opening balance (credit)' : o.entry_no, date: o.date, amountPaise: -natural, unallocatedPaise: -natural, route: null })
  }

  // Journal vouchers live on the date (posted, or cancelled after it), net per party.
  const vouchers = db
    .prepare(
      `SELECT v.id, v.voucher_no AS number, v.voucher_date AS date, l.party_id, SUM(l.debit_paise - l.credit_paise) AS b
       FROM vouchers v JOIN journal_entry_lines l ON l.journal_entry_id = v.journal_entry_id LEFT JOIN journal_entries rj ON rj.id = v.reversal_journal_entry_id
       WHERE v.company_id = @co AND v.voucher_date <= @d AND (v.status = 'POSTED' OR rj.entry_date > @d)
         AND l.account_id = ${control.id} AND l.party_type = '${side}' ${partyFilter('l.party_id')}
       GROUP BY v.id, l.party_id`
    )
    .all(P) as Array<{ id: number; number: string; date: string; party_id: number; b: number }>
  for (const v of vouchers) {
    const natural = v.b * c.sign
    if (natural > 0) party(v.party_id).items.push(item('ADJUSTMENT', v.id, v.number, v.date, v.date, natural, 0, `/finance/vouchers/${v.id}`))
    else if (natural < 0) party(v.party_id).onAccount.push({ kind: 'ADJUSTMENT', id: v.id, number: v.number, date: v.date, amountPaise: -natural, unallocatedPaise: -natural, route: `/finance/vouchers/${v.id}` })
  }
  return out
}

/** Party balances in the control ledger as of the date (natural sign), independent of documents. */
function ledgerByParty(ctx: ServiceContext, side: Side, asOf: string): { byParty: Map<number, number>; control: number } {
  const c = CFG[side]
  const rows = ctx.db
    .prepare(
      `SELECT l.party_type, l.party_id, SUM(l.debit_paise - l.credit_paise) AS b FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE je.company_id = ? AND a.system_key = ? AND je.entry_date <= ? GROUP BY l.party_type, l.party_id`
    )
    .all(ctx.companyId, c.controlKey, asOf) as Array<{ party_type: string | null; party_id: number | null; b: number }>
  const byParty = new Map<number, number>()
  let control = 0
  for (const r of rows) {
    control += r.b * c.sign
    if (r.party_type === side && r.party_id) byParty.set(r.party_id, (byParty.get(r.party_id) ?? 0) + r.b * c.sign)
  }
  return { byParty, control }
}

function summarise(p: { id: number; code: string; name: string }, data: PartyData, ledger: number): PartyAgeingRow {
  const buckets = emptyBuckets()
  let gross = 0
  let overdue = 0
  let oldest = 0
  for (const i of data.items) {
    buckets[i.bucket] += i.balancePaise
    gross += i.balancePaise
    if (i.daysOverdue > 0) {
      overdue += i.balancePaise
      oldest = Math.max(oldest, i.daysOverdue)
    }
  }
  const onAccount = data.onAccount.reduce((s, o) => s + o.unallocatedPaise, 0)
  return {
    partyId: p.id, code: p.code, name: p.name, buckets, grossPaise: gross, onAccountPaise: onAccount, netPaise: gross - onAccount, ledgerPaise: ledger,
    differencePaise: gross - onAccount - ledger, overduePaise: overdue, oldestOverdueDays: oldest, openItems: data.items.length,
    overdueInvoices: data.items.filter((i) => i.kind === 'INVOICE' && i.daysOverdue > 0).length,
    overdueItems: data.items.filter((i) => i.daysOverdue > 0).length
  }
}

export function ageing(ctx: ServiceContext, side: Side, asOf: string): AgeingReport {
  const c = CFG[side]
  const data = collect(ctx, side, asOf)
  const { byParty, control } = ledgerByParty(ctx, side, asOf)
  const parties = ctx.db.prepare(`SELECT id, code, name FROM ${c.partyTable} WHERE company_id = ? ORDER BY name`).all(ctx.companyId) as Array<{ id: number; code: string; name: string }>
  const rows: PartyAgeingRow[] = []
  for (const p of parties) {
    const d = data.get(p.id) ?? { items: [], onAccount: [] }
    const ledger = byParty.get(p.id) ?? 0
    if (d.items.length === 0 && d.onAccount.length === 0 && ledger === 0) continue
    rows.push(summarise(p, d, ledger))
  }
  const totals = { ...emptyBuckets(), grossPaise: 0, onAccountPaise: 0, netPaise: 0, overduePaise: 0 }
  for (const r of rows) {
    for (const b of AGEING_BUCKETS) totals[b] += r.buckets[b]
    totals.grossPaise += r.grossPaise
    totals.onAccountPaise += r.onAccountPaise
    totals.netPaise += r.netPaise
    totals.overduePaise += r.overduePaise
  }
  const difference = totals.netPaise - control
  return { side, asOf, rows: rows.sort((a, b) => b.netPaise - a.netPaise || a.name.localeCompare(b.name)), totals, controlAccountPaise: control, differencePaise: difference, agrees: difference === 0 && rows.every((r) => r.differencePaise === 0) }
}

export function partyStatement(ctx: ServiceContext, side: Side, partyId: number, asOf: string): PartyStatement {
  const c = CFG[side]
  const p = ctx.db
    .prepare(`SELECT id, code, name, gstin, ${c.creditDays} AS days${c.creditLimit ? `, ${c.creditLimit} AS lim` : ''} FROM ${c.partyTable} WHERE id = ? AND company_id = ?`)
    .get(partyId, ctx.companyId) as { id: number; code: string; name: string; gstin: string | null; days: number; lim?: number } | undefined
  if (!p) throw notFound(side === 'CUSTOMER' ? 'Customer' : 'Supplier')
  const d = collect(ctx, side, asOf, partyId).get(partyId) ?? { items: [], onAccount: [] }
  const ledger = ledgerByParty(ctx, side, asOf).byParty.get(partyId) ?? 0

  const payments = (
    ctx.db
      .prepare(`SELECT id, ${c.payNo} AS number, ${c.payDate} AS date, mode, amount_paise AS amountPaise FROM ${c.payTable}
                WHERE company_id = ? AND ${c.partyCol} = ? AND status = 'POSTED' AND ${c.payDate} <= ? ORDER BY ${c.payDate} DESC, id DESC`)
      .all(ctx.companyId, partyId, asOf) as Array<{ id: number; number: string; date: string; mode: string; amountPaise: number }>
  ).map((x) => {
    const allocations = ctx.db
      .prepare(`SELECT i.invoice_no AS number, a.amount_paise AS amountPaise FROM payment_allocations a JOIN ${c.invoiceTable} i ON i.id = a.invoice_id
                WHERE a.source_type = ? AND a.source_id = ? AND a.is_reversed = 0 ORDER BY a.id`)
      .all(c.payKind, x.id) as Array<{ number: string; amountPaise: number }>
    return { ...x, route: `${c.payRoute}/${x.id}`, allocatedPaise: allocations.reduce((s, a) => s + a.amountPaise, 0), allocations }
  })

  const notes = (
    ctx.db
      .prepare(
        `SELECT d.id, d.doc_type AS kind, d.doc_no AS number, d.doc_date AS date, d.status, d.grand_total_paise AS amountPaise,
           CASE WHEN d.source_type = '${c.invoiceKind}' THEN (SELECT invoice_no FROM ${c.invoiceTable} WHERE id = d.source_id) END AS against
         FROM trade_documents d WHERE d.company_id = ? AND d.${c.partyCol} = ? AND d.doc_type IN (${c.notes.map((n) => `'${n}'`).join(',')})
           AND d.status <> 'DRAFT' AND d.doc_date <= ? ORDER BY d.doc_date DESC, d.id DESC`
      )
      .all(ctx.companyId, partyId, asOf) as Array<{ id: number; kind: DocumentKind; number: string; date: string; status: string; amountPaise: number; against: string | null }>
  ).map((n) => ({ ...n, label: n.kind.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()), route: docRoute(n.kind, n.id) }))

  return {
    side, asOf,
    party: { id: p.id, code: p.code, name: p.name, gstin: p.gstin, creditDays: p.days, creditLimitPaise: p.lim ?? null },
    items: d.items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)),
    onAccount: d.onAccount.sort((a, b) => a.date.localeCompare(b.date)),
    payments, notes,
    summary: summarise(p, d, ledger)
  }
}
