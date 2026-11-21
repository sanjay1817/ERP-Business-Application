# User guide

For everyday users: sales staff, accountants and auditors. What you see depends on your role; ask your administrator if you need more access.

## Signing in

Enter your username and password. If your administrator gave you a temporary password, you are asked to choose your own straight away: at least 10 characters, with letters and a number.

After 5 wrong passwords your account locks for 5 minutes; an administrator can unlock it sooner. To change your password later, open **User Management → Change my password**, or ask an administrator.

If a yellow **DEMO DATABASE** bar is shown, you are working in sample data, not the company books.

## Finding your way

- **Sidebar:** the modules your role can use.
- **Search** (`Ctrl K`): find customers, suppliers, items and documents by name, code, number or GSTIN.
- **Company switcher** (top right): if your business has more than one company in the company database.
- **Bell:** reminders, such as overdue invoices and e-way bills about to expire.

## Sales and purchase documents

Every document goes through the same steps:

1. **Draft**: numbered `DRAFT-n`. It can be edited or deleted and has no effect on stock or accounts.
2. **Validate**: checks the document without saving anything permanent.
3. **Post**: gives the document its legal number (for example `INV/2026-27/0012`), moves stock, and posts a balanced accounting entry. After posting, a document **cannot be edited**.
4. **Cancel**: posts a reversing entry and restores stock. The original stays visible, marked *Cancelled*, and the reason is recorded.

Create a document from another one (quotation → order → challan → invoice; invoice → credit note) with **Convert**. Each link is remembered, and stock moves only once.

**Print, preview and PDF** produce the same layout, with page numbers on PDFs. Documents in the demo carry a DEMO watermark.

### Receipts and payments

Record money received (**Sales → Receipts**) or paid (**Purchase → Payments**) against the cash or bank account, and allocate it to invoices. Any unallocated part stays *on account* as an advance.

You cannot submit the same form twice: a second click returns the first posting. A bank reference cannot be reused for the same party.

## Inventory

**Inventory** shows stock by item and warehouse, valued at moving-average cost, together with the movement history. Stock changes only when challans, invoices, returns and goods receipts are posted.

## Finance and banking

- **Finance & Accounts:**
  - general ledger, trial balance, profit and loss, balance sheet, day book;
  - receivables and payables with ageing;
  - journal and contra vouchers.
- **Banking:** cash book, bank book and bank reconciliation. Paste the bank statement as CSV, match the lines, record bank charges, and complete.

All figures come from posted entries only; drafts never count.

## GST

**GST Management** shows:
- sales and purchase registers;
- input-tax-credit classification (credit counts only after you mark it *eligible*);
- GSTR-1 and GSTR-3B preparation with validation;
- reconciliation against supplier or GSTR-2B files.

Returns are **prepared and exported only**: the program never files anything with the GST portal.

## E-invoice and e-way bill

These screens work with a **DEMO provider**:
- e-invoice numbers start with `DEMO-` and have no QR code;
- e-way bill numbers start with `DEMO`.

They are **not** government records and must not be given to customers or transporters as real ones. Your administrator can tell you when a real connection is in place. Until then, use the government portals for real e-invoices and e-way bills.

## Reports

**Reports** lists every statement and register. Each one can be:
- previewed;
- printed;
- saved as PDF (A4, with page numbers);
- saved as an Excel workbook (opens in Microsoft Excel with rupee formatting).

Totals in every report match the books.

## Auditors

Auditors can see everything and change nothing:
- integrity checks;
- the exception report;
- the journal inspector;
- stock movements;
- the audit trail.

Exceptions are items for review. They are never labelled as fraud.

## Good habits

- Post documents only when they are final; corrections are made by cancelling and re-entering.
- Sign out when you leave the PC (user menu, top right).
- Tell your administrator if a backup warning appears or the program reports a database check problem.
