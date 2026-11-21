/**
 * Manual journal vouchers and contra vouchers (cash ↔ bank transfers).
 *
 * Both post through the same balanced-journal engine as every document. A voucher
 * is never edited: it is cancelled by a reversing journal. Rejected unbalanced
 * attempts are written to the audit log (outside the rolled-back transaction) so
 * they appear in the auditor's exception report.
 */
import { VoucherCreateInput, type VoucherCreateInputT, type VoucherDetail, type VoucherRow, type VoucherType } from '@shared/finance'
import { financialYearOf } from '@shared/india'
import { formatINR } from '@shared/money'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { businessRule, conflict, notFound, validation } from '../errors'
import { postJournal } from '../ledger'
import { nextDocumentNumber } from '../sequences'
import { todayIso } from './periods'

interface AccountInfo { id: number; code: string; name: string; is_group: number; is_active: number; is_bank: number; system_key: string | null }

const SEQ: Record<VoucherType, 'CONTRA_VOUCHER' | 'JOURNAL_VOUCHER'> = { CONTRA: 'CONTRA_VOUCHER', JOURNAL: 'JOURNAL_VOUCHER' }

/** Returns the entity a request key already produced, if any (idempotent resubmission). */
export function priorRequest(ctx: ServiceContext, key: string | undefined, entityType: string): number | null {
  if (!key) return null
  const r = ctx.db.prepare('SELECT entity_type, entity_id FROM posting_requests WHERE company_id = ? AND request_key = ?').get(ctx.companyId, key) as
    | { entity_type: string; entity_id: number }
    | undefined
  if (!r) return null
  if (r.entity_type !== entityType) throw conflict('This request was already used for a different transaction')
  return r.entity_id
}

export function recordRequest(ctx: ServiceContext, key: string | undefined, entityType: string, entityId: number): void {
  if (!key) return
  ctx.db.prepare('INSERT INTO posting_requests (company_id, request_key, entity_type, entity_id, created_by) VALUES (?, ?, ?, ?, ?)').run(ctx.companyId, key, entityType, entityId, ctx.userId)
}

export function createVoucher(ctx: ServiceContext, raw: VoucherCreateInputT): VoucherDetail {
  const input = VoucherCreateInput.parse(raw)
  const prior = priorRequest(ctx, input.requestKey, 'voucher')
  if (prior) return getVoucher(ctx, prior)
  const db = ctx.db
  const fieldErrors: Record<string, string> = {}
  if (input.date > todayIso()) fieldErrors.date = 'Voucher date cannot be in the future'

  const accStmt = db.prepare('SELECT id, code, name, is_group, is_active, is_bank, system_key FROM chart_of_accounts WHERE id = ? AND company_id = ?')
  const accounts = new Map<number, AccountInfo>()
  input.lines.forEach((l, i) => {
    const f = (k: string, m: string) => (fieldErrors[`lines.${i}.${k}`] ??= m)
    if ((l.debitPaise > 0) === (l.creditPaise > 0)) f('debitPaise', 'Enter either a debit or a credit amount')
    const a = accStmt.get(l.accountId, ctx.companyId) as AccountInfo | undefined
    if (!a) return void f('accountId', 'Select a valid account')
    accounts.set(a.id, a)
    if (a.is_group) f('accountId', `${a.code} is a group account`)
    if (!a.is_active) f('accountId', `${a.code} is inactive`)
    if (input.type === 'CONTRA' && !a.is_bank) f('accountId', 'Contra vouchers move money between cash and bank accounts only')
    if (a.system_key === 'INVENTORY') f('accountId', 'Stock in Hand changes only through stock documents, so stock and the ledger stay equal')
    const needs = a.system_key === 'AR' ? 'CUSTOMER' : a.system_key === 'AP' ? 'SUPPLIER' : null
    if (needs) {
      if (l.partyType !== needs || !l.partyId) f('partyId', `Select the ${needs === 'CUSTOMER' ? 'customer' : 'supplier'} for ${a.name}`)
      else if (!db.prepare(`SELECT 1 FROM ${needs === 'CUSTOMER' ? 'customers' : 'suppliers'} WHERE id = ? AND company_id = ?`).get(l.partyId, ctx.companyId)) f('partyId', 'Select a valid party')
    } else if (l.partyType || l.partyId) f('partyId', `${a.name} is not a party account`)
  })
  const accountIds = input.lines.map((l) => l.accountId)
  if (input.type === 'CONTRA') {
    const dr = new Set(input.lines.filter((l) => l.debitPaise > 0).map((l) => l.accountId))
    if (input.lines.some((l) => l.creditPaise > 0 && dr.has(l.accountId))) fieldErrors.lines = 'The same account cannot be debited and credited in a contra'
  }
  if (Object.keys(fieldErrors).length) throw validation('Please correct the highlighted fields', fieldErrors)

  const debit = input.lines.reduce((s, l) => s + l.debitPaise, 0)
  const credit = input.lines.reduce((s, l) => s + l.creditPaise, 0)
  if (debit !== credit) {
    writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'JOURNAL_REJECTED', entityType: 'voucher',
      summary: `Unbalanced ${input.type === 'CONTRA' ? 'contra' : 'journal'} voucher rejected: debit ${formatINR(debit)} vs credit ${formatINR(credit)}`,
      details: { type: input.type, date: input.date, narration: input.narration, debitPaise: debit, creditPaise: credit, differencePaise: debit - credit, accounts: accountIds }
    })
    throw validation(`Debits (${formatINR(debit)}) must equal credits (${formatINR(credit)}). Difference ${formatINR(Math.abs(debit - credit))}.`, { lines: 'Debits and credits are not equal' })
  }

  // Cash cannot go below zero.
  for (const a of accounts.values()) {
    if (a.system_key !== 'CASH') continue
    const net = input.lines.filter((l) => l.accountId === a.id).reduce((s, l) => s + l.debitPaise - l.creditPaise, 0)
    if (net >= 0) continue
    const available = (db.prepare('SELECT COALESCE(SUM(debit_paise - credit_paise), 0) AS b FROM journal_entry_lines WHERE account_id = ?').get(a.id) as { b: number }).b
    if (available + net < 0) throw businessRule(`Insufficient cash: available ${formatINR(available)}`)
  }

  return inTransaction(db, () => {
    const { fy_start_month } = db.prepare('SELECT fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { fy_start_month: number }
    const fy = financialYearOf(input.date, fy_start_month)
    const number = nextDocumentNumber(db, ctx.companyId, SEQ[input.type], fy)
    const id = Number(
      db
        .prepare(`INSERT INTO vouchers (company_id, voucher_type, financial_year, voucher_no, voucher_date, reference_no, narration, amount_paise, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ctx.companyId, input.type, fy, number, input.date, input.referenceNo ?? null, input.narration, debit, ctx.userId).lastInsertRowid
    )
    const journal = postJournal(db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: input.date, sourceType: 'MANUAL', sourceKind: SEQ[input.type], sourceId: id,
      narration: `${input.type === 'CONTRA' ? 'Contra' : 'Journal'} ${number}: ${input.narration}`,
      lines: input.lines.map((l) => ({ accountId: l.accountId, debitPaise: l.debitPaise, creditPaise: l.creditPaise, partyType: l.partyType ?? undefined, partyId: l.partyId ?? undefined, narration: l.narration ?? undefined }))
    })
    db.prepare('UPDATE vouchers SET journal_entry_id = ? WHERE id = ?').run(journal.id, id)
    recordRequest(ctx, input.requestKey, 'voucher', id)
    writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: 'voucher', entityId: id,
      summary: `${input.type === 'CONTRA' ? 'Contra' : 'Journal'} voucher ${number} posted: ${formatINR(debit)} — ${input.narration}`,
      details: { journal: journal.entryNo, lines: input.lines.length, date: input.date }
    })
    return getVoucher(ctx, id)
  })
}

export function cancelVoucher(ctx: ServiceContext, id: number, reason: string): VoucherDetail {
  const db = ctx.db
  return inTransaction(db, () => {
    const v = db.prepare('SELECT * FROM vouchers WHERE id = ? AND company_id = ?').get(id, ctx.companyId) as Record<string, unknown> | undefined
    if (!v) throw notFound('Voucher')
    if (v.status !== 'POSTED') throw businessRule('This voucher is already cancelled')
    const lines = db.prepare('SELECT account_id, debit_paise, credit_paise, party_type, party_id FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_no').all(v.journal_entry_id) as Array<{
      account_id: number; debit_paise: number; credit_paise: number; party_type: 'CUSTOMER' | 'SUPPLIER' | null; party_id: number | null
    }>
    const today = todayIso()
    const kind = v.voucher_type === 'CONTRA' ? 'CONTRA_VOUCHER' : 'JOURNAL_VOUCHER'
    const rev = postJournal(db, {
      companyId: ctx.companyId, userId: ctx.userId, entryDate: today, sourceType: 'REVERSAL', sourceKind: `CANCEL:${kind}`, sourceId: id,
      narration: `Cancellation of ${v.voucher_no}: ${reason}`,
      lines: lines.map((l) => ({ accountId: l.account_id, debitPaise: l.credit_paise, creditPaise: l.debit_paise, partyType: l.party_type ?? undefined, partyId: l.party_id ?? undefined }))
    })
    db.prepare(`UPDATE journal_entries SET status = 'REVERSED' WHERE id = ?`).run(v.journal_entry_id)
    db.prepare(`UPDATE vouchers SET status = 'CANCELLED', reversal_journal_entry_id = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?`).run(rev.id, ctx.userId, reason, id)
    writeAudit(db, { companyId: ctx.companyId, userId: ctx.userId, action: 'CANCEL', entityType: 'voucher', entityId: id, summary: `Voucher ${v.voucher_no} cancelled by reversal ${rev.entryNo}: ${reason}` })
    return getVoucher(ctx, id)
  })
}

const ROW_SQL = `SELECT v.id, v.voucher_type AS type, v.voucher_no AS number, v.voucher_date AS date, v.narration, v.reference_no AS referenceNo, v.amount_paise AS amountPaise,
  v.status, je.entry_no AS entryNo, u.username AS createdBy
  FROM vouchers v LEFT JOIN journal_entries je ON je.id = v.journal_entry_id LEFT JOIN users u ON u.id = v.created_by`

export function listVouchers(ctx: ServiceContext, q: { type?: VoucherType; from?: string; to?: string; search?: string } = {}): VoucherRow[] {
  const where = ['v.company_id = @c']
  if (q.type) where.push('v.voucher_type = @type')
  if (q.from) where.push('v.voucher_date >= @from')
  if (q.to) where.push('v.voucher_date <= @to')
  if (q.search) where.push(`(v.voucher_no LIKE @like OR v.narration LIKE @like OR IFNULL(v.reference_no, '') LIKE @like)`)
  return ctx.db
    .prepare(`${ROW_SQL} WHERE ${where.join(' AND ')} ORDER BY v.voucher_date DESC, v.id DESC LIMIT 1000`)
    .all({ c: ctx.companyId, type: q.type ?? null, from: q.from ?? null, to: q.to ?? null, like: `%${q.search ?? ''}%` }) as VoucherRow[]
}

export function getVoucher(ctx: ServiceContext, id: number): VoucherDetail {
  const r = ctx.db
    .prepare(`${ROW_SQL.replace('v.status,', 'v.status, v.journal_entry_id, v.cancel_reason, v.cancelled_at, v.created_at, (SELECT entry_no FROM journal_entries WHERE id = v.reversal_journal_entry_id) AS reversalEntryNo,')} WHERE v.id = ? AND v.company_id = ?`)
    .get(id, ctx.companyId) as (VoucherRow & { journal_entry_id: number | null; cancel_reason: string | null; cancelled_at: string | null; created_at: string; reversalEntryNo: string | null }) | undefined
  if (!r) throw notFound('Voucher')
  const lines = ctx.db
    .prepare(
      `SELECT a.id AS accountId, a.code AS accountCode, a.name AS accountName,
         CASE l.party_type WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = l.party_id) WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = l.party_id) END AS party,
         l.debit_paise AS debitPaise, l.credit_paise AS creditPaise, l.narration
       FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.line_no`
    )
    .all(r.journal_entry_id ?? -1) as VoucherDetail['lines']
  const { journal_entry_id, cancel_reason, cancelled_at, created_at, ...row } = r
  return { ...row, journalId: journal_entry_id, cancelReason: cancel_reason, cancelledAt: cancelled_at, createdAt: created_at, lines }
}
