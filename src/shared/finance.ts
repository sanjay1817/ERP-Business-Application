/**
 * Phase 3 — finance, accounting, banking, receivables/payables, auditor and
 * report contracts shared by the main process and the renderer.
 */
import { z } from 'zod'

// ───────── Common ─────────
const id = z.number().int().positive()
const isoDate = z
  .string({ error: 'Date is required' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'Use a valid date')
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null)), z.string().max(max, `Must be at most ${max} characters`).nullable())
const paise = (label: string) => z.number({ error: `${label} is required` }).int(`${label} must be whole paise`).min(0, `${label} cannot be negative`).max(1e13, `${label} is too large`)
const signedPaise = (label: string) => z.number({ error: `${label} is required` }).int(`${label} must be whole paise`).min(-1e13).max(1e13)
/** Client-generated key that makes a posting request idempotent (double-click / resubmit safe). */
const requestKey = z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'Invalid request key').optional()

export const REPORT_GROUP_LABELS = {
  CASH: 'Cash',
  BANK: 'Bank',
  RECEIVABLES: 'Trade receivables',
  INVENTORY: 'Inventory',
  FIXED_ASSET: 'Fixed assets',
  OTHER_ASSET: 'Other assets',
  PAYABLES: 'Trade payables',
  LOANS: 'Loans',
  TAX_LIABILITY: 'Tax liabilities',
  OTHER_LIABILITY: 'Other liabilities',
  CAPITAL: 'Capital',
  RETAINED_EARNINGS: 'Retained earnings',
  SALES: 'Sales revenue',
  OTHER_INCOME: 'Other income',
  COGS: 'Purchases & cost of goods sold',
  DIRECT_EXPENSE: 'Direct expenses',
  INDIRECT_EXPENSE: 'Indirect (selling & distribution) expenses',
  ADMIN_EXPENSE: 'Administrative expenses',
  FINANCE_EXPENSE: 'Finance expenses'
} as const
export type ReportGroup = keyof typeof REPORT_GROUP_LABELS

export const PeriodInput = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'End date must be on or after the start date' })
export const AsOfInput = z.object({ asOf: isoDate }).strict()
export const LedgerInput = z
  .object({ accountId: id, from: isoDate, to: isoDate, partyType: z.enum(['CUSTOMER', 'SUPPLIER']).optional(), partyId: id.optional() })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'End date must be on or after the start date' })
export const CashBookInput = z
  .object({ accountId: id, from: isoDate, to: isoDate })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'End date must be on or after the start date' })
export const PartySide = z.enum(['CUSTOMER', 'SUPPLIER'])
export const AgeingInput = z.object({ side: PartySide, asOf: isoDate }).strict()
export const PartyStatementInput = z.object({ side: PartySide, partyId: id, asOf: isoDate }).strict()
export const JournalGetInput = z.object({ id }).strict()

// ───────── Periods ─────────
export interface FinancialYearInfo {
  fy: string
  from: string
  to: string
  hasData: boolean
}
export interface PeriodsInfo {
  fyStartMonth: number
  today: string
  currentFy: string
  years: FinancialYearInfo[]
}

// ───────── Accounts & ledgers ─────────
export interface AccountRow {
  id: number
  code: string
  name: string
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'
  reportGroup: ReportGroup | null
  parentCode: string | null
  isGroup: boolean
  isBank: boolean
  isCash: boolean
  systemKey: string | null
  isActive: boolean
  /** Debit-positive balance (all posted journals). */
  balancePaise: number
  lineCount: number
}

/** Where a journal came from: voucher type and number, with a route to the source document. */
export interface SourceRef {
  kind: string
  voucherType: string
  voucherNo: string | null
  route: string | null
  documentStatus: string | null
  isCancellation: boolean
}

export interface JournalDetail {
  id: number
  entryNo: string
  entryDate: string
  financialYear: string
  narration: string | null
  status: 'POSTED' | 'REVERSED'
  totalPaise: number
  source: SourceRef
  reversalOf: { id: number; entryNo: string } | null
  reversedBy: Array<{ id: number; entryNo: string; entryDate: string }>
  createdAt: string
  createdBy: string | null
  lines: Array<{ lineId: number; lineNo: number; accountId: number; accountCode: string; accountName: string; party: string | null; debitPaise: number; creditPaise: number; narration: string | null }>
}

export interface LedgerLine {
  journalId: number
  lineId: number
  date: string
  entryNo: string
  voucherType: string
  voucherNo: string | null
  route: string | null
  /** Contra accounts / party for the line. */
  particulars: string
  narration: string | null
  debitPaise: number
  creditPaise: number
  balancePaise: number
  journalStatus: 'POSTED' | 'REVERSED'
  isCancellation: boolean
}

export interface LedgerReport {
  account: { id: number; code: string; name: string; accountType: AccountRow['accountType']; reportGroup: ReportGroup | null }
  party: { type: 'CUSTOMER' | 'SUPPLIER'; id: number; name: string } | null
  from: string
  to: string
  /** Debit-positive. Income/expense accounts open at zero at each financial-year start. */
  openingPaise: number
  debitPaise: number
  creditPaise: number
  closingPaise: number
  lines: LedgerLine[]
}

export interface TrialBalanceLine {
  accountId: number | null
  code: string
  name: string
  accountType: AccountRow['accountType']
  reportGroup: ReportGroup | null
  openingDebitPaise: number
  openingCreditPaise: number
  periodDebitPaise: number
  periodCreditPaise: number
  closingDebitPaise: number
  closingCreditPaise: number
  /** Prior-year profit carried into retained earnings (no account of its own). */
  synthetic?: boolean
}
export interface TrialBalanceReport {
  from: string
  to: string
  financialYear: string
  rows: TrialBalanceLine[]
  totals: Omit<TrialBalanceLine, 'accountId' | 'code' | 'name' | 'accountType' | 'reportGroup' | 'synthetic'>
  /** Each column pair balances. Differences are reported, never hidden. */
  balanced: boolean
  differences: { openingPaise: number; periodPaise: number; closingPaise: number }
  priorYearsProfitPaise: number
}

export interface StatementItem {
  label: string
  accountId: number | null
  code: string | null
  amountPaise: number
  note?: string
}
export interface StatementSection {
  key: string
  label: string
  items: StatementItem[]
  totalPaise: number
}
export interface ProfitLossReport {
  from: string
  to: string
  income: StatementSection[]
  expenses: StatementSection[]
  salesRevenuePaise: number
  otherIncomePaise: number
  cogsPaise: number
  directExpensesPaise: number
  grossProfitPaise: number
  indirectExpensesPaise: number
  adminExpensesPaise: number
  operatingProfitPaise: number
  financeExpensesPaise: number
  netProfitPaise: number
  totalIncomePaise: number
  totalExpensesPaise: number
}
export interface BalanceSheetReport {
  asOf: string
  financialYear: string
  fyFrom: string
  assets: StatementSection[]
  liabilities: StatementSection[]
  equity: StatementSection[]
  totalAssetsPaise: number
  totalLiabilitiesPaise: number
  totalEquityPaise: number
  currentYearProfitPaise: number
  retainedEarningsPaise: number
  /** Assets − (Liabilities + Equity). Must be zero; shown if not. */
  differencePaise: number
  balanced: boolean
}

export interface DayBookEntry {
  journalId: number
  entryNo: string
  date: string
  voucherType: string
  voucherNo: string | null
  route: string | null
  narration: string | null
  status: 'POSTED' | 'REVERSED'
  isCancellation: boolean
  amountPaise: number
  lines: Array<{ accountCode: string; accountName: string; party: string | null; debitPaise: number; creditPaise: number }>
}

export interface CashBookRow {
  journalId: number
  lineId: number
  date: string
  voucherType: string
  voucherNo: string | null
  route: string | null
  particulars: string
  narration: string | null
  receiptPaise: number
  paymentPaise: number
  balancePaise: number
  isContra: boolean
  cleared: boolean
}
export interface CashBookReport {
  account: { id: number; code: string; name: string; isCash: boolean }
  from: string
  to: string
  openingPaise: number
  receiptsPaise: number
  paymentsPaise: number
  contraInPaise: number
  contraOutPaise: number
  closingPaise: number
  rows: CashBookRow[]
}

export interface FinanceDashboard {
  from: string
  to: string
  financialYear: string
  kpis: {
    salesPaise: number
    salesCount: number
    purchasesPaise: number
    purchasesCount: number
    receivablesPaise: number
    payablesPaise: number
    cashPaise: number
    bankPaise: number
    incomePaise: number
    expensesPaise: number
    netProfitPaise: number
    overdueReceivablesCount: number
    overdueReceivablesPaise: number
    overduePayablesCount: number
    overduePayablesPaise: number
  }
  monthly: Array<{ month: string; label: string; incomePaise: number; expensesPaise: number; netPaise: number }>
  recent: DayBookEntry[]
  checks: { trialBalanceBalanced: boolean; balanceSheetBalanced: boolean }
}

// ───────── Receivables / payables ─────────
export const AGEING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const
export type AgeingBucket = (typeof AGEING_BUCKETS)[number]
export const AGEING_LABELS: Record<AgeingBucket, string> = { CURRENT: 'Current', D1_30: '1–30 days', D31_60: '31–60 days', D61_90: '61–90 days', D90_PLUS: 'Above 90 days' }
export const bucketFor = (daysOverdue: number): AgeingBucket =>
  daysOverdue <= 0 ? 'CURRENT' : daysOverdue <= 30 ? 'D1_30' : daysOverdue <= 60 ? 'D31_60' : daysOverdue <= 90 ? 'D61_90' : 'D90_PLUS'

export interface AgeingItem {
  kind: 'INVOICE' | 'OPENING' | 'ADJUSTMENT'
  id: number
  number: string
  date: string
  dueDate: string
  daysOverdue: number
  bucket: AgeingBucket
  amountPaise: number
  settledPaise: number
  balancePaise: number
  route: string | null
}
export interface OnAccountItem {
  kind: 'RECEIPT' | 'PAYMENT' | 'SALES_RETURN' | 'CREDIT_NOTE' | 'PURCHASE_RETURN' | 'DEBIT_NOTE' | 'ADJUSTMENT'
  id: number
  number: string
  date: string
  amountPaise: number
  unallocatedPaise: number
  route: string | null
}
export interface PartyAgeingRow {
  partyId: number
  code: string
  name: string
  buckets: Record<AgeingBucket, number>
  /** Sum of open debit items (invoices, opening balances, adjustments). */
  grossPaise: number
  /** Unallocated receipts/payments and notes (advances / on account). */
  onAccountPaise: number
  netPaise: number
  /** Party balance in the control ledger as of the date (natural sign). */
  ledgerPaise: number
  differencePaise: number
  overduePaise: number
  oldestOverdueDays: number
  openItems: number
  overdueInvoices: number
  /** Overdue open items of any kind (invoices, opening balances, adjustments). */
  overdueItems: number
}
export interface AgeingReport {
  side: 'CUSTOMER' | 'SUPPLIER'
  asOf: string
  rows: PartyAgeingRow[]
  totals: Record<AgeingBucket, number> & { grossPaise: number; onAccountPaise: number; netPaise: number; overduePaise: number }
  /** Control account (Sundry Debtors / Creditors) balance as of the date, natural sign. */
  controlAccountPaise: number
  differencePaise: number
  agrees: boolean
}
export interface PartyStatement {
  side: 'CUSTOMER' | 'SUPPLIER'
  asOf: string
  party: { id: number; code: string; name: string; gstin: string | null; creditDays: number; creditLimitPaise: number | null }
  items: AgeingItem[]
  onAccount: OnAccountItem[]
  payments: Array<{ id: number; number: string; date: string; mode: string; amountPaise: number; allocatedPaise: number; route: string; allocations: Array<{ number: string; amountPaise: number }> }>
  notes: Array<{ kind: string; label: string; id: number; number: string; date: string; status: string; amountPaise: number; against: string | null; route: string }>
  summary: PartyAgeingRow
}

// ───────── Vouchers ─────────
export const VOUCHER_TYPES = ['CONTRA', 'JOURNAL'] as const
export type VoucherType = (typeof VOUCHER_TYPES)[number]
export const VoucherLineInput = z
  .object({
    accountId: id,
    debitPaise: paise('Debit').default(0),
    creditPaise: paise('Credit').default(0),
    partyType: z.enum(['CUSTOMER', 'SUPPLIER']).nullable().optional(),
    partyId: id.nullable().optional(),
    narration: optText(200).optional()
  })
  .strict()
export const VoucherCreateInput = z
  .object({
    type: z.enum(VOUCHER_TYPES),
    date: isoDate,
    referenceNo: optText(50).optional(),
    narration: z.string({ error: 'Narration is required' }).trim().min(3, 'Enter a narration (at least 3 characters)').max(300),
    lines: z.array(VoucherLineInput).min(2, 'Add at least two lines').max(50, 'At most 50 lines'),
    requestKey
  })
  .strict()
export type VoucherCreateInputT = z.input<typeof VoucherCreateInput>
export const VoucherCancelInput = z.object({ id, reason: z.string().trim().min(3, 'Enter a reason (at least 3 characters)').max(200) }).strict()
export const VoucherListInput = z
  .object({ type: z.enum(VOUCHER_TYPES).optional(), from: isoDate.optional(), to: isoDate.optional(), search: z.string().trim().max(100).optional() })
  .strict()
  .optional()

export interface VoucherRow {
  id: number
  type: VoucherType
  number: string
  date: string
  narration: string
  referenceNo: string | null
  amountPaise: number
  status: 'POSTED' | 'CANCELLED'
  entryNo: string | null
  createdBy: string | null
}
export interface VoucherDetail extends VoucherRow {
  journalId: number | null
  reversalEntryNo: string | null
  cancelReason: string | null
  cancelledAt: string | null
  createdAt: string
  lines: Array<{ accountId: number; accountCode: string; accountName: string; party: string | null; debitPaise: number; creditPaise: number; narration: string | null }>
}

// ───────── Bank reconciliation ─────────
const statementLine = z
  .object({
    date: isoDate,
    description: z.string().trim().min(1, 'Description is required').max(200),
    reference: optText(60).optional(),
    depositPaise: paise('Deposit').default(0),
    withdrawalPaise: paise('Withdrawal').default(0)
  })
  .strict()
  .refine((v) => (v.depositPaise > 0) !== (v.withdrawalPaise > 0), { path: ['depositPaise'], message: 'Enter either a deposit or a withdrawal' })
export const BankRecCreateInput = z.object({ accountId: id, statementDate: isoDate, statementBalancePaise: signedPaise('Statement balance'), notes: optText(300).optional() }).strict()
export const BankRecUpdateInput = z.object({ id, statementDate: isoDate, statementBalancePaise: signedPaise('Statement balance'), notes: optText(300).optional() }).strict()
export const BankRecIdInput = z.object({ id }).strict()
export const BankRecListInput = z.object({ accountId: id.optional() }).strict().optional()
export const BankRecAddLinesInput = z
  .object({ id, lines: z.array(statementLine).max(500).optional(), csv: z.string().max(200000).optional() })
  .strict()
  .refine((v) => (v.lines?.length ?? 0) > 0 || !!v.csv?.trim(), { path: ['csv'], message: 'Enter statement lines or paste CSV rows' })
export const BankRecMatchInput = z.object({ id, statementLineId: id, journalLineId: id }).strict()
export const BankRecLineRef = z.object({ id, statementLineId: id }).strict()
export const BankRecTickInput = z.object({ id, journalLineId: id, clearedDate: isoDate }).strict()
export const BankRecRecordInput = z
  .object({ id, statementLineId: id, contraAccountId: id, narration: z.string().trim().min(3).max(300), requestKey })
  .strict()

export interface BookItem {
  journalLineId: number
  journalId: number
  date: string
  entryNo: string
  voucherType: string
  voucherNo: string | null
  route: string | null
  particulars: string
  /** Positive amount; direction says which side of the bank account it is on. */
  amountPaise: number
  direction: 'DEPOSIT' | 'WITHDRAWAL'
}
export interface StatementLineRow {
  id: number
  date: string
  description: string
  reference: string | null
  depositPaise: number
  withdrawalPaise: number
  source: 'STATEMENT' | 'BOOK_TICK'
  matched: BookItem | null
}
export interface BankRecRow {
  id: number
  accountId: number
  accountName: string
  statementDate: string
  statementBalancePaise: number
  status: 'IN_PROGRESS' | 'COMPLETED'
  bookBalancePaise: number | null
  differencePaise: number | null
  completedAt: string | null
  createdAt: string
}
export interface BankRecDetail extends BankRecRow {
  notes: string | null
  account: { id: number; code: string; name: string }
  statementLines: StatementLineRow[]
  unclearedDeposits: BookItem[]
  unclearedWithdrawals: BookItem[]
  summary: {
    bookBalancePaise: number
    unclearedDepositsPaise: number
    unclearedWithdrawalsPaise: number
    /** Book balance − deposits not yet in the bank + withdrawals not yet presented. */
    adjustedBookBalancePaise: number
    statementBalancePaise: number
    unmatchedStatementDepositsPaise: number
    unmatchedStatementWithdrawalsPaise: number
    unmatchedStatementLines: number
    differencePaise: number
    status: 'RECONCILED' | 'UNRECONCILED'
  }
}

// ───────── Auditor ─────────
export const EXCEPTION_CATEGORIES = {
  UNBALANCED_ATTEMPT: 'Unbalanced journal attempts',
  MISSING_SOURCE: 'Missing source references',
  DUPLICATE_REFERENCE: 'Duplicate document references',
  MANUAL_JOURNAL: 'Unusual manual journals',
  REVERSED: 'Reversed transactions',
  CANCELLED: 'Cancelled documents',
  STOCK_ADJUSTMENT: 'Unusual stock adjustments'
} as const
export type ExceptionCategory = keyof typeof EXCEPTION_CATEGORIES
export const ExceptionsInput = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .strict()
  .optional()
export interface AuditException {
  id: string
  category: ExceptionCategory
  /** 'review' = needs a look; 'info' = recorded for completeness. Never an accusation. */
  severity: 'info' | 'review'
  date: string
  reference: string
  route: string | null
  title: string
  detail: string
  amountPaise: number | null
  user: string | null
}
export interface AuditExceptionReport {
  from: string | null
  to: string | null
  generatedAt: string
  counts: Record<ExceptionCategory, number>
  items: AuditException[]
  disclaimer: string
}
export interface IntegrityCheck {
  key: string
  label: string
  ok: boolean
  detail: string
  differencePaise?: number
}
export interface IntegrityReport {
  asOf: string
  checks: IntegrityCheck[]
  allOk: boolean
}

// ───────── Reports (preview, PDF, Excel) ─────────
export const REPORT_KINDS = {
  DAY_BOOK: { label: 'Day Book', period: 'range', permission: 'finance.view' },
  CASH_BOOK: { label: 'Cash Book', period: 'range', permission: 'banking.view' },
  BANK_BOOK: { label: 'Bank Book', period: 'range', permission: 'banking.view' },
  GENERAL_LEDGER: { label: 'General Ledger', period: 'range', permission: 'finance.view' },
  TRIAL_BALANCE: { label: 'Trial Balance', period: 'range', permission: 'finance.view' },
  PROFIT_LOSS: { label: 'Profit & Loss', period: 'range', permission: 'finance.view' },
  BALANCE_SHEET: { label: 'Balance Sheet', period: 'asOf', permission: 'finance.view' },
  RECEIVABLES: { label: 'Receivables Ageing', period: 'asOf', permission: 'finance.view' },
  PAYABLES: { label: 'Payables Ageing', period: 'asOf', permission: 'finance.view' },
  STOCK_VALUATION: { label: 'Stock Valuation', period: 'asOf', permission: 'inventory.view' },
  SALES_REGISTER: { label: 'Sales Register', period: 'range', permission: 'sales.view' },
  PURCHASE_REGISTER: { label: 'Purchase Register', period: 'range', permission: 'purchase.view' },
  GST_SUMMARY: { label: 'GST Summary', period: 'range', permission: 'gst.view' },
  BANK_RECONCILIATION: { label: 'Bank Reconciliation Statement', period: 'none', permission: 'banking.view' }
} as const
export type ReportKind = keyof typeof REPORT_KINDS
export const REPORT_KIND_KEYS = Object.keys(REPORT_KINDS) as [ReportKind, ...ReportKind[]]

export const ReportParams = z
  .object({
    report: z.enum(REPORT_KIND_KEYS),
    from: isoDate.optional(),
    to: isoDate.optional(),
    asOf: isoDate.optional(),
    accountId: id.optional(),
    reconciliationId: id.optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.report === 'BANK_RECONCILIATION' && !v.reconciliationId) ctx.addIssue({ code: 'custom', path: ['reconciliationId'], message: 'Select a reconciliation' })
    const p = REPORT_KINDS[v.report].period
    if (p === 'range' && (!v.from || !v.to)) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Select a period' })
    if (p === 'range' && v.from && v.to && v.from > v.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after the start date' })
    if (p === 'asOf' && !v.asOf) ctx.addIssue({ code: 'custom', path: ['asOf'], message: 'Select a date' })
    if ((v.report === 'GENERAL_LEDGER' || v.report === 'BANK_BOOK') && !v.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'Select an account' })
  })
export type ReportParamsT = z.input<typeof ReportParams>

export type ReportCell = string | number | null
export interface ReportColumn {
  key: string
  label: string
  type: 'text' | 'date' | 'money' | 'qty' | 'number'
  width?: number
}
export interface ReportRow {
  cells: Record<string, ReportCell>
  style?: 'group' | 'subtotal' | 'total' | 'muted'
  indent?: number
}
export interface ReportDoc {
  kind: ReportKind
  title: string
  subtitle: string
  companyName: string
  companyGstin: string | null
  isDemo: boolean
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Key figures shown above the table (label → formatted value). */
  summary: Array<{ label: string; value: string; tone?: 'good' | 'bad' }>
  notes: string[]
  generatedAt: string
  generatedBy: string | null
}

/** One formatter for report cells, shared by the screen preview, PDF/print and Excel labels. */
export function formatReportCell(c: ReportColumn, v: ReportCell): string {
  if (v === null || v === undefined || v === '') return ''
  if (c.type === 'money' && typeof v === 'number') return (v / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (c.type === 'qty' && typeof v === 'number') return (v / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 })
  if (c.type === 'number' && typeof v === 'number') return v.toLocaleString('en-IN')
  if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    return new Date(`${v}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return String(v)
}
