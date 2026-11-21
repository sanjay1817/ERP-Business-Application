# Known limitations and production-readiness report

Version 0.5.0 · 21 November 2026 · For the business owner deciding on go-live, and for Latha Technologies.

## Verdict

**Ready for a supervised pilot** on one Windows 10 PC, as the bookkeeping, GST-preparation and inventory system of a single business. This assumes:
- the backup routine in [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md) is followed;
- GST returns, e-invoices and e-way bills continue to be filed on the government portals.

**Not ready** for any of the following until the items listed are done:

| Not ready for | Why | What is needed |
|---|---|---|
| Real e-invoices, e-way bills or return filing from the program | No government system is connected; only DEMO providers exist | An authorised GSP/IRP contract, credentials, and an adapter tested against the provider's sandbox |
| Wide distribution of the installer | The installer is not code-signed, so SmartScreen warns | A code-signing certificate, and signing in the build |
| Windows 11 | Not tested | An install-and-smoke run on Windows 11 |
| Several users on several PCs sharing one database | Single-PC design (SQLite file); a network share is not supported | A server-based edition |
| Physical printers | Printing was tested only through Windows' XPS driver | A test print on the office printer |

## What was tested, and how

All results below come from runs on this PC (Windows 10 Home 22H2, 64-bit) on 21 November 2026.

| Area | How it was tested | Result |
|---|---|---|
| Existing behaviour | The 174 tests from phases 1–4 | All pass. One existing test was edited: the Phase 4 migration-005 test is pinned to migrations 1–5, assertions unchanged |
| New behaviour | 57 Phase 5 tests: backup, restore, workspace, users, security, reports, scale, interruption, real-app end-to-end | All pass. Total: **231 tests in 22 files, 0 failed** |
| Typecheck and production build | `npm run test:all` | Pass |
| Backup | Real WAL database while open; checksum; manifest; retention; interrupted backup (simulated crash, leftover partial files) | Pass |
| Restore on a separate database copy | Restore over changed data; damaged backup refused; newer-version backup refused; DEMO backup refused for the company database; crash at each of the 5 restore stages | Pass: every case left either the previous database or the backup exactly; byte-level fingerprints compared |
| Restore in the real app | Back up → change → restore (refusals for wrong phrase, wrong password, other folder, auditor) → restart completes the restore | Pass |
| Upgrade of your real data | Copy of your database (schema 3) upgraded to schema 7 by the development build **and** by the final installed build | Pass: verified pre-upgrade backup made first; no existing row changed or removed (only the self-test's own sign-in time); integrity OK, 0 foreign-key errors |
| Your real database | Hash before and after every test | Database file and its WAL **unchanged** (see the note under Incidents) |
| Installer | Silent install of 0.5.0-rc.1; upgrade install to 0.5.0 over it; uninstall; then the final 0.5.0 build installed, checked and uninstalled again | Pass. Data files byte-identical across the upgrade install; uninstall removes the program, shortcuts and Programs entry and keeps data |
| Installed app | Self-test (sign-in, isolation, IPC); real window sign-in by typing into the window; normal close | Pass; database ready in 0.1 s on later starts; shutdown 0.5 s with the WAL checkpointed |
| Packaging hardening | Electron fuses read back; Node mode, `--inspect` and remote debugging tried against the installed exe; data folder inside the install folder | All refused as designed |
| Native SQLite in the installer | Loaded by the installed app (SQLite 3.53.4) | Pass |
| Permissions | Every IPC channel checked against every role (static matrix) and with hostile input | Pass: no view-level role can reach a changing action; nothing answers unauthenticated requests |
| Secrets | Password hashes, encrypted credential blobs, audit log and application log searched for every test password | No password or credential found |
| Report totals | 11 reports recomputed independently from journal lines, documents and stock | All equal |
| Excel | All 14 exported workbooks opened in **Microsoft Excel 2013** with alerts on | All opened without repair; totals and rupee formats correct |
| PDF | 21 PDFs (reports, invoices, notes, challan, quotation, DEMO e-invoice, DEMO e-way bill) rendered to images and inspected | A4, correct orientation, no text off the page, DEMO marks present, page numbers |
| Printing | One invoice printed silently through Chromium to the *Microsoft XPS Document Writer* driver and the output inspected | Pass |
| Interrupted posting | A process posting invoices and receipts was hard-killed 3 times | Pass: database opened cleanly; every posting complete or absent; numbering gap-free; stock and ledgers agree |
| Large data | See *Performance* | |
| DEMO vs live | DEMO banner, DEMO database refuses credentials and real companies; DEMO IRNs and e-way bill numbers formatted so they cannot be real; prints watermarked | Pass |

## Performance

Measured on one company with **20 000 sales invoices, 4 000 purchase bills, receipts, credit notes and cancellations** (37 617 journal entries, 186 593 journal lines, 52 968 stock movements, 11 681 receipts; a 78.5 MB database), built through the real posting engine. Measured on this PC: Intel Core i3-7020U (2.3 GHz, 2 cores), 12 GB RAM, Windows 10 Home. Faster PCs will be quicker.

| Operation | Time |
|---|---|
| Posting one sales invoice into the large database | 13 ms |
| Start-up integrity check · open and upgrade | 0.5 s · 0.1 s |
| Trial balance, profit and loss, balance sheet (financial year) | 0.3–0.5 s each |
| Receivables or payables ageing | 0.2–0.4 s |
| Day book (one month) · dashboard · sales register screen · search | 0.4 s · 0.2 s · 0.02 s · 0.03 s |
| GSTR-1 or GSTR-3B (one month) · GST validation (one month) | 0.1 s · 0.3 s |
| GST purchase register (year) · GST sales register (year) | 0.35 s · 2.1 s |
| Auditor exception report (year) | 2.7 s (was 10.2 s before the fixes below) |
| Finance dashboard (year, 12 monthly balances) | 3.4 s |
| Auditor integrity checks (includes SQLite's full integrity check, 2 s) | 5.5 s |
| Backup including verification · separate verification | 3.6 s · 2.3 s |
| Restore including the safety backup · restart afterwards | 12.8 s · 2.8 s |

Fixes made because of this test:
- Migration 007 adds two indexes for the auditor's reversal and cancellation lookups.
- The integrity check no longer rebuilds every ledger's display text.
- GST registers and validation reuse the compliance rules per date.
- Repeated lookups use prepared statements.
- Backups copy in larger steps.

**Limit to be aware of:** an automatic backup runs inside the application. At this size the window can pause for up to about 3–4 seconds while the copy is verified.

The regular test suite repeats the same checks on 600 invoices. The 20 000-invoice figures above were measured with `tests/profile-scale.ts` and `tests/profile-ops.ts` on the database generated by `tests/scale-data.ts`.

## Not tested

- Windows 11, Windows 10 Pro/Enterprise, other locales or display scaling above 100 %.
- A physical printer; the *Microsoft Print to PDF* driver (it opens a Save dialog). Printing was checked through the XPS driver only.
- Excel versions other than 2013; LibreOffice; Excel on Mac.
- A real power failure or disk-full condition. Power loss was simulated by killing processes; disk-full was not simulated.
- Restoring onto a different PC, or a different Windows user. Integration credentials are encrypted for the Windows user and cannot be decrypted elsewhere; they must be entered again.
- The "database failed its integrity check" dialog at start-up. The recovery logic is tested; the dialog itself was not clicked through.
- The *Change folder…* and *Import file…* buttons. They open Windows dialogs; the underlying folder and import functions are tested.
- Long-running use: automatic backups every N hours over days, and log rotation at 5 MB.
- Accessibility (screen readers, keyboard-only use).
- Any live or sandbox government API (none exists).

## Known limitations

### Data and operation
- Single PC, single signed-in user at a time. The database must not be placed on a network share.
- Backups are not encrypted. Protect the backup folder.
- Restore replaces the whole database. There is no partial restore and no point-in-time recovery between backups.
- Roles are fixed (Administrator, Accountant, Sales, Auditor). There are no custom roles and no per-company permissions.
- There is no automatic sign-out after inactivity.
- The first start after installation can take up to about a minute while Windows scans the new files. 37 s was observed once; later starts were under a second.

### GST, e-invoice and e-way bill (from Phase 4)
- No government integration. Returns are prepared and exported only. The JSON export is the program's own format, not the GSTN offline-tool schema.
- No outward debit notes (supplementary invoices), so GSTR-1 table 9B debit notes are empty.
- Monthly returns only (no QRMP). No amendment, advance or e-commerce tables, and no shipping-bill or port details.
- Reverse-charge tax is calculated for GSTR-3B but not posted to the ledger.
- Input tax credit is classified per bill, not per line, and proportionate reversals (rules 42/43) are not calculated.
- The GSTR-3B net figure does not apply cross-utilisation of credits.
- All documents report under the primary GSTIN; branch-wise GSTINs are not assigned to documents.
- Customer registration type is read from the current master, not as it was at invoice time.
- E-way bill distance is entered by hand; there are no consolidated or multi-vehicle e-way bills, and no B2C dynamic QR code.
- Compliance-rule defaults come from public guidance and must be verified. Pre-2023 e-invoice thresholds and pre-2021 HSN digit rules are simplified.

### Distribution
- The installer is unsigned (SmartScreen warning).
- The application icon is a placeholder ("SA" on blue); no logo was supplied.
- Automatic updates are not included; upgrades are done by running the new installer.

## Incidents during testing

- **Your real application log.** During the installer tests, a check that a data folder inside the installation folder is refused made the installed app fall back to your normal profile for its log file. Four lines were appended to `%APPDATA%\SA Business ERP\logs\app.log` on 21 Nov 2026 (09:35 and 09:50 UTC): two "Starting SA Business ERP" and two "Fatal startup error" lines. Your database and every other file in the profile were not touched.
  - The bug is fixed in 0.5.0: a refused data folder now never touches any profile.
  - The log lines were left in place. Removing them would mean editing an application log.
- Two existing defects were found and fixed:
  - "-₹0.00" was shown for zero payables;
  - the integrity check and GST registers were slow on large data.

## Before go-live checklist

1. Install 0.5.0 on the office PC. Choose **Set up my company**, with a strong administrator password.
2. Create one account per person; never share the administrator account.
3. **Backup & Restore → Change folder…** to a second drive. Make a manual backup, and copy it offsite.
4. Enter opening balances and masters. Run **Auditor → Integrity checks**, then make a backup.
5. Verify every compliance rule in **GST → Configuration** against current notifications.
6. Print one invoice on the office printer and check the layout.
7. Keep filing GST returns, e-invoices and e-way bills on the government portals.
8. Rehearse a restore once, on a spare PC or a test data folder.
