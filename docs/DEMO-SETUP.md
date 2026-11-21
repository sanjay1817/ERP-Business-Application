# Demo setup guide

For trainers and evaluators who want to try SA Business ERP with sample data.

## Open the demo

- **First start:** choose **Explore the demo**.
- **From the company database:** on the sign-in screen, click **Open the demo instead**.

The program restarts on the separate DEMO database. While it is open:
- a yellow **DEMO DATABASE** bar shows on every screen;
- the sign-in screen is labelled DEMO DATABASE;
- printed documents carry DEMO watermarks.

## Demo sign-ins

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin@123` | Administrator |
| `accounts` | `Accounts@123` | Accountant |
| `auditor` | `Auditor@123` | Auditor (read-only) |

These are published on purpose and work **only** in the demo database. The company database never contains them. If an old database that already holds a real company still has one of these passwords, that user must change it.

## What the demo contains

*SA Demo Enterprises (DEMO)*, a Tamil Nadu company, with data for the current financial year:
- customers (including SEZ, export and consumer), suppliers, goods, services and an exempt product;
- quotations, orders, challans, invoices, returns, credit and debit notes, purchases, goods receipts;
- receipts and payments, journal and contra vouchers, and a completed bank reconciliation;
- GST:
  - HSN rates with effective dates;
  - input-tax-credit classifications;
  - a GST reconciliation import;
  - prepared GSTR-1 and GSTR-3B (*not filed*);
- DEMO e-invoices (one failed, one cancelled), DEMO e-way bills, vehicles and transport documents.

Every e-invoice number starts with `DEMO-` and has no QR code. E-way bill numbers start with `DEMO`. None of them is a government record.

## Start the demo again from scratch

1. Close the program.
2. Delete (or move away) `%APPDATA%\SA Business ERP\data\sa-business-erp.db` and any `-wal` and `-shm` files next to it.

   **Only the demo database is in that folder's top level.** Company books are in `data\company\`; do not touch them.
3. Start the program and open the demo. A fresh demo database is created with dates relative to today.

## Keeping demo and real data apart

- Demo and company data are separate files, and each file permanently records which kind it is.
- The demo cannot be opened as the company database, or the reverse; the program stops with an explanation.
- Real companies cannot be created inside the demo, and government-integration credentials cannot be stored there.
- Backups are kept in separate folders (`backups\demo`, `backups\company`). A demo backup cannot be restored into the company database.
- Nothing in the demo is sent anywhere. The DEMO e-invoice and e-way bill providers run inside the program.
