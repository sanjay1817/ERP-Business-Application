/**
 * DEMO scenario — full commercial document flows, all posted through the real
 * engine (dated over the last month). Covers every document kind, partial
 * payments, returns, notes, a cancellation, open orders and drafts.
 */
import { DocumentSaveInput, type DocumentDetail, type DocumentSaveInputT } from '@shared/documents'
import { toMilli, toPaise } from '@shared/money'
import type { ServiceContext } from '../../services/context'
import { cancelDocument, convertDocument, postDocument, saveDraft } from '../../services/documents/engine'
import { createPayment, openInvoices } from '../../services/documents/payments'
import type { Customer, Product, Supplier } from '@shared/types'

export interface FlowDeps {
  ctx: ServiceContext
  todayIso: string
  fyStart: string
  plusDays: (iso: string, n: number) => string
  between: (min: number, max: number) => number
  productByCode: Map<string, Product>
  customers: Customer[]
  suppliers: Supplier[]
  whId: (code: string) => number
  bankId: number
  cashId: number
  collectionsId: number
}

export function phase2Flows(f: FlowDeps): void {
  const { ctx, todayIso, plusDays, between, bankId, cashId, collectionsId } = f
  const db = ctx.db
  const day = (n: number) => {
    const x = plusDays(todayIso, -n)
    return x < f.fyStart ? f.fyStart : x
  }
  const P = (code: string) => f.productByCode.get(code)!
  const cust = (code: string) => f.customers.find((x) => x.code === code)!
  const supp = (code: string) => f.suppliers.find((x) => x.code === code)!
  const save = (input: DocumentSaveInputT) => saveDraft(ctx, DocumentSaveInput.parse(input))
  const post = (doc: DocumentDetail) => postDocument(ctx, doc.kind, doc.id)
  const sell = (code: string, qty: number) => ({ productId: P(code).id, qtyMilli: toMilli(qty), ratePaise: P(code).salePricePaise })
  const buy = (code: string, qty: number) => ({ productId: P(code).id, qtyMilli: toMilli(qty), ratePaise: P(code).purchasePricePaise })
  const roundDown = (paise: number) => Math.floor(paise / 100000) * 100000 // to the nearest ₹1,000
  const receive = (customer: string, invoiceId: number | null, amount: number, date: string, accountIdValue = bankId) =>
    createPayment(ctx, {
      type: 'RECEIPT', partyId: cust(customer).id, date, amountPaise: amount, mode: 'BANK_TRANSFER', accountId: accountIdValue,
      referenceNo: `UTR${between(100000, 999999)}`, allocations: invoiceId ? [{ invoiceId, amountPaise: amount }] : []
    })

  // ── Purchase: requisition → order → goods receipt → bill matched to the GRN, then a debit note
  const prq = post(save({ kind: 'PURCHASE_REQUISITION', partyId: null, date: day(30), dueDate: day(20), notes: 'Replenish networking stock for upcoming installations', lines: [buy('SW-24G', 4), buy('CAB-C6', 6)] }))
  const po1 = post(convertDocument(ctx, 'PURCHASE_REQUISITION', prq.id, 'PURCHASE_ORDER', { partyId: supp('S003').id, date: day(28), dueDate: day(21), terms: 'Deliver to Main Warehouse. Payment 30 days from invoice.' }))
  const grn = post(convertDocument(ctx, 'PURCHASE_ORDER', po1.id, 'GOODS_RECEIPT', { date: day(22), supplierRef: 'SNS/DC/2611' }))
  const pi1 = post(convertDocument(ctx, 'GOODS_RECEIPT', grn.id, 'PURCHASE_INVOICE', { date: day(20), supplierRef: 'SNS/26-27/3301', supplierRefDate: day(21) }))
  post(
    convertDocument(ctx, 'PURCHASE_INVOICE', pi1.id, 'DEBIT_NOTE', {
      date: day(10), reason: 'Rate difference as per PO (Rs 500 per switch)', supplierRef: 'SNS/CN/0098',
      lines: [{ productId: P('SW-24G').id, qtyMilli: toMilli(4), ratePaise: toPaise(500), sourceLineId: pi1.lines[0].id }]
    })
  )

  // ── Direct bill with freight (capitalised into stock cost) and packing charges; one unit returned; part-paid
  const pi2 = post(
    save({
      kind: 'PURCHASE_INVOICE', partyId: supp('S002').id, date: day(18), supplierRef: 'PPI/26-27/1188', supplierRefDate: day(18), warehouseId: f.whId('MAIN'),
      freightPaise: toPaise(1800), freightTaxBps: 1800, otherChargesPaise: toPaise(500), otherChargesLabel: 'Packing', otherChargesTaxBps: 1800,
      lines: [buy('MON-24', 6), buy('SSD-1TB', 5), buy('KBM-WL', 20)]
    })
  )
  post(
    convertDocument(ctx, 'PURCHASE_INVOICE', pi2.id, 'PURCHASE_RETURN', {
      date: day(12), reason: 'Damaged in transit', supplierRef: 'PPI/CN/0412',
      lines: [{ productId: P('MON-24').id, qtyMilli: toMilli(1), ratePaise: 0, sourceLineId: pi2.lines[0].id }]
    })
  )
  const pi2Balance = openInvoices(ctx, 'PAYMENT', supp('S002').id).find((o) => o.invoiceId === pi2.id)!.balancePaise
  createPayment(ctx, {
    type: 'PAYMENT', partyId: supp('S002').id, date: day(8), amountPaise: roundDown(pi2Balance / 2), mode: 'BANK_TRANSFER', accountId: bankId,
    referenceNo: 'NEFT771204', allocations: [{ invoiceId: pi2.id, amountPaise: roundDown(pi2Balance / 2) }]
  })
  // Open purchase order (not yet received)
  post(save({ kind: 'PURCHASE_ORDER', partyId: supp('S004').id, date: day(5), dueDate: plusDays(todayIso, 10), lines: [buy('CHR-ERG', 10), buy('DSK-1460', 4)] }))

  // ── Sales: quotation → order → invoice; part-paid; one unit returned
  const q1 = post(
    save({
      kind: 'SALES_QUOTATION', partyId: cust('C004').id, date: day(16), dueDate: plusDays(todayIso, 14), referenceNo: 'RFQ/SH/2611',
      terms: 'Prices valid for 30 days. Delivery within 7 days of order.', lines: [sell('UPS-1K', 3), sell('CHR-ERG', 4), sell('SVC-INST', 3)]
    })
  )
  const so1 = post(convertDocument(ctx, 'SALES_QUOTATION', q1.id, 'SALES_ORDER', { date: day(14), referenceNo: 'SH/PO/4471' }))
  const si1 = post(convertDocument(ctx, 'SALES_ORDER', so1.id, 'SALES_INVOICE', { date: day(9) }))
  receive('C004', si1.id, roundDown(si1.grandTotalPaise / 2), day(5), collectionsId)
  post(
    convertDocument(ctx, 'SALES_INVOICE', si1.id, 'SALES_RETURN', {
      date: day(4), reason: 'One UPS unit dead on arrival',
      lines: [{ productId: P('UPS-1K').id, qtyMilli: toMilli(1), ratePaise: 0, sourceLineId: si1.lines[0].id }]
    })
  )

  // Open quotation
  post(save({ kind: 'SALES_QUOTATION', partyId: cust('C007').id, date: day(3), dueDate: plusDays(todayIso, 27), lines: [sell('LAP-14I5', 2), sell('SVC-AMC', 2)] }))

  // Order → delivery challan (goods dispatched, invoice pending)
  const so2 = post(save({ kind: 'SALES_ORDER', partyId: cust('C001').id, date: day(8), dueDate: day(2), referenceNo: 'VSS/PO/0932', lines: [sell('KBM-WL', 10), sell('MON-24', 3)] }))
  post(convertDocument(ctx, 'SALES_ORDER', so2.id, 'DELIVERY_CHALLAN', { date: day(6) }))

  // Credit note against an older invoice that still has a balance
  const creditTarget = (
    db
      .prepare(
        `SELECT i.id FROM sales_invoices i WHERE i.company_id = ? AND i.status = 'POSTED' AND i.customer_id = ?
           AND i.grand_total_paise > COALESCE((SELECT SUM(a.amount_paise) FROM payment_allocations a WHERE a.invoice_type = 'SALES_INVOICE' AND a.invoice_id = i.id AND a.is_reversed = 0), 0) + 500000
         ORDER BY i.invoice_date LIMIT 1`
      )
      .get(ctx.companyId, cust('C009').id) as { id: number } | undefined
  )?.id
  if (creditTarget)
    post(
      convertDocument(ctx, 'SALES_INVOICE', creditTarget, 'CREDIT_NOTE', {
        date: day(3), reason: 'Service-level credit for delayed installation',
        lines: [{ productId: P('SVC-INST').id, qtyMilli: toMilli(1), ratePaise: toPaise(2000) }]
      })
    )

  // Retail sale at GST-inclusive prices, paid in cash
  const retail = post(
    save({
      kind: 'SALES_INVOICE', partyId: cust('C010').id, date: day(2), warehouseId: f.whId('MAIN'), pricingMode: 'INCLUSIVE',
      lines: [{ ...sell('KBM-WL', 2), ratePaise: toPaise(1949) }, { ...sell('SSD-1TB', 1), ratePaise: toPaise(9299) }]
    })
  )
  createPayment(ctx, { type: 'RECEIPT', partyId: cust('C010').id, date: day(2), amountPaise: retail.grandTotalPaise, mode: 'CASH', accountId: cashId, allocations: [{ invoiceId: retail.id, amountPaise: retail.grandTotalPaise }] })

  // Invoice raised in error, cancelled by reversal (stock and ledger restored)
  const wrong = post(save({ kind: 'SALES_INVOICE', partyId: cust('C006').id, date: day(1), warehouseId: f.whId('MAIN'), lines: [sell('UPS-1K', 1)] }))
  cancelDocument(ctx, 'SALES_INVOICE', wrong.id, 'Raised against the wrong customer')

  // Advance received on account (not allocated to any invoice)
  receive('C001', null, toPaise(25000), day(1))

  // Drafts awaiting review
  save({ kind: 'SALES_INVOICE', partyId: cust('C005').id, date: todayIso, warehouseId: f.whId('MAIN'), referenceNo: 'DRV/AMC/118', notes: 'AMC renewal for 12 store POS terminals', lines: [sell('SVC-AMC', 12), sell('SVC-CLD', 3)] })
  save({ kind: 'PURCHASE_INVOICE', partyId: supp('S005').id, date: todayIso, warehouseId: f.whId('MAIN'), lines: [buy('PPR-A4', 40), buy('TNR-88A', 10)] })
  save({ kind: 'SALES_QUOTATION', partyId: cust('C002').id, date: todayIso, lines: [sell('DT-I5', 3), sell('SVC-TRN', 1)] })
}
