/**
 * Development-only end-to-end check (`--e2e-test`): drives the REAL renderer
 * through the preload bridge and IPC (exactly what the UI does), then renders
 * the posted invoice to PDF with Chromium. Prints `E2E_RESULT {json}` and exits.
 */
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrintingDeps } from './ipc/routes'

const FLOW = `(async () => {
  const inv = async (ch, input) => {
    const r = await window.erp.invoke(ch, input)
    if (!r.ok) throw new Error(ch + ': ' + r.error.message + ' ' + JSON.stringify(r.error.fieldErrors || {}))
    return r.data
  }
  const out = {}
  await inv('auth:login', { username: 'admin', password: 'Admin@123' })
  const lk = await inv('lookup:all')
  const wh = lk.warehouses.find((w) => w.code === 'MAIN')
  const bank = lk.cashBankAccounts.find((a) => a.systemKey === 'BANK')
  const product = (await inv('product:list', {})).find((p) => p.code === 'UPS-1K')
  const supplier = (await inv('supplier:list', {})).find((s) => s.code === 'S002')
  const customer = (await inv('customer:list', {})).find((c) => c.code === 'C003')
  const today = new Date().toISOString().slice(0, 10)
  const stock0 = product.stockQtyMilli

  // Purchase: draft → validate → post (5 units + freight)
  let pi = await inv('doc:saveDraft', { kind: 'PURCHASE_INVOICE', partyId: supplier.id, date: today, supplierRef: 'E2E-' + Date.now(), warehouseId: wh.id,
    freightPaise: 50000, freightTaxBps: 1800, lines: [{ productId: product.id, qtyMilli: 5000, ratePaise: 495000, taxRateBps: 1800 }] })
  out.purchaseDraftNumber = pi.number
  out.purchaseValid = (await inv('doc:validate', { kind: 'PURCHASE_INVOICE', id: pi.id })).ok
  pi = await inv('doc:post', { kind: 'PURCHASE_INVOICE', id: pi.id })
  out.purchaseNumber = pi.number
  out.purchaseTotal = pi.grandTotalPaise
  const stock1 = (await inv('product:get', { id: product.id })).stockQtyMilli
  out.stockDeltaPurchase = stock1 - stock0
  out.supplierBalanceDelta = (await inv('supplier:get', { id: supplier.id })).balancePaise - supplier.balancePaise

  // Sale: inter-state customer, 2 units with 5% discount
  let si = await inv('doc:saveDraft', { kind: 'SALES_INVOICE', partyId: customer.id, date: today, warehouseId: wh.id,
    lines: [{ productId: product.id, qtyMilli: 2000, ratePaise: 620000, discountBps: 500 }] })
  si = await inv('doc:post', { kind: 'SALES_INVOICE', id: si.id })
  out.salesNumber = si.number
  out.salesTotal = si.grandTotalPaise
  out.salesUsesIgst = si.igstPaise > 0 && si.cgstPaise === 0 && si.sgstPaise === 0
  const stock2 = (await inv('product:get', { id: product.id })).stockQtyMilli
  out.stockDeltaSale = stock2 - stock1
  out.customerBalanceDelta = (await inv('customer:get', { id: customer.id })).balancePaise - customer.balancePaise

  // Draft must not affect stock; posting twice must be rejected
  const draft = await inv('doc:saveDraft', { kind: 'SALES_INVOICE', partyId: customer.id, date: today, warehouseId: wh.id, lines: [{ productId: product.id, qtyMilli: 1000, ratePaise: 620000 }] })
  out.draftNoStockEffect = (await inv('product:get', { id: product.id })).stockQtyMilli === stock2
  await inv('doc:deleteDraft', { kind: 'SALES_INVOICE', id: draft.id })
  const again = await window.erp.invoke('doc:post', { kind: 'SALES_INVOICE', id: si.id })
  out.doublePostRejected = again.ok === false

  // Partial receipt allocated to the invoice
  await inv('payment:create', { type: 'RECEIPT', partyId: customer.id, date: today, amountPaise: 500000, mode: 'UPI', accountId: bank.id, referenceNo: 'E2E-UTR', allocations: [{ invoiceId: si.id, amountPaise: 500000 }] })
  const siAfter = await inv('doc:get', { kind: 'SALES_INVOICE', id: si.id })
  out.paymentStatus = siAfter.paymentStatus
  out.balanceDue = siAfter.balanceDuePaise

  // Books
  const tb = await inv('finance:trialBalance')
  out.trialBalanceNet = tb.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0)
  const stockRows = await inv('inventory:stock')
  const stockValue = stockRows.reduce((s, r) => s + r.valuePaise, 0)
  const inv1400 = tb.find((r) => r.code === '1400')
  out.inventoryLedgerEqualsStock = inv1400.debitPaise - inv1400.creditPaise === stockValue
  const journals = await inv('finance:journals', { limit: 1000 })
  out.journalsBalanced = journals.every((j) => j.lines.reduce((s, l) => s + l.debitPaise - l.creditPaise, 0) === 0)

  const html = await inv('doc:printHtml', { kind: 'SALES_INVOICE', id: si.id })
  out.html = html.html
  out.fileName = html.fileName
  return out
})()`

export async function runE2E(win: BrowserWindow, printing: PrintingDeps, outDir: string): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  await new Promise((r) => setTimeout(r, 1200))
  const result = (await win.webContents.executeJavaScript(FLOW)) as Record<string, unknown> & { html: string; fileName: string }
  const pdf = await printing.toPdf(result.html)
  const pdfPath = join(outDir, 'e2e-sales-invoice.pdf')
  writeFileSync(pdfPath, pdf)
  const head = pdf.subarray(0, 5).toString('latin1')
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  const { html: _html, ...rest } = result
  const out: Record<string, unknown> = { ...rest, pdfHeader: head, pdfBytes: pdf.length, pdfPages: pages, pdfPath }
  const pass =
    out.purchaseValid === true && /^DRAFT-\d+$/.test(String(out.purchaseDraftNumber)) && /^PUR\//.test(String(out.purchaseNumber)) &&
    out.stockDeltaPurchase === 5000 && out.supplierBalanceDelta === out.purchaseTotal &&
    /^INV\//.test(String(out.salesNumber)) && out.salesUsesIgst === true && out.stockDeltaSale === -2000 && out.customerBalanceDelta === out.salesTotal &&
    out.draftNoStockEffect === true && out.doublePostRejected === true && out.paymentStatus === 'PARTIAL' &&
    out.trialBalanceNet === 0 && out.inventoryLedgerEqualsStock === true && out.journalsBalanced === true &&
    head === '%PDF-' && pdf.length > 10000 && pages >= 1
  return { pass, result: out }
}
