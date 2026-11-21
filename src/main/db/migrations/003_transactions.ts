import type { Migration } from '../migrator'

/**
 * Phase 2 — transaction engine.
 *  - Extends sales/purchase invoices with draft-editing, pricing mode, addresses, charges and source links.
 *  - trade_documents/trade_document_lines hold every other commercial document
 *    (quotation, order, delivery challan, returns, credit/debit notes, requisition, PO, GRN).
 *  - payment_allocations links receipts/payments/notes to invoices (amount received / balance due).
 *  - New ledger accounts for returns, GRN clearing, price variance, freight and purchase charges.
 *  - Company invoice settings (bank details, terms) and cancel permissions.
 */
const TS = `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

const HEADER_EXTRAS = (table: string, withDueDate: boolean) => `
${withDueDate ? `ALTER TABLE ${table} ADD COLUMN due_date TEXT;` : ''}
ALTER TABLE ${table} ADD COLUMN reference_no TEXT;
ALTER TABLE ${table} ADD COLUMN billing_address TEXT;
ALTER TABLE ${table} ADD COLUMN shipping_address TEXT;
ALTER TABLE ${table} ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'EXCLUSIVE' CHECK (pricing_mode IN ('EXCLUSIVE','INCLUSIVE'));
ALTER TABLE ${table} ADD COLUMN subtotal_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN freight_paise INTEGER NOT NULL DEFAULT 0 CHECK (freight_paise >= 0);
ALTER TABLE ${table} ADD COLUMN freight_tax_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN freight_tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN other_charges_paise INTEGER NOT NULL DEFAULT 0 CHECK (other_charges_paise >= 0);
ALTER TABLE ${table} ADD COLUMN other_charges_label TEXT;
ALTER TABLE ${table} ADD COLUMN other_charges_tax_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN other_charges_tax_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN source_type TEXT;
ALTER TABLE ${table} ADD COLUMN source_id INTEGER;
ALTER TABLE ${table} ADD COLUMN terms TEXT;
ALTER TABLE ${table} ADD COLUMN reason TEXT;
CREATE INDEX idx_${table}_source ON ${table}(source_type, source_id);`

const LINE_EXTRAS = (table: string, withCost: boolean) => `
ALTER TABLE ${table} ADD COLUMN gross_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN discount_bps INTEGER CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000);
ALTER TABLE ${table} ADD COLUMN source_line_id INTEGER;
${withCost ? `ALTER TABLE ${table} ADD COLUMN cost_paise INTEGER NOT NULL DEFAULT 0;` : ''}
CREATE INDEX idx_${table}_source_line ON ${table}(source_line_id);`

const NEW_ACCOUNTS: ReadonlyArray<[code: string, name: string, type: string, parent: string, key: string]> = [
  ['4300', 'Sales Returns & Allowances', 'INCOME', '4000', 'SALES_RETURNS'],
  ['2300', 'Goods Received Not Invoiced', 'LIABILITY', '2000', 'GRNI'],
  ['5300', 'Purchase Price Variance', 'EXPENSE', '5000', 'PPV'],
  ['5400', 'Freight Inward', 'EXPENSE', '5000', 'FREIGHT_INWARD'],
  ['5500', 'Other Purchase Charges', 'EXPENSE', '5000', 'OTHER_PURCHASE_CHARGES'],
  ['5600', 'Purchase Returns & Allowances', 'EXPENSE', '5000', 'PURCHASE_ALLOWANCES']
]

const accountsSql = NEW_ACCOUNTS.map(
  ([code, name, type, parent, key]) =>
    `INSERT INTO chart_of_accounts (company_id, code, name, account_type, parent_id, system_key)
     SELECT c.id, '${code}', '${name}', '${type}', (SELECT a.id FROM chart_of_accounts a WHERE a.company_id = c.id AND a.code = '${parent}'), '${key}'
     FROM companies c WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.company_id = c.id AND (x.code = '${code}' OR x.system_key = '${key}'));`
).join('\n')

const DOC_TYPES = `'SALES_QUOTATION','SALES_ORDER','DELIVERY_CHALLAN','SALES_RETURN','CREDIT_NOTE','PURCHASE_REQUISITION','PURCHASE_ORDER','GOODS_RECEIPT','PURCHASE_RETURN','DEBIT_NOTE'`

export const migration003: Migration = {
  version: 3,
  name: 'transaction_engine',
  sql: `
-- ───────── Invoice extensions ─────────
${HEADER_EXTRAS('sales_invoices', false)}
${HEADER_EXTRAS('purchase_invoices', true)}
${LINE_EXTRAS('sales_invoice_items', false)}
${LINE_EXTRAS('purchase_invoice_items', true)}

-- ───────── Other commercial documents ─────────
CREATE TABLE trade_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL CHECK (doc_type IN (${DOC_TYPES})),
  financial_year TEXT NOT NULL,
  doc_no TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  due_date TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE RESTRICT,
  party_gstin TEXT,
  supplier_ref TEXT,
  supplier_ref_date TEXT,
  place_of_supply TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  is_inter_state INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  reference_no TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  pricing_mode TEXT NOT NULL DEFAULT 'EXCLUSIVE' CHECK (pricing_mode IN ('EXCLUSIVE','INCLUSIVE')),
  subtotal_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  freight_paise INTEGER NOT NULL DEFAULT 0 CHECK (freight_paise >= 0),
  freight_tax_bps INTEGER NOT NULL DEFAULT 0,
  freight_tax_paise INTEGER NOT NULL DEFAULT 0,
  other_charges_paise INTEGER NOT NULL DEFAULT 0 CHECK (other_charges_paise >= 0),
  other_charges_label TEXT,
  other_charges_tax_bps INTEGER NOT NULL DEFAULT 0,
  other_charges_tax_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  grand_total_paise INTEGER NOT NULL DEFAULT 0 CHECK (grand_total_paise >= 0),
  notes TEXT,
  terms TEXT,
  reason TEXT,
  source_type TEXT,
  source_id INTEGER,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at TEXT, posted_by INTEGER REFERENCES users(id),
  cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, doc_type, financial_year, doc_no),
  CHECK (customer_id IS NULL OR supplier_id IS NULL)
);
CREATE INDEX idx_td_company_type_date ON trade_documents(company_id, doc_type, doc_date);
CREATE INDEX idx_td_customer ON trade_documents(customer_id);
CREATE INDEX idx_td_supplier ON trade_documents(supplier_id);
CREATE INDEX idx_td_source ON trade_documents(source_type, source_id);

CREATE TABLE trade_document_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES trade_documents(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description TEXT,
  hsn_sac TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('GOODS','SERVICE')),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
  gross_paise INTEGER NOT NULL DEFAULT 0,
  discount_bps INTEGER CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise INTEGER NOT NULL,
  tax_rate_bps INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL,
  cost_paise INTEGER NOT NULL DEFAULT 0,
  source_line_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (document_id, line_no)
);
CREATE INDEX idx_tdl_product ON trade_document_lines(product_id);
CREATE INDEX idx_tdl_source_line ON trade_document_lines(source_line_id);

CREATE TRIGGER trg_td_update_guard BEFORE UPDATE ON trade_documents
WHEN OLD.status <> 'DRAFT' AND NOT (
  OLD.status = 'POSTED' AND NEW.status = 'CANCELLED'
  AND NEW.grand_total_paise = OLD.grand_total_paise AND NEW.doc_no = OLD.doc_no AND NEW.doc_date = OLD.doc_date
  AND IFNULL(NEW.customer_id, 0) = IFNULL(OLD.customer_id, 0) AND IFNULL(NEW.supplier_id, 0) = IFNULL(OLD.supplier_id, 0)
  AND NEW.taxable_paise = OLD.taxable_paise AND NEW.financial_year = OLD.financial_year
  AND (OLD.journal_entry_id IS NULL OR NEW.reversal_journal_entry_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'Posted documents cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_td_no_delete BEFORE DELETE ON trade_documents WHEN OLD.status <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Posted documents cannot be deleted'); END;
CREATE TRIGGER trg_tdl_ins_guard BEFORE INSERT ON trade_document_lines
WHEN (SELECT status FROM trade_documents WHERE id = NEW.document_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot add lines to a posted document'); END;
CREATE TRIGGER trg_tdl_upd_guard BEFORE UPDATE ON trade_document_lines
WHEN (SELECT status FROM trade_documents WHERE id = OLD.document_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot modify lines of a posted document'); END;
CREATE TRIGGER trg_tdl_del_guard BEFORE DELETE ON trade_document_lines
WHEN (SELECT status FROM trade_documents WHERE id = OLD.document_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot delete lines of a posted document'); END;

-- ───────── Journal source kind (exact originating document) ─────────
-- No backfill: posted journals are immutable (trg_je_update_guard). Readers use COALESCE(source_kind, source_type).
ALTER TABLE journal_entries ADD COLUMN source_kind TEXT;

-- ───────── Payment allocation ─────────
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('RECEIPT','PAYMENT','SALES_RETURN','CREDIT_NOTE','PURCHASE_RETURN','DEBIT_NOTE')),
  source_id INTEGER NOT NULL,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('SALES_INVOICE','PURCHASE_INVOICE')),
  invoice_id INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  is_reversed INTEGER NOT NULL DEFAULT 0 CHECK (is_reversed IN (0,1)),
  reversed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_alloc_invoice ON payment_allocations(invoice_type, invoice_id);
CREATE INDEX idx_alloc_source ON payment_allocations(source_type, source_id);
CREATE TRIGGER trg_alloc_update_guard BEFORE UPDATE ON payment_allocations
WHEN NOT (OLD.is_reversed = 0 AND NEW.is_reversed = 1 AND NEW.amount_paise = OLD.amount_paise
          AND NEW.invoice_id = OLD.invoice_id AND NEW.source_id = OLD.source_id)
BEGIN SELECT RAISE(ABORT, 'Payment allocations cannot be edited; reverse them instead'); END;
CREATE TRIGGER trg_alloc_no_delete BEFORE DELETE ON payment_allocations
BEGIN SELECT RAISE(ABORT, 'Payment allocations cannot be deleted'); END;

-- ───────── Company invoice settings ─────────
ALTER TABLE companies ADD COLUMN bank_name TEXT;
ALTER TABLE companies ADD COLUMN bank_account_no TEXT;
ALTER TABLE companies ADD COLUMN bank_ifsc TEXT;
ALTER TABLE companies ADD COLUMN bank_branch TEXT;
ALTER TABLE companies ADD COLUMN upi_id TEXT;
ALTER TABLE companies ADD COLUMN invoice_terms TEXT;

-- ───────── Ledger accounts ─────────
${accountsSql}
INSERT INTO chart_of_accounts (company_id, code, name, account_type, parent_id, is_bank)
  SELECT c.id, '1210', 'Bank - Collections Account', 'ASSET', (SELECT a.id FROM chart_of_accounts a WHERE a.company_id = c.id AND a.code = '1000'), 1
  FROM companies c WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.company_id = c.id AND x.code = '1210');

-- ───────── Permissions ─────────
INSERT INTO permissions (code, module, description) VALUES ('sales.cancel', 'Sales', 'Cancel posted sales documents by reversal');
INSERT INTO permissions (code, module, description) VALUES ('purchase.cancel', 'Purchase', 'Cancel posted purchase documents by reversal');
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('sales.cancel','purchase.cancel') WHERE r.code IN ('ADMIN','ACCOUNTANT');
`
}
