/**
 * Phase 5 — interrupted operations. A separate process posts invoices and
 * receipts continuously and is hard-killed (TerminateProcess on Windows) at
 * different moments. Afterwards the database must open cleanly and every posting
 * must be all-or-nothing: no unbalanced or orphan journal, no half-posted
 * invoice, gap-free numbering, stock and ledgers still agreeing.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/db/connection'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { integrityReport } from '../src/main/services/finance/audit-checks'
import { setupScaleCompany } from './scale-data'
import { tempDir } from './helpers'

const root = join(__dirname, '..')

function runAndKill(dbPath: string, killAfterPosts: number, extraDelayMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vite-node/vite-node.mjs'), '--config', join(root, 'vitest.config.ts'), join(root, 'tests/interrupt-child.ts'), dbPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let posted = 0
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.stdout.on('data', (d: Buffer) => {
      const m = [...d.toString().matchAll(/posted (\d+)/g)].pop()
      if (m) posted = Number(m[1])
      if (posted >= killAfterPosts && !child.killed) setTimeout(() => child.kill('SIGKILL'), extraDelayMs)
    })
    child.on('exit', () => (posted > 0 ? resolve(posted) : reject(new Error(`child posted nothing: ${err.slice(0, 2000)}`))))
  })
}

describe('posting interrupted by a killed process', () => {
  it('leaves only complete postings, three kills at different moments', async () => {
    const t = tempDir()
    try {
      const dbPath = join(t.dir, 'interrupt.db')
      const sc = setupScaleCompany(dbPath, { customers: 20, suppliers: 2, products: 24 })
      closeDatabase(sc.db)
      let totalPosted = 0
      for (const [after, delay] of [[15, 0], [10, 7], [20, 23]] as const) {
        totalPosted += await runAndKill(dbPath, after, delay)
        const db = openDatabase({ filePath: dbPath })
        try {
          expect(db.pragma('quick_check', { simple: true })).toBe('ok')
          expect(db.pragma('foreign_key_check')).toEqual([])
          const one = (sql: string) => db.prepare(sql).all()
          // Every journal is balanced and its header matches its lines.
          expect(one(`SELECT je.id FROM journal_entries je LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id GROUP BY je.id HAVING COUNT(l.id) < 2 OR SUM(l.debit_paise) <> SUM(l.credit_paise) OR SUM(l.debit_paise) <> je.total_debit_paise`)).toEqual([])
          // Every posted invoice has its journal and stock movements; no movement or journal without a posted source.
          expect(one(`SELECT si.id FROM sales_invoices si WHERE si.status = 'POSTED' AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.source_type = 'SALES_INVOICE' AND je.source_id = si.id)`)).toEqual([])
          expect(one(`SELECT si.id FROM sales_invoices si WHERE si.status = 'POSTED' AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.reference_type = 'SALES_INVOICE' AND m.reference_id = si.id)`)).toEqual([])
          expect(one(`SELECT je.id FROM journal_entries je WHERE je.source_type = 'SALES_INVOICE' AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.id = je.source_id AND si.status <> 'DRAFT')`)).toEqual([])
          expect(one(`SELECT r.id FROM payment_receipts r WHERE NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.source_type = 'RECEIPT' AND je.source_id = r.id)`)).toEqual([])
          // Stock balances equal the movement history.
          expect(one(`SELECT b.product_id FROM stock_balances b LEFT JOIN (SELECT product_id, warehouse_id, SUM(qty_in_milli - qty_out_milli) q FROM stock_movements GROUP BY product_id, warehouse_id) m ON m.product_id = b.product_id AND m.warehouse_id = b.warehouse_id WHERE b.qty_milli <> COALESCE(m.q, 0)`)).toEqual([])
          // Gap-free numbering of posted invoices.
          const nums = (db.prepare(`SELECT invoice_no n FROM sales_invoices WHERE status <> 'DRAFT' ORDER BY id`).all() as Array<{ n: string }>).map((r) => Number(r.n.split('/').pop()))
          expect(nums).toEqual(nums.map((_, i) => i + 1))
          expect(nums.length).toBeGreaterThanOrEqual(totalPosted) // the kill may land after one more commit
          const companyId = (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: number }).id
          expect(integrityReport({ db, userId: null, companyId }, '2026-11-30').checks.filter((c) => !c.ok)).toEqual([])
          // The application start-up path accepts the file.
          await initializeDatabase(db, { seedDemo: false, environment: 'COMPANY' })
        } finally {
          closeDatabase(db)
        }
      }
    } finally {
      t.cleanup()
    }
  }, 300_000)
})
