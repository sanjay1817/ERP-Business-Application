import type { Migration } from '../migrator'

/**
 * Conventions
 *  - Money: INTEGER paise (*_paise). Quantity: INTEGER milli-units (*_milli). Rates: INTEGER basis points (*_bps).
 *  - Timestamps: ISO-8601 UTC text. Business dates: 'YYYY-MM-DD'.
 *  - Posted documents & ledger rows are protected by triggers; corrections go through reversals.
 */
const TS = `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema',
  sql: `
-- ───────────────────────── Organisation ─────────────────────────
CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  legal_name TEXT,
  gstin TEXT,
  pan TEXT,
  state_code TEXT NOT NULL,
  address_line1 TEXT, address_line2 TEXT, city TEXT, pincode TEXT,
  phone TEXT, email TEXT,
  fy_start_month INTEGER NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  base_currency TEXT NOT NULL DEFAULT 'INR',
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  ${TS}
);

CREATE TABLE branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  gstin TEXT,
  state_code TEXT NOT NULL,
  address_line1 TEXT, city TEXT, pincode TEXT,
  is_head_office INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code)
);

-- ───────────────────────── Security ─────────────────────────
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  ${TS}
);

CREATE TABLE permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  description TEXT NOT NULL,
  ${TS}
);

CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  default_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  ${TS}
);
CREATE INDEX idx_users_role ON users(role_id);

-- ───────────────────────── Masters ─────────────────────────
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL COLLATE NOCASE,
  parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, name)
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,      -- GST UQC code
  name TEXT NOT NULL,
  decimal_places INTEGER NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 3),
  ${TS}
);

CREATE TABLE tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  cess_bps INTEGER NOT NULL DEFAULT 0 CHECK (cess_bps >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS}
);

CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  address TEXT, city TEXT, state_code TEXT, pincode TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code)
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  party_type TEXT NOT NULL DEFAULT 'BUSINESS' CHECK (party_type IN ('BUSINESS','INDIVIDUAL')),
  gst_registration_type TEXT NOT NULL CHECK (gst_registration_type IN ('REGULAR','COMPOSITION','UNREGISTERED','CONSUMER','SEZ','OVERSEAS')),
  gstin TEXT, pan TEXT,
  contact_person TEXT, phone TEXT, email TEXT,
  address_line1 TEXT, address_line2 TEXT, city TEXT, state_code TEXT NOT NULL, pincode TEXT,
  shipping_address_line1 TEXT, shipping_address_line2 TEXT, shipping_city TEXT, shipping_state_code TEXT, shipping_pincode TEXT,
  credit_limit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_paise >= 0),
  credit_days INTEGER NOT NULL DEFAULT 0 CHECK (credit_days >= 0),
  opening_balance_paise INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code)
);
CREATE INDEX idx_customers_company_name ON customers(company_id, name);
CREATE INDEX idx_customers_gstin ON customers(company_id, gstin);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  gst_registration_type TEXT NOT NULL CHECK (gst_registration_type IN ('REGULAR','COMPOSITION','UNREGISTERED','CONSUMER','SEZ','OVERSEAS')),
  gstin TEXT, pan TEXT,
  contact_person TEXT, phone TEXT, email TEXT,
  address_line1 TEXT, address_line2 TEXT, city TEXT, state_code TEXT NOT NULL, pincode TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  bank_account_name TEXT, bank_account_no TEXT, bank_ifsc TEXT,
  opening_balance_paise INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code)
);
CREATE INDEX idx_suppliers_company_name ON suppliers(company_id, name);
CREATE INDEX idx_suppliers_gstin ON suppliers(company_id, gstin);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  item_type TEXT NOT NULL CHECK (item_type IN ('GOODS','SERVICE')),
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  hsn_sac TEXT NOT NULL,
  tax_rate_id INTEGER NOT NULL REFERENCES tax_rates(id) ON DELETE RESTRICT,
  sale_price_paise INTEGER NOT NULL DEFAULT 0 CHECK (sale_price_paise >= 0),
  purchase_price_paise INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_paise >= 0),
  mrp_paise INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= 0),
  reorder_level_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  track_inventory INTEGER NOT NULL DEFAULT 1 CHECK (track_inventory IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code),
  CHECK (item_type = 'GOODS' OR track_inventory = 0)
);
CREATE INDEX idx_products_company_name ON products(company_id, name);
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE transporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  transporter_id TEXT NOT NULL,   -- GSTIN or TRANSIN (15 chars)
  phone TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, transporter_id)
);

-- ───────────────────────── Accounting ─────────────────────────
CREATE TABLE chart_of_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  parent_id INTEGER REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  system_key TEXT,                -- stable key used by posting rules (AR, AP, SALES, ...)
  is_group INTEGER NOT NULL DEFAULT 0,
  is_bank INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  ${TS},
  UNIQUE (company_id, code)
);
CREATE UNIQUE INDEX ux_coa_system_key ON chart_of_accounts(company_id, system_key) WHERE system_key IS NOT NULL;

CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL,
  entry_no TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('OPENING','SALES_INVOICE','PURCHASE_INVOICE','RECEIPT','PAYMENT','MANUAL','REVERSAL')),
  source_id INTEGER,
  narration TEXT,
  total_debit_paise INTEGER NOT NULL CHECK (total_debit_paise > 0),
  total_credit_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  reversal_of_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ${TS},
  UNIQUE (company_id, financial_year, entry_no),
  CHECK (total_debit_paise = total_credit_paise)
);
CREATE INDEX idx_je_company_date ON journal_entries(company_id, entry_date);
CREATE INDEX idx_je_source ON journal_entries(source_type, source_id);

CREATE TABLE journal_entry_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  debit_paise INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
  credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
  party_type TEXT CHECK (party_type IS NULL OR party_type IN ('CUSTOMER','SUPPLIER')),
  party_id INTEGER,
  narration TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (journal_entry_id, line_no),
  CHECK ((debit_paise = 0) <> (credit_paise = 0))
);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);
CREATE INDEX idx_jel_party ON journal_entry_lines(party_type, party_id);

CREATE TABLE document_sequences (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL,
  financial_year TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, doc_type, financial_year)
);

-- ───────────────────────── Sales ─────────────────────────
CREATE TABLE sales_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL,
  invoice_no TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  is_inter_state INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  grand_total_paise INTEGER NOT NULL DEFAULT 0 CHECK (grand_total_paise >= 0),
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at TEXT, posted_by INTEGER REFERENCES users(id),
  cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, financial_year, invoice_no)
);
CREATE INDEX idx_si_company_date ON sales_invoices(company_id, invoice_date);
CREATE INDEX idx_si_customer ON sales_invoices(customer_id);

CREATE TABLE sales_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description TEXT,
  hsn_sac TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('GOODS','SERVICE')),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise INTEGER NOT NULL,
  tax_rate_bps INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL,
  cost_paise INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_sii_product ON sales_invoice_items(product_id);

-- ───────────────────────── Purchase ─────────────────────────
CREATE TABLE purchase_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL,
  invoice_no TEXT NOT NULL,                 -- our internal voucher number
  invoice_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_invoice_no TEXT NOT NULL,
  supplier_invoice_date TEXT NOT NULL,
  supplier_gstin TEXT,
  place_of_supply TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE RESTRICT,
  is_inter_state INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  taxable_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  grand_total_paise INTEGER NOT NULL DEFAULT 0 CHECK (grand_total_paise >= 0),
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at TEXT, posted_by INTEGER REFERENCES users(id),
  cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, financial_year, invoice_no),
  UNIQUE (company_id, supplier_id, supplier_invoice_no)
);
CREATE INDEX idx_pi_company_date ON purchase_invoices(company_id, invoice_date);
CREATE INDEX idx_pi_supplier ON purchase_invoices(supplier_id);

CREATE TABLE purchase_invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  description TEXT,
  hsn_sac TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('GOODS','SERVICE')),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise INTEGER NOT NULL,
  tax_rate_bps INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_pii_product ON purchase_invoice_items(product_id);

-- ───────────────────────── Inventory ─────────────────────────
CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  movement_date TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('OPENING','PURCHASE','SALE','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER_IN','TRANSFER_OUT','SALE_REVERSAL','PURCHASE_REVERSAL')),
  qty_in_milli INTEGER NOT NULL DEFAULT 0 CHECK (qty_in_milli >= 0),
  qty_out_milli INTEGER NOT NULL DEFAULT 0 CHECK (qty_out_milli >= 0),
  unit_cost_paise INTEGER NOT NULL DEFAULT 0,
  value_paise INTEGER NOT NULL DEFAULT 0,
  balance_qty_milli INTEGER NOT NULL,
  reference_type TEXT,
  reference_id INTEGER,
  reference_no TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((qty_in_milli = 0) <> (qty_out_milli = 0))
);
CREATE INDEX idx_sm_product_wh_date ON stock_movements(product_id, warehouse_id, movement_date);
CREATE INDEX idx_sm_reference ON stock_movements(reference_type, reference_id);
CREATE INDEX idx_sm_company_date ON stock_movements(company_id, movement_date);

CREATE TABLE stock_balances (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  qty_milli INTEGER NOT NULL DEFAULT 0,
  value_paise INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (product_id, warehouse_id)
);
CREATE INDEX idx_sb_company ON stock_balances(company_id);

-- ───────────────────────── Receipts & payments ─────────────────────────
CREATE TABLE payment_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL,
  receipt_no TEXT NOT NULL,
  receipt_date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  mode TEXT NOT NULL CHECK (mode IN ('CASH','BANK_TRANSFER','UPI','CHEQUE','CARD')),
  deposit_account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  reference_no TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, financial_year, receipt_no)
);
CREATE INDEX idx_pr_customer ON payment_receipts(customer_id);
CREATE INDEX idx_pr_company_date ON payment_receipts(company_id, receipt_date);

CREATE TABLE payment_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  financial_year TEXT NOT NULL,
  voucher_no TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  mode TEXT NOT NULL CHECK (mode IN ('CASH','BANK_TRANSFER','UPI','CHEQUE','CARD')),
  paid_from_account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  reference_no TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','CANCELLED')),
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, financial_year, voucher_no)
);
CREATE INDEX idx_pv_supplier ON payment_vouchers(supplier_id);
CREATE INDEX idx_pv_company_date ON payment_vouchers(company_id, voucher_date);

-- ───────────────────────── Compliance ─────────────────────────
CREATE TABLE ewaybill_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,                  -- 'DEMO' or a live provider id
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  ewb_no TEXT,
  ewb_date TEXT,
  valid_upto TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PART_A_ONLY','CANCELLED','EXPIRED')),
  document_type TEXT NOT NULL,
  document_no TEXT NOT NULL,
  document_date TEXT NOT NULL,
  sales_invoice_id INTEGER REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  supply_type TEXT NOT NULL, sub_supply_type TEXT NOT NULL, transaction_type TEXT NOT NULL,
  from_gstin TEXT, from_name TEXT NOT NULL, from_address TEXT NOT NULL, from_state_code TEXT NOT NULL, from_pincode TEXT,
  to_gstin TEXT, to_name TEXT NOT NULL, to_address TEXT NOT NULL, to_state_code TEXT NOT NULL, to_pincode TEXT,
  taxable_paise INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0, sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0, cess_paise INTEGER NOT NULL DEFAULT 0,
  total_value_paise INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  transport_mode TEXT NOT NULL CHECK (transport_mode IN ('ROAD','RAIL','AIR','SHIP')),
  transporter_id INTEGER REFERENCES transporters(id) ON DELETE RESTRICT,
  transport_doc_no TEXT, transport_doc_date TEXT,
  vehicle_no TEXT,
  vehicle_type TEXT NOT NULL DEFAULT 'REGULAR' CHECK (vehicle_type IN ('REGULAR','ODC')),
  distance_km INTEGER NOT NULL CHECK (distance_km BETWEEN 1 AND 4000),
  part_b_updated_at TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  cancel_reason TEXT, cancel_remarks TEXT, cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE UNIQUE INDEX ux_ewb_provider_no ON ewaybill_records(provider, ewb_no) WHERE ewb_no IS NOT NULL;
CREATE INDEX idx_ewb_company ON ewaybill_records(company_id, created_at);
CREATE INDEX idx_ewb_invoice ON ewaybill_records(sales_invoice_id);

CREATE TABLE einvoice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  sales_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1,
  irn TEXT,
  ack_no TEXT,
  ack_date TEXT,
  signed_qr TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','GENERATED','CANCELLED','FAILED')),
  error_message TEXT,
  cancelled_at TEXT, cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE INDEX idx_einv_invoice ON einvoice_records(sales_invoice_id);
CREATE UNIQUE INDEX ux_einv_irn ON einvoice_records(irn) WHERE irn IS NOT NULL;

-- ───────────────────────── System ─────────────────────────
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_company_date ON audit_logs(company_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE application_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE UNIQUE INDEX ux_settings_scope_key ON application_settings(IFNULL(company_id, 0), key);

-- ───────────────────────── Integrity triggers ─────────────────────────
-- Audit log is append-only.
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit log entries are immutable'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit log entries cannot be deleted'); END;

-- Ledger lines are immutable; journal headers may only move POSTED -> REVERSED.
CREATE TRIGGER trg_jel_no_update BEFORE UPDATE ON journal_entry_lines
BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be modified; post a reversal'); END;
CREATE TRIGGER trg_jel_no_delete BEFORE DELETE ON journal_entry_lines
BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be deleted; post a reversal'); END;
CREATE TRIGGER trg_je_no_delete BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'Journal entries cannot be deleted; post a reversal'); END;
CREATE TRIGGER trg_je_update_guard BEFORE UPDATE ON journal_entries
WHEN NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
          AND NEW.total_debit_paise = OLD.total_debit_paise AND NEW.total_credit_paise = OLD.total_credit_paise
          AND NEW.entry_date = OLD.entry_date AND NEW.entry_no = OLD.entry_no AND NEW.company_id = OLD.company_id)
BEGIN SELECT RAISE(ABORT, 'Journal entries cannot be edited; post a reversal'); END;

-- Stock movements are immutable.
CREATE TRIGGER trg_sm_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'Stock movements cannot be modified; post an adjustment'); END;
CREATE TRIGGER trg_sm_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'Stock movements cannot be deleted; post an adjustment'); END;

-- Posted sales invoices: only POSTED -> CANCELLED (via reversal) is allowed.
CREATE TRIGGER trg_si_update_guard BEFORE UPDATE ON sales_invoices
WHEN OLD.status <> 'DRAFT' AND NOT (
  OLD.status = 'POSTED' AND NEW.status = 'CANCELLED'
  AND NEW.grand_total_paise = OLD.grand_total_paise AND NEW.invoice_no = OLD.invoice_no
  AND NEW.invoice_date = OLD.invoice_date AND NEW.customer_id = OLD.customer_id
  AND NEW.taxable_paise = OLD.taxable_paise AND NEW.financial_year = OLD.financial_year
  AND NEW.reversal_journal_entry_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Posted sales invoices cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_si_no_delete BEFORE DELETE ON sales_invoices WHEN OLD.status <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Posted sales invoices cannot be deleted'); END;
CREATE TRIGGER trg_sii_ins_guard BEFORE INSERT ON sales_invoice_items
WHEN (SELECT status FROM sales_invoices WHERE id = NEW.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot add lines to a posted sales invoice'); END;
CREATE TRIGGER trg_sii_upd_guard BEFORE UPDATE ON sales_invoice_items
WHEN (SELECT status FROM sales_invoices WHERE id = OLD.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot modify lines of a posted sales invoice'); END;
CREATE TRIGGER trg_sii_del_guard BEFORE DELETE ON sales_invoice_items
WHEN (SELECT status FROM sales_invoices WHERE id = OLD.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot delete lines of a posted sales invoice'); END;

-- Posted purchase invoices: same rules.
CREATE TRIGGER trg_pi_update_guard BEFORE UPDATE ON purchase_invoices
WHEN OLD.status <> 'DRAFT' AND NOT (
  OLD.status = 'POSTED' AND NEW.status = 'CANCELLED'
  AND NEW.grand_total_paise = OLD.grand_total_paise AND NEW.invoice_no = OLD.invoice_no
  AND NEW.invoice_date = OLD.invoice_date AND NEW.supplier_id = OLD.supplier_id
  AND NEW.taxable_paise = OLD.taxable_paise AND NEW.financial_year = OLD.financial_year
  AND NEW.reversal_journal_entry_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Posted purchase invoices cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_pi_no_delete BEFORE DELETE ON purchase_invoices WHEN OLD.status <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Posted purchase invoices cannot be deleted'); END;
CREATE TRIGGER trg_pii_ins_guard BEFORE INSERT ON purchase_invoice_items
WHEN (SELECT status FROM purchase_invoices WHERE id = NEW.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot add lines to a posted purchase invoice'); END;
CREATE TRIGGER trg_pii_upd_guard BEFORE UPDATE ON purchase_invoice_items
WHEN (SELECT status FROM purchase_invoices WHERE id = OLD.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot modify lines of a posted purchase invoice'); END;
CREATE TRIGGER trg_pii_del_guard BEFORE DELETE ON purchase_invoice_items
WHEN (SELECT status FROM purchase_invoices WHERE id = OLD.invoice_id) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'Cannot delete lines of a posted purchase invoice'); END;

-- Receipts / payments: amounts and parties are fixed once posted.
CREATE TRIGGER trg_pr_update_guard BEFORE UPDATE ON payment_receipts
WHEN NEW.amount_paise <> OLD.amount_paise OR NEW.customer_id <> OLD.customer_id OR NEW.receipt_date <> OLD.receipt_date OR NEW.receipt_no <> OLD.receipt_no
BEGIN SELECT RAISE(ABORT, 'Posted receipts cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_pr_no_delete BEFORE DELETE ON payment_receipts
BEGIN SELECT RAISE(ABORT, 'Receipts cannot be deleted'); END;
CREATE TRIGGER trg_pv_update_guard BEFORE UPDATE ON payment_vouchers
WHEN NEW.amount_paise <> OLD.amount_paise OR NEW.supplier_id <> OLD.supplier_id OR NEW.voucher_date <> OLD.voucher_date OR NEW.voucher_no <> OLD.voucher_no
BEGIN SELECT RAISE(ABORT, 'Posted payments cannot be edited; cancel with a reversal'); END;
CREATE TRIGGER trg_pv_no_delete BEFORE DELETE ON payment_vouchers
BEGIN SELECT RAISE(ABORT, 'Payments cannot be deleted'); END;
`
}
