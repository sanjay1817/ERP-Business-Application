/**
 * Real-application Phase 4 test: launches the built Electron app with --e2e-gst on a fresh
 * profile and checks GST registers vs ledgers, return preparation (never filed), DEMO IRN and
 * e-way bill workflows with duplicate prevention, live-mode refusal, auditor read-only access,
 * and real PDF / Excel output of the DEMO e-invoice, e-way bill and GSTR-3B preparation.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { tempDir } from './helpers'

const root = join(__dirname, '..')
const built = existsSync(join(root, 'out/main/index.js')) && existsSync(join(root, 'out/renderer/index.html'))

describe('real Electron application — GST, e-invoice and e-way bill', () => {
  it.skipIf(!built)('prepares returns, prevents duplicate IRNs / e-way bills, refuses live mode safely and prints DEMO documents', () => {
    const t = tempDir()
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, SA_ERP_USER_DATA: t.dir }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const res = spawnSync(electronPath as unknown as string, [root, '--e2e-gst'], { env, encoding: 'utf8', timeout: 150000 })
      const line = `${res.stdout}`.split(/\r?\n/).find((l) => l.startsWith('E2E_GST_RESULT '))
      expect(line, `no result.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeDefined()
      const r = JSON.parse(line!.slice('E2E_GST_RESULT '.length))
      expect(r.failedChecks ?? []).toEqual([])
      expect(r.validationErrorList ?? []).toEqual([])
      expect(r).toMatchObject({
        salesAgreesWithLedger: true, purchasesAgreeWithLedger: true, validationErrors: 0, preparedStatuses: ['PREPARED', 'PREPARED'], anyFiledWording: false,
        einvoiceIsDemo: true, einvoiceIdempotent: true, einvoiceDuplicateRefused: true, irnIsDemo: true,
        ewbPreviewErrors: [], ewbIdempotent: true, ewbPartAOnly: true, ewbTransporterChanged: true, ewbActiveAfterPartB: true, ewbStatus: 'ACTIVE', ewbCancelled: true,
        accountantIntegrationForbidden: true, liveRefused: true, liveRecordedFailed: true, retryAfterDemoGenerated: true, auditorForbidden: true, integrityAllOk: true,
        einvoiceHtmlDemo: true, ewbHtmlDemo: true, einvoicePdfHeader: '%PDF-', ewbPdfHeader: '%PDF-', xlsxHeader: 'PK'
      })
      expect(r.sections).toEqual(expect.arrayContaining(['B2B', 'B2CL', 'B2CS', 'CDNR', 'EXPWOP', 'SEZWOP', 'SEZWP']))
      expect(readFileSync(r.einvoicePdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(readFileSync(r.gstr3bXlsxPath).subarray(0, 2).toString('latin1')).toBe('PK')
      expect(r.pass).toBe(true)
      expect(res.status).toBe(0)
    } finally {
      t.cleanup()
    }
  }, 180000)
})
