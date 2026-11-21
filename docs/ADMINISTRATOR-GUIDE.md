# Administrator guide

For the person who manages users, security, backups and settings.

## Company database and demo database

SA Business ERP keeps **company books** and **DEMO sample data** in separate database files. Each file records which kind it is when it is first set up. That record cannot be changed afterwards, not even by editing the database directly.

| | Company database | DEMO database |
|---|---|---|
| Created by | *Set up my company* (first start, or the sign-in screen) | *Explore the demo* |
| Users | Only those you create | Published demo users (`admin`, `accounts`, `auditor`) |
| Demo passwords | Never accepted: an account still on a demo password must change it | Shown on the sign-in screen |
| New companies | Allowed (e.g. a second legal entity) | Refused: real companies go in the company database |
| E-invoice and e-way bill credentials | Can be stored (encrypted) | Refused |
| Banner | None | A yellow **DEMO DATABASE** bar on every screen |

To switch, sign out and use the link at the bottom of the sign-in screen. The program restarts on the other database.

## Users and roles

Use **User Management**.

- **New user:** enter a username, full name, role and a **temporary password**. Give the temporary password to the person directly, not by email. The program requires them to choose their own password before they can do anything else.
- **Edit:** change name, email, role, or status (active or disabled). You cannot disable yourself or change your own role. The last active administrator cannot be disabled or demoted.
- **Reset password:** sets a new temporary password and unlocks the account. The user must change it at next sign-in.
- **Unlock:** after 5 wrong passwords an account is locked for 5 minutes. *Unlock* clears this immediately.
- **Change my password:** any user can change their own password from this page.

Password rules: at least 10 characters, with letters and at least one number. It must differ from the username, and it must not be a published demo password. Passwords are stored only as salted scrypt hashes; nobody, including the administrator, can read them.

Every user change is recorded in the audit trail (create, update, password reset, unlock, password change, refused password change), and never includes the password.

### What each role can do

The roles are fixed; custom roles are not available in this version. "all" means every action in that area; "x/y" means some of them, as listed below.

| Area | Administrator | Accountant | Sales | Auditor |
|---|---|---|---|---|
| Sales, purchase and payment documents | all | all | sales side only | view only |
| Masters (customers, suppliers, products) | all | customers & suppliers; products view only | customers; products view only | view only |
| Companies | all | view | — | view |
| Finance, vouchers, banking, bank reconciliation | all | all | — | view only |
| GST registers, returns, reconciliation | all | all | — | view only |
| E-invoice, e-way bill, transport | all | all | view | view |
| Reports (view, print, export) | all | all | — | all |
| Auditor workspace and audit trail | all | — | — | all |
| Integrations and credentials | all | view status | view status | view status |
| User management | all | — | — | — |
| Backup and restore | all | — | — | view backups and history |

The main process enforces every rule on every request. Hiding a button in the screen is never the only protection.

## Backups

See [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md). Administrator tasks:
- choose a backup folder on another drive;
- check that automatic backups are running (*Last automatic* on the Backup & Restore page);
- copy backups offsite;
- test a restore now and then.

## Security configuration (what is in place)

- **The program cannot be repurposed:**
  - it ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`;
  - it loads only its own packaged code, whose integrity is checked;
  - the installed program refuses remote-debugging switches.
- **The screen is isolated:**
  - the user interface has no access to files, the system, or Node.js;
  - it can only send requests from a fixed list;
  - every request is checked, in order: sender, input, signed-in session, then permission;
  - no web pages, pop-ups, downloads, camera, microphone or other device access.
- **Data:**
  - the data folder is outside the installation folder;
  - posted documents, journals, stock movements and the audit log cannot be edited or deleted, even directly in the database: corrections are made by reversal;
  - integration credentials are encrypted with Windows Data Protection (tied to this Windows user) and are never shown again or written to logs.
- **Logs:** `logs\app.log` records start-up, errors, refused requests and slow operations. Fields whose names look like passwords, secrets, tokens or hashes are replaced with `[REDACTED]`.

The installer is **not code-signed** yet. SmartScreen warns on install, and Windows cannot prove the file came from Latha Technologies. Buy a code-signing certificate before distributing widely.

## GST, e-invoice and e-way bill settings

- **GST → Configuration** holds:
  - GST registrations;
  - turnover and e-invoice applicability;
  - HSN/SAC rates with effective dates;
  - the compliance rules (thresholds, time limits).

  Defaults come from public guidance and are marked *verify*. Check them against current notifications before relying on them.
- **No government system is connected:**
  - e-invoices and e-way bills are produced by a DEMO provider and labelled DEMO everywhere;
  - choosing *Sandbox* or *Live* does not connect anything, and every such request fails and is recorded as failed;
  - GST returns are prepared and exported, never filed;
  - connecting to a real system needs an authorised provider (GSP/IRP), credentials issued for your GSTIN, and an adapter written to that provider's specification.

## Audit trail

**Auditor → Audit trail** lists:
- sign-ins, failed sign-ins and lock-outs;
- user and password administration;
- every posting, cancellation and reversal;
- master-data changes;
- GST preparation and export;
- integration and credential changes (never their values);
- backups, restores and refused restores.

The integrity checks under **Auditor** confirm that the ledgers, receivables, payables, stock and the balance sheet agree.

## Logs and support

Send support:
- `%APPDATA%\SA Business ERP\logs\app.log` (and `app.1.log` if present);
- the version number from **Settings**.

The logs contain no passwords. They do contain usernames, company names and file paths.
