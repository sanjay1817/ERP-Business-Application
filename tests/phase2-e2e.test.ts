/**
 * Real-application end-to-end test: launches the built Electron app with
 * --e2e-test on a fresh profile. The app posts a purchase and a sale through the
 * renderer → preload → IPC path, checks stock/balances/books, and renders the
 * sales invoice to an actual PDF with Chromium. Requires `npm run build`.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { tempDir } from './helpers'

const root = join(__dirname, '..')
const built = existsSync(join(root, 'out/main/index.js')) && existsSync(join(root, 'out/renderer/index.html'))

describe('real Electron application — transaction flow and PDF', () => {
  it.skipIf(!built)('posts purchase and sales through IPC, updates stock and balances, keeps books balanced, and generates a PDF invoice', () => {
    const t = tempDir()
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, SA_ERP_USER_DATA: t.dir }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const res = spawnSync(electronPath as unknown as string, [root, '--e2e-test'], { env, encoding: 'utf8', timeout: 120000 })
      const line = `${res.stdout}`.split(/\r?\n/).find((l) => l.startsWith('E2E_RESULT '))
      expect(line, `no E2E result.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeDefined()
      const r = JSON.parse(line!.slice('E2E_RESULT '.length))
      expect(r).toMatchObject({
        purchaseValid: true,
        stockDeltaPurchase: 5000,
        salesUsesIgst: true,
        stockDeltaSale: -2000,
        draftNoStockEffect: true,
        doublePostRejected: true,
        paymentStatus: 'PARTIAL',
        trialBalanceNet: 0,
        inventoryLedgerEqualsStock: true,
        journalsBalanced: true,
        pdfHeader: '%PDF-'
      })
      expect(r.purchaseNumber).toMatch(/^PUR\/\d{4}-\d{2}\/\d{4}$/)
      expect(r.salesNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{4}$/)
      expect(r.supplierBalanceDelta).toBe(r.purchaseTotal)
      expect(r.customerBalanceDelta).toBe(r.salesTotal)
      expect(r.balanceDue).toBe(r.salesTotal - 500000)
      expect(r.pdfBytes).toBeGreaterThan(10000)
      expect(r.pdfPages).toBeGreaterThanOrEqual(1)
      expect(readFileSync(r.pdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(r.pass).toBe(true)
      expect(res.status).toBe(0)
    } finally {
      t.cleanup()
    }
  }, 150000)
})
