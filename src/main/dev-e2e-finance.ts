/**
 * Development-only Phase 3 end-to-end check (`--e2e-finance`): drives the REAL
 * renderer through the preload bridge and IPC as the accountant and the auditor,
 * verifies the books reconcile, then renders report PDF (Chromium) and Excel files.
 * Prints `E2E_FINANCE_RESULT {json}` and exits.
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReportDoc } from '@shared/finance'
import type { PrintingDeps } from './ipc/routes'
import { reportHtml } from './services/reports/report-html'
import { reportToXlsx } from './services/reports/xlsx'

const FLOW = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const inv = async (ch, input) => {
    const r = await call(ch, input)
    if (!r.ok) throw new Error(ch + ': ' + r.error.message + ' ' + JSON.stringify(r.error.fieldErrors || {}))
    return r.data
  }
  const out = {}
  const today = new Date().toISOString().slice(0, 10)
  await inv('auth:login', { username: 'accounts', password: 'Accounts@123' })
  const periods = await inv('finance:periods')
  const fy = periods.years.find((y) => y.fy === periods.currentFy)
  const range = { from: fy.from, to: today }
  out.fy = periods.currentFy

  // Statements reconcile.
  const tb = await inv('finance:trialBalanceReport', range)
  out.tbBalanced = tb.balanced
  out.tbRows = tb.rows.length
  const bs = await inv('finance:balanceSheet', { asOf: today })
  out.bsBalanced = bs.balanced
  const pl = await inv('finance:profitLoss', range)
  out.bsProfitEqualsPl = bs.currentYearProfitPaise === pl.netProfitPaise
  const ar = await inv('finance:ageing', { side: 'CUSTOMER', asOf: today })
  const ap = await inv('finance:ageing', { side: 'SUPPLIER', asOf: today })
  out.receivablesAgree = ar.agrees
  out.payablesAgree = ap.agrees
  const dash = await inv('finance:dashboard', range)
  out.dashboardNetEqualsPl = dash.kpis.netProfitPaise === pl.netProfitPaise

  // Post a journal voucher twice with the same request key: one posting only.
  const accounts = await inv('finance:accounts')
  const id = (code) => accounts.find((a) => a.code === code).id
  const before = (await inv('finance:dayBook', { from: today, to: today })).length
  const key = 'e2e0' + Date.now().toString(16).padStart(12, '0') + '-0000-4000-8000'
  const body = { type: 'JOURNAL', date: today, narration: 'E2E office supplies', requestKey: key, lines: [{ accountId: id('6400'), debitPaise: 123400 }, { accountId: id('1200'), creditPaise: 123400 }] }
  const v1 = await inv('voucher:create', body)
  const v2 = await inv('voucher:create', body)
  out.voucherNumber = v1.number
  out.voucherIdempotent = v1.id === v2.id
  out.journalsAdded = (await inv('finance:dayBook', { from: today, to: today })).length - before
  const unbalanced = await call('voucher:create', { type: 'JOURNAL', date: today, narration: 'E2E unbalanced', lines: [{ accountId: id('6400'), debitPaise: 1000 }, { accountId: id('1200'), creditPaise: 999 }] })
  out.unbalancedRejected = unbalanced.ok === false && unbalanced.error.code === 'VALIDATION'
  // Drill-down: the voucher's bank ledger line opens the voucher.
  const gl = await inv('finance:ledger', { accountId: id('1200'), from: today, to: today })
  out.ledgerTracesVoucher = gl.lines.some((l) => l.voucherNo === v1.number && l.route === '/finance/vouchers/' + v1.id)
  const integrity = await inv('audit:integrity').catch((e) => ({ error: String(e) }))
  out.accountantCanAudit = !integrity.error
  out.tbDoc = await inv('report:run', { report: 'TRIAL_BALANCE', ...range })
  out.plDoc = await inv('report:run', { report: 'PROFIT_LOSS', ...range })
  await inv('auth:logout')

  // Auditor: read and export, never post.
  await inv('auth:login', { username: 'auditor', password: 'Auditor@123' })
  const checks = await inv('audit:integrity')
  out.integrityAllOk = checks.allOk
  out.failedChecks = checks.checks.filter((c) => !c.ok).map((c) => c.label + ': ' + c.detail)
  const ex = await inv('audit:exceptions')
  out.exceptionCounts = ex.counts
  out.exceptionsMentionFraud = /fraud/i.test(JSON.stringify(ex.items))
  const forbidden = await call('voucher:create', body)
  out.auditorPostForbidden = forbidden.ok === false && forbidden.error.code === 'FORBIDDEN'
  const cancel = await call('voucher:cancel', { id: v1.id, reason: 'auditor attempt' })
  out.auditorCancelForbidden = cancel.ok === false && cancel.error.code === 'FORBIDDEN'
  const rep = await call('report:run', { report: 'BALANCE_SHEET', asOf: today })
  out.auditorCanRunReports = rep.ok === true
  await inv('auth:logout')
  return out
})()`

export async function runFinanceE2E(win: BrowserWindow, printing: PrintingDeps, outDir: string): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  await new Promise((r) => setTimeout(r, 1200))
  const r = (await win.webContents.executeJavaScript(FLOW)) as Record<string, unknown> & { tbDoc: ReportDoc; plDoc: ReportDoc }
  const pdf = await printing.toPdf(reportHtml(r.tbDoc))
  const pdfPath = join(outDir, 'e2e-trial-balance.pdf')
  writeFileSync(pdfPath, pdf)
  const xlsx = reportToXlsx(r.plDoc)
  const xlsxPath = join(outDir, 'e2e-profit-loss.xlsx')
  writeFileSync(xlsxPath, xlsx)
  const { tbDoc, plDoc, ...rest } = r
  const out: Record<string, unknown> = {
    ...rest,
    tbDocRows: tbDoc.rows.length,
    plDocRows: plDoc.rows.length,
    pdfHeader: pdf.subarray(0, 5).toString('latin1'),
    pdfBytes: pdf.length,
    pdfPath,
    xlsxHeader: xlsx.subarray(0, 2).toString('latin1'),
    xlsxBytes: xlsx.length,
    xlsxPath
  }
  const pass =
    out.tbBalanced === true && out.bsBalanced === true && out.bsProfitEqualsPl === true && out.receivablesAgree === true && out.payablesAgree === true &&
    out.dashboardNetEqualsPl === true && out.voucherIdempotent === true && out.journalsAdded === 1 && out.unbalancedRejected === true && out.ledgerTracesVoucher === true &&
    out.accountantCanAudit === false && out.integrityAllOk === true && out.exceptionsMentionFraud === false && out.auditorPostForbidden === true &&
    out.auditorCancelForbidden === true && out.auditorCanRunReports === true && out.pdfHeader === '%PDF-' && pdf.length > 5000 && out.xlsxHeader === 'PK'
  return { pass, result: out }
}
