import type { DB } from '../db/connection'

export type DocType =
  | 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'RECEIPT' | 'PAYMENT' | 'JOURNAL'
  | 'SALES_QUOTATION' | 'SALES_ORDER' | 'DELIVERY_CHALLAN' | 'SALES_RETURN' | 'CREDIT_NOTE'
  | 'PURCHASE_REQUISITION' | 'PURCHASE_ORDER' | 'GOODS_RECEIPT' | 'PURCHASE_RETURN' | 'DEBIT_NOTE'
  | 'CONTRA_VOUCHER' | 'JOURNAL_VOUCHER'

export const DOC_PREFIX: Record<DocType, string> = {
  SALES_INVOICE: 'INV',
  PURCHASE_INVOICE: 'PUR',
  RECEIPT: 'RCT',
  PAYMENT: 'PAY',
  JOURNAL: 'JV',
  SALES_QUOTATION: 'QT',
  SALES_ORDER: 'SO',
  DELIVERY_CHALLAN: 'DC',
  SALES_RETURN: 'SR',
  CREDIT_NOTE: 'CN',
  PURCHASE_REQUISITION: 'PRQ',
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GRN',
  PURCHASE_RETURN: 'PRT',
  DEBIT_NOTE: 'DN',
  CONTRA_VOUCHER: 'CV',
  JOURNAL_VOUCHER: 'MJ'
}

/**
 * Allocate the next document number for (company, doc type, financial year).
 * Must be called inside the same transaction that inserts the document, so a
 * rollback also releases the number. GST rules cap invoice numbers at 16 chars:
 * "INV/2026-27/0001" is exactly 16.
 */
export function nextDocumentNumber(db: DB, companyId: number, docType: DocType, financialYear: string): string {
  const prefix = DOC_PREFIX[docType]
  db.prepare(
    `INSERT INTO document_sequences (company_id, doc_type, financial_year, prefix, next_number)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (company_id, doc_type, financial_year) DO NOTHING`
  ).run(companyId, docType, financialYear, prefix)
  const row = db
    .prepare(
      `UPDATE document_sequences SET next_number = next_number + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE company_id = ? AND doc_type = ? AND financial_year = ?
       RETURNING next_number - 1 AS n, prefix`
    )
    .get(companyId, docType, financialYear) as { n: number; prefix: string }
  return `${row.prefix}/${financialYear}/${String(row.n).padStart(4, '0')}`
}
