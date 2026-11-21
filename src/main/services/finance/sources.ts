/**
 * Resolves the originating document of each journal entry (voucher type,
 * voucher number and a route to open it). Used by the general ledger, day book,
 * cash/bank books and the auditor's drill-down.
 */
import type { Statement } from 'better-sqlite3'
import { DOCUMENT_KINDS, KINDS, docRoute, type DocumentKind } from '@shared/documents'
import type { SourceRef } from '@shared/finance'
import type { DB } from '../../db/connection'
import { storeFor } from '../documents/store'

export interface JournalSourceRow {
  id: number
  source_type: string
  source_kind: string | null
  source_id: number | null
}

const VOUCHER_LABEL: Partial<Record<DocumentKind, string>> = {
  SALES_INVOICE: 'Sales',
  PURCHASE_INVOICE: 'Purchase',
  DELIVERY_CHALLAN: 'Delivery Challan',
  GOODS_RECEIPT: 'Goods Receipt',
  SALES_RETURN: 'Sales Return',
  CREDIT_NOTE: 'Credit Note',
  PURCHASE_RETURN: 'Purchase Return',
  DEBIT_NOTE: 'Debit Note'
}

export class SourceResolver {
  private cache = new Map<string, SourceRef>()
  private statements = new Map<string, Statement>()
  constructor(private db: DB) {}

  /** Prepared once per resolver: day books and ledgers resolve thousands of lines. */
  private stmt(sql: string): Statement {
    let s = this.statements.get(sql)
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)))
    return s
  }

  resolve(j: JournalSourceRow): SourceRef {
    const kind = j.source_kind ?? j.source_type
    const key = `${kind}#${j.source_id ?? ''}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const ref = this.compute(kind, j.source_id)
    this.cache.set(key, ref)
    return ref
  }

  private compute(kind: string, sourceId: number | null): SourceRef {
    const isCancellation = kind.startsWith('CANCEL:')
    const base = isCancellation ? kind.slice('CANCEL:'.length) : kind
    const make = (voucherType: string, voucherNo: string | null, route: string | null, documentStatus: string | null = null): SourceRef => ({
      kind, voucherType: isCancellation ? `${voucherType} (cancellation)` : voucherType, voucherNo, route, documentStatus, isCancellation
    })

    if ((DOCUMENT_KINDS as readonly string[]).includes(base)) {
      const k = base as DocumentKind
      const label = VOUCHER_LABEL[k] ?? KINDS[k].label
      if (!sourceId) return make(label, null, null)
      const s = storeFor(k)
      const row = this.stmt(`SELECT ${s.numberCol} AS no, status FROM ${s.header} WHERE id = ?${s.typed ? ' AND doc_type = ?' : ''}`).get(...(s.typed ? [sourceId, k] : [sourceId])) as
        | { no: string; status: string }
        | undefined
      return row ? make(label, row.no, docRoute(k, sourceId), row.status) : make(label, null, null, 'MISSING')
    }
    if (base === 'RECEIPT' || base === 'PAYMENT') {
      const receipt = base === 'RECEIPT'
      if (!sourceId) return make(receipt ? 'Receipt' : 'Payment', null, null)
      const row = this.stmt(`SELECT ${receipt ? 'receipt_no' : 'voucher_no'} AS no, status FROM ${receipt ? 'payment_receipts' : 'payment_vouchers'} WHERE id = ?`).get(sourceId) as
        | { no: string; status: string }
        | undefined
      return row
        ? make(receipt ? 'Receipt' : 'Payment', row.no, receipt ? `/sales/receipts/${sourceId}` : `/purchase/payments/${sourceId}`, row.status)
        : make(receipt ? 'Receipt' : 'Payment', null, null, 'MISSING')
    }
    if (base === 'CONTRA_VOUCHER' || base === 'JOURNAL_VOUCHER') {
      const label = base === 'CONTRA_VOUCHER' ? 'Contra' : 'Journal'
      if (!sourceId) return make(label, null, null)
      const row = this.stmt('SELECT voucher_no AS no, status FROM vouchers WHERE id = ?').get(sourceId) as { no: string; status: string } | undefined
      return row ? make(label, row.no, `/finance/vouchers/${sourceId}`, row.status) : make(label, null, null, 'MISSING')
    }
    if (base === 'OPENING') return make('Opening balance', null, null)
    if (base === 'MANUAL') return make('Manual journal', null, null)
    if (base === 'REVERSAL') return make('Reversal', null, null)
    return make(base.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), null, null)
  }
}
