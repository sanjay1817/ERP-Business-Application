# Installation guide

For the person who installs SA Business ERP on an office PC. Version 0.5.0.

## Requirements

| | |
|---|---|
| Operating system | Windows 10 or Windows 11, 64-bit. Tested on Windows 10 Home 22H2 (build 19045); **Windows 11 has not been tested**. |
| Disk | About 380 MB for the program, plus room for your data and backups (a company with 20 000 invoices a year is about 80 MB; each backup is about the same size again). |
| Rights | A normal Windows user account. Administrator rights are **not** needed. |
| Other software | None. The SQLite database engine is built in. |

## Install

1. Run `SA-Business-ERP-Setup-0.5.0-x64.exe`.
2. **Windows SmartScreen** may say *"Windows protected your PC"*. The installer is not yet code-signed, so Windows does not know the publisher. Choose **More info → Run anyway** only if you received the file directly from Latha Technologies.
3. Choose the installation folder (default `C:\Users\<you>\AppData\Local\Programs\SA Business ERP`) and finish.
4. The installer adds a **Start menu** entry and a **desktop shortcut**.

The first start after installing can take up to a minute while Windows scans the new program. Later starts take a few seconds.

### Silent install (IT staff)

```
SA-Business-ERP-Setup-0.5.0-x64.exe /S
```

This installs for the current Windows user into the default folder, without prompts.

## First start

The first screen asks how to begin:

- **Set up my company**: creates your company database. You enter the company details and choose the administrator's username and password (at least 10 characters, with letters and a number). No demo data and no demo passwords are created.
- **Explore the demo**: opens a separate DEMO database with sample data. See [DEMO-SETUP.md](DEMO-SETUP.md).

Your company books and the demo are **separate files** and never mix. You can switch between them later from the sign-in screen.

## Where your data is kept

Data is never stored in the installation folder, so upgrading or uninstalling the program does not touch it.

| What | Location (under `%APPDATA%\SA Business ERP`) |
|---|---|
| Company database | `data\company\sa-business-erp-company.db` |
| Demo database | `data\sa-business-erp.db` |
| Backups | `backups\company\` and `backups\demo\` |
| Application log | `logs\app.log` (starts a new file at 5 MB) |
| Workspace and backup settings | `workspace.json`, `backup-settings.json`, `restore-history.jsonl` |

`%APPDATA%` is usually `C:\Users\<you>\AppData\Roaming`. Paste `%APPDATA%\SA Business ERP` into File Explorer's address bar to open it.

**Upgrading from version 0.1:** if this PC already ran version 0.1, its database at `data\sa-business-erp.db` is kept where it is. If it holds only the DEMO company, it becomes the demo database. If it holds a real company, it becomes the company database.

### Keeping data on another drive

To keep the data folder elsewhere (for example `D:\ERP-Data`), add `--data-dir` to the shortcut:

1. Right-click the desktop shortcut → **Properties**.
2. Set **Target** to:
   ```
   "C:\Users\<you>\AppData\Local\Programs\SA Business ERP\SA Business ERP.exe" "--data-dir=D:\ERP-Data"
   ```
3. Apply the same change to the Start menu shortcut, or remove it, so the program is never started on the wrong data folder.

The program refuses a data folder inside its own installation folder.

## Upgrade

1. Optional but recommended: in the program, open **Backup & Restore → Back up now**.
2. Close the program.
3. Run the new installer. It replaces the program files and keeps all data.
4. On the next start, if the new version changes the database structure, the program first makes a verified backup (type *Before upgrade*) and then upgrades the database.

If the upgrade fails, the database stays as it was: each upgrade step is all-or-nothing. The *Before upgrade* backup is also available.

## Uninstall

Use **Settings → Apps → SA Business ERP → Uninstall**. For a silent uninstall:

```
"%LOCALAPPDATA%\Programs\SA Business ERP\Uninstall SA Business ERP.exe" /S /currentuser
```

Uninstalling removes the program, the shortcuts and the Programs entry. It **keeps your data folder**. To remove the data as well, first copy a backup somewhere safe, then delete `%APPDATA%\SA Business ERP` by hand.

## If the program does not start

| What you see | What to do |
|---|---|
| *"SA Business ERP failed to start"* with a message | Read the message: it names the problem, and your data has not been changed. Then check `logs\app.log`. |
| *"The database failed its integrity check"* | The program offers to restore the newest verified backup; the damaged file is kept for support. See [BACKUP-AND-RESTORE.md](BACKUP-AND-RESTORE.md). |
| *"…holds DEMO sample data but is configured as the company database"* | Someone copied a demo file over the company file. Restore the company database from a company backup. |
| *"Debugging switches are not allowed"* | The shortcut contains a debugging option. Recreate the shortcut. |
| Nothing happens, or the window appears and closes | Another copy may already be running (only one is allowed); check the taskbar. Otherwise check `logs\app.log`. |
