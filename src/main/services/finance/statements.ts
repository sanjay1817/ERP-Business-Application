/**
 * Financial statements derived ONLY from posted journal lines (drafts never post
 * journals). Reversed entries stay in the books together with their reversal, so
 * every figure reconciles to the journal. Nothing here writes to the database.
 *
 * Conventions: amounts are INTEGER paise; "balance" is debit-positive unless a
 * function says "natural". Income and expense accounts open at zero at the start
 * of each financial year; earlier years' profit appears in retained earnings.
 */
import type {
  AccountRow, BalanceSheetReport, CashBookReport, CashBookRow, DayBookEntry, FinanceDashboard, JournalDetail, LedgerLine, LedgerReport,
  ProfitLossReport, ReportGroup, StatementItem, StatementSection, TrialBalanceLine, TrialBalanceReport
} from '@shared/finance'
import { REPORT_GROUP_LABELS } from '@shared/finance'
import type { ServiceContext } from '../context'
import { bool } from '../context'
import { businessRule, notFound } from '../errors'
import { assertPeriod, fyFor } from './periods'
import { SourceResolver, type JournalSourceRow } from './sources'
import { ageing } from './ageing'

type AccountType = AccountRow['accountType']
const isPL = (t: string) => t === 'INCOME' || t === 'EXPENSE'
const split = (net: number) => ({ dr: net > 0 ? net : 0, cr: net < 0 ? -net : 0 })
/** Negation without producing -0. */
const neg = (x: number) => (x === 0 ? 0 : -x)

interface Movement {
  id: number
  code: string
  name: string
  account_type: AccountType
  report_group: ReportGroup | null
  system_key: string | null
  is_bank: number
  /** Net debit before `from` (all history). */
  before: number
  /** Net debit before `from` but within the financial year of `from`. */
  before_fy: number
  pd: number
  pc: number
  n: number
}

/** Per-account movements for a period, from posted journal lines. */
function movements(ctx: ServiceContext, from: string, to: string): Movement[] {
  const { from: fyStart } = fyFor(ctx, from)
  return ctx.db
    .prepare(
      `SELECT a.id, a.code, a.name, a.account_type, a.report_group, a.system_key, a.is_bank,
         COALESCE(m.before, 0) AS before, COALESCE(m.before_fy, 0) AS before_fy, COALESCE(m.pd, 0) AS pd, COALESCE(m.pc, 0) AS pc, COALESCE(m.n, 0) AS n
       FROM chart_of_accounts a LEFT JOIN (
         SELECT l.account_id,
           SUM(CASE WHEN je.entry_date < @from THEN l.debit_paise - l.credit_paise ELSE 0 END) AS before,
           SUM(CASE WHEN je.entry_date < @from AND je.entry_date >= @fyStart THEN l.debit_paise - l.credit_paise ELSE 0 END) AS before_fy,
           SUM(CASE WHEN je.entry_date >= @from THEN l.debit_paise ELSE 0 END) AS pd,
           SUM(CASE WHEN je.entry_date >= @from THEN l.credit_paise ELSE 0 END) AS pc,
           COUNT(*) AS n
         FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
         WHERE je.company_id = @c AND je.entry_date <= @to
         GROUP BY l.account_id
       ) m ON m.account_id = a.id
       WHERE a.company_id = @c AND a.is_group = 0
       ORDER BY a.code`
    )
    .all({ c: ctx.companyId, from, to, fyStart }) as Movement[]
}

function retainedEarningsAccount(ctx: ServiceContext): { id: number; code: string; name: string } | undefined {
  return ctx.db
    .prepare(`SELECT id, code, name FROM chart_of_accounts WHERE company_id = ? AND is_group = 0 AND (system_key = 'RETAINED_EARNINGS' OR report_group = 'RETAINED_EARNINGS') ORDER BY system_key IS NULL, code LIMIT 1`)
    .get(ctx.companyId) as { id: number; code: string; name: string } | undefined
}

// ───────────────────────── Chart of accounts ─────────────────────────

export function chartOfAccounts(ctx: ServiceContext): AccountRow[] {
  const rows = ctx.db
    .prepare(
      `SELECT a.id, a.code, a.name, a.account_type AS accountType, a.report_group AS reportGroup, p.code AS parentCode, a.is_group AS isGroup, a.is_bank AS isBank,
         a.system_key AS systemKey, a.is_active AS isActive,
         COALESCE((SELECT SUM(l.debit_paise - l.credit_paise) FROM journal_entry_lines l WHERE l.account_id = a.id), 0) AS balancePaise,
         (SELECT COUNT(*) FROM journal_entry_lines l WHERE l.account_id = a.id) AS lineCount
       FROM chart_of_accounts a LEFT JOIN chart_of_accounts p ON p.id = a.parent_id
       WHERE a.company_id = ? ORDER BY a.code`
    )
    .all(ctx.companyId) as Array<Omit<AccountRow, 'isGroup' | 'isBank' | 'isActive' | 'isCash'> & { isGroup: number; isBank: number; isActive: number }>
  return rows.map((r) => ({ ...r, isGroup: bool(r.isGroup), isBank: bool(r.isBank), isActive: bool(r.isActive), isCash: r.systemKey === 'CASH' }))
}

function loadAccount(ctx: ServiceContext, accountId: number) {
  const a = ctx.db
    .prepare('SELECT id, code, name, account_type AS accountType, report_group AS reportGroup, is_group, is_bank, system_key FROM chart_of_accounts WHERE id = ? AND company_id = ?')
    .get(accountId, ctx.companyId) as
    | { id: number; code: string; name: string; accountType: AccountType; reportGroup: ReportGroup | null; is_group: number; is_bank: number; system_key: string | null }
    | undefined
  if (!a) throw notFound('Account')
  if (a.is_group) throw businessRule(`${a.code} ${a.name} is a group account and has no ledger of its own`)
  return a
}

// ───────────────────────── Journal detail & particulars ─────────────────────────

const partyNameSql = `CASE l.party_type WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = l.party_id) WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = l.party_id) END`

interface JLine { id: number; account_id: number; code: string; name: string; is_bank: number; debit_paise: number; credit_paise: number; party: string | null }

class JournalLines {
  private cache = new Map<number, JLine[]>()
  private stmt
  constructor(ctx: ServiceContext) {
    this.stmt = ctx.db.prepare(
      `SELECT l.id, l.account_id, a.code, a.name, a.is_bank, l.debit_paise, l.credit_paise, ${partyNameSql} AS party
       FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.line_no`
    )
  }
  get(journalId: number): JLine[] {
    let v = this.cache.get(journalId)
    if (!v) {
      v = this.stmt.all(journalId) as JLine[]
      this.cache.set(journalId, v)
    }
    return v
  }
  /** "Party · opposite accounts" for one line, the way a ledger shows "To/By". */
  particulars(journalId: number, lineId: number): string {
    const lines = this.get(journalId)
    const me = lines.find((l) => l.id === lineId)
    if (!me) return ''
    const debitSide = me.debit_paise > 0
    const opposite = [...new Set(lines.filter((l) => l.id !== lineId && (debitSide ? l.credit_paise > 0 : l.debit_paise > 0)).map((l) => l.name))]
    const party = me.party ?? lines.find((l) => l.party)?.party ?? null
    const accounts = opposite.length > 3 ? `${opposite.slice(0, 3).join(', ')} +${opposite.length - 3}` : opposite.join(', ')
    return [party, accounts].filter(Boolean).join(' · ')
  }
}

export function journalDetail(ctx: ServiceContext, id: number): JournalDetail {
  const j = ctx.db
    .prepare(
      `SELECT je.*, u.username FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by WHERE je.id = ? AND je.company_id = ?`
    )
    .get(id, ctx.companyId) as (JournalSourceRow & Record<string, unknown>) | undefined
  if (!j) throw notFound('Journal entry')
  const resolver = new SourceResolver(ctx.db)
  const lines = ctx.db
    .prepare(
      `SELECT l.id AS lineId, l.line_no AS lineNo, a.id AS accountId, a.code AS accountCode, a.name AS accountName, ${partyNameSql} AS party,
         l.debit_paise AS debitPaise, l.credit_paise AS creditPaise, l.narration
       FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.line_no`
    )
    .all(id) as JournalDetail['lines']
  const reversalOf = j.reversal_of_id ? (ctx.db.prepare('SELECT id, entry_no AS entryNo FROM journal_entries WHERE id = ?').get(j.reversal_of_id) as { id: number; entryNo: string }) : null
  // Reversals are linked through the originating document (cancellation) or reversal_of_id.
  const kind = (j.source_kind as string | null) ?? j.source_type
  const reversedBy = ctx.db
    .prepare(
      `SELECT id, entry_no AS entryNo, entry_date AS entryDate FROM journal_entries
       WHERE company_id = ? AND id <> ? AND (reversal_of_id = ? OR (source_kind = ? AND source_id = ?)) ORDER BY id`
    )
    .all(ctx.companyId, id, id, `CANCEL:${kind}`, j.source_id ?? -1) as JournalDetail['reversedBy']
  return {
    id,
    entryNo: j.entry_no as string,
    entryDate: j.entry_date as string,
    financialYear: j.financial_year as string,
    narration: (j.narration as string | null) ?? null,
    status: j.status as 'POSTED' | 'REVERSED',
    totalPaise: j.total_debit_paise as number,
    source: resolver.resolve(j),
    reversalOf,
    reversedBy: (j.status as string) === 'REVERSED' || reversedBy.length ? reversedBy : [],
    createdAt: j.created_at as string,
    createdBy: (j.username as string | null) ?? null,
    lines
  }
}

// ───────────────────────── General ledger ─────────────────────────

export function generalLedger(ctx: ServiceContext, q: { accountId: number; from: string; to: string; partyType?: 'CUSTOMER' | 'SUPPLIER'; partyId?: number }): LedgerReport {
  assertPeriod(q.from, q.to)
  const acc = loadAccount(ctx, q.accountId)
  const fyStart = fyFor(ctx, q.from).from
  const partyFilter = q.partyType && q.partyId ? 'AND l.party_type = @pt AND l.party_id = @pid' : ''
  const params = { a: acc.id, c: ctx.companyId, from: q.from, to: q.to, fyStart, pt: q.partyType ?? null, pid: q.partyId ?? null }
  const opening = (
    ctx.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
         WHERE l.account_id = @a AND je.company_id = @c AND je.entry_date < @from ${isPL(acc.accountType) ? 'AND je.entry_date >= @fyStart' : ''} ${partyFilter}`
      )
      .get(params) as { b: number }
  ).b
  const rows = ctx.db
    .prepare(
      `SELECT l.id AS lineId, je.id AS journalId, je.entry_date AS date, je.entry_no AS entryNo, je.status, je.source_type, je.source_kind, je.source_id,
         COALESCE(l.narration, je.narration) AS narration, l.debit_paise AS debitPaise, l.credit_paise AS creditPaise
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = @a AND je.company_id = @c AND je.entry_date BETWEEN @from AND @to ${partyFilter}
       ORDER BY je.entry_date, je.id, l.line_no`
    )
    .all(params) as Array<{ lineId: number; journalId: number; date: string; entryNo: string; status: 'POSTED' | 'REVERSED'; source_type: string; source_kind: string | null; source_id: number | null; narration: string | null; debitPaise: number; creditPaise: number }>
  const resolver = new SourceResolver(ctx.db)
  const jl = new JournalLines(ctx)
  let running = opening
  let dr = 0
  let cr = 0
  const lines: LedgerLine[] = rows.map((r) => {
    running += r.debitPaise - r.creditPaise
    dr += r.debitPaise
    cr += r.creditPaise
    const src = resolver.resolve({ id: r.journalId, source_type: r.source_type, source_kind: r.source_kind, source_id: r.source_id })
    return {
      journalId: r.journalId, lineId: r.lineId, date: r.date, entryNo: r.entryNo, voucherType: src.voucherType, voucherNo: src.voucherNo ?? r.entryNo, route: src.route,
      particulars: jl.particulars(r.journalId, r.lineId), narration: r.narration, debitPaise: r.debitPaise, creditPaise: r.creditPaise, balancePaise: running,
      journalStatus: r.status, isCancellation: src.isCancellation
    }
  })
  let party: LedgerReport['party'] = null
  if (q.partyType && q.partyId) {
    const p = ctx.db.prepare(`SELECT name FROM ${q.partyType === 'CUSTOMER' ? 'customers' : 'suppliers'} WHERE id = ? AND company_id = ?`).get(q.partyId, ctx.companyId) as { name: string } | undefined
    if (!p) throw notFound(q.partyType === 'CUSTOMER' ? 'Customer' : 'Supplier')
    party = { type: q.partyType, id: q.partyId, name: p.name }
  }
  return {
    account: { id: acc.id, code: acc.code, name: acc.name, accountType: acc.accountType, reportGroup: acc.reportGroup },
    party, from: q.from, to: q.to, openingPaise: opening, debitPaise: dr, creditPaise: cr, closingPaise: opening + dr - cr, lines
  }
}

/**
 * Closing balance of an account rebuilt line by line from its journal lines, using exactly the
 * opening rule and line selection of generalLedger() but none of its display work. Used by the
 * integrity check on every account, where resolving each line's document would dominate.
 */
export function ledgerClosingLineByLine(ctx: ServiceContext, accountId: number, from: string, to: string): number {
  assertPeriod(from, to)
  const acc = loadAccount(ctx, accountId)
  const fyStart = fyFor(ctx, from).from
  const params = { a: acc.id, c: ctx.companyId, from, to, fyStart }
  let running = (
    ctx.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
         WHERE l.account_id = @a AND je.company_id = @c AND je.entry_date < @from ${isPL(acc.accountType) ? 'AND je.entry_date >= @fyStart' : ''}`
      )
      .get(params) as { b: number }
  ).b
  for (const r of ctx.db
    .prepare(
      `SELECT l.debit_paise AS d, l.credit_paise AS c FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = @a AND je.company_id = @c AND je.entry_date BETWEEN @from AND @to`
    )
    .iterate(params) as Iterable<{ d: number; c: number }>)
    running += r.d - r.c
  return running
}

// ───────────────────────── Trial balance ─────────────────────────

export function trialBalanceReport(ctx: ServiceContext, from: string, to: string): TrialBalanceReport {
  assertPeriod(from, to)
  const ms = movements(ctx, from, to)
  const re = retainedEarningsAccount(ctx)
  const priorYears = ms.filter((m) => isPL(m.account_type)).reduce((s, m) => s + (m.before - m.before_fy), 0)
  const rows: TrialBalanceLine[] = []
  for (const m of ms) {
    let opening = isPL(m.account_type) ? m.before_fy : m.before
    if (re && m.id === re.id) opening += priorYears
    if (opening === 0 && m.pd === 0 && m.pc === 0) continue
    const o = split(opening)
    const c = split(opening + m.pd - m.pc)
    rows.push({
      accountId: m.id, code: m.code, name: m.name, accountType: m.account_type, reportGroup: m.report_group,
      openingDebitPaise: o.dr, openingCreditPaise: o.cr, periodDebitPaise: m.pd, periodCreditPaise: m.pc, closingDebitPaise: c.dr, closingCreditPaise: c.cr
    })
  }
  if (!re && priorYears !== 0) {
    const o = split(priorYears)
    rows.push({ accountId: null, code: '—', name: 'Profit & loss of earlier years', accountType: 'EQUITY', reportGroup: 'RETAINED_EARNINGS', openingDebitPaise: o.dr, openingCreditPaise: o.cr, periodDebitPaise: 0, periodCreditPaise: 0, closingDebitPaise: o.dr, closingCreditPaise: o.cr, synthetic: true })
  }
  const sum = (k: keyof TrialBalanceReport['totals']) => rows.reduce((s, r) => s + r[k], 0)
  const totals = {
    openingDebitPaise: sum('openingDebitPaise'), openingCreditPaise: sum('openingCreditPaise'), periodDebitPaise: sum('periodDebitPaise'),
    periodCreditPaise: sum('periodCreditPaise'), closingDebitPaise: sum('closingDebitPaise'), closingCreditPaise: sum('closingCreditPaise')
  }
  const differences = {
    openingPaise: totals.openingDebitPaise - totals.openingCreditPaise,
    periodPaise: totals.periodDebitPaise - totals.periodCreditPaise,
    closingPaise: totals.closingDebitPaise - totals.closingCreditPaise
  }
  return {
    from, to, financialYear: fyFor(ctx, from).fy, rows, totals, differences,
    balanced: differences.openingPaise === 0 && differences.periodPaise === 0 && differences.closingPaise === 0,
    priorYearsProfitPaise: neg(priorYears)
  }
}

// ───────────────────────── Profit & loss ─────────────────────────

const INCOME_GROUPS: ReportGroup[] = ['SALES', 'OTHER_INCOME']
const EXPENSE_GROUPS: ReportGroup[] = ['COGS', 'DIRECT_EXPENSE', 'INDIRECT_EXPENSE', 'ADMIN_EXPENSE', 'FINANCE_EXPENSE']

function plGroup(m: Movement): ReportGroup {
  if (m.report_group && (INCOME_GROUPS.includes(m.report_group) || EXPENSE_GROUPS.includes(m.report_group))) return m.report_group
  return m.account_type === 'INCOME' ? 'OTHER_INCOME' : 'INDIRECT_EXPENSE'
}

export function profitAndLoss(ctx: ServiceContext, from: string, to: string): ProfitLossReport {
  assertPeriod(from, to)
  const ms = movements(ctx, from, to).filter((m) => isPL(m.account_type))
  const section = (g: ReportGroup, incomeSide: boolean): StatementSection => {
    const items: StatementItem[] = ms
      .filter((m) => plGroup(m) === g && (m.pd !== 0 || m.pc !== 0))
      .map((m) => ({ label: m.name, accountId: m.id, code: m.code, amountPaise: incomeSide ? m.pc - m.pd : m.pd - m.pc }))
    return { key: g, label: REPORT_GROUP_LABELS[g], items, totalPaise: items.reduce((s, i) => s + i.amountPaise, 0) }
  }
  const income = INCOME_GROUPS.map((g) => section(g, true))
  const expenses = EXPENSE_GROUPS.map((g) => section(g, false))
  const t = (g: ReportGroup) => [...income, ...expenses].find((s) => s.key === g)!.totalPaise
  const salesRevenue = t('SALES')
  const gross = salesRevenue - t('COGS') - t('DIRECT_EXPENSE')
  const operating = gross - t('INDIRECT_EXPENSE') - t('ADMIN_EXPENSE')
  const net = operating + t('OTHER_INCOME') - t('FINANCE_EXPENSE')
  return {
    from, to, income, expenses,
    salesRevenuePaise: salesRevenue, otherIncomePaise: t('OTHER_INCOME'), cogsPaise: t('COGS'), directExpensesPaise: t('DIRECT_EXPENSE'),
    grossProfitPaise: gross, indirectExpensesPaise: t('INDIRECT_EXPENSE'), adminExpensesPaise: t('ADMIN_EXPENSE'), operatingProfitPaise: operating,
    financeExpensesPaise: t('FINANCE_EXPENSE'), netProfitPaise: net,
    totalIncomePaise: income.reduce((s, x) => s + x.totalPaise, 0), totalExpensesPaise: expenses.reduce((s, x) => s + x.totalPaise, 0)
  }
}

// ───────────────────────── Balance sheet ─────────────────────────

const ASSET_GROUPS: ReportGroup[] = ['CASH', 'BANK', 'RECEIVABLES', 'INVENTORY', 'FIXED_ASSET', 'OTHER_ASSET']
const LIABILITY_GROUPS: ReportGroup[] = ['PAYABLES', 'LOANS', 'TAX_LIABILITY', 'OTHER_LIABILITY']

export function balanceSheet(ctx: ServiceContext, asOf: string): BalanceSheetReport {
  const fy = fyFor(ctx, asOf)
  const ms = movements(ctx, fy.from, asOf)
  const bal = (m: Movement) => m.before + m.pd - m.pc
  const sections = (groups: ReportGroup[]) => new Map(groups.map((g) => [g, { key: g, label: REPORT_GROUP_LABELS[g], items: [] as StatementItem[], totalPaise: 0 }]))
  const assets = sections(ASSET_GROUPS)
  const liabilities = sections(LIABILITY_GROUPS)
  const equity = new Map<string, StatementSection>([
    ['CAPITAL', { key: 'CAPITAL', label: REPORT_GROUP_LABELS.CAPITAL, items: [], totalPaise: 0 }],
    ['RETAINED_EARNINGS', { key: 'RETAINED_EARNINGS', label: REPORT_GROUP_LABELS.RETAINED_EARNINGS, items: [], totalPaise: 0 }],
    ['CURRENT_PROFIT', { key: 'CURRENT_PROFIT', label: 'Profit for the current year', items: [], totalPaise: 0 }]
  ])
  const add = (s: StatementSection, item: StatementItem) => {
    if (item.amountPaise === 0) return
    s.items.push(item)
    s.totalPaise += item.amountPaise
  }

  // Party-wise split of the control accounts: credit balances on debtors are customer advances
  // (a liability); debit balances on creditors are supplier advances (an asset).
  const partySplit = ctx.db.prepare(
    `SELECT l.party_type, l.party_id, SUM(l.debit_paise - l.credit_paise) AS b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
     WHERE je.company_id = ? AND l.account_id = ? AND je.entry_date <= ? GROUP BY l.party_type, l.party_id`
  )

  for (const m of ms) {
    if (isPL(m.account_type)) continue
    const debitBalance = bal(m)
    if (m.account_type === 'ASSET') {
      const g = m.report_group && ASSET_GROUPS.includes(m.report_group) ? m.report_group : 'OTHER_ASSET'
      if (g === 'RECEIVABLES') {
        const parts = partySplit.all(ctx.companyId, m.id, asOf) as Array<{ b: number }>
        add(assets.get(g)!, { label: m.name, accountId: m.id, code: m.code, amountPaise: parts.filter((p) => p.b > 0).reduce((s, p) => s + p.b, 0) })
        add(liabilities.get('OTHER_LIABILITY')!, { label: 'Advances from customers', accountId: m.id, code: m.code, amountPaise: -parts.filter((p) => p.b < 0).reduce((s, p) => s + p.b, 0), note: `Credit balances in ${m.name}` })
      } else add(assets.get(g)!, { label: m.name, accountId: m.id, code: m.code, amountPaise: debitBalance })
    } else if (m.account_type === 'LIABILITY') {
      const g = m.report_group && LIABILITY_GROUPS.includes(m.report_group) ? m.report_group : 'OTHER_LIABILITY'
      if (g === 'PAYABLES') {
        const parts = partySplit.all(ctx.companyId, m.id, asOf) as Array<{ b: number }>
        add(liabilities.get(g)!, { label: m.name, accountId: m.id, code: m.code, amountPaise: -parts.filter((p) => p.b < 0).reduce((s, p) => s + p.b, 0) })
        add(assets.get('OTHER_ASSET')!, { label: 'Advances to suppliers', accountId: m.id, code: m.code, amountPaise: parts.filter((p) => p.b > 0).reduce((s, p) => s + p.b, 0), note: `Debit balances in ${m.name}` })
      } else add(liabilities.get(g)!, { label: m.name, accountId: m.id, code: m.code, amountPaise: -debitBalance })
    } else {
      const g = m.report_group === 'RETAINED_EARNINGS' ? 'RETAINED_EARNINGS' : 'CAPITAL'
      add(equity.get(g)!, { label: m.name, accountId: m.id, code: m.code, amountPaise: -debitBalance })
    }
  }

  const pl = ms.filter((m) => isPL(m.account_type))
  const priorYears = neg(pl.reduce((s, m) => s + m.before, 0))
  const currentYear = neg(pl.reduce((s, m) => s + m.pd - m.pc, 0))
  add(equity.get('RETAINED_EARNINGS')!, { label: 'Profit & loss of earlier years', accountId: null, code: null, amountPaise: priorYears })
  const dmy = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  add(equity.get('CURRENT_PROFIT')!, { label: `Net profit, ${dmy(fy.from)} – ${dmy(asOf)}`, accountId: null, code: null, amountPaise: currentYear })

  const list = (m: Map<string, StatementSection>) => [...m.values()]
  const total = (m: Map<string, StatementSection>) => list(m).reduce((s, x) => s + x.totalPaise, 0)
  const totalAssets = total(assets)
  const totalLiabilities = total(liabilities)
  const totalEquity = total(equity)
  const difference = totalAssets - totalLiabilities - totalEquity
  return {
    asOf, financialYear: fy.fy, fyFrom: fy.from,
    assets: list(assets), liabilities: list(liabilities), equity: list(equity),
    totalAssetsPaise: totalAssets, totalLiabilitiesPaise: totalLiabilities, totalEquityPaise: totalEquity,
    currentYearProfitPaise: currentYear, retainedEarningsPaise: equity.get('RETAINED_EARNINGS')!.totalPaise,
    differencePaise: difference, balanced: difference === 0
  }
}

// ───────────────────────── Day book ─────────────────────────

export function dayBook(ctx: ServiceContext, from: string, to: string, opts: { limit?: number; desc?: boolean } = {}): DayBookEntry[] {
  assertPeriod(from, to)
  const headers = ctx.db
    .prepare(
      `SELECT id, entry_no, entry_date, narration, status, total_debit_paise, source_type, source_kind, source_id FROM journal_entries
       WHERE company_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date ${opts.desc ? 'DESC' : ''}, id ${opts.desc ? 'DESC' : ''} LIMIT ?`
    )
    .all(ctx.companyId, from, to, opts.limit ?? 5000) as Array<JournalSourceRow & { entry_no: string; entry_date: string; narration: string | null; status: 'POSTED' | 'REVERSED'; total_debit_paise: number }>
  const resolver = new SourceResolver(ctx.db)
  const jl = new JournalLines(ctx)
  return headers.map((h) => {
    const src = resolver.resolve(h)
    return {
      journalId: h.id, entryNo: h.entry_no, date: h.entry_date, voucherType: src.voucherType, voucherNo: src.voucherNo, route: src.route, narration: h.narration,
      status: h.status, isCancellation: src.isCancellation, amountPaise: h.total_debit_paise,
      lines: jl.get(h.id).map((l) => ({ accountCode: l.code, accountName: l.name, party: l.party, debitPaise: l.debit_paise, creditPaise: l.credit_paise }))
    }
  })
}

// ───────────────────────── Cash book / bank book ─────────────────────────

export function cashBook(ctx: ServiceContext, accountId: number, from: string, to: string): CashBookReport {
  assertPeriod(from, to)
  const acc = loadAccount(ctx, accountId)
  if (!acc.is_bank) throw businessRule(`${acc.code} ${acc.name} is not a cash or bank account`)
  const opening = (
    ctx.db
      .prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id WHERE l.account_id = ? AND je.company_id = ? AND je.entry_date < ?`)
      .get(acc.id, ctx.companyId, from) as { b: number }
  ).b
  const rows = ctx.db
    .prepare(
      `SELECT l.id AS lineId, je.id AS journalId, je.entry_date AS date, je.entry_no, je.source_type, je.source_kind, je.source_id, je.narration,
         l.debit_paise, l.credit_paise, EXISTS (SELECT 1 FROM bank_statement_lines s WHERE s.journal_line_id = l.id) AS cleared
       FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE l.account_id = ? AND je.company_id = ? AND je.entry_date BETWEEN ? AND ? ORDER BY je.entry_date, je.id, l.line_no`
    )
    .all(acc.id, ctx.companyId, from, to) as Array<{ lineId: number; journalId: number; date: string; entry_no: string; source_type: string; source_kind: string | null; source_id: number | null; narration: string | null; debit_paise: number; credit_paise: number; cleared: number }>
  const resolver = new SourceResolver(ctx.db)
  const jl = new JournalLines(ctx)
  let running = opening
  let receipts = 0
  let payments = 0
  let contraIn = 0
  let contraOut = 0
  const out: CashBookRow[] = rows.map((r) => {
    running += r.debit_paise - r.credit_paise
    receipts += r.debit_paise
    payments += r.credit_paise
    const others = jl.get(r.journalId).filter((l) => l.id !== r.lineId)
    const isContra = others.length > 0 && others.every((l) => l.is_bank === 1)
    if (isContra) {
      contraIn += r.debit_paise
      contraOut += r.credit_paise
    }
    const src = resolver.resolve({ id: r.journalId, source_type: r.source_type, source_kind: r.source_kind, source_id: r.source_id })
    return {
      journalId: r.journalId, lineId: r.lineId, date: r.date, voucherType: isContra && !src.voucherType.startsWith('Contra') ? `${src.voucherType} (contra)` : src.voucherType,
      voucherNo: src.voucherNo ?? r.entry_no, route: src.route, particulars: jl.particulars(r.journalId, r.lineId), narration: r.narration,
      receiptPaise: r.debit_paise, paymentPaise: r.credit_paise, balancePaise: running, isContra, cleared: r.cleared === 1
    }
  })
  return {
    account: { id: acc.id, code: acc.code, name: acc.name, isCash: acc.system_key === 'CASH' },
    from, to, openingPaise: opening, receiptsPaise: receipts, paymentsPaise: payments, contraInPaise: contraIn, contraOutPaise: contraOut, closingPaise: running, rows: out
  }
}

// ───────────────────────── Finance dashboard ─────────────────────────

function monthsBetween(from: string, to: string): Array<{ month: string; label: string; from: string; to: string }> {
  const out: Array<{ month: string; label: string; from: string; to: string }> = []
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  while (`${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7)) {
    const month = `${y}-${String(m).padStart(2, '0')}`
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    out.push({
      month, label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      from: `${month}-01` < from ? from : `${month}-01`, to: last > to ? to : last
    })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out.slice(-12)
}

export function financeDashboard(ctx: ServiceContext, from: string, to: string): FinanceDashboard {
  assertPeriod(from, to)
  const db = ctx.db
  const c = ctx.companyId
  const pl = profitAndLoss(ctx, from, to)
  const bs = balanceSheet(ctx, to)
  const tb = trialBalanceReport(ctx, from, to)
  const sum = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { t: number; n: number })
  const sales = sum(`SELECT COUNT(*) n, COALESCE(SUM(taxable_paise),0) t FROM sales_invoices WHERE company_id=? AND status='POSTED' AND invoice_date BETWEEN ? AND ?`, c, from, to)
  const purchases = sum(`SELECT COUNT(*) n, COALESCE(SUM(taxable_paise),0) t FROM purchase_invoices WHERE company_id=? AND status='POSTED' AND invoice_date BETWEEN ? AND ?`, c, from, to)
  const purchaseCredits = sum(`SELECT COUNT(*) n, COALESCE(SUM(taxable_paise),0) t FROM trade_documents WHERE company_id=? AND status='POSTED' AND doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') AND doc_date BETWEEN ? AND ?`, c, from, to)
  const groupBalance = (g: ReportGroup) =>
    (db
      .prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
                WHERE je.company_id = ? AND a.report_group = ? AND je.entry_date <= ?`)
      .get(c, g, to) as { b: number }).b
  const ar = ageing(ctx, 'CUSTOMER', to)
  const ap = ageing(ctx, 'SUPPLIER', to)
  const overdue = (r: ReturnType<typeof ageing>) => r.rows.reduce((s, x) => s + x.overduePaise, 0)
  const overdueCount = (r: ReturnType<typeof ageing>) => r.rows.reduce((s, x) => s + x.overdueItems, 0)
  const months = monthsBetween(from, to).map((m) => {
    const p = profitAndLoss(ctx, m.from, m.to)
    return { month: m.month, label: m.label, incomePaise: p.totalIncomePaise, expensesPaise: p.totalExpensesPaise, netPaise: p.netProfitPaise }
  })
  return {
    from, to, financialYear: fyFor(ctx, to).fy,
    kpis: {
      salesPaise: pl.salesRevenuePaise, salesCount: sales.n, purchasesPaise: purchases.t - purchaseCredits.t, purchasesCount: purchases.n,
      receivablesPaise: ar.controlAccountPaise, payablesPaise: ap.controlAccountPaise,
      cashPaise: groupBalance('CASH'), bankPaise: groupBalance('BANK'),
      incomePaise: pl.totalIncomePaise, expensesPaise: pl.totalExpensesPaise, netProfitPaise: pl.netProfitPaise,
      overdueReceivablesCount: overdueCount(ar), overdueReceivablesPaise: overdue(ar),
      overduePayablesCount: overdueCount(ap), overduePayablesPaise: overdue(ap)
    },
    monthly: months,
    recent: dayBook(ctx, from, to, { limit: 8, desc: true }),
    checks: { trialBalanceBalanced: tb.balanced, balanceSheetBalanced: bs.balanced }
  }
}
