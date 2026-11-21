import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { closeDatabase, openDatabase } from '../src/main/db/connection'
import { currentSchemaVersion, migrate, MigrationError } from '../src/main/db/migrator'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../src/main/db/migrations'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { tempDir, TEST_TODAY } from './helpers'

const REQUIRED_TABLES = [
  'companies', 'branches', 'users', 'roles', 'permissions', 'customers', 'suppliers', 'products', 'categories', 'units', 'warehouses',
  'tax_rates', 'sales_invoices', 'sales_invoice_items', 'purchase_invoices', 'purchase_invoice_items', 'stock_movements', 'stock_balances',
  'payment_receipts', 'payment_vouchers', 'chart_of_accounts', 'journal_entries', 'journal_entry_lines', 'audit_logs', 'transporters',
  'ewaybill_records', 'einvoice_records', 'application_settings'
]

describe('database connection', () => {
  it('opens an in-memory database with foreign keys enforced', () => {
    const db = openDatabase({ filePath: ':memory:' })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 })
    closeDatabase(db)
    expect(db.open).toBe(false)
  })

  it('creates the file (and parent folder) on disk in WAL mode', () => {
    const t = tempDir()
    try {
      const file = join(t.dir, 'nested', 'erp.db')
      const db = openDatabase({ filePath: file })
      expect(existsSync(file)).toBe(true)
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
      closeDatabase(db)
    } finally {
      t.cleanup()
    }
  })
})

describe('migrations', () => {
  it('creates every required table and records the schema version', () => {
    const db = openDatabase({ filePath: ':memory:' })
    const report = migrate(db, MIGRATIONS)
    expect(report.fromVersion).toBe(0)
    expect(report.toVersion).toBe(LATEST_SCHEMA_VERSION)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name)
    for (const t of REQUIRED_TABLES) expect(tables, `missing table ${t}`).toContain(t)
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('is idempotent: re-running applies nothing', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS)
    expect(migrate(db, MIGRATIONS).applied).toHaveLength(0)
  })

  it('declares foreign keys and indexes', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS)
    const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list('sales_invoice_items')`).all() as Array<{ table: string }>
    expect(fks.map((f) => f.table)).toEqual(expect.arrayContaining(['sales_invoices', 'products', 'units']))
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).all() as unknown[]).length
    expect(idx).toBeGreaterThan(30)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('rolls back a failing migration completely', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS)
    const bad = { version: 999, name: 'broken', sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);' }
    expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow(MigrationError)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='half_done'`).get()).toBeUndefined()
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('detects an applied migration that was modified', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS)
    const tampered = MIGRATIONS.map((m) => (m.version === 2 ? { ...m, sql: m.sql + '\n-- edited' } : m))
    expect(() => migrate(db, tampered)).toThrow(/modified after it was applied/)
  })

  it('refuses a database created by a newer application version', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, [...MIGRATIONS, { version: 50, name: 'future', sql: 'SELECT 1;' }])
    expect(() => migrate(db, MIGRATIONS)).toThrow(/does not know/)
  })
})

describe('database initialisation', () => {
  it('creates users and the DEMO company exactly once, persisting to disk', async () => {
    const t = tempDir()
    try {
      const file = join(t.dir, 'erp.db')
      let db = openDatabase({ filePath: file })
      const first = await initializeDatabase(db, { seedDemo: true, today: TEST_TODAY })
      expect(first.usersCreated).toBe(3)
      expect(first.demo).not.toBeNull()
      closeDatabase(db)

      db = openDatabase({ filePath: file })
      const second = await initializeDatabase(db, { seedDemo: true, today: TEST_TODAY })
      expect(second.usersCreated).toBe(0)
      expect(second.demo).toBeNull()
      expect(second.migrations.applied).toHaveLength(0)
      expect((db.prepare('SELECT COUNT(*) n FROM companies WHERE is_demo = 1').get() as { n: number }).n).toBe(1)
      closeDatabase(db)
    } finally {
      t.cleanup()
    }
  })
})
