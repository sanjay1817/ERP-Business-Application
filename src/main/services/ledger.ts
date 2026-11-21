import type { DB } from '../db/connection'
import { businessRule, UnbalancedJournalError } from './errors'
import { nextDocumentNumber } from './sequences'
import { financialYearOf } from '@shared/india'
import { PHASE3_ACCOUNTS, REPORT_GROUPS } from '../db/migrations/004_finance'

export type SystemAccount =
  | 'CASH' | 'BANK' | 'AR' | 'INVENTORY' | 'INPUT_CGST' | 'INPUT_SGST' | 'INPUT_IGST'
  | 'AP' | 'OUTPUT_CGST' | 'OUTPUT_SGST' | 'OUTPUT_IGST'
  | 'CAPITAL' | 'OPENING_EQUITY'
  | 'SALES_GOODS' | 'SALES_SERVICES' | 'ROUND_OFF'
  | 'COGS' | 'PURCHASE_SERVICES'
  | 'SALES_RETURNS' | 'GRNI' | 'PPV' | 'FREIGHT_INWARD' | 'OTHER_PURCHASE_CHARGES' | 'PURCHASE_ALLOWANCES'
  | 'RETAINED_EARNINGS'

type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'

export type ReportGroup = (typeof REPORT_GROUPS)[number]

const DEFAULT_COA: ReadonlyArray<{ code: string; name: string; type: AccountType; group?: boolean; parent?: string; key?: SystemAccount; bank?: boolean; report?: ReportGroup }> = [
  { code: '1000', name: 'Assets', type: 'ASSET', group: true },
  { code: '1100', name: 'Cash in Hand', type: 'ASSET', parent: '1000', key: 'CASH', bank: true, report: 'CASH' },
  { code: '1200', name: 'Bank - Current Account', type: 'ASSET', parent: '1000', key: 'BANK', bank: true, report: 'BANK' },
  { code: '1210', name: 'Bank - Collections Account', type: 'ASSET', parent: '1000', bank: true, report: 'BANK' },
  { code: '1300', name: 'Sundry Debtors', type: 'ASSET', parent: '1000', key: 'AR', report: 'RECEIVABLES' },
  { code: '1400', name: 'Stock in Hand', type: 'ASSET', parent: '1000', key: 'INVENTORY', report: 'INVENTORY' },
  { code: '1500', name: 'Input CGST', type: 'ASSET', parent: '1000', key: 'INPUT_CGST', report: 'OTHER_ASSET' },
  { code: '1510', name: 'Input SGST', type: 'ASSET', parent: '1000', key: 'INPUT_SGST', report: 'OTHER_ASSET' },
  { code: '1520', name: 'Input IGST', type: 'ASSET', parent: '1000', key: 'INPUT_IGST', report: 'OTHER_ASSET' },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY', group: true },
  { code: '2100', name: 'Sundry Creditors', type: 'LIABILITY', parent: '2000', key: 'AP', report: 'PAYABLES' },
  { code: '2200', name: 'Output CGST', type: 'LIABILITY', parent: '2000', key: 'OUTPUT_CGST', report: 'TAX_LIABILITY' },
  { code: '2210', name: 'Output SGST', type: 'LIABILITY', parent: '2000', key: 'OUTPUT_SGST', report: 'TAX_LIABILITY' },
  { code: '2220', name: 'Output IGST', type: 'LIABILITY', parent: '2000', key: 'OUTPUT_IGST', report: 'TAX_LIABILITY' },
  { code: '2300', name: 'Goods Received Not Invoiced', type: 'LIABILITY', parent: '2000', key: 'GRNI', report: 'OTHER_LIABILITY' },
  { code: '3000', name: 'Equity', type: 'EQUITY', group: true },
  { code: '3100', name: 'Capital Account', type: 'EQUITY', parent: '3000', key: 'CAPITAL', report: 'CAPITAL' },
  { code: '3900', name: 'Opening Balance Equity', type: 'EQUITY', parent: '3000', key: 'OPENING_EQUITY', report: 'CAPITAL' },
  { code: '4000', name: 'Income', type: 'INCOME', group: true },
  { code: '4100', name: 'Sales - Goods', type: 'INCOME', parent: '4000', key: 'SALES_GOODS', report: 'SALES' },
  { code: '4200', name: 'Service Income', type: 'INCOME', parent: '4000', key: 'SALES_SERVICES', report: 'SALES' },
  { code: '4300', name: 'Sales Returns & Allowances', type: 'INCOME', parent: '4000', key: 'SALES_RETURNS', report: 'SALES' },
  { code: '4900', name: 'Rounding Differences', type: 'INCOME', parent: '4000', key: 'ROUND_OFF', report: 'OTHER_INCOME' },
  { code: '5000', name: 'Expenses', type: 'EXPENSE', group: true },
  { code: '5100', name: 'Cost of Goods Sold', type: 'EXPENSE', parent: '5000', key: 'COGS', report: 'COGS' },
  { code: '5200', name: 'Purchases - Services', type: 'EXPENSE', parent: '5000', key: 'PURCHASE_SERVICES', report: 'COGS' },
  { code: '5300', name: 'Purchase Price Variance', type: 'EXPENSE', parent: '5000', key: 'PPV', report: 'COGS' },
  { code: '5400', name: 'Freight Inward', type: 'EXPENSE', parent: '5000', key: 'FREIGHT_INWARD', report: 'COGS' },
  { code: '5500', name: 'Other Purchase Charges', type: 'EXPENSE', parent: '5000', key: 'OTHER_PURCHASE_CHARGES', report: 'COGS' },
  { code: '5600', name: 'Purchase Returns & Allowances', type: 'EXPENSE', parent: '5000', key: 'PURCHASE_ALLOWANCES', report: 'COGS' },
  // Phase 3 accounts (same definitions as migration 004 adds to existing companies).
  ...PHASE3_ACCOUNTS.map(([code, name, type, parent, report, key, isGroup]) => ({
    code, name, type: type as AccountType, parent: parent ?? undefined, report: (report ?? undefined) as ReportGroup | undefined,
    key: (key ?? undefined) as SystemAccount | undefined, group: isGroup === 1
  }))
]

export function createDefaultChartOfAccounts(db: DB, companyId: number): void {
  // Databases created before migration 004 (upgrade tests) have no report_group column and none of
  // the Phase 3 accounts; migration 004 adds both, exactly as for a company created back then.
  const classified = db.prepare(`SELECT 1 FROM pragma_table_info('chart_of_accounts') WHERE name = 'report_group'`).get() !== undefined
  const phase3 = new Set(PHASE3_ACCOUNTS.map(([code]) => code))
  const insert = db.prepare(
    `INSERT INTO chart_of_accounts (company_id, code, name, account_type, parent_id, system_key, is_group, is_bank${classified ? ', report_group' : ''})
     VALUES (?, ?, ?, ?, (SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?), ?, ?, ?${classified ? ', ?' : ''})`
  )
  for (const a of DEFAULT_COA) {
    if (!classified && phase3.has(a.code)) continue
    const values = [companyId, a.code, a.name, a.type, companyId, a.parent ?? null, a.key ?? null, a.group ? 1 : 0, a.bank ? 1 : 0]
    insert.run(...(classified ? [...values, a.report ?? null] : values))
  }
}

export function accountId(db: DB, companyId: number, key: SystemAccount): number {
  const row = db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND system_key = ?').get(companyId, key) as { id: number } | undefined
  if (!row) throw businessRule(`Ledger account ${key} is not configured for this company`)
  return row.id
}

export interface JournalLineInput {
  accountId: number
  debitPaise?: number
  creditPaise?: number
  partyType?: 'CUSTOMER' | 'SUPPLIER'
  partyId?: number
  narration?: string
}

export interface JournalInput {
  companyId: number
  userId: number | null
  entryDate: string
  sourceType: 'OPENING' | 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'RECEIPT' | 'PAYMENT' | 'MANUAL' | 'REVERSAL'
  sourceId?: number | null
  /** Exact originating document kind (e.g. DELIVERY_CHALLAN, CANCEL:SALES_INVOICE). */
  sourceKind?: string | null
  narration: string
  lines: JournalLineInput[]
}

/**
 * Post a balanced journal entry. Zero-value lines are dropped; the entry is
 * rejected unless total debits equal total credits. Call inside a transaction.
 */
export function postJournal(db: DB, input: JournalInput): { id: number; entryNo: string } {
  const lines = input.lines
    .map((l) => ({ ...l, debitPaise: l.debitPaise ?? 0, creditPaise: l.creditPaise ?? 0 }))
    .filter((l) => l.debitPaise !== 0 || l.creditPaise !== 0)

  if (lines.length < 2) throw businessRule('A journal entry needs at least two non-zero lines')
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debitPaise) || !Number.isSafeInteger(l.creditPaise) || l.debitPaise < 0 || l.creditPaise < 0) {
      throw businessRule('Journal amounts must be non-negative whole paise')
    }
    if (l.debitPaise > 0 && l.creditPaise > 0) throw businessRule('A journal line cannot have both debit and credit')
  }
  const totalDebit = lines.reduce((s, l) => s + l.debitPaise, 0)
  const totalCredit = lines.reduce((s, l) => s + l.creditPaise, 0)
  if (totalDebit !== totalCredit) {
    throw new UnbalancedJournalError(totalDebit, totalCredit, { narration: input.narration, sourceKind: input.sourceKind ?? input.sourceType, entryDate: input.entryDate })
  }

  const accountCheck = db.prepare('SELECT company_id, is_group, is_active FROM chart_of_accounts WHERE id = ?')
  for (const l of lines) {
    const acc = accountCheck.get(l.accountId) as { company_id: number; is_group: number; is_active: number } | undefined
    if (!acc || acc.company_id !== input.companyId) throw businessRule('Journal line refers to an account of another company')
    if (acc.is_group) throw businessRule('Cannot post to a group account')
    if (!acc.is_active) throw businessRule('Cannot post to an inactive account')
  }

  const fy = financialYearOf(input.entryDate)
  const entryNo = nextDocumentNumber(db, input.companyId, 'JOURNAL', fy)
  const header = db
    .prepare(
      `INSERT INTO journal_entries (company_id, financial_year, entry_no, entry_date, source_type, source_kind, source_id, narration, total_debit_paise, total_credit_paise, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.companyId, fy, entryNo, input.entryDate, input.sourceType, input.sourceKind ?? input.sourceType, input.sourceId ?? null, input.narration, totalDebit, totalCredit, input.userId)
  const journalId = Number(header.lastInsertRowid)

  const insertLine = db.prepare(
    `INSERT INTO journal_entry_lines (journal_entry_id, line_no, account_id, debit_paise, credit_paise, party_type, party_id, narration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  lines.forEach((l, i) => insertLine.run(journalId, i + 1, l.accountId, l.debitPaise, l.creditPaise, l.partyType ?? null, l.partyId ?? null, l.narration ?? null))
  return { id: journalId, entryNo }
}

/** Debit-positive balance of an account (optionally for one party). */
export function accountBalance(db: DB, accountIdValue: number, party?: { type: 'CUSTOMER' | 'SUPPLIER'; id: number }): number {
  const row = party
    ? db
        .prepare(
          `SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS b FROM journal_entry_lines l
           WHERE l.account_id = ? AND l.party_type = ? AND l.party_id = ?`
        )
        .get(accountIdValue, party.type, party.id)
    : db.prepare('SELECT COALESCE(SUM(debit_paise - credit_paise), 0) AS b FROM journal_entry_lines WHERE account_id = ?').get(accountIdValue)
  return (row as { b: number }).b
}
