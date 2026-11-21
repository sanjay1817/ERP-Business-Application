# SA Business ERP — Enterprise Management

Windows desktop ERP (Windows 10/11, 64-bit) built with Electron, React, TypeScript, Vite, Tailwind CSS and SQLite.

## Quick start

```bash
npm install          # Node.js 22+ required; no C++ toolchain needed (SQLite ships N-API prebuilds)
npm run dev          # development with hot reload
npm start            # production build + run
npm test             # unit/integration tests (+ Electron boot test if `out/` is built)
npm run test:all     # typecheck → build → all tests (recommended before a demo)
npm run dist:win     # Windows NSIS installer in release/<version>/
```

On first launch the app asks whether to **set up your company** (a new company database with an administrator you choose) or **explore the demo**: a separate DEMO database at `%APPDATA%\SA Business ERP\data\sa-business-erp.db` with a clearly labelled DEMO company.

| Demo user  | Password       | Role                 |
|------------|----------------|----------------------|
| `admin`    | `Admin@123`    | Administrator        |
| `accounts` | `Accounts@123` | Accountant           |
| `auditor`  | `Auditor@123`  | Auditor (read-only)  |

These work only in the DEMO database. See [docs/DEMO-SETUP.md](docs/DEMO-SETUP.md) to reset the demo.

## Architecture

```
src/
  shared/      Zod schemas, IPC contract & channel allow-list, decimal-safe money, GST helpers
  main/        Electron main process
    db/        connection, versioned migrator, migrations/, seed/ (DEMO company)
    services/  business logic: masters, posting engine, ledger, inventory, auth, audit, reports, ewaybill/
    ipc/       router (sender → Zod → auth → permission → handler) and route table
    security.ts, logger.ts, index.ts
  preload/     sandboxed bridge exposing only window.erp.invoke(channel, input)
  renderer/    React UI (layouts, components, pages)
tests/         Vitest suites (database, migrations, business rules, IPC security, masters, startup)
```

### Data rules
- Money is INTEGER paise, quantity INTEGER milli-units, tax rates INTEGER basis points. There is no floating-point arithmetic.
- Every posting runs in one SQLite transaction: number allocation, document and lines, stock movements and balances (goods only), a balanced journal, and an audit log.
- Perpetual inventory at moving-average cost: the Stock-in-Hand ledger always equals the stock valuation.
- Database triggers block edits and deletes of posted invoices, invoice lines, journal lines, stock movements and audit logs. Corrections use reversals.
- Document numbers are unique per company and financial year (`INV/2026-27/0001`). Supplier bill numbers are unique per supplier.

### Security
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, and no webviews, pop-ups, navigation or device permissions.
- The preload exposes one function, which only accepts allow-listed channels.
- The main process validates every request in this order: sender URL, Zod schema (strict), session, then role permission. Errors are returned as typed envelopes; SQL and stack traces never reach the UI.
- Passwords are hashed with scrypt, and accounts lock after 5 failed sign-ins. Logs are JSON lines with secrets redacted and rotate at 5 MB.

### Sales & purchase documents (Phase 2)
- One configuration drives 12 document kinds: quotation, sales order, delivery challan, sales invoice, sales return, credit note, purchase requisition, purchase order, goods receipt note (GRN), purchase invoice, purchase return and debit note.
- The lifecycle is **draft → validate → post → cancel by reversal**. Drafts are numbered `DRAFT-n` and have no stock or ledger effect. The legal number (e.g. `INV/2026-27/0001`) is assigned when the document is posted, so posted numbers have no gaps.
- Each conversion records its source document. Stock moves only once: a challan or GRN moves the stock, and the invoice made from it does not.
- Returns are valued at the original cost. Freight on stocked goods is capitalised pro rata into their stock cost. GRN-matched bills clear *Goods Received Not Invoiced* and book any price difference to *Purchase Price Variance*.
- Receipts and payments post to a chosen cash or bank account and are allocated to invoices. Unallocated amounts stay on account as advances. Invoices show the amount received or paid and the balance due.
- GST is calculated in `src/shared/tax.ts`: line-level tax, discount before tax, exclusive or inclusive pricing, CGST+SGST or IGST from the place of supply (SEZ and export always use IGST), and invoice-level rounding to the rupee. The engine calculates tax only; it does **not** file returns.
- Print, preview and PDF all use the same escaped HTML template. PDFs are rendered by Chromium in a hidden, sandboxed window with JavaScript disabled.
- Real-app check: `npm run build`, then `node scripts/run-electron.cjs npx electron . --e2e-test`. This posts a purchase and a sale through IPC, verifies stock, balances and books, and writes `e2e-sales-invoice.pdf`. The `tests/phase2-e2e.test.ts` test does this automatically.

### Finance, accounting & auditor workspace (Phase 3)
All figures are read from posted journal lines. Drafts never post, and reversed entries stay in the books alongside their reversals.
- **Finance:** dashboard (period KPIs, monthly income vs expenses), general ledger (opening and running balance, drill-down to the journal and source document), trial balance (opening, period and closing debit/credit), profit & loss (gross, operating and net profit), balance sheet (with the equation check), day book, and chart of accounts.
  - Income and expense accounts open at zero each financial year; earlier years' profit appears in retained earnings.
  - Accounts are classified for the statements by `chart_of_accounts.report_group` (migration 004).
- **Vouchers:** journal vouchers (expenses, accruals, adjustments) and contra vouchers (cash ↔ bank), posted through the same balanced-journal engine. They are cancelled only by a reversing entry.
  - Stock in Hand cannot be posted manually, and debtors/creditors lines need a party.
  - Unbalanced attempts are rejected and written to the audit log.
- **Receivables / payables:** party-wise and invoice-wise outstanding, ageing (current, 1–30, 31–60, 61–90, over 90 days) as of any date, advances on account, credit and debit notes, and payment history.
  - Totals are checked against Sundry Debtors / Creditors.
- **Banking:**
  - Cash book and bank book with contra entries.
  - Bank reconciliation: paste a statement as CSV, auto-match or match manually, tick cleared entries, record bank-only charges as new vouchers, and complete (which locks the reconciliation).
  - Matching never changes posted transactions.
- **Duplicate posting prevention:** receipt, payment and voucher forms send a one-time request key, so a resubmitted form returns the first posting. A bank or UTR reference cannot be reused for the same party.
- **Auditor workspace** (`/auditor`, read-only):
  - Integrity checks: trial balance, journals, ledger vs journals, balance sheet equation, receivables and payables vs ledgers, stock vs ledger, drafts, and database integrity.
  - An exception report covering unbalanced attempts, missing sources, duplicate references, unusual manual journals, reversals, cancellations and stock adjustments. Exceptions are for review; they are never labelled as fraud.
  - Also included: a journal inspector, stock movements and the audit trail. Auditors can export reports but cannot post, edit, cancel or reconcile; this is enforced by the server.
- **Reports** (`/reports`): Day Book, Cash Book, Bank Book, General Ledger, Trial Balance, Profit & Loss, Balance Sheet, Receivables, Payables, Stock Valuation, Sales/Purchase Register and GST Summary, plus the Bank Reconciliation Statement.
  - Each one is previewed, printed, exported to PDF (Chromium) or exported to a real `.xlsx` workbook (written without extra dependencies) from the same data.
- Real-app check: `npm run build`, then `node scripts/run-electron.cjs npx electron . --e2e-finance` (run automatically by `tests/phase3-e2e.test.ts`).
- Existing databases upgrade automatically (migration 004 only adds master data and new tables). New Phase 3 demo vouchers and reconciliations appear only in a freshly created demo database.

### GST, e-invoice and e-way bill (Phase 4)
**No government system is connected.** Returns are prepared and exported, never filed. E-invoices and e-way bills come from DEMO providers, and every result is labelled DEMO.
- **GST configuration** (`/gst/config`):
  - Registrations, one per GSTIN, with type, state, branch, effective dates and a primary flag.
  - Turnover (AATO), e-invoice applicability and LUT/bond.
  - HSN/SAC master with **effective-dated rates**: tax category (taxable, nil, exempt, non-GST, zero rated), cess and reverse charge.
  - Effective dates on the tax-rate master.
  - **Compliance rules** with effective dates: B2C Large limit, e-invoice thresholds and 30-day window, IRN and e-way bill cancel windows, km per day, extension window, HSN digits, reconciliation tolerance.
  - Rule defaults come from public guidance and are marked "verify"; company rules override them.
- **Registers** (`/gst/sales`, `/gst/purchases`):
  - Every posted invoice and note is classified (B2B, B2CL, B2CS, EXPWP/EXPWOP, SEZWP/SEZWOP, CDNR, CDNUR), with HSN and rate summaries.
  - Filters: financial year, dates, GSTIN, status and category. Each row opens the original document.
  - Totals are proved against the GST ledger accounts.
- **ITC**: credit counts only after it is classified as eligible. Unregistered suppliers have none unless reverse charge applies. Classification is stored beside the immutable bill.
- **GSTR-1 / GSTR-3B** (`/gst/gstr1`, `/gst/gstr3b`):
  - Live computation; validation errors block preparation.
  - Frozen snapshots are marked out of date when source data changes.
  - Excel and JSON export. The JSON is the ERP's own documented format, **not** the GSTN offline-tool schema.
  - Statuses are `PREPARED` or `EXPORTED` only.
- **Validation** (`/gst/validation`): missing or invalid GSTIN, document-number rules, missing or short HSN, rate vs HSN rule on the document date, intra/inter-state mismatch, tax recomputation, duplicate references, missing LUT, place of supply and PIN code, and ITC pending review.
- **GST reconciliation** (`/gst/reconciliation`):
  - Import a supplier statement or GSTR-2B CSV.
  - Results: matched, value difference, GSTIN differs, probable, not in books, duplicate, and books-only.
  - ITC review status per line. Differences are never labelled as wrongdoing.
- **E-invoice** (`/einvoice`):
  - Eligibility and document validation; IRN request through the provider interface.
  - DEMO IRNs start with `DEMO-`. A real IRN is 64 hexadecimal characters; the DEMO provider never produces a signed QR code.
  - Ack number and date, status check, cancellation within the configured window, print and PDF.
  - Duplicates are prevented by request key, a unique index, a provider status check after timeouts, and resolution of "duplicate" responses.
- **E-way bill** (`/ewaybill`):
  - Sources: sales invoice or delivery challan. Consignor/consignee/GSTIN/PIN checks and Part A preview.
  - Transporter, vehicle and transport document taken from the masters.
  - Operations: Part B update, transporter change, validity extension (configured window), cancellation, status lookup, print.
  - Register with expiry monitoring; applicability is indicative and rule-driven.
- **Transport masters** (`/masters/transport`): transporters (GSTIN/TRANSIN), vehicles and LR/RR/AWB/BL documents, linked to invoices, challans and e-way bills.
- **Integration architecture** (`services/integrations`, `services/einvoice`, `services/ewaybill`):
  - The provider interface has DEMO and placeholder live/sandbox providers. The live/sandbox placeholders send nothing and fail with `NOT_CONFIGURED`.
  - Shared runner: timeouts, error classes, retries for transient errors only, an append-only API log (secrets scrubbed) and idempotency keys.
  - Credentials are encrypted with Windows Data Protection (`safeStorage`) and are never returned or logged.
  - No endpoint URLs or response formats are assumed.
- Real-app check: `npm run build`, then `node scripts/run-electron.cjs npx electron . --e2e-gst` (run automatically by `tests/phase4-e2e.test.ts`).

### Production readiness (Phase 5)
Guides for installers, users and administrators are in [`docs/`](docs/):
- [Installation](docs/INSTALLATION.md)
- [User guide](docs/USER-GUIDE.md)
- [Backup & restore](docs/BACKUP-AND-RESTORE.md)
- [Administrator guide](docs/ADMINISTRATOR-GUIDE.md)
- [Demo setup](docs/DEMO-SETUP.md)
- [Known limitations & production-readiness report](docs/PRODUCTION-READINESS.md)

- **Company and DEMO data are separate database files** (`data\company\sa-business-erp-company.db` and `data\sa-business-erp.db`), chosen through `workspace.json`.
  - Each file records what it is in `database_profile` (migration 006), set once and protected by triggers.
  - First run offers *Set up my company* (the administrator chooses their own password; no demo data) or *Explore the demo*.
  - Installed builds never seed demo data into company books.
- **Users:** create, edit, disable, reset password and unlock. New and reset accounts must change their temporary password; the server enforces this.
  - Published demo passwords are refused, and must be changed if found in company data.
- **Backups** (`services/backup`):
  - SQLite online backup, then verification (integrity, foreign keys, schema), a SHA-256 manifest and an atomic rename.
  - Automatic (interval), before every upgrade, and before every restore. Retention rules. Interrupted backups are cleaned up.
- **Restore:**
  - administrator only, with the phrase `RESTORE` and the user's password;
  - the backup is verified, a safety backup is made, then a journaled file swap with automatic roll-back, then a restart;
  - an interrupted restore is resolved at the next start;
  - a database that fails its startup integrity check is never opened, and the newest verified backup is offered.
- **Packaging:**
  - Electron fuses (no run-as-Node, no `NODE_OPTIONS`/`--inspect`, asar-only with integrity check);
  - remote-debugging switches are refused;
  - Windows x64 SQLite binary only; dev helpers excluded;
  - `--data-dir=<folder>` (refused inside the install folder).
- Dev checks (real app):
  - `--e2e-backup=run|verify`
  - `--e2e-setup=run|verify`
  - `--export-samples=<dir> [--print-to=<printer_name_with_underscores>]`
- Tests:
  - `phase5-backup`, `-ipc`, `-security`, `-reports`, `-scale`, `-interrupt` and `-e2e`;
  - the scale test's size is set with `SA_ERP_SCALE_SALES` / `SA_ERP_SCALE_PURCHASES`.

## Troubleshooting
- **`app` is undefined / Electron starts as Node:** the shell has `ELECTRON_RUN_AS_NODE` set. The npm scripts strip it via `scripts/run-electron.cjs`.
- **Screenshots of every screen (dev only):** `npm run build`, then `node scripts/run-electron.cjs npx electron . --capture=<folder>`.
