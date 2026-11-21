/**
 * Bank reconciliation. A reconciliation session holds bank statement lines; a
 * match links a statement line to a posted book line (journal line on the bank
 * account). Posted transactions are never changed — clearing state lives only in
 * bank_statement_lines. Once completed, a reconciliation is locked by triggers.
 *
 *   adjusted book balance = book balance − deposits not yet credited by the bank
 *                                        + withdrawals not yet debited by the bank
 *   expected statement     = adjusted book + bank-only deposits − bank-only withdrawals
 *   difference             = statement balance − expected statement
 */
import type { BankRecDetail, BankRecRow, BookItem, StatementLineRow } from '@shared/finance'
import { formatINR, toPaise } from '@shared/money'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { businessRule, conflict, notFound, validation } from '../errors'
import { SourceResolver } from './sources'
import { addDays, todayIso } from './periods'
import { createVoucher } from './vouchers'

interface RecRow {
  id: number; company_id: number; account_id: number; statement_date: string; statement_balance_paise: number; status: 'IN_PROGRESS' | 'COMPLETED'
  book_balance_paise: number | null; difference_paise: number | null; notes: string | null; completed_at: string | null; created_at: string
}

function loadRec(ctx: ServiceContext, id: number): RecRow {
  const r = ctx.db.prepare('SELECT * FROM bank_reconciliations WHERE id = ? AND company_id = ?').get(id, ctx.companyId) as RecRow | undefined
  if (!r) throw notFound('Bank reconciliation')
  return r
}
function openRec(ctx: ServiceContext, id: number): RecRow {
  const r = loadRec(ctx, id)
  if (r.status !== 'IN_PROGRESS') throw businessRule('This reconciliation is completed and locked')
  return r
}

function bankAccount(ctx: ServiceContext, accountId: number): { id: number; code: string; name: string } {
  const a = ctx.db.prepare(`SELECT id, code, name, is_bank, system_key, is_group FROM chart_of_accounts WHERE id = ? AND company_id = ?`).get(accountId, ctx.companyId) as
    | { id: number; code: string; name: string; is_bank: number; system_key: string | null; is_group: number }
    | undefined
  if (!a || !a.is_bank || a.is_group) throw validation('Please correct the highlighted fields', { accountId: 'Select a bank account' })
  if (a.system_key === 'CASH') throw validation('Please correct the highlighted fields', { accountId: 'Cash in hand has no bank statement to reconcile' })
  return a
}

/** Book lines on the bank account up to the statement date, with their clearing state as of this reconciliation. */
function bookItems(ctx: ServiceContext, rec: RecRow): Array<BookItem & { clearedBy: number | null }> {
  const rows = ctx.db
    .prepare(
      `SELECT l.id AS lineId, je.id AS journalId, je.entry_date AS date, je.entry_no, je.source_type, je.source_kind, je.source_id, je.narration,
         l.debit_paise, l.credit_paise,
         (SELECT s.id FROM bank_statement_lines s JOIN bank_reconciliations r ON r.id = s.reconciliation_id
           WHERE s.journal_line_id = l.id AND (r.id = @rec OR (r.status = 'COMPLETED' AND r.statement_date <= @sd))) AS clearedBy
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = @acc AND je.company_id = @c AND je.entry_date <= @sd
       ORDER BY je.entry_date, je.id`
    )
    .all({ rec: rec.id, sd: rec.statement_date, acc: rec.account_id, c: ctx.companyId }) as Array<{
    lineId: number; journalId: number; date: string; entry_no: string; source_type: string; source_kind: string | null; source_id: number | null; narration: string | null
    debit_paise: number; credit_paise: number; clearedBy: number | null
  }>
  const resolver = new SourceResolver(ctx.db)
  const other = ctx.db.prepare(
    `SELECT GROUP_CONCAT(DISTINCT COALESCE(CASE l.party_type WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = l.party_id) WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = l.party_id) END, a.name)) AS p
     FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND l.id <> ?`
  )
  return rows.map((r) => {
    const src = resolver.resolve({ id: r.journalId, source_type: r.source_type, source_kind: r.source_kind, source_id: r.source_id })
    return {
      journalLineId: r.lineId, journalId: r.journalId, date: r.date, entryNo: r.entry_no, voucherType: src.voucherType, voucherNo: src.voucherNo ?? r.entry_no, route: src.route,
      particulars: ((other.get(r.journalId, r.lineId) as { p: string | null }).p ?? r.narration ?? '').replace(/,/g, ', '),
      amountPaise: r.debit_paise || r.credit_paise, direction: r.debit_paise > 0 ? 'DEPOSIT' : 'WITHDRAWAL', clearedBy: r.clearedBy
    }
  })
}

export function listReconciliations(ctx: ServiceContext, q: { accountId?: number } = {}): BankRecRow[] {
  return ctx.db
    .prepare(
      `SELECT r.id, r.account_id AS accountId, a.name AS accountName, r.statement_date AS statementDate, r.statement_balance_paise AS statementBalancePaise, r.status,
         r.book_balance_paise AS bookBalancePaise, r.difference_paise AS differencePaise, r.completed_at AS completedAt, r.created_at AS createdAt
       FROM bank_reconciliations r JOIN chart_of_accounts a ON a.id = r.account_id
       WHERE r.company_id = @c ${q.accountId ? 'AND r.account_id = @a' : ''} ORDER BY r.statement_date DESC, r.id DESC`
    )
    .all({ c: ctx.companyId, a: q.accountId ?? null }) as BankRecRow[]
}

export function getReconciliation(ctx: ServiceContext, id: number): BankRecDetail {
  const rec = loadRec(ctx, id)
  const account = ctx.db.prepare('SELECT id, code, name FROM chart_of_accounts WHERE id = ?').get(rec.account_id) as { id: number; code: string; name: string }
  const items = bookItems(ctx, rec)
  const byLine = new Map(items.map((i) => [i.journalLineId, i]))
  const statementLines = (
    ctx.db
      .prepare(`SELECT id, line_date AS date, description, reference, deposit_paise AS depositPaise, withdrawal_paise AS withdrawalPaise, source, journal_line_id FROM bank_statement_lines WHERE reconciliation_id = ? ORDER BY line_date, id`)
      .all(id) as Array<Omit<StatementLineRow, 'matched'> & { journal_line_id: number | null }>
  ).map(({ journal_line_id, ...l }) => {
    const m = journal_line_id ? byLine.get(journal_line_id) : undefined
    return { ...l, matched: m ? (({ clearedBy: _c, ...b }) => b)(m) : null }
  })
  const book = items.reduce((s, i) => s + (i.direction === 'DEPOSIT' ? i.amountPaise : -i.amountPaise), 0)
  const uncleared = items.filter((i) => i.clearedBy === null).map(({ clearedBy: _c, ...b }) => b)
  const unclearedDeposits = uncleared.filter((i) => i.direction === 'DEPOSIT')
  const unclearedWithdrawals = uncleared.filter((i) => i.direction === 'WITHDRAWAL')
  const ud = unclearedDeposits.reduce((s, i) => s + i.amountPaise, 0)
  const uw = unclearedWithdrawals.reduce((s, i) => s + i.amountPaise, 0)
  const unmatched = statementLines.filter((l) => !l.matched)
  const sd = unmatched.reduce((s, l) => s + l.depositPaise, 0)
  const sw = unmatched.reduce((s, l) => s + l.withdrawalPaise, 0)
  const adjusted = book - ud + uw
  const difference = rec.statement_balance_paise - (adjusted + sd - sw)
  return {
    id: rec.id, accountId: rec.account_id, accountName: account.name, statementDate: rec.statement_date, statementBalancePaise: rec.statement_balance_paise,
    status: rec.status, bookBalancePaise: rec.status === 'COMPLETED' ? rec.book_balance_paise : book, differencePaise: rec.status === 'COMPLETED' ? rec.difference_paise : difference,
    completedAt: rec.completed_at, createdAt: rec.created_at, notes: rec.notes, account, statementLines, unclearedDeposits, unclearedWithdrawals,
    summary: {
      bookBalancePaise: book, unclearedDepositsPaise: ud, unclearedWithdrawalsPaise: uw, adjustedBookBalancePaise: adjusted, statementBalancePaise: rec.statement_balance_paise,
      unmatchedStatementDepositsPaise: sd, unmatchedStatementWithdrawalsPaise: sw, unmatchedStatementLines: unmatched.length, differencePaise: difference,
      status: difference === 0 && unmatched.length === 0 ? 'RECONCILED' : 'UNRECONCILED'
    }
  }
}

export function createReconciliation(ctx: ServiceContext, input: { accountId: number; statementDate: string; statementBalancePaise: number; notes?: string | null }): BankRecDetail {
  const acc = bankAccount(ctx, input.accountId)
  if (input.statementDate > todayIso()) throw validation('Please correct the highlighted fields', { statementDate: 'Statement date cannot be in the future' })
  const last = ctx.db.prepare(`SELECT MAX(statement_date) AS d FROM bank_reconciliations WHERE account_id = ? AND status = 'COMPLETED'`).get(acc.id) as { d: string | null }
  if (last.d && input.statementDate < last.d) throw validation('Please correct the highlighted fields', { statementDate: `Must be on or after the last completed reconciliation (${last.d})` })
  if (ctx.db.prepare(`SELECT 1 FROM bank_reconciliations WHERE account_id = ? AND status = 'IN_PROGRESS'`).get(acc.id)) throw conflict(`A reconciliation for ${acc.name} is already in progress. Complete it first.`)
  return inTransaction(ctx.db, () => {
    const id = Number(
      ctx.db
        .prepare('INSERT INTO bank_reconciliations (company_id, account_id, statement_date, statement_balance_paise, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.companyId, acc.id, input.statementDate, input.statementBalancePaise, input.notes ?? null, ctx.userId).lastInsertRowid
    )
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'CREATE', entityType: 'bank_reconciliation', entityId: id, summary: `Bank reconciliation started for ${acc.name} as of ${input.statementDate} (statement ${formatINR(input.statementBalancePaise)})` })
    return getReconciliation(ctx, id)
  })
}

export function updateReconciliation(ctx: ServiceContext, input: { id: number; statementDate: string; statementBalancePaise: number; notes?: string | null }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  if (input.statementDate > todayIso()) throw validation('Please correct the highlighted fields', { statementDate: 'Statement date cannot be in the future' })
  const late = ctx.db
    .prepare(`SELECT COUNT(*) n FROM bank_statement_lines s LEFT JOIN journal_entry_lines l ON l.id = s.journal_line_id LEFT JOIN journal_entries je ON je.id = l.journal_entry_id
              WHERE s.reconciliation_id = ? AND (s.line_date > ? OR je.entry_date > ?)`)
    .get(rec.id, input.statementDate, input.statementDate) as { n: number }
  if (late.n > 0) throw validation('Please correct the highlighted fields', { statementDate: 'Some statement lines or matches are dated after this date' })
  ctx.db.prepare('UPDATE bank_reconciliations SET statement_date = ?, statement_balance_paise = ?, notes = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?')
    .run(input.statementDate, input.statementBalancePaise, input.notes ?? null, rec.id)
  return getReconciliation(ctx, rec.id)
}

/** Parses pasted CSV: date, description, reference, deposit, withdrawal (header row optional). */
export function parseStatementCsv(csv: string): Array<{ date: string; description: string; reference: string | null; depositPaise: number; withdrawalPaise: number }> {
  const out: Array<{ date: string; description: string; reference: string | null; depositPaise: number; withdrawalPaise: number }> = []
  const errors: string[] = []
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  lines.forEach((line, i) => {
    const cells: string[] = []
    let cur = ''
    let quoted = false
    for (const ch of line) {
      if (ch === '"') quoted = !quoted
      else if (ch === ',' && !quoted) {
        cells.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    cells.push(cur.trim())
    if (i === 0 && /date/i.test(cells[0] ?? '')) return
    const [d, description, reference, dep, wd] = cells
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '') ?? (() => {
      const x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(d ?? '')
      return x ? [x[0], x[3], x[2].padStart(2, '0'), x[1].padStart(2, '0')] : null
    })()
    const date = m ? `${m[1]}-${m[2]}-${m[3]}` : ''
    const t = date ? Date.parse(`${date}T00:00:00Z`) : NaN
    const valid = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date
    const amount = (v: string | undefined) => {
      const s = (v ?? '').replace(/[,₹\s]/g, '')
      if (!s) return 0
      if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('amount')
      return toPaise(s)
    }
    try {
      if (!valid) throw new Error('date')
      const deposit = amount(dep)
      const withdrawal = amount(wd)
      if ((deposit > 0) === (withdrawal > 0)) throw new Error('one amount')
      if (!description) throw new Error('description')
      out.push({ date, description: description.slice(0, 200), reference: reference ? reference.slice(0, 60) : null, depositPaise: deposit, withdrawalPaise: withdrawal })
    } catch (e) {
      const why = (e as Error).message
      errors.push(`Row ${i + 1}: ${why === 'date' ? 'invalid date (use YYYY-MM-DD or DD/MM/YYYY)' : why === 'amount' ? 'invalid amount' : why === 'one amount' ? 'enter either a deposit or a withdrawal' : 'description is required'}`)
    }
  })
  if (errors.length) throw validation(errors.slice(0, 5).join('; '), { csv: errors[0] })
  return out
}

export function addStatementLines(
  ctx: ServiceContext,
  input: { id: number; lines?: Array<{ date: string; description: string; reference?: string | null; depositPaise: number; withdrawalPaise: number }>; csv?: string }
): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const lines = [...(input.lines ?? []), ...(input.csv?.trim() ? parseStatementCsv(input.csv) : [])]
  const late = lines.find((l) => l.date > rec.statement_date)
  if (late) throw validation(`Statement line dated ${late.date} is after the statement date ${rec.statement_date}`, { csv: 'Line dated after the statement date' })
  inTransaction(ctx.db, () => {
    const ins = ctx.db.prepare('INSERT INTO bank_statement_lines (reconciliation_id, line_date, description, reference, deposit_paise, withdrawal_paise, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const l of lines) ins.run(rec.id, l.date, l.description, l.reference ?? null, l.depositPaise, l.withdrawalPaise, ctx.userId)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'UPDATE', entityType: 'bank_reconciliation', entityId: rec.id, summary: `${lines.length} bank statement line(s) added` })
  })
  return getReconciliation(ctx, rec.id)
}

function checkBookLine(ctx: ServiceContext, rec: RecRow, journalLineId: number) {
  const l = ctx.db
    .prepare(`SELECT l.id, l.account_id, l.debit_paise, l.credit_paise, je.entry_date FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id WHERE l.id = ? AND je.company_id = ?`)
    .get(journalLineId, ctx.companyId) as { id: number; account_id: number; debit_paise: number; credit_paise: number; entry_date: string } | undefined
  if (!l || l.account_id !== rec.account_id) throw businessRule('That book entry is not on this bank account')
  if (l.entry_date > rec.statement_date) throw businessRule('That book entry is dated after the statement date')
  if (ctx.db.prepare('SELECT 1 FROM bank_statement_lines WHERE journal_line_id = ?').get(l.id)) throw conflict('That book entry is already cleared')
  return l
}

export function matchLine(ctx: ServiceContext, input: { id: number; statementLineId: number; journalLineId: number }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const s = ctx.db.prepare('SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?').get(input.statementLineId, rec.id) as
    | { id: number; deposit_paise: number; withdrawal_paise: number; journal_line_id: number | null }
    | undefined
  if (!s) throw notFound('Statement line')
  if (s.journal_line_id) throw conflict('That statement line is already matched')
  const l = checkBookLine(ctx, rec, input.journalLineId)
  if ((s.deposit_paise > 0) !== (l.debit_paise > 0)) throw businessRule('A deposit must be matched with a receipt into the bank, and a withdrawal with a payment from it')
  if ((s.deposit_paise || s.withdrawal_paise) !== (l.debit_paise || l.credit_paise))
    throw businessRule(`Amounts differ: statement ${formatINR(s.deposit_paise || s.withdrawal_paise)} vs book ${formatINR(l.debit_paise || l.credit_paise)}`)
  ctx.db.prepare('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ?').run(l.id, s.id)
  return getReconciliation(ctx, rec.id)
}

export function unmatchLine(ctx: ServiceContext, input: { id: number; statementLineId: number }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const s = ctx.db.prepare('SELECT id, source FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?').get(input.statementLineId, rec.id) as { id: number; source: string } | undefined
  if (!s) throw notFound('Statement line')
  if (s.source === 'BOOK_TICK') ctx.db.prepare('DELETE FROM bank_statement_lines WHERE id = ?').run(s.id)
  else ctx.db.prepare('UPDATE bank_statement_lines SET journal_line_id = NULL WHERE id = ?').run(s.id)
  return getReconciliation(ctx, rec.id)
}

export function deleteStatementLine(ctx: ServiceContext, input: { id: number; statementLineId: number }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const res = ctx.db.prepare('DELETE FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?').run(input.statementLineId, rec.id)
  if (res.changes === 0) throw notFound('Statement line')
  return getReconciliation(ctx, rec.id)
}

/** Marks a book entry as cleared on a date without a typed statement line (e.g. ticking off a passbook). */
export function tickBookLine(ctx: ServiceContext, input: { id: number; journalLineId: number; clearedDate: string }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const l = checkBookLine(ctx, rec, input.journalLineId)
  if (input.clearedDate < l.entry_date || input.clearedDate > rec.statement_date)
    throw validation('Please correct the highlighted fields', { clearedDate: `Must be between ${l.entry_date} and ${rec.statement_date}` })
  const item = bookItems(ctx, rec).find((b) => b.journalLineId === l.id)!
  ctx.db
    .prepare(`INSERT INTO bank_statement_lines (reconciliation_id, line_date, description, reference, deposit_paise, withdrawal_paise, journal_line_id, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'BOOK_TICK', ?)`)
    .run(rec.id, input.clearedDate, `${item.voucherType} ${item.voucherNo ?? ''} — ${item.particulars}`.slice(0, 200), item.voucherNo, l.debit_paise, l.credit_paise, l.id, ctx.userId)
  return getReconciliation(ctx, rec.id)
}

/** Matches unmatched statement lines to uncleared book entries of the same amount and direction (reference first, then nearest date). */
export function autoMatch(ctx: ServiceContext, id: number): { matched: number; detail: BankRecDetail } {
  const rec = openRec(ctx, id)
  const detail = getReconciliation(ctx, id)
  const pool = [...detail.unclearedDeposits, ...detail.unclearedWithdrawals]
  const used = new Set<number>()
  let matched = 0
  const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const refs = ctx.db.prepare(
    `SELECT COALESCE((SELECT reference_no FROM payment_receipts WHERE id = je.source_id AND je.source_type = 'RECEIPT'),
                     (SELECT reference_no FROM payment_vouchers WHERE id = je.source_id AND je.source_type = 'PAYMENT'),
                     (SELECT reference_no FROM vouchers WHERE id = je.source_id AND je.source_type = 'MANUAL'), '') AS r
     FROM journal_entries je WHERE je.id = ?`
  )
  inTransaction(ctx.db, () => {
    for (const s of detail.statementLines.filter((l) => !l.matched)) {
      const dir = s.depositPaise > 0 ? 'DEPOSIT' : 'WITHDRAWAL'
      const amount = s.depositPaise || s.withdrawalPaise
      const lo = addDays(s.date, -30)
      const hi = addDays(s.date, 5)
      const candidates = pool.filter((b) => !used.has(b.journalLineId) && b.direction === dir && b.amountPaise === amount && b.date >= lo && b.date <= hi)
      if (!candidates.length) continue
      const ref = norm(s.reference)
      const byRef = ref ? candidates.find((b) => norm((refs.get(b.journalId) as { r: string }).r) === ref || norm(b.voucherNo) === ref) : undefined
      const best = byRef ?? candidates.sort((a, b) => Math.abs(new Date(a.date).getTime() - new Date(s.date).getTime()) - Math.abs(new Date(b.date).getTime() - new Date(s.date).getTime()))[0]
      // Without a reference, only auto-match when the amount is unambiguous.
      if (!byRef && candidates.length > 1) continue
      ctx.db.prepare('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ? AND reconciliation_id = ?').run(best.journalLineId, s.id, rec.id)
      used.add(best.journalLineId)
      matched++
    }
  })
  return { matched, detail: getReconciliation(ctx, id) }
}

/** Books a bank-only item (charges, interest) as a journal voucher and matches it. Never alters existing entries. */
export function recordInBooks(ctx: ServiceContext, input: { id: number; statementLineId: number; contraAccountId: number; narration: string; requestKey?: string }): BankRecDetail {
  const rec = openRec(ctx, input.id)
  const s = ctx.db.prepare('SELECT * FROM bank_statement_lines WHERE id = ? AND reconciliation_id = ?').get(input.statementLineId, rec.id) as
    | { id: number; line_date: string; reference: string | null; deposit_paise: number; withdrawal_paise: number; journal_line_id: number | null }
    | undefined
  if (!s) throw notFound('Statement line')
  if (s.journal_line_id) throw conflict('That statement line is already matched')
  const contra = ctx.db.prepare('SELECT id, is_bank, system_key, is_group FROM chart_of_accounts WHERE id = ? AND company_id = ?').get(input.contraAccountId, ctx.companyId) as
    | { id: number; is_bank: number; system_key: string | null; is_group: number }
    | undefined
  if (!contra || contra.is_group || contra.id === rec.account_id || ['AR', 'AP', 'INVENTORY'].includes(contra.system_key ?? ''))
    throw validation('Please correct the highlighted fields', { contraAccountId: 'Select an income, expense or other non-party account' })
  return inTransaction(ctx.db, () => {
    const deposit = s.deposit_paise > 0
    const amount = s.deposit_paise || s.withdrawal_paise
    const v = createVoucher(ctx, {
      type: contra.is_bank ? 'CONTRA' : 'JOURNAL', date: s.line_date, referenceNo: s.reference, narration: input.narration, requestKey: input.requestKey,
      lines: [
        { accountId: rec.account_id, debitPaise: deposit ? amount : 0, creditPaise: deposit ? 0 : amount },
        { accountId: contra.id, debitPaise: deposit ? 0 : amount, creditPaise: deposit ? amount : 0 }
      ]
    })
    const line = ctx.db.prepare('SELECT id FROM journal_entry_lines WHERE journal_entry_id = ? AND account_id = ?').get(v.journalId, rec.account_id) as { id: number }
    ctx.db.prepare('UPDATE bank_statement_lines SET journal_line_id = ? WHERE id = ?').run(line.id, s.id)
    return getReconciliation(ctx, rec.id)
  })
}

export function completeReconciliation(ctx: ServiceContext, id: number): BankRecDetail {
  openRec(ctx, id)
  const d = getReconciliation(ctx, id)
  if (d.summary.status !== 'RECONCILED')
    throw businessRule(
      d.summary.unmatchedStatementLines
        ? `${d.summary.unmatchedStatementLines} statement line(s) are not matched to the books. Match them or record them in the books first.`
        : `The statement does not agree with the books (difference ${formatINR(d.summary.differencePaise)})`
    )
  inTransaction(ctx.db, () => {
    ctx.db
      .prepare(`UPDATE bank_reconciliations SET status = 'COMPLETED', book_balance_paise = ?, difference_paise = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(d.summary.bookBalancePaise, d.summary.differencePaise, ctx.userId, id)
    writeAudit(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'COMPLETE', entityType: 'bank_reconciliation', entityId: id,
      summary: `Bank reconciliation of ${d.accountName} as of ${d.statementDate} completed: book ${formatINR(d.summary.bookBalancePaise)}, statement ${formatINR(d.statementBalancePaise)}`,
      details: { unclearedDeposits: d.summary.unclearedDepositsPaise, unclearedWithdrawals: d.summary.unclearedWithdrawalsPaise, matchedLines: d.statementLines.length }
    })
  })
  return getReconciliation(ctx, id)
}
