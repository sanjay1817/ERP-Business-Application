import type { Migration } from '../migrator'

/**
 * Phase 5 — production readiness.
 *  - database_profile: what this database file is (DEMO or COMPANY). Set once; it can never be
 *    changed or deleted afterwards, so demo data cannot be relabelled as company books (or the reverse).
 *    Existing files are classified by content: any non-demo company → COMPANY; only the DEMO company → DEMO;
 *    no company yet → UNSET (decided when the database is set up).
 *  - users: forced password change and password-change timestamp.
 *  - Permissions for backup and restore.
 * Adds tables and columns only; no existing row is modified.
 */
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

const PERMS: ReadonlyArray<[code: string, module: string, desc: string, roles: string[]]> = [
  ['backup.view', 'Settings', 'View backups and restore history', ['ADMIN', 'AUDITOR']],
  ['backup.manage', 'Settings', 'Create backups, change backup settings and restore', ['ADMIN']]
]
const permsSql = PERMS.map(
  ([code, module, desc, roles]) =>
    `INSERT INTO permissions (code, module, description) VALUES (${q(code)}, ${q(module)}, ${q(desc)});
     INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ${q(code)} WHERE r.code IN (${roles.map(q).join(',')});`
).join('\n')

export const migration006: Migration = {
  version: 6,
  name: 'production_readiness',
  sql: `
CREATE TABLE database_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  environment TEXT NOT NULL CHECK (environment IN ('UNSET','DEMO','COMPANY')),
  database_uid TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  set_at TEXT
);
INSERT INTO database_profile (id, environment, database_uid, set_at)
SELECT 1,
  CASE WHEN EXISTS (SELECT 1 FROM companies WHERE is_demo = 0) THEN 'COMPANY'
       WHEN EXISTS (SELECT 1 FROM companies) THEN 'DEMO'
       ELSE 'UNSET' END,
  lower(hex(randomblob(16))),
  CASE WHEN EXISTS (SELECT 1 FROM companies) THEN ${NOW} END;

CREATE TRIGGER trg_profile_no_delete BEFORE DELETE ON database_profile
BEGIN SELECT RAISE(ABORT, 'The database profile cannot be deleted'); END;
CREATE TRIGGER trg_profile_set_once BEFORE UPDATE ON database_profile
WHEN OLD.environment <> 'UNSET' AND (NEW.environment IS NOT OLD.environment OR NEW.database_uid IS NOT OLD.database_uid)
BEGIN SELECT RAISE(ABORT, 'The database environment cannot be changed once set'); END;

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1));
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

${permsSql}
`
}
