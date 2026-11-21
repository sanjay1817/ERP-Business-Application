# Backup and restore guide

For the administrator responsible for the company's data.

## How backups work

A backup is a complete, verified copy of the open database: either the company books or the demo, never both.

1. The copy is made with SQLite's own backup method, so it is consistent even while people are working.
2. It is written under a temporary name (`….db.partial`) and then checked:
   - full integrity check;
   - foreign-key check;
   - database version.
3. A SHA-256 checksum and a description file (`….json`) are saved next to it.
4. Only then does it get its final name, for example `sa-erp-company-20261121-093000-manual.db`.

A backup interrupted by a crash or power cut never appears in the list; its leftover files are removed on the next start.

| Backup type | When it is made | Kept |
|---|---|---|
| Manual | **Backup & Restore → Back up now** | Always, until you delete it |
| Automatic | About a minute after start, then whenever the interval has passed (checked every 30 minutes while the program is open) | Newest 14 (configurable) |
| Before upgrade | Before a new program version changes the database | Newest 10 (configurable) |
| Before restore | Before every restore, as a copy of the database being replaced | Newest 10 (configurable) |
| Imported file | **Import file…** | Always |

Backups are stored in `%APPDATA%\SA Business ERP\backups\company` (company) and `…\backups\demo` (demo). A demo backup can never be restored into the company database, or the reverse.

### Back up to another drive

Backups on the same disk do not protect you if that disk fails or the PC is lost. Use **Change folder…** to choose a folder on another drive, a USB drive or a network share. Also copy backups regularly to a second place that is kept away from the office.

Backups are **not encrypted**. Store them where only authorised people can read them.

## Make a backup now

**Backup & Restore → Back up now.** An optional label (for example "before year-end close") helps you find it later. The result is checked before it is listed.

## Check a backup

Click **Verify** next to a backup. It re-checks:
- integrity;
- the checksum (the file has not changed since it was made);
- the program version that made it;
- that it belongs to this database (company or demo).

It also shows how many companies, documents, journal lines and audit entries the backup contains.

## Restore

A restore replaces the **whole** database with the backup. Everything entered after the backup time is no longer in the books. Only an administrator can restore.

1. **Backup & Restore**, then click **Restore…** next to the backup.
2. Read the warning, type `RESTORE`, enter your own password, and click **Restore and restart**.
3. The program then:
   1. verifies the backup again;
   2. makes a verified *Before restore* backup of the current database;
   3. replaces the database file step by step, keeping a journal of each step;
   4. checks the restored file;
   5. restarts.
4. After the restart, the sign-in screen confirms the restore. The restore is recorded in the restore history and in the audit trail.

To undo a restore, restore the *Before restore* backup that was made automatically.

### If something goes wrong during a restore

- **The backup is damaged, from a newer version, or from the other database:** the restore is refused before anything changes.
- **The restored file fails its check:** the previous database is put back automatically.
- **Power cut or crash part-way through:** on the next start the program reads the restore journal.
  - If the swap had not finished, it puts the previous database back.
  - If the swap had finished and the restored file is healthy, it completes the restore.
  - A message on the sign-in screen tells you which happened.

### Restore a backup file from elsewhere

Use **Import file…** to bring in a database file, for example from a USB drive. It is copied and verified, then listed as an *Imported file* backup, which you can restore normally.

## The database is damaged

If the database fails its integrity check at start-up, the program does not open it. It offers to restore the newest verified backup:

- **Restore this backup:** the damaged file is kept in the backup folder as `damaged-<date>.db.keep` for support, the backup is restored, and the program starts.
- **Quit without changes:** nothing is touched. Contact support with `logs\app.log`.

## Manual restore (support staff only)

Use this only if the program cannot start at all.

1. Close SA Business ERP and make sure it is not running in Task Manager.
2. In `%APPDATA%\SA Business ERP\data\company\`, move `sa-business-erp-company.db` and any `-wal` and `-shm` files with the same name into a new folder (do not delete them).
3. Copy the chosen backup `.db` file into `data\company\` and rename it `sa-business-erp-company.db`.
4. Start the program. It checks the file and upgrades it if the backup came from an older version.

## Recommended routine

- Daily: automatic backups stay on (the default).
- Weekly: copy the newest backup to a second drive or offsite.
- Monthly: restore a recent backup on a spare PC, or a test data folder started with `--data-dir`, and check that the books look right.
- Before year-end closing, before upgrades and before bulk changes: **Back up now**, with a label.
