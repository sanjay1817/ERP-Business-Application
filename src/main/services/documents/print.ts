/**
 * Print / PDF layout for commercial documents. Generated in the main process;
 * every value is HTML-escaped. The same HTML is used for on-screen preview,
 * the system print dialog and PDF export, so all three always match.
 */
import { KINDS, isInvoiceKind, type DocumentDetail, type DocumentKind } from '@shared/documents'
import { stateName } from '@shared/india'
import { milliToString } from '@shared/money'
import { amountInWordsINR } from '@shared/words'
import type { ServiceContext } from '../context'
import { loadDocument } from './store'

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const nl = (v: string | null | undefined): string => esc(v).replace(/\n/g, '<br>')
const inr = (paise: number): string => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (bps: number): string => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`
const date = (iso: string | null): string => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—')

interface CompanyPrint {
  name: string; legal_name: string | null; gstin: string | null; pan: string | null; state_code: string; address_line1: string | null; address_line2: string | null
  city: string | null; pincode: string | null; phone: string | null; email: string | null; is_demo: number; bank_name: string | null; bank_account_no: string | null
  bank_ifsc: string | null; bank_branch: string | null; upi_id: string | null; invoice_terms: string | null
}

const STYLE = `
  @page { size: A4; margin: 12mm 11mm; }
  * { box-sizing: border-box; }
  .doc { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 10.5px; line-height: 1.4; position: relative; background: #fff; }
  .doc h1 { margin: 0; font-size: 19px; letter-spacing: -0.2px; }
  .muted { color: #475569; }
  .row { display: flex; gap: 16px; }
  .grow { flex: 1; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f1f45; padding-bottom: 10px; }
  .title { text-align: right; }
  .title .t { font-size: 17px; font-weight: 800; color: #0f1f45; letter-spacing: 1px; }
  .badge { display: inline-block; border: 1px solid #b45309; color: #92400e; background: #fffbeb; font-weight: 700; padding: 2px 6px; border-radius: 4px; font-size: 9.5px; letter-spacing: .5px; margin-top: 4px; }
  .cancel { border-color: #b91c1c; color: #991b1b; background: #fef2f2; }
  .box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
  .label { font-size: 8.5px; text-transform: uppercase; letter-spacing: .8px; color: #64748b; font-weight: 700; margin-bottom: 3px; }
  .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; margin: 10px 0; }
  .meta b { display: block; font-size: 10.5px; }
  table { width: 100%; border-collapse: collapse; }
  .items th { background: #0f1f45; color: #fff; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: .3px; padding: 5px 5px; text-align: left; }
  .items td { padding: 5px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .items tr { page-break-inside: avoid; }
  .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c { text-align: center; }
  .small { font-size: 9px; }
  .totals td { padding: 3px 0; }
  .totals .grand td { border-top: 2px solid #0f1f45; font-size: 13px; font-weight: 800; padding-top: 6px; }
  .words { margin-top: 8px; padding: 6px 8px; background: #f1f5f9; border-radius: 4px; font-weight: 600; }
  .hsn th { background: #f1f5f9; font-size: 8.5px; text-transform: uppercase; padding: 4px; text-align: right; }
  .hsn th:first-child, .hsn td:first-child { text-align: left; }
  .hsn td { padding: 3px 4px; border-bottom: 1px solid #e2e8f0; text-align: right; font-variant-numeric: tabular-nums; }
  .sign { text-align: right; margin-top: 26px; }
  .foot { margin-top: 12px; border-top: 1px solid #e2e8f0; padding-top: 6px; font-size: 8.5px; color: #64748b; display: flex; justify-content: space-between; }
  .wm { position: fixed; top: 38%; left: 0; right: 0; text-align: center; transform: rotate(-24deg); font-size: 56px; font-weight: 900; color: rgba(180, 83, 9, 0.09); pointer-events: none; z-index: 0; }
`

export function buildDocumentHtml(ctx: ServiceContext, kind: DocumentKind, id: number): string {
  const doc = loadDocument(ctx, kind, id)
  const company = ctx.db.prepare('SELECT * FROM companies WHERE id = ?').get(ctx.companyId) as CompanyPrint
  const party = doc.partyId
    ? (ctx.db.prepare(`SELECT name, gstin, pan, phone, email, state_code FROM ${KINDS[kind].party === 'CUSTOMER' ? 'customers' : 'suppliers'} WHERE id = ?`).get(doc.partyId) as {
        name: string; gstin: string | null; pan: string | null; phone: string | null; email: string | null; state_code: string
      })
    : null
  return renderDocumentHtml(doc, company, party)
}

export function renderDocumentHtml(
  doc: DocumentDetail,
  company: CompanyPrint,
  party: { name: string; gstin: string | null; pan: string | null; phone: string | null; email: string | null; state_code: string } | null
): string {
  const cfg = KINDS[doc.kind]
  const inter = doc.isInterState
  const isDraft = doc.status === 'DRAFT'
  const companyAddr = [company.address_line1, company.address_line2, [company.city, company.pincode].filter(Boolean).join(' - '), stateName(company.state_code)].filter(Boolean).join(', ')
  const partyLabel = cfg.party === 'CUSTOMER' ? 'Bill to' : 'Supplier'
  const taxCols = inter ? 1 : 2

  const lineRows = doc.lines
    .map(
      (l, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td><b>${esc(l.description ?? l.productName)}</b><div class="muted small">${esc(l.productCode)}</div></td>
        <td>${esc(l.hsnSac)}</td>
        <td class="r">${esc(milliToString(l.qtyMilli))} ${esc(l.unitCode)}</td>
        <td class="r">${inr(l.ratePaise)}</td>
        <td class="r">${l.discountPaise ? `${inr(l.discountPaise)}${l.discountBps != null ? `<div class="small muted">${pct(l.discountBps)}</div>` : ''}` : '—'}</td>
        <td class="r">${inr(l.taxablePaise)}</td>
        <td class="r">${pct(l.taxRateBps)}</td>
        ${inter ? `<td class="r">${inr(l.igstPaise)}</td>` : `<td class="r">${inr(l.cgstPaise)}</td><td class="r">${inr(l.sgstPaise)}</td>`}
        <td class="r"><b>${inr(l.totalPaise)}</b></td>
      </tr>`
    )
    .join('')

  const charge = (label: string, amount: number, bps: number) => {
    if (!amount) return ''
    const tax = Math.round((amount * bps) / 10000)
    const half = Math.ceil(tax / 2)
    return `<tr><td></td><td colspan="5"><b>${esc(label)}</b></td><td class="r">${inr(amount)}</td><td class="r">${pct(bps)}</td>${
      inter ? `<td class="r">${inr(tax)}</td>` : `<td class="r">${inr(half)}</td><td class="r">${inr(tax - half)}</td>`
    }<td class="r"><b>${inr(amount + tax)}</b></td></tr>`
  }

  // HSN/SAC-wise tax summary (as required on GST invoices).
  const hsn = new Map<string, { taxable: number; rate: number; cgst: number; sgst: number; igst: number }>()
  for (const l of doc.lines) {
    const key = `${l.hsnSac}|${l.taxRateBps}`
    const h = hsn.get(key) ?? { taxable: 0, rate: l.taxRateBps, cgst: 0, sgst: 0, igst: 0 }
    h.taxable += l.taxablePaise
    h.cgst += l.cgstPaise
    h.sgst += l.sgstPaise
    h.igst += l.igstPaise
    hsn.set(key, h)
  }
  const hsnRows = [...hsn.entries()]
    .map(([key, h]) => `<tr><td>${esc(key.split('|')[0])}</td><td>${inr(h.taxable)}</td><td>${pct(h.rate)}</td>${inter ? `<td>${inr(h.igst)}</td>` : `<td>${inr(h.cgst)}</td><td>${inr(h.sgst)}</td>`}<td>${inr(h.cgst + h.sgst + h.igst)}</td></tr>`)
    .join('')

  const total = (label: string, value: number, cls = '') => `<tr class="${cls}"><td>${esc(label)}</td><td class="r">${value < 0 ? '−' : ''}₹ ${inr(Math.abs(value))}</td></tr>`
  const meta = (label: string, value: string | null | undefined) => (value ? `<div><div class="label">${esc(label)}</div><b>${esc(value)}</b></div>` : '')
  const terms = doc.terms ?? (cfg.side === 'SALES' ? company.invoice_terms : null)
  const bank = company.bank_name || company.bank_account_no
  const statusBadge =
    doc.status === 'CANCELLED'
      ? `<div class="badge cancel">CANCELLED${doc.cancelReason ? ` — ${esc(doc.cancelReason)}` : ''}</div>`
      : isDraft
        ? '<div class="badge">DRAFT — NOT ISSUED</div>'
        : ''

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(cfg.printTitle)} ${esc(doc.number)}</title><style>${STYLE}</style></head><body style="margin:0">
<div class="doc">
  ${company.is_demo ? '<div class="wm">DEMO DATA</div>' : ''}
  <div class="head">
    <div>
      <h1>${esc(company.name)}</h1>
      ${company.legal_name ? `<div class="muted">${esc(company.legal_name)}</div>` : ''}
      <div>${esc(companyAddr)}</div>
      <div>${company.gstin ? `GSTIN <b>${esc(company.gstin)}</b>` : 'GST unregistered'}${company.pan ? ` &nbsp;·&nbsp; PAN ${esc(company.pan)}` : ''}</div>
      <div class="muted">${[company.phone, company.email].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    <div class="title">
      <div class="t">${esc(cfg.printTitle)}</div>
      ${cfg.kind === 'SALES_INVOICE' ? '<div class="muted small">Original for recipient</div>' : ''}
      ${company.is_demo ? '<div class="badge">DEMO — NOT A VALID TAX DOCUMENT</div>' : ''}
      ${statusBadge}
    </div>
  </div>

  <div class="meta">
    ${meta(`${cfg.label} no.`, isDraft ? 'Assigned on posting' : doc.number)}
    ${meta('Date', date(doc.date))}
    ${meta(cfg.dueDateLabel, doc.dueDate ? date(doc.dueDate) : null)}
    ${meta('Place of supply', `${doc.placeOfSupply} - ${stateName(doc.placeOfSupply)}`)}
    ${meta('Supply type', inter ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)')}
    ${meta('Payment terms', isInvoiceKind(doc.kind) ? `${doc.paymentTermsDays} days` : null)}
    ${meta('Reference', doc.referenceNo)}
    ${meta(cfg.supplierRefLabel ?? 'Supplier ref.', doc.supplierRef ? `${doc.supplierRef}${doc.supplierRefDate ? ` (${date(doc.supplierRefDate)})` : ''}` : null)}
    ${meta('Against', doc.source ? `${KINDS[doc.source.kind].label} ${doc.source.number}` : null)}
    ${meta('Prices', doc.pricingMode === 'INCLUSIVE' ? 'Inclusive of GST' : null)}
  </div>

  <div class="row" style="margin-bottom:10px">
    <div class="box grow">
      <div class="label">${partyLabel}</div>
      ${party ? `<b style="font-size:12px">${esc(party.name)}</b>
      <div>${nl(doc.billingAddress)}</div>
      <div>${esc(stateName(party.state_code))} (${esc(party.state_code)})</div>
      <div>${party.gstin ? `GSTIN <b>${esc(party.gstin)}</b>` : 'Unregistered'}${party.pan && !party.gstin ? ` · PAN ${esc(party.pan)}` : ''}</div>
      <div class="muted">${[party.phone, party.email].filter(Boolean).map(esc).join(' · ')}</div>` : '<span class="muted">—</span>'}
    </div>
    <div class="box grow">
      <div class="label">${cfg.party === 'CUSTOMER' ? 'Ship to' : 'Deliver to'}</div>
      ${cfg.party === 'CUSTOMER' ? `<b>${esc(party?.name ?? '')}</b><div>${nl(doc.shippingAddress ?? doc.billingAddress)}</div>` : `<b>${esc(company.name)}</b><div>${esc(doc.warehouseName ?? '')}</div><div>${esc(companyAddr)}</div>`}
      ${doc.reason ? `<div style="margin-top:4px"><span class="label">Reason</span> ${esc(doc.reason)}</div>` : ''}
    </div>
  </div>

  <table class="items">
    <thead><tr>
      <th class="c">#</th><th>Item / description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc.</th><th class="r">Taxable</th><th class="r">GST</th>
      ${inter ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}<th class="r">Amount</th>
    </tr></thead>
    <tbody>
      ${lineRows}
      ${charge('Freight', doc.freightPaise, doc.freightTaxBps)}
      ${charge(doc.otherChargesLabel ?? 'Other charges', doc.otherChargesPaise, doc.otherChargesTaxBps)}
    </tbody>
  </table>

  <div class="row" style="margin-top:10px; align-items:flex-start">
    <div class="grow">
      <table class="hsn">
        <thead><tr><th>HSN/SAC</th><th>Taxable</th><th>Rate</th>${inter ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}<th>Total tax</th></tr></thead>
        <tbody>${hsnRows}</tbody>
      </table>
      <div class="words">${esc(amountInWordsINR(doc.grandTotalPaise))}</div>
      ${doc.notes ? `<div style="margin-top:8px"><div class="label">Notes</div>${nl(doc.notes)}</div>` : ''}
    </div>
    <div style="width:${taxCols === 1 ? 230 : 240}px">
      <table class="totals">
        ${total('Subtotal', doc.subtotalPaise)}
        ${doc.discountPaise ? total('Discount', -doc.discountPaise) : ''}
        ${doc.freightPaise || doc.otherChargesPaise ? total('Charges', doc.freightPaise + doc.otherChargesPaise) : ''}
        ${total('Taxable value', doc.taxablePaise)}
        ${inter ? total('IGST', doc.igstPaise) : `${total('CGST', doc.cgstPaise)}${total('SGST', doc.sgstPaise)}`}
        ${doc.roundOffPaise ? total('Round off', doc.roundOffPaise) : ''}
        ${total('Grand total', doc.grandTotalPaise, 'grand')}
        ${isInvoiceKind(doc.kind) && doc.status === 'POSTED' ? `${total(cfg.side === 'SALES' ? 'Amount received' : 'Amount paid', doc.settledPaise)}${total('Balance due', doc.balanceDuePaise)}` : ''}
      </table>
    </div>
  </div>

  <div class="row" style="margin-top:12px">
    ${cfg.side === 'SALES' && bank ? `<div class="box grow"><div class="label">Payment details</div>
      ${company.bank_name ? `<div>Bank: <b>${esc(company.bank_name)}</b>${company.bank_branch ? `, ${esc(company.bank_branch)}` : ''}</div>` : ''}
      ${company.bank_account_no ? `<div>A/c no.: <b>${esc(company.bank_account_no)}</b></div>` : ''}
      ${company.bank_ifsc ? `<div>IFSC: <b>${esc(company.bank_ifsc)}</b></div>` : ''}
      ${company.upi_id ? `<div>UPI: <b>${esc(company.upi_id)}</b></div>` : ''}
    </div>` : ''}
    ${terms ? `<div class="box grow"><div class="label">Terms &amp; conditions</div>${nl(terms)}</div>` : ''}
  </div>

  <div class="sign">For <b>${esc(company.name)}</b><br><br><br>Authorised signatory</div>
  <div class="foot">
    <span>This is a computer-generated document${company.is_demo ? ' prepared with DEMONSTRATION data — not valid for tax purposes' : ''}.</span>
    <span>${esc(cfg.label)} ${esc(isDraft ? 'DRAFT' : doc.number)}</span>
  </div>
</div></body></html>`
}
