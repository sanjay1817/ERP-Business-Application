/**
 * Dev-only: write every printable output of the DEMO database to a folder so the
 * real files can be inspected (PDF pages rendered to images, workbooks opened in
 * Excel) and send one document through the Windows print pipeline.
 *   --export-samples=<dir> [--print-to=<printer name>]
 */
import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPORT_KINDS, type ReportKind } from '@shared/finance'
import type { DB } from './db/connection'
import type { PrintingDeps } from './ipc/routes'
import { buildReport } from './services/reports/report-docs'
import { reportHtml } from './services/reports/report-html'
import { reportToXlsx } from './services/reports/xlsx'
import { buildDocumentHtml } from './services/documents/print'
import { EInvoiceService } from './services/einvoice/service'
import { EwayBillService, defaultEwayBillProvider } from './services/ewaybill/service'
import type { DocumentKind } from '@shared/documents'

export async function exportSamples(db: DB, printing: PrintingDeps, dir: string, printTo: string | null): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  mkdirSync(dir, { recursive: true })
  const company = db.prepare(`SELECT id FROM companies WHERE is_demo = 1`).get() as { id: number }
  const admin = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get() as { id: number }
  const ctx = { db, userId: admin.id, companyId: company.id }
  const files: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  const fyFrom = (db.prepare(`SELECT MIN(entry_date) d FROM journal_entries WHERE company_id = ?`).get(company.id) as { d: string }).d
  const bank = db.prepare(`SELECT id FROM chart_of_accounts WHERE company_id = ? AND is_bank = 1 AND system_key = 'BANK'`).get(company.id) as { id: number } | undefined
  const rec = db.prepare(`SELECT id FROM bank_reconciliations WHERE company_id = ? ORDER BY id LIMIT 1`).get(company.id) as { id: number } | undefined
  const gl = db.prepare(`SELECT id FROM chart_of_accounts WHERE company_id = ? AND system_key = 'AR'`).get(company.id) as { id: number }

  for (const kind of Object.keys(REPORT_KINDS) as ReportKind[]) {
    const period = REPORT_KINDS[kind].period
    const params =
      period === 'asOf' ? { asOf: today } : period === 'none' ? { reconciliationId: rec?.id } : { from: fyFrom, to: today, ...(kind === 'BANK_BOOK' ? { accountId: bank?.id } : kind === 'GENERAL_LEDGER' ? { accountId: gl.id } : {}) }
    if (kind === 'BANK_RECONCILIATION' && !rec) continue
    const doc = buildReport(ctx, { report: kind, ...params } as never)
    const html = reportHtml(doc)
    writeFileSync(join(dir, `report-${kind}.pdf`), await printing.toPdf(html))
    writeFileSync(join(dir, `report-${kind}.xlsx`), reportToXlsx(doc))
    files.push(`report-${kind}.pdf`, `report-${kind}.xlsx`)
  }

  const docs: Array<[DocumentKind, string]> = [['SALES_INVOICE', 'sales_invoices'], ['PURCHASE_INVOICE', 'purchase_invoices']]
  for (const [kind, table] of docs) {
    // The largest posted invoice: most lines, so page breaks and totals are exercised.
    const r = db.prepare(`SELECT id FROM ${table} WHERE company_id = ? AND status = 'POSTED' ORDER BY grand_total_paise DESC LIMIT 1`).get(company.id) as { id: number }
    writeFileSync(join(dir, `doc-${kind}.pdf`), await printing.toPdf(buildDocumentHtml(ctx, kind, r.id)))
    files.push(`doc-${kind}.pdf`)
  }
  for (const kind of ['DELIVERY_CHALLAN', 'CREDIT_NOTE', 'SALES_QUOTATION'] as DocumentKind[]) {
    const r = db.prepare(`SELECT id FROM trade_documents WHERE company_id = ? AND doc_type = ? AND status = 'POSTED' ORDER BY id DESC LIMIT 1`).get(company.id, kind) as { id: number } | undefined
    if (!r) continue
    writeFileSync(join(dir, `doc-${kind}.pdf`), await printing.toPdf(buildDocumentHtml(ctx, kind, r.id)))
    files.push(`doc-${kind}.pdf`)
  }
  const einv = db.prepare(`SELECT id FROM einvoices WHERE company_id = ? AND status = 'GENERATED' ORDER BY id LIMIT 1`).get(company.id) as { id: number } | undefined
  if (einv) {
    writeFileSync(join(dir, 'einvoice-DEMO.pdf'), await printing.toPdf(new EInvoiceService().printHtml(ctx, einv.id).html))
    files.push('einvoice-DEMO.pdf')
  }
  const ewb = db.prepare(`SELECT id FROM ewaybill_records WHERE company_id = ? AND status = 'ACTIVE' ORDER BY id LIMIT 1`).get(company.id) as { id: number } | undefined
  if (ewb) {
    writeFileSync(join(dir, 'ewaybill-DEMO.pdf'), await printing.toPdf(new EwayBillService(defaultEwayBillProvider).printHtml(ctx, ewb.id).html))
    files.push('ewaybill-DEMO.pdf')
  }

  // One real print job through Chromium's print pipeline to a Windows printer driver.
  let printed: { ok: boolean; reason: string | null } | null = null
  if (printTo) {
    const inv = db.prepare(`SELECT id FROM sales_invoices WHERE company_id = ? AND status = 'POSTED' ORDER BY id LIMIT 1`).get(company.id) as { id: number }
    const html = buildDocumentHtml(ctx, 'SALES_INVOICE', inv.id)
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } })
    try {
      await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`)
      const printers = await win.webContents.getPrintersAsync()
      const target = printers.find((p) => p.name === printTo)
      if (!target) printed = { ok: false, reason: `printer not found; available: ${printers.map((p) => p.name).join(', ')}` }
      else
        printed = await new Promise((resolve) =>
          win.webContents.print({ silent: true, deviceName: printTo, printBackground: true, pageSize: 'A4' }, (ok, reason) => resolve({ ok, reason: reason || null }))
        )
    } finally {
      win.destroy()
    }
  }
  const result = { files: files.length, list: files, printed, dir }
  return { pass: files.length >= 20 && (!printTo || !!printed?.ok), result }
}
