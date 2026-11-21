/**
 * Child process for the interruption test: posts sales invoices (with receipts)
 * in a loop until it is killed. Run with vite-node; argv[2] = database path.
 */
import { toMilli, toPaise } from '@shared/money'
import { DocumentSaveInput } from '@shared/documents'
import { openDatabase } from '../src/main/db/connection'
import { postDocument, saveDraft } from '../src/main/services/documents/engine'
import { createPayment } from '../src/main/services/documents/payments'
import { accountId } from '../src/main/services/ledger'

const db = openDatabase({ filePath: process.argv[2] })
const companyId = (db.prepare(`SELECT id FROM companies LIMIT 1`).get() as { id: number }).id
const userId = (db.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: number }).id
const ctx = { db, userId, companyId }
const wh = (db.prepare('SELECT id FROM warehouses WHERE company_id = ?').get(companyId) as { id: number }).id
const customers = (db.prepare(`SELECT id FROM customers WHERE company_id = ?`).all(companyId) as Array<{ id: number }>).map((r) => r.id)
const goods = (db.prepare(`SELECT id FROM products WHERE company_id = ? AND item_type = 'GOODS'`).all(companyId) as Array<{ id: number }>).map((r) => r.id)
const bank = accountId(db, companyId, 'BANK')
let n = 0
for (;;) {
  const lines = [1, 2, 3].map((k) => ({ productId: goods[(n + k) % goods.length], qtyMilli: toMilli(1 + (n % 5)), ratePaise: toPaise(500 + k * 10) }))
  const d = saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: customers[n % customers.length], date: '2026-11-14', warehouseId: wh, lines }))
  const inv = postDocument(ctx, 'SALES_INVOICE', d.id)
  if (n % 2 === 0) createPayment(ctx, { type: 'RECEIPT', partyId: customers[n % customers.length], date: '2026-11-14', amountPaise: inv.grandTotalPaise, mode: 'UPI', accountId: bank, referenceNo: `INT-${process.pid}-${n}`, allocations: [{ invoiceId: inv.id, amountPaise: inv.grandTotalPaise }] })
  n++
  process.stdout.write(`posted ${n}\n`)
}
