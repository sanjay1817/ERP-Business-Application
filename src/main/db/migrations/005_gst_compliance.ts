import type { Migration } from '../migrator'

/**
 * Phase 4 — GST, e-invoice and e-way bill.
 *
 * Additive only: no posted document, journal or stock row is changed.
 *  - GST registrations (per company / branch), company GST settings and effective-dated compliance rules.
 *  - HSN/SAC master with effective-dated rate rules (tax category, cess, reverse charge).
 *  - Effective dates on the tax-rate master.
 *  - ITC classification of purchase documents, kept beside the immutable documents (never assumed eligible).
 *  - GST return preparations (prepared / exported — never "filed").
 *  - GST reconciliation (supplier statement / 2B-style CSV import).
 *  - Integration settings, encrypted credentials and an append-only API request log.
 *  - E-invoices (replaces the unused Phase 1 einvoice_records placeholder, whose rows are copied).
 *  - E-way bill source documents (invoice or delivery challan), transport masters and documents.
 */
const TS = `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * Default compliance rules (company_id NULL = default for every company; a company row overrides it).
 * Values come from public guidance current at the time of writing and MUST be verified against the
 * latest CBIC notifications / GSTN advisories by the user; they are editable in GST → Configuration.
 */
export const DEFAULT_RULES: ReadonlyArray<[key: string, value: number, from: string, to: string | null, description: string, source: string]> = [
  ['B2CL_INVOICE_THRESHOLD_PAISE', 25000000, '2017-07-01', '2024-07-31', 'Inter-state invoice value to unregistered persons reported invoice-wise (B2C Large)', 'Earlier ₹2,50,000 limit'],
  ['B2CL_INVOICE_THRESHOLD_PAISE', 10000000, '2024-08-01', null, 'Inter-state invoice value to unregistered persons reported invoice-wise (B2C Large)', 'Notification 12/2024-CT (verify effective date and portal implementation)'],
  ['EINVOICE_AATO_THRESHOLD_PAISE', 10000000000, '2017-07-01', '2023-07-31', 'Aggregate annual turnover from which e-invoicing applies', 'Simplified for earlier periods: e-invoicing was phased in from Oct 2020 at higher limits (verify)'],
  ['EINVOICE_AATO_THRESHOLD_PAISE', 5000000000, '2023-08-01', null, 'Aggregate annual turnover from which e-invoicing applies', 'Notification 10/2023-CT (verify)'],
  ['EINVOICE_REPORTING_LIMIT_DAYS', 30, '2017-07-01', null, 'Days within which a document must be reported to the IRP (applies above the next threshold)', 'GSTN advisory (verify)'],
  ['EINVOICE_REPORTING_LIMIT_AATO_PAISE', 9999999999999, '2017-07-01', '2023-10-31', 'AATO from which the reporting time limit applies', 'No reporting time limit before Nov 2023'],
  ['EINVOICE_REPORTING_LIMIT_AATO_PAISE', 100000000000, '2023-11-01', '2025-03-31', 'AATO from which the reporting time limit applies', 'GSTN advisory: Rs 100 crore and above (verify)'],
  ['EINVOICE_REPORTING_LIMIT_AATO_PAISE', 10000000000, '2025-04-01', null, 'AATO from which the reporting time limit applies', 'GSTN advisory: Rs 10 crore and above (verify)'],
  ['IRN_CANCEL_WINDOW_HOURS', 24, '2017-07-01', null, 'Hours after IRN generation within which it may be cancelled on the IRP', 'IRP guidance (verify)'],
  ['EWB_CONSIGNMENT_THRESHOLD_PAISE', 5000000, '2017-07-01', null, 'Consignment value above which an e-way bill is generally required (states may notify different intra-state limits)', 'CGST Rule 138 (verify state limits)'],
  ['EWB_KM_PER_DAY_REGULAR', 100, '2017-07-01', '2020-12-31', 'Validity: one day per this many km (regular cargo)', 'CGST Rule 138(10) (earlier text)'],
  ['EWB_KM_PER_DAY_REGULAR', 200, '2021-01-01', null, 'Validity: one day per this many km (regular cargo)', 'CGST Rule 138(10) as amended (verify)'],
  ['EWB_KM_PER_DAY_ODC', 20, '2017-07-01', null, 'Validity: one day per this many km (over-dimensional cargo)', 'CGST Rule 138(10) (verify)'],
  ['EWB_CANCEL_WINDOW_HOURS', 24, '2017-07-01', null, 'Hours after generation within which an e-way bill may be cancelled', 'CGST Rule 138(9) (verify)'],
  ['EWB_EXTENSION_WINDOW_HOURS', 8, '2017-07-01', null, 'Validity may be extended within this many hours before or after expiry', 'CGST Rule 138(10) proviso (verify)'],
  ['EWB_MAX_DISTANCE_KM', 4000, '2017-07-01', null, 'Maximum approximate distance accepted for an e-way bill', 'E-way bill portal limit (verify)'],
  ['HSN_MIN_DIGITS_SMALL', 2, '2017-07-01', '2021-03-31', 'Minimum HSN digits when AATO is up to the threshold below', 'Earlier requirement (simplified; verify)'],
  ['HSN_MIN_DIGITS_SMALL', 4, '2021-04-01', null, 'Minimum HSN digits when AATO is up to the threshold below', 'Notification 78/2020-CT (verify)'],
  ['HSN_MIN_DIGITS_LARGE', 4, '2017-07-01', '2021-03-31', 'Minimum HSN digits when AATO exceeds the threshold below', 'Earlier requirement (simplified; verify)'],
  ['HSN_MIN_DIGITS_LARGE', 6, '2021-04-01', null, 'Minimum HSN digits when AATO exceeds the threshold below', 'Notification 78/2020-CT (verify)'],
  ['HSN_LARGE_AATO_PAISE', 5000000000, '2017-07-01', null, 'AATO above which the larger HSN digit requirement applies', 'Notification 78/2020-CT (verify)'],
  ['GST_RECON_TOLERANCE_PAISE', 100, '2017-07-01', null, 'Amount difference treated as a match in GST reconciliation (internal policy)', 'Company policy']
]

const rulesSql = DEFAULT_RULES.map(
  ([key, value, from, to, desc, src]) =>
    `INSERT INTO compliance_rules (company_id, rule_key, value_num, effective_from, effective_to, description, source_note) VALUES (NULL, ${q(key)}, ${value}, ${q(from)}, ${to ? q(to) : 'NULL'}, ${q(desc)}, ${q(src)});`
).join('\n')

const PERMS: ReadonlyArray<[code: string, module: string, desc: string, roles: string[]]> = [
  ['gst.manage', 'GST', 'Configure GST, classify ITC, prepare returns and reconcile', ['ADMIN', 'ACCOUNTANT']],
  ['einvoice.view', 'E-Invoice', 'View e-invoices', ['ADMIN', 'ACCOUNTANT', 'AUDITOR', 'SALES']],
  ['einvoice.manage', 'E-Invoice', 'Generate and cancel e-invoices', ['ADMIN', 'ACCOUNTANT']],
  ['integration.manage', 'Settings', 'Configure government integrations and credentials', ['ADMIN']]
]
const permsSql = PERMS.map(
  ([code, module, desc, roles]) =>
    `INSERT INTO permissions (code, module, description) VALUES (${q(code)}, ${q(module)}, ${q(desc)});
     INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ${q(code)} WHERE r.code IN (${roles.map(q).join(',')});`
).join('\n')

export const TAX_CATEGORIES = ['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST', 'ZERO_RATED'] as const
const cats = TAX_CATEGORIES.map(q).join(',')

export const migration005: Migration = {
  version: 5,
  name: 'gst_compliance',
  sql: `
-- ───────── GST registrations & settings ─────────
CREATE TABLE gst_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id INTEGER REFERENCES branches(id) ON DELETE RESTRICT,
  gstin TEXT NOT NULL,
  registration_type TEXT NOT NULL DEFAULT 'REGULAR' CHECK (registration_type IN ('REGULAR','COMPOSITION','SEZ_UNIT','SEZ_DEVELOPER','CASUAL','ISD')),
  state_code TEXT NOT NULL,
  legal_name TEXT, trade_name TEXT,
  address TEXT, pincode TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  ${TS},
  UNIQUE (company_id, gstin),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX ux_gstreg_primary ON gst_registrations(company_id) WHERE is_primary = 1;
INSERT INTO gst_registrations (company_id, branch_id, gstin, state_code, legal_name, trade_name, address, pincode, effective_from, is_primary)
  SELECT c.id, (SELECT b.id FROM branches b WHERE b.company_id = c.id AND b.is_head_office = 1 LIMIT 1), c.gstin, c.state_code, c.legal_name, c.name,
         TRIM(COALESCE(c.address_line1,'') || ' ' || COALESCE(c.city,'')), c.pincode, '2017-07-01', 1
  FROM companies c WHERE c.gstin IS NOT NULL AND c.gstin <> '';

CREATE TABLE gst_company_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT,
  aato_paise INTEGER CHECK (aato_paise IS NULL OR aato_paise >= 0),
  aato_fy TEXT,
  einvoice_enabled INTEGER NOT NULL DEFAULT 0 CHECK (einvoice_enabled IN (0,1)),
  einvoice_exempt_reason TEXT,
  return_frequency TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (return_frequency IN ('MONTHLY','QUARTERLY')),
  lut_number TEXT, lut_valid_from TEXT, lut_valid_upto TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE compliance_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  rule_key TEXT NOT NULL,
  value_num INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  description TEXT NOT NULL,
  source_note TEXT,
  updated_by INTEGER REFERENCES users(id),
  ${TS},
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_rules_key ON compliance_rules(rule_key, company_id, effective_from);
${rulesSql}

-- ───────── Tax-rate master: effective dates ─────────
ALTER TABLE tax_rates ADD COLUMN effective_from TEXT;
ALTER TABLE tax_rates ADD COLUMN effective_to TEXT;

-- ───────── HSN / SAC master with effective-dated rates ─────────
CREATE TABLE hsn_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('GOODS','SERVICE')),
  default_uqc TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  ${TS},
  UNIQUE (company_id, code)
);
CREATE TABLE hsn_rate_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  hsn_code TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  tax_category TEXT NOT NULL DEFAULT 'TAXABLE' CHECK (tax_category IN (${cats})),
  rate_bps INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  cess_bps INTEGER NOT NULL DEFAULT 0 CHECK (cess_bps >= 0),
  reverse_charge INTEGER NOT NULL DEFAULT 0 CHECK (reverse_charge IN (0,1)),
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'USER' CHECK (source IN ('USER','PRODUCT_MASTER')),
  updated_by INTEGER REFERENCES users(id),
  ${TS},
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_hsnrate_lookup ON hsn_rate_rules(company_id, hsn_code, effective_from);
-- Backfill from each company's own product master (to be verified by the user; marked PRODUCT_MASTER).
INSERT INTO hsn_codes (company_id, code, description, kind, default_uqc)
  SELECT p.company_id, p.hsn_sac, MIN(p.name), MIN(p.item_type), MIN(u.code)
  FROM products p JOIN units u ON u.id = p.unit_id GROUP BY p.company_id, p.hsn_sac;
INSERT INTO hsn_rate_rules (company_id, hsn_code, effective_from, tax_category, rate_bps, source, notes)
  SELECT p.company_id, p.hsn_sac, '2017-07-01', CASE WHEN MAX(t.rate_bps) = 0 THEN 'NIL_RATED' ELSE 'TAXABLE' END, MAX(t.rate_bps), 'PRODUCT_MASTER',
         'Copied from the product master during upgrade; verify against the current rate notification'
  FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id GROUP BY p.company_id, p.hsn_sac;

-- ───────── ITC classification (beside the immutable purchase documents) ─────────
CREATE TABLE purchase_itc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('PURCHASE_INVOICE','PURCHASE_RETURN','DEBIT_NOTE')),
  document_id INTEGER NOT NULL,
  eligibility TEXT NOT NULL CHECK (eligibility IN ('PENDING','ELIGIBLE','INELIGIBLE','BLOCKED')),
  itc_type TEXT NOT NULL DEFAULT 'INPUTS' CHECK (itc_type IN ('INPUTS','CAPITAL_GOODS','INPUT_SERVICES')),
  reverse_charge INTEGER NOT NULL DEFAULT 0 CHECK (reverse_charge IN (0,1)),
  reason TEXT,
  classified_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (document_kind, document_id)
);
CREATE INDEX idx_itc_company ON purchase_itc(company_id, eligibility);

-- ───────── Return preparations (prepared / exported only; filing happens on the GST portal) ─────────
CREATE TABLE gst_return_preparations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  return_type TEXT NOT NULL CHECK (return_type IN ('GSTR1','GSTR3B')),
  period TEXT NOT NULL,
  gstin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','EXPORTED')),
  summary_json TEXT NOT NULL,
  validation_errors INTEGER NOT NULL DEFAULT 0,
  validation_warnings INTEGER NOT NULL DEFAULT 0,
  source_hash TEXT NOT NULL,
  prepared_by INTEGER REFERENCES users(id),
  prepared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  exported_at TEXT, exported_by INTEGER REFERENCES users(id), export_format TEXT
);
CREATE INDEX idx_gstprep ON gst_return_preparations(company_id, return_type, period);
CREATE TRIGGER trg_gstprep_no_delete BEFORE DELETE ON gst_return_preparations
BEGIN SELECT RAISE(ABORT, 'Return preparations are kept for audit and cannot be deleted'); END;
CREATE TRIGGER trg_gstprep_update_guard BEFORE UPDATE ON gst_return_preparations
WHEN NEW.summary_json <> OLD.summary_json OR NEW.source_hash <> OLD.source_hash OR NEW.period <> OLD.period OR NEW.return_type <> OLD.return_type
BEGIN SELECT RAISE(ABORT, 'A prepared return is a frozen snapshot; prepare it again instead'); END;

-- ───────── GST reconciliation ─────────
CREATE TABLE gst_recon_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('SUPPLIER_STATEMENT','GSTR2B_CSV','OTHER')),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE TABLE gst_recon_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES gst_recon_batches(id) ON DELETE RESTRICT,
  row_no INTEGER NOT NULL,
  supplier_gstin TEXT,
  supplier_name TEXT,
  invoice_no TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'INVOICE' CHECK (document_type IN ('INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
  taxable_paise INTEGER NOT NULL,
  igst_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  cess_paise INTEGER NOT NULL DEFAULT 0,
  match_status TEXT NOT NULL DEFAULT 'UNMATCHED',
  matched_kind TEXT,
  matched_id INTEGER,
  diff_taxable_paise INTEGER NOT NULL DEFAULT 0,
  diff_tax_paise INTEGER NOT NULL DEFAULT 0,
  match_note TEXT,
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','ACCEPTED','REJECTED','ON_HOLD')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  UNIQUE (batch_id, row_no)
);
CREATE INDEX idx_reconl_batch ON gst_recon_lines(batch_id, match_status);

-- ───────── Integrations: settings, encrypted credentials, API log ─────────
CREATE TABLE integration_settings (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  service TEXT NOT NULL CHECK (service IN ('EINVOICE','EWAYBILL','GST_RETURNS')),
  mode TEXT NOT NULL DEFAULT 'DEMO' CHECK (mode IN ('DEMO','SANDBOX','LIVE')),
  provider_name TEXT,
  api_base_url TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  max_retries INTEGER NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, service)
);
CREATE TABLE integration_credentials (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  service TEXT NOT NULL CHECK (service IN ('EINVOICE','EWAYBILL','GST_RETURNS')),
  environment TEXT NOT NULL CHECK (environment IN ('SANDBOX','LIVE')),
  secret_blob BLOB NOT NULL,
  username_hint TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company_id, service, environment)
);
CREATE TABLE api_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
  service TEXT NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  request_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILED')),
  error_class TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  request_summary TEXT,
  response_ref TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_apireq_entity ON api_requests(entity_type, entity_id);
CREATE INDEX idx_apireq_key ON api_requests(request_key);
CREATE INDEX idx_apireq_company ON api_requests(company_id, created_at);
CREATE TRIGGER trg_apireq_no_update BEFORE UPDATE ON api_requests
BEGIN SELECT RAISE(ABORT, 'API request history is append-only'); END;
CREATE TRIGGER trg_apireq_no_delete BEFORE DELETE ON api_requests
BEGIN SELECT RAISE(ABORT, 'API request history is append-only'); END;

-- ───────── E-invoices ─────────
CREATE TABLE einvoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_kind TEXT NOT NULL CHECK (document_kind IN ('SALES_INVOICE','CREDIT_NOTE','SALES_RETURN')),
  document_id INTEGER NOT NULL,
  document_no TEXT NOT NULL,
  document_date TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('INV','CRN','DBN')),
  supply_type TEXT NOT NULL,
  seller_gstin TEXT NOT NULL,
  buyer_gstin TEXT,
  total_value_paise INTEGER NOT NULL,
  provider TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DEMO','SANDBOX','LIVE')),
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('PENDING','GENERATED','FAILED','CANCELLED')),
  request_key TEXT NOT NULL,
  irn TEXT,
  ack_no TEXT,
  ack_date TEXT,
  signed_invoice TEXT,
  signed_qr TEXT,
  response_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  cancel_reason_code INTEGER, cancel_remarks TEXT, cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id),
  created_by INTEGER REFERENCES users(id),
  ${TS}
);
CREATE UNIQUE INDEX ux_einv_live_doc ON einvoices(company_id, document_kind, document_id) WHERE status IN ('PENDING','GENERATED');
CREATE UNIQUE INDEX ux_einv_irn_v2 ON einvoices(provider, irn) WHERE irn IS NOT NULL;
CREATE UNIQUE INDEX ux_einv_request ON einvoices(company_id, request_key);
CREATE INDEX idx_einv_doc ON einvoices(document_kind, document_id);
CREATE TRIGGER trg_einv_no_delete BEFORE DELETE ON einvoices
BEGIN SELECT RAISE(ABORT, 'E-invoice records cannot be deleted'); END;
CREATE TRIGGER trg_einv_irn_guard BEFORE UPDATE ON einvoices
WHEN OLD.irn IS NOT NULL AND (NEW.irn IS NOT OLD.irn OR NEW.ack_no IS NOT OLD.ack_no OR NEW.document_id <> OLD.document_id)
BEGIN SELECT RAISE(ABORT, 'A registered IRN cannot be changed'); END;
-- Rows of the unused Phase 1 placeholder (if any) are carried over unchanged in meaning.
INSERT INTO einvoices (company_id, document_kind, document_id, document_no, document_date, document_type, supply_type, seller_gstin, buyer_gstin, total_value_paise,
                       provider, environment, is_demo, status, request_key, irn, ack_no, ack_date, signed_qr, error_message, cancelled_at, cancel_remarks, created_by, created_at)
  SELECT e.company_id, 'SALES_INVOICE', e.sales_invoice_id, si.invoice_no, si.invoice_date, 'INV', 'B2B', COALESCE(c.gstin, ''), si.customer_gstin, si.grand_total_paise,
         e.provider, CASE WHEN e.is_demo = 1 THEN 'DEMO' ELSE 'LIVE' END, e.is_demo, e.status, 'legacy-' || e.id, e.irn, e.ack_no, e.ack_date, e.signed_qr, e.error_message,
         e.cancelled_at, e.cancel_reason, e.created_by, e.created_at
  FROM einvoice_records e JOIN sales_invoices si ON si.id = e.sales_invoice_id JOIN companies c ON c.id = e.company_id;

-- ───────── Transport masters ─────────
ALTER TABLE transporters ADD COLUMN contact_person TEXT;
ALTER TABLE transporters ADD COLUMN address TEXT;
ALTER TABLE transporters ADD COLUMN state_code TEXT;
ALTER TABLE transporters ADD COLUMN email TEXT;
ALTER TABLE transporters ADD COLUMN modes TEXT NOT NULL DEFAULT 'ROAD';
ALTER TABLE transporters ADD COLUMN updated_by INTEGER REFERENCES users(id);

CREATE TABLE vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  vehicle_no TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'REGULAR' CHECK (vehicle_type IN ('REGULAR','ODC')),
  body_type TEXT NOT NULL DEFAULT 'TRUCK' CHECK (body_type IN ('TRUCK','TEMPO','VAN','CONTAINER','TRAILER','PICKUP','OTHER')),
  transporter_id INTEGER REFERENCES transporters(id) ON DELETE RESTRICT,
  capacity_kg INTEGER CHECK (capacity_kg IS NULL OR capacity_kg > 0),
  is_own INTEGER NOT NULL DEFAULT 0 CHECK (is_own IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  ${TS},
  UNIQUE (company_id, vehicle_no)
);

CREATE TABLE transport_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  transport_mode TEXT NOT NULL CHECK (transport_mode IN ('ROAD','RAIL','AIR','SHIP')),
  doc_no TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  transporter_id INTEGER REFERENCES transporters(id) ON DELETE RESTRICT,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE RESTRICT,
  source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('SALES_INVOICE','DELIVERY_CHALLAN')),
  source_id INTEGER,
  from_place TEXT, to_place TEXT,
  distance_km INTEGER CHECK (distance_km IS NULL OR distance_km BETWEEN 1 AND 4000),
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  ${TS},
  UNIQUE (company_id, transporter_id, doc_no)
);
CREATE INDEX idx_tdoc_source ON transport_documents(source_kind, source_id);

-- ───────── E-way bill: source documents, masters, idempotency ─────────
ALTER TABLE ewaybill_records ADD COLUMN source_kind TEXT;
ALTER TABLE ewaybill_records ADD COLUMN source_id INTEGER;
ALTER TABLE ewaybill_records ADD COLUMN vehicle_id INTEGER REFERENCES vehicles(id);
ALTER TABLE ewaybill_records ADD COLUMN transport_document_id INTEGER REFERENCES transport_documents(id);
ALTER TABLE ewaybill_records ADD COLUMN request_key TEXT;
ALTER TABLE ewaybill_records ADD COLUMN environment TEXT NOT NULL DEFAULT 'DEMO';
ALTER TABLE ewaybill_records ADD COLUMN extension_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ewaybill_records ADD COLUMN last_status_check_at TEXT;
ALTER TABLE ewaybill_records ADD COLUMN provider_status TEXT;
UPDATE ewaybill_records SET source_kind = 'SALES_INVOICE', source_id = sales_invoice_id WHERE sales_invoice_id IS NOT NULL AND source_kind IS NULL;
UPDATE ewaybill_records SET environment = CASE WHEN is_demo = 1 THEN 'DEMO' ELSE 'LIVE' END;
CREATE UNIQUE INDEX ux_ewb_request ON ewaybill_records(company_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX idx_ewb_source ON ewaybill_records(source_kind, source_id);

-- ───────── Permissions ─────────
${permsSql}
`
}
