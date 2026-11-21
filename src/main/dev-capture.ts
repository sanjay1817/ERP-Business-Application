/**
 * Development-only: `--capture=<dir>` signs in as the demo admin, visits each
 * screen (including interaction states) and saves a PNG per step. Disabled in
 * packaged builds.
 */
import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Step {
  name: string
  hash?: string
  /** JS run in the page after navigation (e.g. click a row, open a menu). */
  js?: string
  wait?: number
}

const clickRow = (n = 0) => `document.querySelectorAll('tbody tr')[${n}]?.click()`
const clickButton = (text: string) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`
const clickRowContaining = (text: string) => `[...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(text)}))?.click()`

const STEPS: Step[] = [
  { name: 'dashboard', hash: '/dashboard', wait: 2000 },
  { name: 'sales-dashboard', hash: '/sales', wait: 1500 },
  { name: 'sales-customers', hash: '/sales/customers' },
  { name: 'sales-quotations', hash: '/sales/quotations' },
  { name: 'sales-orders', hash: '/sales/orders' },
  { name: 'sales-challans', hash: '/sales/challans' },
  { name: 'sales-invoices', hash: '/sales/invoices' },
  { name: 'sales-invoice-posted', hash: '/sales/invoices', js: clickRowContaining('Sunrise Hospitals'), wait: 1500 },
  { name: 'sales-invoice-posted-lines', js: `document.querySelector('main').scrollTo(0, 620)`, wait: 600 },
  { name: 'sales-invoice-posted-trail', js: `document.querySelector('main').scrollTo(0, 5000)`, wait: 600 },
  { name: 'sales-invoice-preview', js: clickButton('Preview'), wait: 1500 },
  { name: 'sales-invoice-new', hash: '/sales/invoices/new?party=3', wait: 1500 },
  { name: 'sales-invoice-draft', hash: '/sales/invoices', js: clickRowContaining('Draft #'), wait: 1500 },
  { name: 'sales-invoice-draft-lines', js: `document.querySelector('main').scrollTo(0, 560)`, wait: 600 },
  { name: 'sales-invoice-draft-top', js: `document.querySelector('main').scrollTo(0, 0)`, wait: 400 },
  { name: 'sales-invoice-validate', js: clickButton('Validate'), wait: 1500 },
  { name: 'sales-invoice-post-confirm', js: clickButton('Post…'), wait: 1500 },
  { name: 'sales-returns', hash: '/sales/returns' },
  { name: 'sales-credit-notes', hash: '/sales/credit-notes' },
  { name: 'sales-receipts', hash: '/sales/receipts' },
  { name: 'sales-receipt-new', hash: '/sales/receipts/new?party=4', wait: 1500 },
  { name: 'sales-receipt-autoalloc', js: `(() => { const i = document.querySelector('input[inputmode="decimal"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '150000'); i.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => (${clickButton('Auto-allocate')}), 300) })()`, wait: 1200 },
  { name: 'sales-register', hash: '/sales/register', wait: 1200 },
  { name: 'purchase-dashboard', hash: '/purchase', wait: 1500 },
  { name: 'purchase-requisitions', hash: '/purchase/requisitions' },
  { name: 'purchase-orders', hash: '/purchase/orders' },
  { name: 'purchase-goods-receipts', hash: '/purchase/goods-receipts' },
  { name: 'purchase-invoices', hash: '/purchase/invoices' },
  { name: 'purchase-invoice-freight', hash: '/purchase/invoices', js: clickRowContaining('PPI/26-27/1188'), wait: 1500 },
  { name: 'purchase-invoice-freight-lines', js: `document.querySelector('main').scrollTo(0, 640)`, wait: 600 },
  { name: 'purchase-invoice-grn', hash: '/purchase/invoices', js: clickRowContaining('SNS/26-27/3301'), wait: 1500 },
  { name: 'purchase-returns', hash: '/purchase/returns' },
  { name: 'purchase-return-detail', hash: '/purchase/returns', js: clickRow(0), wait: 1500 },
  { name: 'purchase-return-lines', js: `document.querySelector('main').scrollTo(0, 600)`, wait: 600 },
  { name: 'purchase-debit-notes', hash: '/purchase/debit-notes' },
  { name: 'purchase-payments', hash: '/purchase/payments' },
  { name: 'purchase-register', hash: '/purchase/register', wait: 1200 },
  { name: 'finance-dashboard', hash: '/finance', wait: 2200 },
  { name: 'finance-ledger-debtors', js: `window.erp.invoke('finance:accounts').then((r) => (location.hash = '#/finance/ledger?account=' + r.data.find((a) => a.code === '1300').id))`, wait: 1800 },
  { name: 'finance-ledger-journal-drawer', js: clickRow(3), wait: 1200 },
  { name: 'finance-trial-balance', hash: '/finance/trial-balance', wait: 1800 },
  { name: 'finance-profit-loss', hash: '/finance/profit-loss', wait: 1500 },
  { name: 'finance-profit-loss-bottom', js: `document.querySelector('main').scrollTo(0, 5000)`, wait: 600 },
  { name: 'finance-balance-sheet', hash: '/finance/balance-sheet', wait: 1500 },
  { name: 'finance-day-book', hash: '/finance/day-book', wait: 1500 },
  { name: 'finance-vouchers', hash: '/finance/vouchers', wait: 1200 },
  { name: 'finance-voucher-detail', hash: '/finance/vouchers', js: clickRowContaining('Short payment'), wait: 1500 },
  { name: 'finance-voucher-new', hash: '/finance/vouchers/new?type=JOURNAL', wait: 1500 },
  { name: 'finance-receivables', hash: '/finance/receivables', wait: 1800 },
  { name: 'finance-receivable-party', js: clickRow(0), wait: 1800 },
  { name: 'finance-payables', hash: '/finance/payables', wait: 1800 },
  { name: 'finance-accounts', hash: '/finance/accounts', wait: 1200 },
  { name: 'banking-overview', hash: '/banking', wait: 1500 },
  { name: 'banking-cash-book', hash: '/banking/cash-book', wait: 1500 },
  { name: 'banking-bank-book', hash: '/banking/bank-book', wait: 1800 },
  { name: 'banking-reconciliations', hash: '/banking/reconciliation', wait: 1200 },
  { name: 'banking-reconciliation-open', hash: '/banking/reconciliation', js: clickRowContaining('In progress'), wait: 1800 },
  { name: 'reports-trial-balance', hash: '/reports?report=TRIAL_BALANCE', wait: 1800 },
  { name: 'reports-receivables', hash: '/reports?report=RECEIVABLES', wait: 1800 },
  // Phase 4 — GST, e-invoice, e-way bill, transport (as admin)
  { name: 'gst4-overview', hash: '/gst', wait: 2200 },
  { name: 'gst4-sales', hash: '/gst/sales', wait: 2000 },
  { name: 'gst4-sales-sections', js: clickButton('By section'), wait: 800 },
  { name: 'gst4-sales-hsn', js: clickButton('HSN summary'), wait: 800 },
  { name: 'gst4-purchases', hash: '/gst/purchases', wait: 2000 },
  { name: 'gst4-purchases-classify', js: `${clickButton('Select pending')}; setTimeout(() => (${clickButton('Classify ITC')}), 400)`, wait: 1200 },
  { name: 'gst4-gstr1', hash: '/gst/gstr1', wait: 2000 },
  { name: 'gst4-gstr1-b2b', js: clickButton('B2B'), wait: 800 },
  { name: 'gst4-gstr1-exp', js: clickButton('Export / SEZ'), wait: 800 },
  { name: 'gst4-gstr3b', hash: '/gst/gstr3b', wait: 2000 },
  { name: 'gst4-gstr3b-bottom', js: `document.querySelector('main').scrollTo(0, 5000)`, wait: 600 },
  { name: 'gst4-validation', hash: '/gst/validation', wait: 2000 },
  { name: 'gst4-recon', hash: '/gst/reconciliation', wait: 1200 },
  { name: 'gst4-recon-detail', js: clickRow(0), wait: 2000 },
  { name: 'gst4-recon-import', hash: '/gst/reconciliation', js: `setTimeout(() => (${clickButton('Import CSV')}), 600)`, wait: 1500 },
  { name: 'gst4-config', hash: '/gst/config', wait: 1500 },
  { name: 'gst4-config-settings', hash: '/gst/config?tab=settings', wait: 1200 },
  { name: 'gst4-config-hsn', hash: '/gst/config?tab=hsn', js: `setTimeout(() => (${clickRowContaining('85285200')}), 700)`, wait: 1800 },
  { name: 'gst4-config-rates', hash: '/gst/config?tab=rates', wait: 1200 },
  { name: 'gst4-config-rules', hash: '/gst/config?tab=rules', wait: 1200 },
  { name: 'gst4-config-integrations', hash: '/gst/config?tab=integrations', wait: 1500 },
  { name: 'einv4-workspace', hash: '/einvoice', wait: 2200 },
  { name: 'einv4-blocked', js: clickButton('Not eligible'), wait: 800 },
  { name: 'einv4-register', js: clickButton('E-invoice register'), wait: 800 },
  { name: 'einv4-detail', js: `window.erp.invoke('einvoice:list', { status: 'GENERATED' }).then((r) => (location.hash = '#/einvoice/' + r.data[0].id))`, wait: 1800 },
  { name: 'einv4-preview', js: clickButton('Preview'), wait: 1800 },
  { name: 'einv4-failed', js: `window.erp.invoke('einvoice:list', { status: 'FAILED' }).then((r) => (location.hash = '#/einvoice/' + r.data[0].id))`, wait: 1800 },
  { name: 'ewb4-register', hash: '/ewaybill', wait: 1800 },
  { name: 'ewb4-detail', js: clickRowContaining('Delivery challan'), wait: 1500 },
  { name: 'ewb4-preview', js: `${clickRowContaining('Delivery challan')}; setTimeout(() => (${clickButton('Preview')}), 900)`, wait: 2600 },
  { name: 'ewb4-new', hash: '/ewaybill/new', wait: 2000 },
  { name: 'ewb4-new-partb', js: clickRowContaining('Likely required'), wait: 2000 },
  { name: 'transport4-transporters', hash: '/masters/transport', wait: 1500 },
  { name: 'transport4-vehicles', js: clickButton('Vehicles'), wait: 800 },
  { name: 'transport4-documents', js: clickButton('Transport documents'), wait: 800 },
  { name: 'doc4-invoice-compliance', js: `window.erp.invoke('einvoice:list', { status: 'GENERATED' }).then((r) => (location.hash = '#' + r.data.find((x) => x.documentKind === 'SALES_INVOICE').route))`, wait: 2200 },
  { name: 'doc4-invoice-compliance-bottom', js: `document.querySelector('main').scrollTo(0, 5000)`, wait: 800 },
  { name: 'auditor-overview', hash: '/auditor', wait: 2500 },
  { name: 'auditor-exceptions', hash: '/auditor/exceptions', wait: 2000 },
  { name: 'auditor-journals', hash: '/auditor/journals', wait: 1500 },
  { name: 'auditor-stock', hash: '/auditor/stock', wait: 1200 },
  { name: 'auditor-trail', hash: '/auditor/trail', wait: 1200 },
  // Phase 5: backup & restore, user administration, settings (DEMO banner visible on every screen).
  { name: 'p5-backup', hash: '/backup', wait: 1800 },
  { name: 'p5-backup-created', js: clickButton('Back up now'), wait: 3000 },
  { name: 'p5-backup-restore-confirm', js: `document.querySelector('[data-testid^="restore-"]')?.click()`, wait: 900 },
  { name: 'p5-users', hash: '/users', wait: 1500 },
  { name: 'p5-users-new', js: clickButton('New user'), wait: 900 },
  { name: 'p5-settings', hash: '/settings', wait: 1500 },
  { name: 'auditor-login-readonly', js: `window.erp.invoke('auth:logout').then(() => window.erp.invoke('auth:login', { username: 'auditor', password: 'Auditor@123' })).then(() => { location.hash = '#/auditor'; location.reload() })`, wait: 3500 },
  { name: 'auditor-role-voucher-view', hash: '/finance/vouchers', js: clickRow(0), wait: 1500 },
  { name: 'gst4-auditor-overview', hash: '/gst', wait: 2000 },
  { name: 'gst4-auditor-purchases', hash: '/gst/purchases', wait: 2000 },
  { name: 'einv4-auditor-workspace', hash: '/einvoice', wait: 2000 },
  { name: 'inventory-movements', hash: '/inventory', js: clickButton('Stock movements'), wait: 1200 },
  { name: 'company-invoice-settings', hash: '/masters/companies', js: `${clickRow(0)}; setTimeout(() => document.querySelector('[role=dialog] .overflow-y-auto')?.scrollTo(0, 2000), 400)`, wait: 1200 },
  { name: 'p5-auditor-backup', hash: '/backup', wait: 1800 }
]

export async function captureScreens(win: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const wc = win.webContents
  const snap = async (name: string) => writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG())
  await wait(1200)
  await snap('00-login')
  await wc.executeJavaScript(`window.erp.invoke('auth:login', { username: 'admin', password: 'Admin@123' })`)
  await wc.executeJavaScript(`location.hash = '#/dashboard'; location.reload()`)
  await wait(2500)
  let i = 1
  // Optional --capture-filter=a,b: only steps whose name starts with one of the prefixes (numbering is kept).
  const filter = process.argv.find((a) => a.startsWith('--capture-filter='))?.slice('--capture-filter='.length)
  for (const s of STEPS) {
    if (filter && !filter.split(',').some((f) => s.name.startsWith(f))) {
      i++
      continue
    }
    if (s.hash) {
      await wc.executeJavaScript(`location.hash = '#${s.hash}'`)
      await wait(900)
    }
    if (s.js) await wc.executeJavaScript(s.js)
    await wait(s.wait ?? 900)
    // Force a fresh frame before capturing (avoids stale frames in background windows).
    wc.invalidate()
    await wait(150)
    await snap(`${String(i++).padStart(2, '0')}-${s.name}`)
    await wc.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  }
}
