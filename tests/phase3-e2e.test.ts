/**
 * Real-application Phase 3 test: launches the built Electron app with --e2e-finance
 * on a fresh profile. As the accountant it checks the statements reconcile, posts an
 * idempotent journal voucher and traces it in the ledger; as the auditor it runs the
 * integrity checks and exception report and is refused posting. A trial balance is
 * rendered to a real PDF by Chromium and a P&L to an .xlsx workbook.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import electronPath from 'electron'
import { tempDir } from './helpers'

const root = join(__dirname, '..')
const built = existsSync(join(root, 'out/main/index.js')) && existsSync(join(root, 'out/renderer/index.html'))

describe('real Electron application — finance, auditor and report exports', () => {
  it.skipIf(!built)('reconciles the books, prevents duplicate posting, enforces auditor read-only access and exports PDF/Excel', () => {
    const t = tempDir()
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, SA_ERP_USER_DATA: t.dir }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const res = spawnSync(electronPath as unknown as string, [root, '--e2e-finance'], { env, encoding: 'utf8', timeout: 120000 })
      const line = `${res.stdout}`.split(/\r?\n/).find((l) => l.startsWith('E2E_FINANCE_RESULT '))
      expect(line, `no result.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeDefined()
      const r = JSON.parse(line!.slice('E2E_FINANCE_RESULT '.length))
      expect(r.failedChecks ?? []).toEqual([])
      expect(r).toMatchObject({
        tbBalanced: true, bsBalanced: true, bsProfitEqualsPl: true, receivablesAgree: true, payablesAgree: true, dashboardNetEqualsPl: true,
        voucherIdempotent: true, journalsAdded: 1, unbalancedRejected: true, ledgerTracesVoucher: true,
        accountantCanAudit: false, integrityAllOk: true, exceptionsMentionFraud: false, auditorPostForbidden: true, auditorCancelForbidden: true, auditorCanRunReports: true,
        pdfHeader: '%PDF-', xlsxHeader: 'PK'
      })
      expect(r.voucherNumber).toMatch(/^MJ\/\d{4}-\d{2}\/\d{4}$/)
      expect(r.exceptionCounts.UNBALANCED_ATTEMPT).toBeGreaterThanOrEqual(2) // demo slip + this run's attempt
      expect(readFileSync(r.pdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      // The workbook is a valid ZIP whose sheet holds the P&L rows.
      const xlsx = readFileSync(r.xlsxPath)
      const sheetName = 'xl/worksheets/sheet1.xml'
      let o = 0
      let sheet = ''
      while (xlsx.readUInt32LE(o) === 0x04034b50) {
        const size = xlsx.readUInt32LE(o + 18)
        const n = xlsx.readUInt16LE(o + 26)
        const e = xlsx.readUInt16LE(o + 28)
        const name = xlsx.subarray(o + 30, o + 30 + n).toString()
        if (name === sheetName) sheet = inflateRawSync(xlsx.subarray(o + 30 + n + e, o + 30 + n + e + size)).toString()
        o += 30 + n + e + size
      }
      expect(sheet).toContain('GROSS PROFIT')
      expect(sheet).toContain('NET ')
      expect(r.pass).toBe(true)
      expect(res.status).toBe(0)
    } finally {
      t.cleanup()
    }
  }, 150000)
})
