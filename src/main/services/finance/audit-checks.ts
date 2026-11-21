/**
 * Auditor workspace: exception report and integrity / reconciliation checks.
 *
 * Exceptions are items an auditor should look at. They are never labelled as
 * fraud: "unusual" only means the item differs from the normal pattern or lacks
 * expected evidence. Everything is read-only.
 */
import type { Statement } from 'better-sqlite3'
import { DOCUMENT_KINDS, KINDS, docRoute, isInvoiceKind, type DocumentKind } from '@shared/documents'
import { EXCEPTION_CATEGORIES, type AuditException, type AuditExceptionReport, type ExceptionCategory, type IntegrityCheck, type IntegrityReport } from '@shared/finance'
import { formatINR } from '@shared/money'
import type { ServiceContext } from '../context'
import { storeFor } from '../documents/store'
import { ageing } from './ageing'
import { daysBetween, fyFor, todayIso } from './periods'
import { SourceResolver } from './sources'
import { balanceSheet, ledgerClosingLineByLine, trialBalanceReport } from './statements'

export const EXCEPTION_DISCLAIMER =
  'Items are listed for review only. An exception means a transaction is unusual or lacks expected evidence — it is not a finding that it is wrong, and never by itself an indication of fraud.'

/** Manual journal thresholds (review triggers, not judgements). */
export const MANUAL_JOURNAL_RULES = { largePaise: 10_000_000, roundPaise: 1_000_000, roundMinPaise: 5_000_000, backdatedDays: 7 }

const LEDGER_KINDS = DOCUMENT_KINDS.filter((k) => KINDS[k].ledger)

export function auditExceptions(ctx: ServiceContext, q: { from?: string; to?: string } = {}): AuditExceptionReport {
  const db = ctx.db
  const c = ctx.companyId
  const from = q.from ?? '0000-01-01'
  const to = q.to ?? '9999-12-31'
  const items: AuditException[] = []
  const push = (e: Omit<AuditException, 'id'>, key: string) => items.push({ id: `${e.category}:${key}`, ...e })
  const resolver = new SourceResolver(db)

  // 1. Unbalanced journal attempts (rejected before posting; recorded in the audit log).
  for (const r of db
    .prepare(`SELECT a.id, a.created_at, a.summary, a.details_json, u.username FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.company_id = ? AND a.action = 'JOURNAL_REJECTED' AND substr(a.created_at, 1, 10) BETWEEN ? AND ? ORDER BY a.id`)
    .all(c, from, to) as Array<{ id: number; created_at: string; summary: string; details_json: string | null; username: string | null }>) {
    const d = r.details_json ? (JSON.parse(r.details_json) as { differencePaise?: number; narration?: string }) : {}
    push({ category: 'UNBALANCED_ATTEMPT', severity: 'review', date: r.created_at.slice(0, 10), reference: `Audit #${r.id}`, route: null, title: 'Unbalanced journal rejected', detail: `${r.summary}${d.narration ? ` — "${d.narration}"` : ''}. Nothing was posted.`, amountPaise: d.differencePaise ?? null, user: r.username }, String(r.id))
  }
  // Stored journals that do not balance (the engine prevents this; checked as evidence).
  for (const r of db
    .prepare(`SELECT je.id, je.entry_no, je.entry_date, je.total_debit_paise, SUM(l.debit_paise) d, SUM(l.credit_paise) cr FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
              WHERE je.company_id = ? AND je.entry_date BETWEEN ? AND ? GROUP BY je.id HAVING d <> cr OR d <> je.total_debit_paise`)
    .all(c, from, to) as Array<{ id: number; entry_no: string; entry_date: string; d: number; cr: number }>) {
    push({ category: 'UNBALANCED_ATTEMPT', severity: 'review', date: r.entry_date, reference: r.entry_no, route: null, title: 'Stored journal does not balance', detail: `Lines total debit ${formatINR(r.d)} vs credit ${formatINR(r.cr)}`, amountPaise: r.d - r.cr, user: null }, `je${r.id}`)
  }

  // 2. Missing source references.
  for (const j of db
    .prepare(`SELECT je.id, je.entry_no, je.entry_date, je.source_type, je.source_kind, je.source_id, je.total_debit_paise, u.username FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by
              WHERE je.company_id = ? AND je.entry_date BETWEEN ? AND ? ORDER BY je.entry_date, je.id`)
    .all(c, from, to) as Array<{ id: number; entry_no: string; entry_date: string; source_type: string; source_kind: string | null; source_id: number | null; total_debit_paise: number; username: string | null }>) {
    const kind = j.source_kind ?? j.source_type
    if (kind === 'OPENING') continue
    const src = resolver.resolve(j)
    if (src.documentStatus === 'MISSING' || (!j.source_id && kind !== 'OPENING'))
      push({ category: 'MISSING_SOURCE', severity: 'review', date: j.entry_date, reference: j.entry_no, route: null, title: 'Journal without a source document', detail: `${src.voucherType}: the originating document ${j.source_id ? `#${j.source_id} was not found` : 'is not recorded'}`, amountPaise: j.total_debit_paise, user: j.username }, `je${j.id}`)
  }
  for (const kind of LEDGER_KINDS) {
    const s = storeFor(kind)
    for (const d of db
      .prepare(`SELECT id, ${s.numberCol} AS no, ${s.dateCol} AS date, grand_total_paise FROM ${s.header} WHERE company_id = ? AND status <> 'DRAFT' AND journal_entry_id IS NULL AND ${s.dateCol} BETWEEN ? AND ?${s.typed ? ` AND doc_type = '${kind}'` : ''}`)
      .all(c, from, to) as Array<{ id: number; no: string; date: string; grand_total_paise: number }>) {
      // Challans / GRNs of services-only or untracked goods legitimately have no journal.
      const stockMoves = (db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE reference_type = ? AND reference_id = ?').get(kind, d.id) as { n: number }).n
      if (!isInvoiceKind(kind) && KINDS[kind].stock !== 'NONE' && stockMoves === 0) continue
      push({ category: 'MISSING_SOURCE', severity: 'review', date: d.date, reference: d.no, route: docRoute(kind, d.id), title: `${KINDS[kind].label} has no journal entry`, detail: 'A posted document with accounting effect should have a journal entry', amountPaise: d.grand_total_paise, user: null }, `${kind}${d.id}`)
    }
  }
  const existsIn = new Map<string, Statement>()
  const sourceExists = (kind: DocumentKind, id: number) => {
    const table = storeFor(kind).header
    let st = existsIn.get(table)
    if (!st) existsIn.set(table, (st = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`)))
    return !!st.get(id)
  }
  for (const m of db
    .prepare(`SELECT m.id, m.movement_date, m.reference_type, m.reference_id, m.reference_no, m.value_paise FROM stock_movements m WHERE m.company_id = ? AND m.movement_date BETWEEN ? AND ? AND m.movement_type <> 'OPENING'`)
    .all(c, from, to) as Array<{ id: number; movement_date: string; reference_type: string | null; reference_id: number | null; reference_no: string | null; value_paise: number }>) {
    const kind = m.reference_type as DocumentKind | null
    const ok = kind && (DOCUMENT_KINDS as readonly string[]).includes(kind) && m.reference_id && sourceExists(kind, m.reference_id)
    if (!ok) push({ category: 'MISSING_SOURCE', severity: 'review', date: m.movement_date, reference: m.reference_no ?? `Movement #${m.id}`, route: null, title: 'Stock movement without a source document', detail: `Reference ${m.reference_type ?? 'none'} #${m.reference_id ?? '—'} not found`, amountPaise: m.value_paise, user: null }, `sm${m.id}`)
  }

  // 3. Duplicate document references.
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const bills = db
    .prepare(`SELECT p.id, p.invoice_no, p.invoice_date, p.supplier_invoice_no, p.grand_total_paise, p.supplier_id, s.name FROM purchase_invoices p JOIN suppliers s ON s.id = p.supplier_id
              WHERE p.company_id = ? AND p.status = 'POSTED'`)
    .all(c) as Array<{ id: number; invoice_no: string; invoice_date: string; supplier_invoice_no: string; grand_total_paise: number; supplier_id: number; name: string }>
  const byRef = new Map<string, typeof bills>()
  for (const b of bills) {
    const k = `${b.supplier_id}|${norm(b.supplier_invoice_no)}`
    byRef.set(k, [...(byRef.get(k) ?? []), b])
  }
  for (const group of byRef.values()) {
    if (group.length < 2 || !group.some((b) => b.invoice_date >= from && b.invoice_date <= to)) continue
    push({ category: 'DUPLICATE_REFERENCE', severity: 'review', date: group[group.length - 1].invoice_date, reference: group.map((b) => b.invoice_no).join(', '), route: docRoute('PURCHASE_INVOICE', group[group.length - 1].id), title: 'Same supplier bill number recorded more than once', detail: `${group[0].name}: ${group.map((b) => `"${b.supplier_invoice_no}"`).join(' and ')} differ only in punctuation or spacing`, amountPaise: group[group.length - 1].grand_total_paise, user: null }, `bill${group.map((b) => b.id).join('-')}`)
  }
  const sameDayAmount = (table: string, kind: DocumentKind, partyCol: string, partyTable: string, label: string) => {
    for (const r of db
      .prepare(`SELECT ${partyCol} AS party, invoice_date AS date, grand_total_paise AS amt, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(invoice_no, ', ') AS nos, COUNT(*) AS n,
                  (SELECT name FROM ${partyTable} WHERE id = ${partyCol}) AS name
                FROM ${table} WHERE company_id = ? AND status = 'POSTED' AND invoice_date BETWEEN ? AND ? GROUP BY ${partyCol}, invoice_date, grand_total_paise HAVING n > 1`)
      .all(c, from, to) as Array<{ party: number; date: string; amt: number; ids: string; nos: string; n: number; name: string }>)
      push({ category: 'DUPLICATE_REFERENCE', severity: 'review', date: r.date, reference: r.nos, route: docRoute(kind, Number(r.ids.split(',')[0])), title: `Possible duplicate ${label}`, detail: `${r.n} ${label}s for ${r.name} on the same day with the same total ${formatINR(r.amt)}`, amountPaise: r.amt, user: null }, `${kind}${r.ids}`)
  }
  sameDayAmount('sales_invoices', 'SALES_INVOICE', 'customer_id', 'customers', 'sales invoice')
  sameDayAmount('purchase_invoices', 'PURCHASE_INVOICE', 'supplier_id', 'suppliers', 'purchase invoice')
  for (const [table, no, date, party, partyTable, route, label] of [
    ['payment_receipts', 'receipt_no', 'receipt_date', 'customer_id', 'customers', '/sales/receipts', 'receipt'],
    ['payment_vouchers', 'voucher_no', 'voucher_date', 'supplier_id', 'suppliers', '/purchase/payments', 'payment']
  ] as const) {
    const rows = db
      .prepare(`SELECT id, ${no} AS no, ${date} AS date, ${party} AS party, amount_paise, reference_no, (SELECT name FROM ${partyTable} WHERE id = ${party}) AS name FROM ${table}
                WHERE company_id = ? AND status = 'POSTED' AND reference_no IS NOT NULL AND TRIM(reference_no) <> ''`)
      .all(c) as Array<{ id: number; no: string; date: string; party: number; amount_paise: number; reference_no: string; name: string }>
    const groups = new Map<string, typeof rows>()
    for (const r of rows) groups.set(`${r.party}|${norm(r.reference_no)}`, [...(groups.get(`${r.party}|${norm(r.reference_no)}`) ?? []), r])
    for (const g of groups.values()) {
      if (g.length < 2 || !g.some((r) => r.date >= from && r.date <= to)) continue
      push({ category: 'DUPLICATE_REFERENCE', severity: 'review', date: g[g.length - 1].date, reference: g.map((r) => r.no).join(', '), route: `${route}/${g[g.length - 1].id}`, title: `Same bank reference on more than one ${label}`, detail: `${g[0].name}: reference "${g[0].reference_no}" used ${g.length} times`, amountPaise: g[g.length - 1].amount_paise, user: null }, `${label}${g.map((r) => r.id).join('-')}`)
    }
  }

  // 4. Unusual manual journals.
  const R = MANUAL_JOURNAL_RULES
  for (const v of db
    .prepare(`SELECT v.id, v.voucher_no, v.voucher_date, v.narration, v.amount_paise, v.created_at, v.status, u.username,
                (SELECT GROUP_CONCAT(DISTINCT a.system_key) FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = v.journal_entry_id AND a.system_key IS NOT NULL) AS keys
              FROM vouchers v LEFT JOIN users u ON u.id = v.created_by WHERE v.company_id = ? AND v.voucher_type = 'JOURNAL' AND v.voucher_date BETWEEN ? AND ? ORDER BY v.voucher_date`)
    .all(c, from, to) as Array<{ id: number; voucher_no: string; voucher_date: string; narration: string; amount_paise: number; created_at: string; status: string; username: string | null; keys: string | null }>) {
    const reasons: string[] = []
    if (v.amount_paise >= R.largePaise) reasons.push(`large amount (${formatINR(v.amount_paise)} ≥ ${formatINR(R.largePaise)})`)
    else if (v.amount_paise >= R.roundMinPaise && v.amount_paise % R.roundPaise === 0) reasons.push('round amount')
    const control = (v.keys ?? '').split(',').filter((k) => ['AR', 'AP', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST', 'GRNI'].includes(k))
    if (control.length) reasons.push(`adjusts control account(s): ${control.join(', ')}`)
    if (new Date(`${v.voucher_date}T00:00:00Z`).getUTCDay() === 0) reasons.push('dated on a Sunday')
    // Late entry is context for a flagged journal, not a trigger on its own (bulk entry of a month's vouchers is normal).
    const lag = daysBetween(v.voucher_date, v.created_at.slice(0, 10))
    if (reasons.length && lag > R.backdatedDays) reasons.push(`entered ${lag} days after its voucher date`)
    if (reasons.length)
      push({ category: 'MANUAL_JOURNAL', severity: 'review', date: v.voucher_date, reference: v.voucher_no, route: `/finance/vouchers/${v.id}`, title: 'Manual journal for review', detail: `${v.narration} — ${reasons.join('; ')}${v.status === 'CANCELLED' ? ' (since cancelled)' : ''}`, amountPaise: v.amount_paise, user: v.username }, String(v.id))
  }

  // 5. Reversed transactions.
  const revStmt = db.prepare(
    `SELECT entry_no, entry_date FROM (
       SELECT id, entry_no, entry_date FROM journal_entries WHERE reversal_of_id = ? AND company_id = ?
       UNION ALL
       SELECT id, entry_no, entry_date FROM journal_entries WHERE source_kind = ? AND source_id = ? AND company_id = ?
     ) ORDER BY id LIMIT 1`
  )
  for (const j of db
    .prepare(`SELECT je.id, je.entry_no, je.entry_date, je.source_type, je.source_kind, je.source_id, je.total_debit_paise, je.narration FROM journal_entries je
              WHERE je.company_id = ? AND je.status = 'REVERSED' AND je.entry_date BETWEEN ? AND ? ORDER BY je.entry_date`)
    .all(c, from, to) as Array<{ id: number; entry_no: string; entry_date: string; source_type: string; source_kind: string | null; source_id: number | null; total_debit_paise: number; narration: string | null }>) {
    const src = resolver.resolve(j)
    // Two indexed lookups (migration 007) instead of one OR across columns, which forced a scan of all journals.
    const rev = revStmt.get(j.id, c, `CANCEL:${j.source_kind ?? j.source_type}`, j.source_id ?? -1, c) as { entry_no: string; entry_date: string } | undefined
    push({ category: 'REVERSED', severity: 'info', date: j.entry_date, reference: `${j.entry_no}${src.voucherNo ? ` · ${src.voucherNo}` : ''}`, route: src.route, title: `${src.voucherType} reversed`, detail: rev ? `Reversed by ${rev.entry_no} on ${rev.entry_date}` : 'Reversal entry not found', amountPaise: j.total_debit_paise, user: null }, String(j.id))
  }

  // 6. Cancelled documents.
  for (const kind of DOCUMENT_KINDS) {
    const s = storeFor(kind)
    for (const d of db
      .prepare(`SELECT h.id, h.${s.numberCol} AS no, h.${s.dateCol} AS date, h.grand_total_paise, h.cancel_reason, h.cancelled_at, u.username FROM ${s.header} h LEFT JOIN users u ON u.id = h.cancelled_by
                WHERE h.company_id = ? AND h.status = 'CANCELLED' AND substr(h.cancelled_at, 1, 10) BETWEEN ? AND ?${s.typed ? ` AND h.doc_type = '${kind}'` : ''}`)
      .all(c, from, to) as Array<{ id: number; no: string; date: string; grand_total_paise: number; cancel_reason: string | null; cancelled_at: string; username: string | null }>)
      push({ category: 'CANCELLED', severity: 'info', date: d.cancelled_at.slice(0, 10), reference: d.no, route: docRoute(kind, d.id), title: `${KINDS[kind].label} cancelled`, detail: `Dated ${d.date}. Reason: ${d.cancel_reason ?? '—'}`, amountPaise: d.grand_total_paise, user: d.username }, `${kind}${d.id}`)
  }
  for (const v of db
    .prepare(`SELECT v.id, v.voucher_no, v.voucher_date, v.amount_paise, v.cancel_reason, v.cancelled_at, u.username FROM vouchers v LEFT JOIN users u ON u.id = v.cancelled_by
              WHERE v.company_id = ? AND v.status = 'CANCELLED' AND substr(v.cancelled_at, 1, 10) BETWEEN ? AND ?`)
    .all(c, from, to) as Array<{ id: number; voucher_no: string; voucher_date: string; amount_paise: number; cancel_reason: string | null; cancelled_at: string; username: string | null }>)
    push({ category: 'CANCELLED', severity: 'info', date: v.cancelled_at.slice(0, 10), reference: v.voucher_no, route: `/finance/vouchers/${v.id}`, title: 'Voucher cancelled', detail: `Dated ${v.voucher_date}. Reason: ${v.cancel_reason ?? '—'}`, amountPaise: v.amount_paise, user: v.username }, `v${v.id}`)

  // 7. Unusual stock adjustments.
  for (const m of db
    .prepare(`SELECT m.id, m.movement_date, m.movement_type, m.reference_type, m.qty_in_milli, m.qty_out_milli, m.unit_cost_paise, m.value_paise, m.reference_no, m.created_at, p.code, p.name, u.username
              FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.created_by
              WHERE m.company_id = ? AND m.movement_date BETWEEN ? AND ? ORDER BY m.movement_date, m.id`)
    .all(c, from, to) as Array<{ id: number; movement_date: string; movement_type: string; reference_type: string | null; qty_in_milli: number; qty_out_milli: number; unit_cost_paise: number; value_paise: number; reference_no: string | null; created_at: string; code: string; name: string; username: string | null }>) {
    const reasons: string[] = []
    let severity: AuditException['severity'] = 'review'
    if (m.movement_type.startsWith('ADJUSTMENT')) reasons.push(`manual stock adjustment (${m.movement_type === 'ADJUSTMENT_IN' ? 'increase' : 'decrease'})`)
    // Returns are normal business; a reversal that is not a return comes from cancelling a document.
    const isReturn = m.reference_type === 'SALES_RETURN' || m.reference_type === 'PURCHASE_RETURN'
    if (m.movement_type.endsWith('_REVERSAL') && !isReturn) {
      reasons.push(`stock movement reversed because ${m.reference_type ? KINDS[m.reference_type as DocumentKind]?.label ?? m.reference_type : 'a document'} was cancelled`)
      severity = 'info'
    }
    if (m.qty_in_milli > 0 && m.value_paise === 0 && !m.movement_type.endsWith('_REVERSAL')) {
      reasons.push('received at zero cost')
      severity = 'review'
    }
    if (!reasons.length) continue
    push({ category: 'STOCK_ADJUSTMENT', severity, date: m.movement_date, reference: m.reference_no ?? `Movement #${m.id}`, route: '/inventory', title: `${m.code} ${m.name}`, detail: `${reasons.join('; ')} — ${m.qty_in_milli ? `+${m.qty_in_milli / 1000}` : `−${m.qty_out_milli / 1000}`} units, ${formatINR(m.value_paise)}`, amountPaise: m.value_paise, user: m.username }, String(m.id))
  }

  const counts = Object.fromEntries(Object.keys(EXCEPTION_CATEGORIES).map((k) => [k, items.filter((i) => i.category === k).length])) as Record<ExceptionCategory, number>
  items.sort((a, b) => b.date.localeCompare(a.date) || a.category.localeCompare(b.category))
  return { from: q.from ?? null, to: q.to ?? null, generatedAt: new Date().toISOString(), counts, items, disclaimer: EXCEPTION_DISCLAIMER }
}

/** Financial report reconciliation: every figure that must agree, checked from independent sources. */
export function integrityReport(ctx: ServiceContext, asOf = todayIso()): IntegrityReport {
  const db = ctx.db
  const c = ctx.companyId
  const checks: IntegrityCheck[] = []
  const add = (key: string, label: string, ok: boolean, detail: string, differencePaise?: number) => checks.push({ key, label, ok, detail, differencePaise })
  const fy = fyFor(ctx, asOf)

  const tb = trialBalanceReport(ctx, fy.from, asOf)
  add('trial_balance', 'Trial balance is balanced', tb.balanced, tb.balanced ? `Closing debits = credits = ${formatINR(tb.totals.closingDebitPaise)} (FY ${tb.financialYear})` : `Differences — opening ${formatINR(tb.differences.openingPaise)}, period ${formatINR(tb.differences.periodPaise)}, closing ${formatINR(tb.differences.closingPaise)}`, tb.differences.closingPaise)

  const bad = db
    .prepare(`SELECT COUNT(*) n FROM (SELECT je.id FROM journal_entries je LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id WHERE je.company_id = ?
              GROUP BY je.id HAVING COALESCE(SUM(l.debit_paise),0) <> je.total_debit_paise OR COALESCE(SUM(l.credit_paise),0) <> je.total_credit_paise OR COUNT(l.id) < 2)`)
    .get(c) as { n: number }
  const jt = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_debit_paise),0) t FROM journal_entries WHERE company_id = ?`).get(c) as { n: number; t: number }
  add('journals_balanced', 'Every journal entry balances and matches its lines', bad.n === 0, bad.n === 0 ? `${jt.n} journal entries checked (${formatINR(jt.t)})` : `${bad.n} journal entries do not match their lines`)

  // Ledger agrees with journal entries: per-account ledger closing (rebuilt line by line) = trial balance closing.
  let ledgerMismatch = 0
  let accountsChecked = 0
  for (const r of tb.rows) {
    if (!r.accountId) continue
    accountsChecked++
    const closing = ledgerClosingLineByLine(ctx, r.accountId, fy.from, asOf)
    const tbClosing = r.closingDebitPaise - r.closingCreditPaise
    const reAdj = r.reportGroup === 'RETAINED_EARNINGS' ? -tb.priorYearsProfitPaise : 0
    if (closing + reAdj !== tbClosing) ledgerMismatch++
  }
  const lineTotals = db.prepare(`SELECT COALESCE(SUM(l.debit_paise),0) d FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id WHERE je.company_id = ?`).get(c) as { d: number }
  add('ledger_journals', 'General ledger agrees with journal entries', ledgerMismatch === 0 && lineTotals.d === jt.t, ledgerMismatch === 0 && lineTotals.d === jt.t ? `${accountsChecked} account ledgers rebuilt line by line agree with the trial balance; ledger lines total ${formatINR(lineTotals.d)} = journal totals` : `${ledgerMismatch} account(s) disagree; ledger lines ${formatINR(lineTotals.d)} vs journals ${formatINR(jt.t)}`)

  const bs = balanceSheet(ctx, asOf)
  add('balance_sheet', 'Balance sheet: Assets = Liabilities + Equity', bs.balanced, `Assets ${formatINR(bs.totalAssetsPaise)}; Liabilities ${formatINR(bs.totalLiabilitiesPaise)} + Equity ${formatINR(bs.totalEquityPaise)}${bs.balanced ? '' : `; difference ${formatINR(bs.differencePaise)}`}`, bs.differencePaise)

  for (const side of ['CUSTOMER', 'SUPPLIER'] as const) {
    const a = ageing(ctx, side, asOf)
    const label = side === 'CUSTOMER' ? 'Receivables agree with outstanding invoices' : 'Payables agree with outstanding bills'
    add(side === 'CUSTOMER' ? 'receivables' : 'payables', label, a.agrees,
      `${side === 'CUSTOMER' ? 'Sundry Debtors' : 'Sundry Creditors'} ${formatINR(a.controlAccountPaise)}; open items ${formatINR(a.totals.grossPaise)} − on account ${formatINR(a.totals.onAccountPaise)} = ${formatINR(a.totals.netPaise)}${a.agrees ? '' : `; difference ${formatINR(a.differencePaise)}`}`, a.differencePaise)
  }

  const stockLedger = (db.prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.company_id = ? AND a.system_key = 'INVENTORY'`).get(c) as { b: number }).b
  const stockVal = (db.prepare('SELECT COALESCE(SUM(value_paise),0) v FROM stock_balances WHERE company_id = ?').get(c) as { v: number }).v
  const moveVal = (db.prepare('SELECT COALESCE(SUM(CASE WHEN qty_in_milli > 0 THEN value_paise ELSE -value_paise END),0) v FROM stock_movements WHERE company_id = ?').get(c) as { v: number }).v
  add('stock', 'Stock valuation agrees with the stock ledger', stockLedger === stockVal && moveVal === stockVal, `Stock in Hand ledger ${formatINR(stockLedger)}; stock valuation ${formatINR(stockVal)}; stock movements ${formatINR(moveVal)}`, stockLedger - stockVal)

  const draftEffects = LEDGER_KINDS.reduce((n, kind) => {
    const s = storeFor(kind)
    const t = s.typed ? ` AND h.doc_type = '${kind}'` : ''
    return n + (db.prepare(`SELECT COUNT(*) n FROM ${s.header} h WHERE h.company_id = ? AND h.status = 'DRAFT'${t} AND (h.journal_entry_id IS NOT NULL OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.reference_type = ? AND m.reference_id = h.id))`).get(c, kind) as { n: number }).n
  }, 0)
  add('drafts', 'Drafts have no stock or accounting effect', draftEffects === 0, draftEffects === 0 ? 'No draft has a journal entry or stock movement' : `${draftEffects} draft(s) have postings`)

  const fk = db.prepare('PRAGMA foreign_key_check').all().length
  const integ = (db.prepare('PRAGMA integrity_check').get() as Record<string, string>)
  const integOk = Object.values(integ)[0] === 'ok'
  add('database', 'Database integrity', fk === 0 && integOk, `integrity_check: ${Object.values(integ)[0]}; foreign key violations: ${fk}`)

  return { asOf, checks, allOk: checks.every((x) => x.ok) }
}
