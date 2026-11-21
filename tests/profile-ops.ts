/**
 * Operational timings on a large database (not a test). Works on a copy.
 *   node node_modules/vite-node/vite-node.mjs --config vitest.config.ts tests/profile-ops.ts <db-copy> <scratch-root>
 */
import { statSync } from 'node:fs'
import { toMilli, toPaise } from '@shared/money'
import { DocumentSaveInput } from '@shared/documents'
import { closeDatabase, openDatabase, type DB } from '../src/main/db/connection'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { BackupManager } from '../src/main/services/backup/manager'
import { finalizeRestore, quickCheck, recoverInterruptedRestore } from '../src/main/services/backup/restore'
import { postDocument, saveDraft } from '../src/main/services/documents/engine'

const [dbPath, root] = process.argv.slice(2)
const out: Record<string, number | string> = { databaseMB: Math.round(statSync(dbPath).size / 1e5) / 10 }
const t = (name: string, s: number) => (out[name] = Math.round(performance.now() - s))

let s = performance.now()
const ok = quickCheck(dbPath)
t('startupQuickCheckMs', s)
s = performance.now()
let db: DB | null = openDatabase({ filePath: dbPath })
void (async () => {
  const report = await initializeDatabase(db!, { seedDemo: false, environment: 'COMPANY' })
  t('openAndMigrateMs', s)
  out.migrationsApplied = report.migrations.applied.map((m) => m.version).join(',') || 'none'
  out.quickCheck = ok ? 'ok' : 'FAILED'

  const companyId = (db!.prepare('SELECT id FROM companies LIMIT 1').get() as { id: number }).id
  const ctx = { db: db!, userId: 1, companyId }
  const wh = (db!.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(companyId) as { id: number }).id
  const customers = (db!.prepare('SELECT id FROM customers WHERE company_id = ? LIMIT 50').all(companyId) as Array<{ id: number }>).map((r) => r.id)
  const goods = (db!.prepare(`SELECT id FROM products WHERE company_id = ? AND item_type = 'GOODS' LIMIT 50`).all(companyId) as Array<{ id: number }>).map((r) => r.id)
  s = performance.now()
  for (let i = 0; i < 200; i++) {
    const lines = [0, 1, 2].map((k) => ({ productId: goods[(i + k) % goods.length], qtyMilli: toMilli(2), ratePaise: toPaise(400 + k) }))
    const d = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: customers[i % customers.length], date: '2026-11-14', warehouseId: wh, lines }))
    postDocument(ctx, 'SALES_INVOICE', d.id)
  }
  out.postPerInvoiceAtScaleMs = Math.round((performance.now() - s) / 20) / 10

  const m = new BackupManager({ root, environment: 'COMPANY', dbPath, appVersion: 'profile', getDb: () => db, closeDb: () => (closeDatabase(db), (db = null)) })
  s = performance.now()
  const b = await m.backupNow('MANUAL')
  t('backupIncludingVerificationMs', s)
  out.backupMB = Math.round(b.sizeBytes / 1e5) / 10
  s = performance.now()
  out.verifyOk = String(m.verify(b.fileName).ok)
  t('verifyMs', s)
  s = performance.now()
  const r = await m.restore(b.fileName, 'owner')
  out.restore = r.outcome
  t('restoreIncludingSafetyBackupMs', s)
  s = performance.now()
  out.recovery = recoverInterruptedRestore(dbPath, 'COMPANY', 99).action
  finalizeRestore(dbPath)
  const conn = openDatabase({ filePath: dbPath })
  await initializeDatabase(conn, { seedDemo: false, environment: 'COMPANY' })
  t('restartAfterRestoreMs', s)
  closeDatabase(conn)
  process.stdout.write(`OPS ${JSON.stringify(out)}\n`)
})()
