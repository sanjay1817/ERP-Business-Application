import type { Migration } from '../migrator'

/**
 * Phase 3 — finance, accounting & auditor workspace.
 *  - chart_of_accounts.report_group: statement classification (P&L / balance sheet lines).
 *    Only master data is updated here; no posted transaction is touched.
 *  - Additional ledger accounts (fixed assets, loans, retained earnings, other income, expenses).
 *  - vouchers: manual journal and contra vouchers (posted through the same journal engine).
 *  - posting_requests: idempotency keys so a resubmitted form never posts twice.
 *  - bank_reconciliations / bank_statement_lines: reconciliation sessions. Matching links a
 *    statement line to a book journal line; posted journals are never modified.
 *  - Permissions: finance.manage, reports.view, reports.export.
 */
const TS = `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export const REPORT_GROUPS = [
  'CASH', 'BANK', 'RECEIVABLES', 'INVENTORY', 'FIXED_ASSET', 'OTHER_ASSET',
  'PAYABLES', 'LOANS', 'TAX_LIABILITY', 'OTHER_LIABILITY',
  'CAPITAL', 'RETAINED_EARNINGS',
  'SALES', 'OTHER_INCOME',
  'COGS', 'DIRECT_EXPENSE', 'INDIRECT_EXPENSE', 'ADMIN_EXPENSE', 'FINANCE_EXPENSE'
] as const

const groupList = REPORT_GROUPS.map((g) => `'${g}'`).join(',')

/** system_key → report group for the accounts created in Phases 1–2. */
const KEY_GROUPS: ReadonlyArray<[key: string, group: string]> = [
  ['CASH', 'CASH'], ['BANK', 'BANK'], ['AR', 'RECEIVABLES'], ['INVENTORY', 'INVENTORY'],
  ['INPUT_CGST', 'OTHER_ASSET'], ['INPUT_SGST', 'OTHER_ASSET'], ['INPUT_IGST', 'OTHER_ASSET'],
  ['AP', 'PAYABLES'], ['OUTPUT_CGST', 'TAX_LIABILITY'], ['OUTPUT_SGST', 'TAX_LIABILITY'], ['OUTPUT_IGST', 'TAX_LIABILITY'], ['GRNI', 'OTHER_LIABILITY'],
  ['CAPITAL', 'CAPITAL'], ['OPENING_EQUITY', 'CAPITAL'],
  ['SALES_GOODS', 'SALES'], ['SALES_SERVICES', 'SALES'], ['SALES_RETURNS', 'SALES'], ['ROUND_OFF', 'OTHER_INCOME'],
  ['COGS', 'COGS'], ['PURCHASE_SERVICES', 'COGS'], ['PPV', 'COGS'], ['FREIGHT_INWARD', 'COGS'], ['OTHER_PURCHASE_CHARGES', 'COGS'], ['PURCHASE_ALLOWANCES', 'COGS']
]

/** [code, name, type, parent code, report group, system key, is_group] */
export const PHASE3_ACCOUNTS: ReadonlyArray<[string, string, string, string | null, string | null, string | null, 0 | 1]> = [
  ['1600', 'Computers & Office Equipment', 'ASSET', '1000', 'FIXED_ASSET', null, 0],
  ['1610', 'Furniture & Fixtures', 'ASSET', '1000', 'FIXED_ASSET', null, 0],
  ['1700', 'Security Deposits & Advances', 'ASSET', '1000', 'OTHER_ASSET', null, 0],
  ['2400', 'TDS Payable', 'LIABILITY', '2000', 'TAX_LIABILITY', null, 0],
  ['2500', 'Bank Term Loan', 'LIABILITY', '2000', 'LOANS', null, 0],
  ['2600', 'Outstanding Expenses', 'LIABILITY', '2000', 'OTHER_LIABILITY', null, 0],
  ['3200', 'Retained Earnings', 'EQUITY', '3000', 'RETAINED_EARNINGS', 'RETAINED_EARNINGS', 0],
  ['4500', 'Other Income', 'INCOME', '4000', 'OTHER_INCOME', null, 0],
  ['4510', 'Interest Income', 'INCOME', '4000', 'OTHER_INCOME', null, 0],
  ['5700', 'Direct Labour & Installation Costs', 'EXPENSE', '5000', 'DIRECT_EXPENSE', null, 0],
  ['6000', 'Operating Expenses', 'EXPENSE', null, null, null, 1],
  ['6100', 'Salaries & Staff Welfare', 'EXPENSE', '6000', 'ADMIN_EXPENSE', null, 0],
  ['6200', 'Rent', 'EXPENSE', '6000', 'ADMIN_EXPENSE', null, 0],
  ['6300', 'Electricity & Utilities', 'EXPENSE', '6000', 'ADMIN_EXPENSE', null, 0],
  ['6400', 'Printing, Stationery & Office Expenses', 'EXPENSE', '6000', 'ADMIN_EXPENSE', null, 0],
  ['6500', 'Advertising & Marketing', 'EXPENSE', '6000', 'INDIRECT_EXPENSE', null, 0],
  ['6600', 'Freight Outward & Delivery', 'EXPENSE', '6000', 'INDIRECT_EXPENSE', null, 0],
  ['6700', 'Travel & Conveyance', 'EXPENSE', '6000', 'INDIRECT_EXPENSE', null, 0],
  ['6800', 'Bank Charges', 'EXPENSE', '6000', 'FINANCE_EXPENSE', null, 0],
  ['6900', 'Interest on Loans', 'EXPENSE', '6000', 'FINANCE_EXPENSE', null, 0]
]

const q = (s: string | null) => (s === null ? 'NULL' : `'${s.replace(/'/g, "''")}'`)

const accountsSql = PHASE3_ACCOUNTS.map(
  ([code, name, type, parent, group, key, isGroup]) =>
    `INSERT INTO chart_of_accounts (company_id, code, name, account_type, parent_id, system_key, is_group, report_group)
     SELECT c.id, ${q(code)}, ${q(name)}, ${q(type)}, ${parent ? `(SELECT a.id FROM chart_of_accounts a WHERE a.company_id = c.id AND a.code = ${q(parent)})` : 'NULL'}, ${q(key)}, ${isGroup}, ${q(group)}
     FROM companies c WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.company_id = c.id AND (x.code = ${q(code)}${key ? ` OR x.system_key = ${q(key)}` : ''}));`
).join('\n')

const PERMS: ReadonlyArray<[code: string, module: string, description: string, roles: string[]]> = [
  ['finance.manage', 'Finance', 'Post and cancel journal/contra vouchers; reconcile bank accounts', ['ADMIN', 'ACCOUNTANT']],
  ['reports.view', 'Reports', 'View financial reports', ['ADMIN', 'ACCOUNTANT', 'AUDITOR']],
  ['reports.export', 'Reports', 'Export and print financial reports (PDF/Excel)', ['ADMIN', 'ACCOUNTANT', 'AUDITOR']]
]
const permsSql = PERMS.map(
  ([code, module, desc, roles]) =>
    `INSERT INTO permissions (code, module, description) VALUES (${q(code)}, ${q(module)}, ${q(desc)});
     INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ${q(code)} WHERE r.code IN (${roles.map(q).join(',')});`
).join('\n')

export const migration004: Migration = {
  version: 4,
  name: 'finance_accounting',
  sql: `
-- ───────── Statement classification (master data only) ─────────
ALTER TABLE chart_of_accounts ADD COLUMN report_group TEXT CHECK (report_group IS NULL OR report_group IN (${groupList}));
${KEY_GROUPS.map(([key, group]) => `UPDATE chart_of_accounts SET report_group = '${group}' WHERE system_key = '${key}';`).join('\n')}
UPDATE chart_of_accounts SET report_group = 'BANK' WHERE report_group IS NULL AND is_group = 0 AND is_bank = 1;
UPDATE chart_of_accounts SET report_group = CASE account_type
    WHEN 'ASSET' THEN 'OTHER_ASSET' WHEN 'LIABILITY' THEN 'OTHER_LIABILITY' WHEN 'EQUITY' THEN 'CAPITAL'
    WHEN 'INCOME' THEN 'OTHER_INCOME' ELSE 'INDIRECT_EXPENSE' END
  WHERE report_group IS NULL AND is_group = 0;
${accountsSql}

-- ───────── Manual journal & contra vouchers ─────────
CREATE TABLE vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('CONTRA','JOURNAL')),
  financial_year TEXT NOT NULL,
  voucher_no TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  reference_no TEXT,
  narration TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, financial_year, voucher_no)
);
CREATE INDEX idx_vouchers_company_date ON vouchers(company_id, voucher_date);
CREATE TRIGGER trg_voucher_update_guard BEFORE UPDATE ON vouchers
WHEN NOT (
  NEW.amount_paise = OLD.amount_paise AND NEW.voucher_no = OLD.voucher_no AND NEW.voucher_date = OLD.voucher_date
  AND NEW.voucher_type = OLD.voucher_type AND NEW.company_id = OLD.company_id AND NEW.narration = OLD.narration
  AND (
    (OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL AND NEW.status = OLD.status)
    OR (OLD.status = 'POSTED' AND NEW.status = 'CANCELLED' AND NEW.journal_entry_id = OLD.journal_entry_id AND NEW.reversal_journal_entry_id IS NOT NULL)
  ))
BEGIN SELECT RAISE(ABORT, 'Posted vouchers cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_voucher_no_delete BEFORE DELETE ON vouchers
BEGIN SELECT RAISE(ABORT, 'Vouchers cannot be deleted'); END;

-- ───────── Idempotent posting (duplicate submission guard) ─────────
CREATE TABLE posting_requests (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, request_key)
);
CREATE TRIGGER trg_postreq_no_update BEFORE UPDATE ON posting_requests
BEGIN SELECT RAISE(ABORT, 'Posting requests are immutable'); END;
CREATE TRIGGER trg_postreq_no_delete BEFORE DELETE ON posting_requests
BEGIN SELECT RAISE(ABORT, 'Posting requests cannot be deleted'); END;

-- ───────── Bank reconciliation ─────────
CREATE TABLE bank_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  statement_date TEXT NOT NULL,
  statement_balance_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  book_balance_paise INTEGER,
  difference_paise INTEGER,
  notes TEXT,
  completed_at TEXT, completed_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE UNIQUE INDEX ux_bankrec_open ON bank_reconciliations(account_id) WHERE status = 'IN_PROGRESS';
CREATE INDEX idx_bankrec_account ON bank_reconciliations(account_id, statement_date);

CREATE TABLE bank_statement_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL REFERENCES bank_reconciliations(id) ON DELETE RESTRICT,
  line_date TEXT NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  deposit_paise INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  withdrawal_paise INTEGER NOT NULL DEFAULT 0 CHECK (withdrawal_paise >= 0),
  journal_line_id INTEGER REFERENCES journal_entry_lines(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'STATEMENT' CHECK (source IN ('STATEMENT','BOOK_TICK')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((deposit_paise = 0) <> (withdrawal_paise = 0))
);
CREATE INDEX idx_bsl_rec ON bank_statement_lines(reconciliation_id);
CREATE UNIQUE INDEX ux_bsl_journal_line ON bank_statement_lines(journal_line_id) WHERE journal_line_id IS NOT NULL;

CREATE TRIGGER trg_bankrec_update_guard BEFORE UPDATE ON bank_reconciliations WHEN OLD.status = 'COMPLETED'
BEGIN SELECT RAISE(ABORT, 'A completed bank reconciliation cannot be changed'); END;
CREATE TRIGGER trg_bankrec_no_delete BEFORE DELETE ON bank_reconciliations
BEGIN SELECT RAISE(ABORT, 'Bank reconciliations cannot be deleted'); END;
CREATE TRIGGER trg_bsl_ins_guard BEFORE INSERT ON bank_statement_lines
WHEN (SELECT status FROM bank_reconciliations WHERE id = NEW.reconciliation_id) <> 'IN_PROGRESS'
BEGIN SELECT RAISE(ABORT, 'A completed bank reconciliation cannot be changed'); END;
CREATE TRIGGER trg_bsl_upd_guard BEFORE UPDATE ON bank_statement_lines
WHEN (SELECT status FROM bank_reconciliations WHERE id = OLD.reconciliation_id) <> 'IN_PROGRESS'
BEGIN SELECT RAISE(ABORT, 'A completed bank reconciliation cannot be changed'); END;
CREATE TRIGGER trg_bsl_del_guard BEFORE DELETE ON bank_statement_lines
WHEN (SELECT status FROM bank_reconciliations WHERE id = OLD.reconciliation_id) <> 'IN_PROGRESS'
BEGIN SELECT RAISE(ABORT, 'A completed bank reconciliation cannot be changed'); END;

-- ───────── Permissions ─────────
${permsSql}
`
}
