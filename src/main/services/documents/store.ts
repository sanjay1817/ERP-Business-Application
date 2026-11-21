/**
 * Storage mapping for commercial documents. Sales and purchase invoices keep
 * their Phase 1 tables; every other kind lives in trade_documents. All three
 * share the same column names except those described in Store.
 */
import type { DB } from '../../db/connection'
import {
  KINDS, isInvoiceKind, type DocStatus, type DocumentDetail, type DocumentKind, type DocumentLine, type DocumentLink, type DocumentRow, type PaymentStatus
} from '@shared/documents'
import type { ServiceContext } from '../context'
import { bool } from '../context'
import { notFound } from '../errors'

export interface Store {
  header: string
  lines: string
  fk: string
  numberCol: string
  dateCol: string
  partyCol: 'customer_id' | 'supplier_id'
  gstinCol: string
  refCol: string | null
  refDateCol: string | null
  /** trade_documents rows are filtered by doc_type. */
  typed: boolean
}

export const DRAFT_REF_PREFIX = '~DRAFT-'

export function storeFor(kind: DocumentKind): Store {
  if (kind === 'SALES_INVOICE')
    return { header: 'sales_invoices', lines: 'sales_invoice_items', fk: 'invoice_id', numberCol: 'invoice_no', dateCol: 'invoice_date', partyCol: 'customer_id', gstinCol: 'customer_gstin', refCol: null, refDateCol: null, typed: false }
  if (kind === 'PURCHASE_INVOICE')
    return { header: 'purchase_invoices', lines: 'purchase_invoice_items', fk: 'invoice_id', numberCol: 'invoice_no', dateCol: 'invoice_date', partyCol: 'supplier_id', gstinCol: 'supplier_gstin', refCol: 'supplier_invoice_no', refDateCol: 'supplier_invoice_date', typed: false }
  return {
    header: 'trade_documents', lines: 'trade_document_lines', fk: 'document_id', numberCol: 'doc_no', dateCol: 'doc_date',
    partyCol: KINDS[kind].party === 'CUSTOMER' ? 'customer_id' : 'supplier_id', gstinCol: 'party_gstin', refCol: 'supplier_ref', refDateCol: 'supplier_ref_date', typed: true
  }
}

const partyTable = (kind: DocumentKind) => (KINDS[kind].party === 'CUSTOMER' ? 'customers' : 'suppliers')
const typeFilter = (s: Store, kind: DocumentKind, alias = 'h') => (s.typed ? ` AND ${alias}.doc_type = '${kind}'` : '')

export type HeaderRow = Record<string, unknown> & {
  id: number; company_id: number; status: DocStatus; financial_year: string; _number: string; _date: string; _party_id: number | null
  _ref: string | null; _ref_date: string | null; grand_total_paise: number; source_type: string | null; source_id: number | null
  warehouse_id: number | null; journal_entry_id: number | null; is_inter_state: number; place_of_supply: string
}

export function loadHeader(ctx: ServiceContext, kind: DocumentKind, id: number): HeaderRow {
  const s = storeFor(kind)
  const row = ctx.db
    .prepare(
      `SELECT h.*, h.${s.numberCol} AS _number, h.${s.dateCol} AS _date, h.${s.partyCol} AS _party_id, h.${s.gstinCol} AS _party_gstin,
         ${s.refCol ? `h.${s.refCol}` : 'NULL'} AS _ref, ${s.refDateCol ? `h.${s.refDateCol}` : 'NULL'} AS _ref_date
       FROM ${s.header} h WHERE h.id = ? AND h.company_id = ?${typeFilter(s, kind)}`
    )
    .get(id, ctx.companyId) as HeaderRow | undefined
  if (!row) throw notFound(KINDS[kind].label)
  return row
}

export function linkFor(db: DB, kind: DocumentKind, id: number): DocumentLink | null {
  const s = storeFor(kind)
  const r = db.prepare(`SELECT id, ${s.numberCol} AS number, status, ${s.dateCol} AS date FROM ${s.header} h WHERE id = ?${typeFilter(s, kind)}`).get(id) as
    | { id: number; number: string; status: DocStatus; date: string }
    | undefined
  return r ? { kind, ...r } : null
}

/** Documents created from (kind, id), across all document tables. */
export function childrenOf(db: DB, kind: DocumentKind, id: number): DocumentLink[] {
  const out: DocumentLink[] = []
  for (const [k, table, numberCol, dateCol] of [
    ['SALES_INVOICE', 'sales_invoices', 'invoice_no', 'invoice_date'],
    ['PURCHASE_INVOICE', 'purchase_invoices', 'invoice_no', 'invoice_date']
  ] as const) {
    for (const r of db.prepare(`SELECT id, ${numberCol} AS number, status, ${dateCol} AS date FROM ${table} WHERE source_type = ? AND source_id = ? ORDER BY id`).all(kind, id) as Array<Omit<DocumentLink, 'kind'>>)
      out.push({ kind: k, ...r })
  }
  for (const r of db.prepare(`SELECT id, doc_type AS kind, doc_no AS number, status, doc_date AS date FROM trade_documents WHERE source_type = ? AND source_id = ? ORDER BY id`).all(kind, id) as DocumentLink[])
    out.push(r)
  return out
}

/** Sum of allocations (receipts/payments/notes) applied to an invoice. */
export function settledAmount(db: DB, kind: DocumentKind, id: number): number {
  if (!isInvoiceKind(kind)) return 0
  return (db.prepare('SELECT COALESCE(SUM(amount_paise),0) s FROM payment_allocations WHERE invoice_type = ? AND invoice_id = ? AND is_reversed = 0').get(kind, id) as { s: number }).s
}

export function paymentStatusOf(kind: DocumentKind, status: DocStatus, grand: number, settled: number): PaymentStatus {
  if (!isInvoiceKind(kind) || status !== 'POSTED') return 'NA'
  if (settled >= grand) return 'PAID'
  return settled > 0 ? 'PARTIAL' : 'UNPAID'
}

/** Quantity of a source line already consumed by posted documents of targetKind (excluding one document). */
export function consumedQty(db: DB, targetKind: DocumentKind, sourceKind: DocumentKind, sourceLineId: number, excludeId: number | null): number {
  const s = storeFor(targetKind)
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.qty_milli),0) q FROM ${s.lines} l JOIN ${s.header} h ON h.id = l.${s.fk}
         WHERE h.status = 'POSTED' AND h.source_type = ? AND l.source_line_id = ? AND h.id <> ?${typeFilter(s, targetKind)}`
      )
      .get(sourceKind, sourceLineId, excludeId ?? -1) as { q: number }
  ).q
}

export interface SourceLine {
  id: number
  product_id: number
  qty_milli: number
  rate_paise: number
  discount_bps: number | null
  discount_paise: number
  taxable_paise: number
  tax_rate_bps: number
  cost_paise: number
  description: string | null
}

export function loadLines(db: DB, kind: DocumentKind, docId: number): SourceLine[] {
  const s = storeFor(kind)
  return db.prepare(`SELECT * FROM ${s.lines} WHERE ${s.fk} = ? ORDER BY line_no`).all(docId) as SourceLine[]
}

const allocSourceNumber = (db: DB, type: string, id: number): { number: string; date: string } => {
  if (type === 'RECEIPT') return db.prepare('SELECT receipt_no number, receipt_date date FROM payment_receipts WHERE id = ?').get(id) as { number: string; date: string }
  if (type === 'PAYMENT') return db.prepare('SELECT voucher_no number, voucher_date date FROM payment_vouchers WHERE id = ?').get(id) as { number: string; date: string }
  return db.prepare('SELECT doc_no number, doc_date date FROM trade_documents WHERE id = ?').get(id) as { number: string; date: string }
}

export function loadDocument(ctx: ServiceContext, kind: DocumentKind, id: number): DocumentDetail {
  const db = ctx.db
  const s = storeFor(kind)
  const h = loadHeader(ctx, kind, id)
  const party = h._party_id
    ? (db.prepare(`SELECT code, name, gst_registration_type, state_code FROM ${partyTable(kind)} WHERE id = ?`).get(h._party_id) as { code: string; name: string; gst_registration_type: string; state_code: string })
    : null
  const wh = h.warehouse_id ? (db.prepare('SELECT name FROM warehouses WHERE id = ?').get(h.warehouse_id) as { name: string }) : null
  const je = (jid: unknown) => (jid ? (db.prepare('SELECT entry_no FROM journal_entries WHERE id = ?').get(jid) as { entry_no: string }).entry_no : null)
  const sourceKind = h.source_type as DocumentKind | null
  const lineLinked = !!sourceKind && KINDS[kind].lineLinkedSource.includes(sourceKind)

  const lines = (
    db
      .prepare(
        `SELECT l.*, p.code AS product_code, p.name AS product_name, p.track_inventory, u.code AS unit_code
         FROM ${s.lines} l JOIN products p ON p.id = l.product_id JOIN units u ON u.id = l.unit_id WHERE l.${s.fk} = ? ORDER BY l.line_no`
      )
      .all(id) as Array<Record<string, unknown>>
  ).map((l): DocumentLine => {
    const sourceLineId = (l.source_line_id as number | null) ?? null
    let remaining: number | null = null
    if (lineLinked && sourceLineId && sourceKind) {
      const src = db.prepare(`SELECT qty_milli FROM ${storeFor(sourceKind).lines} WHERE id = ?`).get(sourceLineId) as { qty_milli: number } | undefined
      if (src) remaining = src.qty_milli - consumedQty(db, kind, sourceKind, sourceLineId, id)
    }
    return {
      id: l.id as number, lineNo: l.line_no as number, productId: l.product_id as number, productCode: l.product_code as string, productName: l.product_name as string,
      itemType: l.item_type as 'GOODS' | 'SERVICE', trackInventory: bool(l.track_inventory), description: l.description as string | null, hsnSac: l.hsn_sac as string,
      unitCode: l.unit_code as string, qtyMilli: l.qty_milli as number, ratePaise: l.rate_paise as number, discountBps: (l.discount_bps as number | null) ?? null,
      discountPaise: l.discount_paise as number, grossPaise: l.gross_paise as number, taxablePaise: l.taxable_paise as number, taxRateBps: l.tax_rate_bps as number,
      cgstPaise: l.cgst_paise as number, sgstPaise: l.sgst_paise as number, igstPaise: l.igst_paise as number, totalPaise: l.line_total_paise as number,
      costPaise: (l.cost_paise as number) ?? 0, sourceLineId, sourceRemainingMilli: remaining
    }
  })

  const settled = settledAmount(db, kind, id)
  const allocations = isInvoiceKind(kind)
    ? (db.prepare('SELECT source_type, source_id, amount_paise FROM payment_allocations WHERE invoice_type = ? AND invoice_id = ? AND is_reversed = 0 ORDER BY id').all(kind, id) as Array<{ source_type: string; source_id: number; amount_paise: number }>).map((a) => ({
        sourceType: a.source_type, sourceId: a.source_id, amountPaise: a.amount_paise, ...allocSourceNumber(db, a.source_type, a.source_id)
      }))
    : []
  const ref = typeof h._ref === 'string' && h._ref.startsWith(DRAFT_REF_PREFIX) ? null : h._ref
  return {
    id: h.id, kind, number: h._number, status: h.status, financialYear: h.financial_year, date: h._date, dueDate: (h.due_date as string | null) ?? null,
    partyId: h._party_id, partyCode: party?.code ?? null, partyName: party?.name ?? null, partyGstin: (h._party_gstin as string | null) ?? null,
    partyRegistrationType: party?.gst_registration_type ?? null, partyStateCode: party?.state_code ?? null,
    placeOfSupply: h.place_of_supply, isInterState: bool(h.is_inter_state), warehouseId: h.warehouse_id, warehouseName: wh?.name ?? null,
    referenceNo: (h.reference_no as string | null) ?? null, supplierRef: ref, supplierRefDate: h._ref_date,
    billingAddress: (h.billing_address as string | null) ?? null, shippingAddress: (h.shipping_address as string | null) ?? null,
    paymentTermsDays: (h.payment_terms_days as number) ?? 0, pricingMode: (h.pricing_mode as 'EXCLUSIVE' | 'INCLUSIVE') ?? 'EXCLUSIVE',
    notes: (h.notes as string | null) ?? null, terms: (h.terms as string | null) ?? null, reason: (h.reason as string | null) ?? null,
    freightPaise: h.freight_paise as number, freightTaxBps: h.freight_tax_bps as number, otherChargesPaise: h.other_charges_paise as number,
    otherChargesLabel: (h.other_charges_label as string | null) ?? null, otherChargesTaxBps: h.other_charges_tax_bps as number,
    subtotalPaise: h.subtotal_paise as number, discountPaise: h.discount_paise as number, taxablePaise: h.taxable_paise as number,
    cgstPaise: h.cgst_paise as number, sgstPaise: h.sgst_paise as number, igstPaise: h.igst_paise as number, roundOffPaise: h.round_off_paise as number,
    grandTotalPaise: h.grand_total_paise, settledPaise: settled,
    balanceDuePaise: isInvoiceKind(kind) && h.status === 'POSTED' ? h.grand_total_paise - settled : 0,
    paymentStatus: paymentStatusOf(kind, h.status, h.grand_total_paise, settled),
    source: sourceKind && h.source_id ? linkFor(db, sourceKind, h.source_id) : null,
    children: childrenOf(db, kind, id),
    allocations,
    journalEntryNo: je(h.journal_entry_id), reversalEntryNo: je(h.reversal_journal_entry_id),
    postedAt: (h.posted_at as string | null) ?? null, cancelledAt: (h.cancelled_at as string | null) ?? null, cancelReason: (h.cancel_reason as string | null) ?? null,
    createdAt: h.created_at as string, updatedAt: h.updated_at as string, lines
  }
}

export function listDocuments(ctx: ServiceContext, q: { kind: DocumentKind; status?: DocStatus; search?: string; partyId?: number; limit?: number }): DocumentRow[] {
  const s = storeFor(q.kind)
  const where = [`h.company_id = @c`]
  if (s.typed) where.push(`h.doc_type = @kind`)
  if (q.status) where.push(`h.status = @status`)
  if (q.partyId) where.push(`h.${s.partyCol} = @party`)
  if (q.search) where.push(`(h.${s.numberCol} LIKE @like OR IFNULL(p.name,'') LIKE @like OR IFNULL(h.reference_no,'') LIKE @like${s.refCol ? ` OR IFNULL(h.${s.refCol},'') LIKE @like` : ''})`)
  const rows = ctx.db
    .prepare(
      `SELECT h.id, h.${s.numberCol} AS number, h.status, h.${s.dateCol} AS date, h.due_date AS dueDate, p.name AS partyName, h.reference_no AS referenceNo, ${s.refCol ? `h.${s.refCol}` : 'NULL'} AS supplierRef,
         h.source_type, h.source_id, h.taxable_paise AS taxablePaise, (h.cgst_paise + h.sgst_paise + h.igst_paise) AS taxPaise, h.grand_total_paise AS grandTotalPaise,
         (SELECT COUNT(*) FROM ${s.lines} l WHERE l.${s.fk} = h.id) AS lineCount
       FROM ${s.header} h LEFT JOIN ${partyTable(q.kind)} p ON p.id = h.${s.partyCol}
       WHERE ${where.join(' AND ')}
       ORDER BY CASE h.status WHEN 'DRAFT' THEN 0 ELSE 1 END, h.${s.dateCol} DESC, h.id DESC LIMIT @limit`
    )
    .all({ c: ctx.companyId, kind: q.kind, status: q.status ?? null, party: q.partyId ?? null, like: `%${q.search ?? ''}%`, limit: q.limit ?? 500 }) as Array<
    Omit<DocumentRow, 'kind' | 'balanceDuePaise' | 'paymentStatus' | 'sourceNumber'> & { source_type: DocumentKind | null; source_id: number | null }
  >
  return rows.map(({ source_type, source_id, ...r }) => {
    const settled = settledAmount(ctx.db, q.kind, r.id)
    return {
      ...r,
      kind: q.kind,
      supplierRef: r.supplierRef?.startsWith(DRAFT_REF_PREFIX) ? null : r.supplierRef,
      sourceNumber: source_type && source_id ? (linkFor(ctx.db, source_type, source_id)?.number ?? null) : null,
      balanceDuePaise: isInvoiceKind(q.kind) && r.status === 'POSTED' ? r.grandTotalPaise - settled : 0,
      paymentStatus: paymentStatusOf(q.kind, r.status, r.grandTotalPaise, settled)
    }
  })
}
