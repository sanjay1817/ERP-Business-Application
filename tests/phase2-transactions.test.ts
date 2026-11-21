import { describe, expect, it } from 'vitest'
import { toMilli, toPaise } from '@shared/money'
import { computeTaxDocument, computeTaxLine, isInterStateSupply, allocateFifo, allocateProportionally } from '@shared/tax'
import { amountInWordsINR, numberToWordsIndian } from '@shared/words'
import { DocumentSaveInput, PaymentCreateInput } from '@shared/documents'
import { cancelDocument, convertDocument, deleteDraft, postDocument, saveDraft, validateDocument } from '../src/main/services/documents/engine'
import { loadDocument, listDocuments } from '../src/main/services/documents/store'
import { createPayment, openInvoices } from '../src/main/services/documents/payments'
import { buildDocumentHtml } from '../src/main/services/documents/print'
import { moduleSummary, register } from '../src/main/services/documents/summary'
import { trialBalance } from '../src/main/services/reports'
import { fromSqliteError } from '../src/main/services/errors'
import { D1, D2, D3, fixture, type Fixture } from './phase2-fixtures'

const line = (productId: number, qty: number, rate: number, extra: Record<string, unknown> = {}) => ({ productId, qtyMilli: toMilli(qty), ratePaise: toPaise(rate), ...extra })
const sale = (f: Fixture, customer: number, lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
  f.save({ kind: 'SALES_INVOICE', partyId: customer, date: D2, warehouseId: f.wh, lines, ...extra })
const purchase = (f: Fixture, supplier: number, ref: string, lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
  f.save({ kind: 'PURCHASE_INVOICE', partyId: supplier, date: D1, supplierRef: ref, warehouseId: f.wh, lines, ...extra })

function assertBooksBalanced(f: Fixture) {
  const unbalanced = f.db.prepare(`SELECT je.id FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
    GROUP BY je.id HAVING SUM(l.debit_paise) <> SUM(l.credit_paise) OR SUM(l.debit_paise) <> je.total_debit_paise`).all()
  expect(unbalanced).toEqual([])
  const tb = trialBalance(f.ctx)
  expect(tb.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0)).toBe(0)
  expect(f.ledger('INVENTORY')).toBe(f.stockValue())
}

// ───────────────────────── GST calculation service ─────────────────────────
describe('GST calculation service', () => {
  it('3. splits intra-state tax into equal CGST and SGST (odd paisa to CGST)', () => {
    const l = computeTaxLine({ qtyMilli: toMilli(1), ratePaise: 10001, taxRateBps: 1800 }, 'EXCLUSIVE', false)
    expect(l.taxablePaise).toBe(10001)
    expect(l.taxPaise).toBe(1800)
    expect(l.cgst).toBe(900)
    expect(l.sgst).toBe(900)
    expect(l.igst).toBe(0)
    const odd = computeTaxLine({ qtyMilli: toMilli(1), ratePaise: 100, taxRateBps: 500 }, 'EXCLUSIVE', false) // tax 5 paise
    expect([odd.cgst, odd.sgst]).toEqual([3, 2])
  })

  it('4. uses IGST for inter-state, SEZ and export supplies', () => {
    const l = computeTaxLine({ qtyMilli: toMilli(2), ratePaise: toPaise(500), taxRateBps: 1800 }, 'EXCLUSIVE', true)
    expect(l).toMatchObject({ taxablePaise: 100000, igst: 18000, cgst: 0, sgst: 0, totalPaise: 118000 })
    expect(isInterStateSupply({ supplierState: '33', placeOfSupply: '29' })).toBe(true)
    expect(isInterStateSupply({ supplierState: '33', placeOfSupply: '33' })).toBe(false)
    expect(isInterStateSupply({ supplierState: '33', placeOfSupply: '33', partyRegistrationType: 'SEZ' })).toBe(true)
    expect(isInterStateSupply({ supplierState: '33', placeOfSupply: '33', partyRegistrationType: 'OVERSEAS' })).toBe(true)
  })

  it('5. back-calculates tax from GST-inclusive prices so the total equals the price charged', () => {
    const l = computeTaxLine({ qtyMilli: toMilli(1), ratePaise: toPaise(1180), taxRateBps: 1800 }, 'INCLUSIVE', false)
    expect(l).toMatchObject({ taxablePaise: 100000, taxPaise: 18000, cgst: 9000, sgst: 9000, totalPaise: 118000 })
    const odd = computeTaxLine({ qtyMilli: toMilli(3), ratePaise: toPaise(99.99), taxRateBps: 1200 }, 'INCLUSIVE', true)
    expect(odd.taxablePaise + odd.taxPaise).toBe(29997)
    const doc = computeTaxDocument({ pricingMode: 'INCLUSIVE', interState: false, lines: [{ qtyMilli: toMilli(2), ratePaise: toPaise(1949), taxRateBps: 1800 }] })
    expect(doc.totals.taxablePaise + doc.totals.taxPaise).toBe(389800)
    expect(doc.totals.grandTotalPaise).toBe(389800)
  })

  it('6. applies percentage and amount discounts before tax, and rejects excessive discounts', () => {
    const pct = computeTaxLine({ qtyMilli: toMilli(4), ratePaise: toPaise(250), discountBps: 1000, taxRateBps: 1800 }, 'EXCLUSIVE', false)
    expect(pct).toMatchObject({ grossPaise: 100000, discountPaise: 10000, taxablePaise: 90000, taxPaise: 16200 })
    const amt = computeTaxLine({ qtyMilli: toMilli(4), ratePaise: toPaise(250), discountPaise: toPaise(55.5), taxRateBps: 500 }, 'EXCLUSIVE', true)
    expect(amt).toMatchObject({ discountPaise: 5550, taxablePaise: 94450, igst: 4723 })
    expect(() => computeTaxLine({ qtyMilli: toMilli(1), ratePaise: 100, discountPaise: 101, taxRateBps: 0 }, 'EXCLUSIVE', false)).toThrow(/exceed/)
    expect(() => computeTaxLine({ qtyMilli: toMilli(1), ratePaise: 100, discountBps: 10001, taxRateBps: 0 }, 'EXCLUSIVE', false)).toThrow(/100%/)
  })

  it('rounds the invoice total to the rupee and reports the round-off', () => {
    const doc = computeTaxDocument({
      pricingMode: 'EXCLUSIVE', interState: false,
      lines: [{ qtyMilli: toMilli(3), ratePaise: 33333, taxRateBps: 1800 }, { qtyMilli: toMilli(1.5), ratePaise: 12345, taxRateBps: 500 }],
      charges: [{ amountPaise: 15000, taxRateBps: 1800 }]
    })
    const exact = doc.totals.taxablePaise + doc.totals.taxPaise
    expect(doc.totals.grandTotalPaise % 100).toBe(0)
    expect(doc.totals.grandTotalPaise - exact).toBe(doc.totals.roundOffPaise)
    expect(Math.abs(doc.totals.roundOffPaise)).toBeLessThanOrEqual(50)
    expect(doc.totals.chargesPaise).toBe(15000)
  })

  it('splits freight pro rata and allocates payments oldest-first', () => {
    expect(allocateProportionally(1000, [1, 1, 1])).toEqual([334, 333, 333])
    expect(allocateProportionally(100, [300, 100])).toEqual([75, 25])
    expect(allocateFifo(1500, [{ invoiceId: 1, balancePaise: 1000 }, { invoiceId: 2, balancePaise: 1000 }])).toEqual([{ invoiceId: 1, amountPaise: 1000 }, { invoiceId: 2, amountPaise: 500 }])
  })
})

// ───────────────────────── Sales ─────────────────────────
describe('sales invoices', () => {
  it('1. creates a draft, posts it with the next legal number and the correct effects', () => {
    const f = fixture()
    const draft = sale(f, f.intra, [line(f.widget, 2, 1000), line(f.service, 1.5, 2000)], { referenceNo: 'PO-77', notes: 'Thanks' })
    expect(draft.status).toBe('DRAFT')
    expect(draft.number).toMatch(/^DRAFT-\d+$/)
    expect(draft.dueDate).toBe('2026-11-04') // 30 credit days
    expect(draft.billingAddress).toContain('1 Test Street')
    const posted = f.post(draft)
    expect(posted.status).toBe('POSTED')
    expect(posted.number).toBe('INV/2026-27/0001')
    expect(posted.journalEntryNo).toBeTruthy()
    expect(posted.paymentStatus).toBe('UNPAID')
    expect(posted.balanceDuePaise).toBe(posted.grandTotalPaise)
  })

  it('2. computes line and footer totals (discounts, taxes, round-off)', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 3, 333.33, { discountBps: 500 }), line(f.gear, 2, 99.99, { discountPaise: toPaise(10) })])
    const [a, b] = d.lines
    expect(a).toMatchObject({ grossPaise: 99999, discountPaise: 5000, taxablePaise: 94999, taxRateBps: 1800, cgstPaise: 8550, sgstPaise: 8550 })
    expect(b).toMatchObject({ grossPaise: 19998, discountPaise: 1000, taxablePaise: 18998, taxRateBps: 500, cgstPaise: 475, sgstPaise: 475 })
    expect(d.subtotalPaise).toBe(119997)
    expect(d.discountPaise).toBe(6000)
    expect(d.taxablePaise).toBe(113997)
    expect(d.cgstPaise + d.sgstPaise).toBe(18050)
    expect(d.grandTotalPaise).toBe(132000)
    expect(d.roundOffPaise).toBe(132000 - 132047)
  })

  it('3/4. chooses CGST+SGST or IGST from the place of supply (and SEZ)', () => {
    const f = fixture()
    const intra = sale(f, f.intra, [line(f.widget, 1, 1000)])
    expect(intra).toMatchObject({ isInterState: false, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 })
    const inter = sale(f, f.inter, [line(f.widget, 1, 1000)])
    expect(inter).toMatchObject({ isInterState: true, placeOfSupply: '29', igstPaise: 18000, cgstPaise: 0 })
    const sez = sale(f, f.sez, [line(f.widget, 1, 1000)])
    expect(sez).toMatchObject({ isInterState: true, placeOfSupply: '33', igstPaise: 18000 })
    const overridden = sale(f, f.intra, [line(f.widget, 1, 1000)], { placeOfSupply: '27' })
    expect(overridden.isInterState).toBe(true)
  })

  it('5. supports GST-inclusive pricing on documents', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 2, 1180)], { pricingMode: 'INCLUSIVE' })
    expect(d).toMatchObject({ pricingMode: 'INCLUSIVE', taxablePaise: 200000, cgstPaise: 18000, sgstPaise: 18000, grandTotalPaise: 236000 })
  })

  it('uses each product\'s own GST rate and rejects rates not in the tax master', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 1, 100), line(f.gear, 1, 100)])
    expect(d.lines.map((l) => l.taxRateBps)).toEqual([1800, 500])
    expect(() => sale(f, f.intra, [line(f.widget, 1, 100, { taxRateBps: 1200 })])).toThrow(/highlighted/)
  })

  it('11/12. posting reduces goods stock at moving-average cost; services never touch stock', () => {
    const f = fixture()
    const before = f.count('SELECT COUNT(*) n FROM stock_movements')
    const posted = f.post(sale(f, f.intra, [line(f.widget, 4, 1000), line(f.service, 2, 2000)]))
    expect(f.stock(f.widget)).toBe(toMilli(6))
    expect(f.count('SELECT COUNT(*) n FROM stock_movements')).toBe(before + 1)
    const move = f.db.prepare(`SELECT * FROM stock_movements WHERE reference_type = 'SALES_INVOICE' AND reference_id = ?`).get(posted.id) as Record<string, number | string>
    expect(move).toMatchObject({ product_id: f.widget, qty_out_milli: toMilli(4), value_paise: toPaise(2400), reference_no: posted.number, warehouse_id: f.wh })
    expect(f.count(`SELECT COUNT(*) n FROM stock_movements WHERE product_id = ?`, f.service)).toBe(0)
    expect(loadDocument(f.ctx, 'SALES_INVOICE', posted.id).lines[0].costPaise).toBe(toPaise(2400))
    assertBooksBalanced(f)
  })

  it('13. prevents negative stock: validation reports it and posting changes nothing', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 7, 1000), line(f.widget, 4, 1000)]) // 11 > 10 on hand (aggregated)
    const v = validateDocument(f.ctx, 'SALES_INVOICE', d.id)
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toMatch(/Insufficient stock for WID.*available 10, required 11/)
    expect(() => f.post(d)).toThrow(/Insufficient stock/)
    expect(f.stock(f.widget)).toBe(toMilli(10))
    expect(loadDocument(f.ctx, 'SALES_INVOICE', d.id).status).toBe('DRAFT')
  })

  it('9. customer outstanding follows invoices, receipts and credit notes', () => {
    const f = fixture()
    const inv = f.post(sale(f, f.intra, [line(f.widget, 1, 1000)]))
    expect(f.customerBalance(f.intra)).toBe(inv.grandTotalPaise)
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: 50000, mode: 'UPI', accountId: f.bank, referenceNo: 'U1', allocations: [{ invoiceId: inv.id, amountPaise: 50000 }] })
    expect(f.customerBalance(f.intra)).toBe(inv.grandTotalPaise - 50000)
    const cn = f.post(convertDocument(f.ctx, 'SALES_INVOICE', inv.id, 'CREDIT_NOTE', { date: D3, reason: 'Goodwill', lines: [line(f.service, 1, 100)] }))
    expect(f.customerBalance(f.intra)).toBe(inv.grandTotalPaise - 50000 - cn.grandTotalPaise)
    const after = loadDocument(f.ctx, 'SALES_INVOICE', inv.id)
    expect(after.settledPaise).toBe(50000 + cn.grandTotalPaise)
    expect(after.paymentStatus).toBe('PARTIAL')
    assertBooksBalanced(f)
  })
})

// ───────────────────────── Purchase ─────────────────────────
describe('purchase invoices', () => {
  it('7/10. posts a bill: stock increases at cost incl. freight; journal debits inventory, expenses and input GST', () => {
    const f = fixture()
    const d = purchase(f, f.vendor, 'BILL-1', [line(f.widget, 10, 600), line(f.gear, 20, 150), line(f.service, 2, 500)], {
      freightPaise: toPaise(900), freightTaxBps: 1800, otherChargesPaise: toPaise(100), otherChargesLabel: 'Loading', otherChargesTaxBps: 1800
    })
    expect(d.taxablePaise).toBe(toPaise(6000 + 3000 + 1000 + 900 + 100))
    const p = f.post(d)
    expect(p.number).toBe('PUR/2026-27/0001')
    expect(f.stock(f.widget)).toBe(toMilli(20))
    expect(f.stock(f.gear)).toBe(toMilli(20))
    // Freight ₹900 capitalised pro rata on goods: widget 6000 → +600, gear 3000 → +300.
    expect(p.lines.map((l) => l.costPaise)).toEqual([toPaise(6600), toPaise(3300), 0])
    expect(f.ledger('PURCHASE_SERVICES')).toBe(toPaise(1000))
    expect(f.ledger('OTHER_PURCHASE_CHARGES')).toBe(toPaise(100))
    expect(f.ledger('FREIGHT_INWARD')).toBe(0)
    expect(f.ledger('INPUT_CGST') + f.ledger('INPUT_SGST')).toBe(p.cgstPaise + p.sgstPaise)
    expect(f.count(`SELECT COUNT(*) n FROM stock_movements WHERE reference_type='PURCHASE_INVOICE' AND reference_id = ?`, p.id)).toBe(2)
    assertBooksBalanced(f)
  })

  it('expenses freight when the bill has no stocked goods, and uses IGST for out-of-state suppliers', () => {
    const f = fixture()
    const p = f.post(purchase(f, f.vendorOut, 'SVC-9', [line(f.service, 1, 1000)], { freightPaise: toPaise(200), freightTaxBps: 1800 }))
    expect(p.isInterState).toBe(true)
    expect(p.igstPaise).toBe(toPaise(216))
    expect(f.ledger('FREIGHT_INWARD')).toBe(toPaise(200))
    assertBooksBalanced(f)
  })

  it('8. supplier outstanding and payment status follow bills and payments', () => {
    const f = fixture()
    const p = f.post(purchase(f, f.vendor, 'B-77', [line(f.widget, 5, 600)]))
    expect(f.supplierBalance(f.vendor)).toBe(p.grandTotalPaise)
    expect(openInvoices(f.ctx, 'PAYMENT', f.vendor)).toEqual([expect.objectContaining({ invoiceId: p.id, balancePaise: p.grandTotalPaise })])
    createPayment(f.ctx, { type: 'PAYMENT', partyId: f.vendor, date: D3, amountPaise: p.grandTotalPaise, mode: 'BANK_TRANSFER', accountId: f.bank, allocations: [{ invoiceId: p.id, amountPaise: p.grandTotalPaise }] })
    expect(f.supplierBalance(f.vendor)).toBe(0)
    expect(loadDocument(f.ctx, 'PURCHASE_INVOICE', p.id).paymentStatus).toBe('PAID')
    expect(openInvoices(f.ctx, 'PAYMENT', f.vendor)).toEqual([])
  })

  it('requires the supplier invoice number before posting', () => {
    const f = fixture()
    const d = f.save({ kind: 'PURCHASE_INVOICE', partyId: f.vendor, date: D1, warehouseId: f.wh, lines: [line(f.widget, 1, 600)] })
    expect(d.supplierRef).toBeNull()
    expect(validateDocument(f.ctx, 'PURCHASE_INVOICE', d.id).errors).toContain('Enter the supplier invoice number')
  })
})

// ───────────────────────── Drafts, duplicates, rollback ─────────────────────────
describe('drafts versus posted documents', () => {
  it('14. drafts have no stock/ledger effect, are editable and deletable, and do not consume legal numbers', () => {
    const f = fixture()
    const je = f.count('SELECT COUNT(*) n FROM journal_entries')
    const a = sale(f, f.intra, [line(f.widget, 1, 1000)])
    const b = sale(f, f.intra, [line(f.widget, 2, 1000)])
    expect(f.stock(f.widget)).toBe(toMilli(10))
    expect(f.count('SELECT COUNT(*) n FROM journal_entries')).toBe(je)
    expect(f.customerBalance(f.intra)).toBe(0)
    const edited = saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', id: a.id, partyId: f.inter, date: D3, warehouseId: f.wh, lines: [line(f.widget, 3, 900)] }))
    expect(edited).toMatchObject({ id: a.id, partyId: f.inter, isInterState: true, date: D3 })
    expect(edited.lines).toHaveLength(1)
    deleteDraft(f.ctx, 'SALES_INVOICE', b.id)
    expect(() => loadDocument(f.ctx, 'SALES_INVOICE', b.id)).toThrow(/not found/)
    const posted = f.post(edited)
    expect(posted.number).toBe('INV/2026-27/0001')
    // Posted documents are immutable through the service and the database.
    expect(() => saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', id: a.id, partyId: f.inter, date: D3, warehouseId: f.wh, lines: [line(f.widget, 1, 1)] }))).toThrow(/cannot be edited/)
    expect(() => deleteDraft(f.ctx, 'SALES_INVOICE', a.id)).toThrow(/Only drafts/)
    expect(() => f.db.prepare('UPDATE sales_invoices SET grand_total_paise = 1 WHERE id = ?').run(a.id)).toThrow(/cannot be edited/)
  })

  it('does not update stock twice: a posted document cannot be posted again', () => {
    const f = fixture()
    const posted = f.post(sale(f, f.intra, [line(f.widget, 2, 1000)]))
    expect(() => postDocument(f.ctx, 'SALES_INVOICE', posted.id)).toThrow(/already posted/)
    expect(f.stock(f.widget)).toBe(toMilli(8))
    expect(f.count(`SELECT COUNT(*) n FROM stock_movements WHERE reference_type='SALES_INVOICE' AND reference_id = ?`, posted.id)).toBe(1)
  })
})

describe('duplicate prevention', () => {
  it('15. rejects duplicate supplier bills (exact and normalised) but allows re-entry after cancellation', () => {
    const f = fixture()
    const p = f.post(purchase(f, f.vendor, 'INV/26/001', [line(f.gear, 1, 150)]))
    let err: unknown
    try {
      purchase(f, f.vendor, 'INV/26/001', [line(f.gear, 1, 150)])
    } catch (e) {
      err = e
    }
    expect(fromSqliteError(err)?.fieldErrors?.supplierRef).toMatch(/already recorded/)
    expect(() => purchase(f, f.vendor, 'inv 26 001', [line(f.gear, 1, 150)])).toThrow(/highlighted/)
    // Same bill number from a different supplier is fine.
    expect(() => purchase(f, f.vendorOut, 'INV/26/001', [line(f.gear, 1, 150)])).not.toThrow()
    cancelDocument(f.ctx, 'PURCHASE_INVOICE', p.id, 'Entered twice')
    expect(() => f.post(purchase(f, f.vendor, 'INV/26/001', [line(f.gear, 1, 150)]))).not.toThrow()
  })

  it('15. keeps sales invoice numbers unique and gap-free per financial year', () => {
    const f = fixture()
    const nos = [1, 2, 3].map(() => f.post(sale(f, f.intra, [line(f.service, 1, 100)])).number)
    expect(nos).toEqual(['INV/2026-27/0001', 'INV/2026-27/0002', 'INV/2026-27/0003'])
    const prev = f.post(sale(f, f.intra, [line(f.service, 1, 100)], { date: '2026-03-20' }))
    expect(prev.number).toBe('INV/2025-26/0001')
    expect(prev.financialYear).toBe('2025-26')
  })
})

describe('transaction rollback', () => {
  it('18. a failure mid-posting leaves no number, stock, journal or allocation behind', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 2, 1000)])
    const snap = () => [
      f.count('SELECT COUNT(*) n FROM journal_entries'), f.count('SELECT COUNT(*) n FROM stock_movements'),
      f.count(`SELECT COALESCE(MAX(next_number),0) n FROM document_sequences WHERE doc_type='SALES_INVOICE'`), f.stock(f.widget)
    ]
    const before = snap()
    // Make the revenue account unusable so the journal fails after stock was already moved.
    f.db.prepare(`UPDATE chart_of_accounts SET is_active = 0 WHERE system_key = 'SALES_GOODS' AND company_id = ?`).run(f.ctx.companyId)
    expect(() => f.post(d)).toThrow(/inactive account/)
    expect(snap()).toEqual(before)
    expect(loadDocument(f.ctx, 'SALES_INVOICE', d.id)).toMatchObject({ status: 'DRAFT', number: `DRAFT-${d.id}` })
  })

  it('18. a payment with an invalid allocation is rejected completely', () => {
    const f = fixture()
    const inv = f.post(sale(f, f.intra, [line(f.widget, 1, 1000)]))
    const receipts = f.count('SELECT COUNT(*) n FROM payment_receipts')
    expect(() =>
      createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: inv.grandTotalPaise + 100, mode: 'UPI', accountId: f.bank, allocations: [{ invoiceId: inv.id, amountPaise: inv.grandTotalPaise + 100 }] })
    ).toThrow(/highlighted/)
    expect(f.count('SELECT COUNT(*) n FROM payment_receipts')).toBe(receipts)
    expect(f.customerBalance(f.intra)).toBe(inv.grandTotalPaise)
  })
})

// ───────────────────────── Payments ─────────────────────────
describe('payment allocation', () => {
  it('17. allocates receipts to invoices, keeps the remainder on account, and validates allocations', () => {
    const f = fixture()
    const a = f.post(sale(f, f.intra, [line(f.service, 1, 1000)]))
    const b = f.post(sale(f, f.intra, [line(f.service, 1, 2000)]))
    const other = f.post(sale(f, f.inter, [line(f.service, 1, 500)]))
    const r = createPayment(f.ctx, {
      type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: toPaise(3000), mode: 'BANK_TRANSFER', accountId: f.bank, referenceNo: 'UTR1',
      allocations: [{ invoiceId: a.id, amountPaise: a.grandTotalPaise }, { invoiceId: b.id, amountPaise: toPaise(1000) }]
    })
    expect(r.allocatedPaise).toBe(a.grandTotalPaise + toPaise(1000))
    expect(r.unallocatedPaise).toBe(toPaise(3000) - r.allocatedPaise)
    expect(loadDocument(f.ctx, 'SALES_INVOICE', a.id).paymentStatus).toBe('PAID')
    const bb = loadDocument(f.ctx, 'SALES_INVOICE', b.id)
    expect(bb).toMatchObject({ paymentStatus: 'PARTIAL', settledPaise: toPaise(1000), balanceDuePaise: b.grandTotalPaise - toPaise(1000) })
    expect(f.ledger('BANK')).toBe(toPaise(500000) + toPaise(3000))
    expect(() => createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: 100, mode: 'UPI', accountId: f.bank, allocations: [{ invoiceId: other.id, amountPaise: 100 }] })).toThrow(/highlighted/)
    expect(PaymentCreateInput.safeParse({ type: 'RECEIPT', partyId: 1, date: D3, amountPaise: 100, mode: 'UPI', accountId: 1, allocations: [{ invoiceId: 1, amountPaise: 101 }] }).success).toBe(false)
    expect(PaymentCreateInput.safeParse({ type: 'RECEIPT', partyId: 1, date: D3, amountPaise: 100, mode: 'CHEQUE', accountId: 1 }).success).toBe(false)
    expect(() => createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: 100, mode: 'UPI', accountId: accountIdOf(f, 'SALES_GOODS'), allocations: [] })).toThrow(/highlighted/)
    assertBooksBalanced(f)
  })

  it('does not treat an unpaid invoice as received, and blocks overdrawing a cash/bank account', () => {
    const f = fixture()
    const inv = f.post(sale(f, f.intra, [line(f.widget, 1, 1000)]))
    expect(inv.settledPaise).toBe(0)
    expect(f.ledger('CASH')).toBe(0)
    const bill = f.post(purchase(f, f.vendor, 'X1', [line(f.gear, 1, 150)]))
    expect(() => createPayment(f.ctx, { type: 'PAYMENT', partyId: f.vendor, date: D3, amountPaise: bill.grandTotalPaise, mode: 'CASH', accountId: f.cash, allocations: [] })).toThrow(/Insufficient cash/)
  })
})

const accountIdOf = (f: Fixture, key: string) => (f.db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND system_key = ?').get(f.ctx.companyId, key) as { id: number }).id

// ───────────────────────── Document flows ─────────────────────────
describe('document flows and reversals', () => {
  it('converts quotation → order → invoice without stock effect until invoicing', () => {
    const f = fixture()
    const q = f.post(f.save({ kind: 'SALES_QUOTATION', partyId: f.intra, date: D1, lines: [line(f.widget, 2, 1000), line(f.service, 1, 2000)] }))
    expect(q.number).toBe('QT/2026-27/0001')
    const so = f.post(convertDocument(f.ctx, 'SALES_QUOTATION', q.id, 'SALES_ORDER', { date: D2 }))
    expect(so.source).toMatchObject({ kind: 'SALES_QUOTATION', number: q.number })
    expect(f.stock(f.widget)).toBe(toMilli(10))
    expect(f.count('SELECT COUNT(*) n FROM journal_entries WHERE source_kind IN (?, ?)', 'SALES_QUOTATION', 'SALES_ORDER')).toBe(0)
    const inv = f.post(convertDocument(f.ctx, 'SALES_ORDER', so.id, 'SALES_INVOICE', { date: D3 }))
    expect(inv.grandTotalPaise).toBe(q.grandTotalPaise)
    expect(f.stock(f.widget)).toBe(toMilli(8))
    expect(loadDocument(f.ctx, 'SALES_ORDER', so.id).children.map((c) => c.number)).toEqual([inv.number])
    expect(() => convertDocument(f.ctx, 'SALES_QUOTATION', q.id, 'SALES_RETURN')).toThrow(/cannot be converted/)
  })

  it('delivery challan moves stock once; the invoice from it does not move stock again', () => {
    const f = fixture()
    const so = f.post(f.save({ kind: 'SALES_ORDER', partyId: f.intra, date: D1, lines: [line(f.widget, 5, 1000)] }))
    const dc = f.post(convertDocument(f.ctx, 'SALES_ORDER', so.id, 'DELIVERY_CHALLAN', { date: D2 }))
    expect(f.stock(f.widget)).toBe(toMilli(5))
    expect(f.ledger('COGS')).toBe(toPaise(3000))
    // Invoice part of the challan, then try to over-invoice the rest.
    const inv = convertDocument(f.ctx, 'DELIVERY_CHALLAN', dc.id, 'SALES_INVOICE', { date: D3 })
    const part = saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', id: inv.id, partyId: f.intra, date: D3, warehouseId: f.wh, sourceKind: 'DELIVERY_CHALLAN', sourceId: dc.id, lines: [{ ...line(f.widget, 3, 1000), sourceLineId: dc.lines[0].id }] }))
    f.post(part)
    expect(f.stock(f.widget)).toBe(toMilli(5))
    expect(f.ledger('COGS')).toBe(toPaise(3000))
    const rest = convertDocument(f.ctx, 'DELIVERY_CHALLAN', dc.id, 'SALES_INVOICE', { date: D3 })
    expect(rest.lines[0].qtyMilli).toBe(toMilli(2))
    const over = saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', id: rest.id, partyId: f.intra, date: D3, warehouseId: f.wh, sourceKind: 'DELIVERY_CHALLAN', sourceId: dc.id, lines: [{ ...line(f.widget, 3, 1000), sourceLineId: dc.lines[0].id }] }))
    expect(validateDocument(f.ctx, 'SALES_INVOICE', over.id).errors.join()).toMatch(/exceeds the remaining 2/)
    assertBooksBalanced(f)
  })

  it('documents converted along requisition → order → GRN → bill take payment terms from the supplier', () => {
    const f = fixture()
    const prq = f.post(f.save({ kind: 'PURCHASE_REQUISITION', partyId: null, date: D1, lines: [line(f.gear, 2, 150)] }))
    const po = f.post(convertDocument(f.ctx, 'PURCHASE_REQUISITION', prq.id, 'PURCHASE_ORDER', { partyId: f.vendor, date: D1 }))
    const grn = f.post(convertDocument(f.ctx, 'PURCHASE_ORDER', po.id, 'GOODS_RECEIPT', { date: D1 }))
    const bill = convertDocument(f.ctx, 'GOODS_RECEIPT', grn.id, 'PURCHASE_INVOICE', { date: D2, supplierRef: 'T-1' })
    expect(bill.paymentTermsDays).toBe(30)
    expect(bill.dueDate).toBe('2026-11-04')
  })

  it('GRN adds stock against GRNI; the matched bill clears GRNI and books price variance', () => {
    const f = fixture()
    const po = f.post(f.save({ kind: 'PURCHASE_ORDER', partyId: f.vendor, date: D1, lines: [line(f.gear, 10, 150)] }))
    const grn = f.post(convertDocument(f.ctx, 'PURCHASE_ORDER', po.id, 'GOODS_RECEIPT', { date: D1, supplierRef: 'DC-1' }))
    expect(f.stock(f.gear)).toBe(toMilli(10))
    expect(f.ledger('GRNI')).toBe(-toPaise(1500))
    const draft = convertDocument(f.ctx, 'GOODS_RECEIPT', grn.id, 'PURCHASE_INVOICE', { date: D2, supplierRef: 'BILL-GRN' })
    const billed = saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'PURCHASE_INVOICE', id: draft.id, partyId: f.vendor, date: D2, supplierRef: 'BILL-GRN', warehouseId: f.wh, sourceKind: 'GOODS_RECEIPT', sourceId: grn.id, lines: [{ ...line(f.gear, 10, 155), sourceLineId: grn.lines[0].id }] }))
    f.post(billed)
    expect(f.stock(f.gear)).toBe(toMilli(10)) // not received twice
    expect(f.ledger('GRNI')).toBe(0)
    expect(f.ledger('PPV')).toBe(toPaise(50))
    assertBooksBalanced(f)
  })

  it('sales return restores stock at original cost and settles the invoice; purchase return removes it', () => {
    const f = fixture()
    const inv = f.post(sale(f, f.intra, [line(f.widget, 4, 1000)]))
    const ret = f.post(convertDocument(f.ctx, 'SALES_INVOICE', inv.id, 'SALES_RETURN', { date: D3, reason: 'Damaged', lines: [{ ...line(f.widget, 1, 0), sourceLineId: inv.lines[0].id }] }))
    expect(ret.lines[0]).toMatchObject({ ratePaise: toPaise(1000), taxablePaise: toPaise(1000) })
    expect(f.stock(f.widget)).toBe(toMilli(7))
    expect(loadDocument(f.ctx, 'SALES_INVOICE', inv.id).settledPaise).toBe(ret.grandTotalPaise)
    expect(f.ledger('SALES_RETURNS')).toBe(toPaise(1000))
    const tooMany = convertDocument(f.ctx, 'SALES_INVOICE', inv.id, 'SALES_RETURN', { date: D3 })
    expect(tooMany.lines[0].qtyMilli).toBe(toMilli(3))

    const bill = f.post(purchase(f, f.vendor, 'PR-1', [line(f.gear, 10, 150)]))
    f.post(convertDocument(f.ctx, 'PURCHASE_INVOICE', bill.id, 'PURCHASE_RETURN', { date: D3, lines: [{ ...line(f.gear, 4, 0), sourceLineId: bill.lines[0].id }] }))
    expect(f.stock(f.gear)).toBe(toMilli(6))
    expect(f.supplierBalance(f.vendor)).toBe(bill.grandTotalPaise - Math.round(4 * 15000 * 1.05))
    assertBooksBalanced(f)
  })

  it('cancels by controlled reversal (stock, ledger, numbering kept) and blocks cancelling paid invoices', () => {
    const f = fixture()
    const inv = f.post(sale(f, f.intra, [line(f.widget, 3, 1000)]))
    const c = cancelDocument(f.ctx, 'SALES_INVOICE', inv.id, 'Wrong customer')
    expect(c).toMatchObject({ status: 'CANCELLED', number: 'INV/2026-27/0001', cancelReason: 'Wrong customer' })
    expect(c.reversalEntryNo).toBeTruthy()
    expect(f.stock(f.widget)).toBe(toMilli(10))
    expect(f.customerBalance(f.intra)).toBe(0)
    expect(f.count(`SELECT COUNT(*) n FROM journal_entries WHERE status = 'REVERSED'`)).toBe(1)
    expect(() => cancelDocument(f.ctx, 'SALES_INVOICE', inv.id, 'again')).toThrow(/already cancelled/)
    expect(f.post(sale(f, f.intra, [line(f.service, 1, 1)])).number).toBe('INV/2026-27/0002')

    const paid = f.post(sale(f, f.intra, [line(f.service, 1, 100)]))
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: paid.grandTotalPaise, mode: 'UPI', accountId: f.bank, allocations: [{ invoiceId: paid.id, amountPaise: paid.grandTotalPaise }] })
    expect(() => cancelDocument(f.ctx, 'SALES_INVOICE', paid.id, 'x')).toThrow(/credit note instead/)

    const bill = f.post(purchase(f, f.vendor, 'CX', [line(f.gear, 5, 150)]))
    f.post(sale(f, f.intra, [line(f.gear, 4, 250)]))
    expect(() => cancelDocument(f.ctx, 'PURCHASE_INVOICE', bill.id, 'x')).toThrow(/Insufficient stock/)
    assertBooksBalanced(f)
  })
})

// ───────────────────────── 16. Balanced books across everything ─────────────────────────
describe('balanced accounting entries', () => {
  it('16. every journal from every document kind balances, and Stock-in-Hand equals stock valuation', () => {
    const f = fixture()
    const bill = f.post(purchase(f, f.vendorOut, 'MIX-1', [line(f.widget, 7, 610), line(f.gear, 13, 149.5)], { freightPaise: 33333, freightTaxBps: 1800 }))
    const inv = f.post(sale(f, f.inter, [line(f.widget, 9, 999.99, { discountBps: 750 }), line(f.gear, 5, 250), line(f.service, 1.25, 2000)], { pricingMode: 'INCLUSIVE' }))
    f.post(convertDocument(f.ctx, 'SALES_INVOICE', inv.id, 'SALES_RETURN', { date: D3, lines: [{ ...line(f.widget, 2, 0), sourceLineId: inv.lines[0].id }] }))
    f.post(convertDocument(f.ctx, 'SALES_INVOICE', inv.id, 'CREDIT_NOTE', { date: D3, lines: [line(f.service, 1, 333.33)] }))
    f.post(convertDocument(f.ctx, 'PURCHASE_INVOICE', bill.id, 'PURCHASE_RETURN', { date: D3, lines: [{ ...line(f.gear, 3, 0), sourceLineId: bill.lines[1].id }] }))
    f.post(convertDocument(f.ctx, 'PURCHASE_INVOICE', bill.id, 'DEBIT_NOTE', { date: D3, lines: [line(f.gear, 1, 77.77)] }))
    const so = f.post(f.save({ kind: 'SALES_ORDER', partyId: f.intra, date: D2, lines: [line(f.gear, 2, 250)] }))
    const dc = f.post(convertDocument(f.ctx, 'SALES_ORDER', so.id, 'DELIVERY_CHALLAN', { date: D2 }))
    cancelDocument(f.ctx, 'DELIVERY_CHALLAN', dc.id, 'Customer refused delivery')
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.inter, date: D3, amountPaise: 123456, mode: 'UPI', accountId: f.bank, allocations: [] })
    assertBooksBalanced(f)
    const ar = f.db.prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.system_key='AR'`).get() as { b: number }
    expect(ar.b).toBe(f.customerBalance(f.intra) + f.customerBalance(f.inter) + f.customerBalance(f.sez))
  })
})

// ───────────────────────── Registers & summaries ─────────────────────────
describe('registers and module dashboards', () => {
  it('derives payment status, balances and overdue days from transactions', () => {
    const f = fixture()
    const a = f.post(sale(f, f.intra, [line(f.service, 1, 1000)]))
    f.post(sale(f, f.intra, [line(f.service, 1, 1000)]))
    sale(f, f.intra, [line(f.service, 1, 1000)]) // draft: excluded
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: 50000, mode: 'UPI', accountId: f.bank, allocations: [{ invoiceId: a.id, amountPaise: 50000 }] })
    const reg = register(f.ctx, { side: 'SALES' }, '2026-11-14')
    expect(reg).toHaveLength(2)
    expect(reg.find((r) => r.id === a.id)).toMatchObject({ paymentStatus: 'PARTIAL', overdueDays: 10 })
    expect(register(f.ctx, { side: 'SALES', paymentStatus: 'UNPAID' }, '2026-11-14')).toHaveLength(1)
    const s = moduleSummary(f.ctx, 'SALES', '2026-11-14')
    expect(s.draftCount).toBe(1)
    expect(s.overdueCount).toBe(2)
    expect(s.outstandingPaise).toBe(f.customerBalance(f.intra))
    expect(listDocuments(f.ctx, { kind: 'SALES_INVOICE', status: 'DRAFT' })).toHaveLength(1)
  })
})

// ───────────────────────── 19. Printable invoice / PDF source ─────────────────────────
describe('invoice print layout (PDF source)', () => {
  it('19. contains company, customer, items, HSN tax breakup, totals in words, payment details and terms — escaped', () => {
    const f = fixture()
    f.db.prepare(`UPDATE companies SET gstin = '33AAKCS4821M1ZX', bank_name = 'State Bank', bank_account_no = '000123456789', bank_ifsc = 'SBIN0000001', upi_id = 'test@upi', invoice_terms = 'Goods once sold will not be taken back.' WHERE id = ?`).run(f.ctx.companyId)
    f.db.prepare(`UPDATE customers SET name = 'Acme <script>alert(1)</script> & Co' WHERE id = ?`).run(f.intra)
    const inv = f.post(sale(f, f.intra, [line(f.widget, 2, 1000), line(f.service, 1, 2000)]))
    const html = buildDocumentHtml(f.ctx, 'SALES_INVOICE', inv.id)
    for (const s of ['TAX INVOICE', 'Test Traders', '33AAKCS4821M1ZX', 'INV/2026-27/0001', '84713010', '998313', 'CGST', 'SGST', 'Grand total', 'Balance due', 'State Bank', 'SBIN0000001', 'test@upi', 'Goods once sold', 'Authorised signatory', 'Indian Rupees Four Thousand Seven Hundred Twenty Only'])
      expect(html, s).toContain(s)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co')
    const draftHtml = buildDocumentHtml(f.ctx, 'SALES_INVOICE', sale(f, f.inter, [line(f.widget, 1, 1000)]).id)
    expect(draftHtml).toContain('DRAFT — NOT ISSUED')
    expect(draftHtml).toContain('IGST')
  })

  it('writes amounts in words using the Indian numbering system', () => {
    expect(numberToWordsIndian(0)).toBe('Zero')
    expect(numberToWordsIndian(1234567)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven')
    expect(numberToWordsIndian(1_00_00_000)).toBe('One Crore')
    expect(amountInWordsINR(12345678)).toBe('Indian Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only')
    expect(amountInWordsINR(100)).toBe('Indian Rupees One Only')
  })
})

// ───────────────────────── 20. Audit logging ─────────────────────────
describe('audit logging', () => {
  it('20. records draft, post, payment allocation and cancellation', () => {
    const f = fixture()
    const d = sale(f, f.intra, [line(f.widget, 1, 1000)])
    saveDraft(f.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', id: d.id, partyId: f.intra, date: D2, warehouseId: f.wh, lines: [line(f.widget, 2, 1000)] }))
    const p = f.post(d)
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: D3, amountPaise: 1000, mode: 'UPI', accountId: f.bank, allocations: [{ invoiceId: p.id, amountPaise: 1000 }] })
    const q = f.post(f.save({ kind: 'SALES_QUOTATION', partyId: f.intra, date: D1, lines: [line(f.service, 1, 1)] }))
    cancelDocument(f.ctx, 'SALES_QUOTATION', q.id, 'Customer declined')
    const actions = (f.db.prepare(`SELECT action, entity_type FROM audit_logs WHERE entity_type IN ('sales_invoice','sales_quotation','payment_receipt') ORDER BY id`).all() as Array<{ action: string; entity_type: string }>).map((a) => `${a.entity_type}:${a.action}`)
    expect(actions).toEqual([
      'sales_invoice:DRAFT_CREATE', 'sales_invoice:DRAFT_UPDATE', 'sales_invoice:POST', 'payment_receipt:POST', 'payment_receipt:ALLOCATE',
      'sales_quotation:DRAFT_CREATE', 'sales_quotation:POST', 'sales_quotation:CANCEL'
    ])
    const post = f.db.prepare(`SELECT user_id, summary FROM audit_logs WHERE action = 'POST' AND entity_type = 'sales_invoice'`).get() as { user_id: number; summary: string }
    expect(post.user_id).toBe(f.ctx.userId)
    expect(post.summary).toContain('INV/2026-27/0001')
  })
})
