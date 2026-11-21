import type { DB } from '../db/connection'
import { divRound, milliToString } from '@shared/money'
import { businessRule } from './errors'

type InType = 'OPENING' | 'PURCHASE' | 'ADJUSTMENT_IN' | 'TRANSFER_IN' | 'SALE_REVERSAL'
type OutType = 'SALE' | 'ADJUSTMENT_OUT' | 'TRANSFER_OUT' | 'PURCHASE_REVERSAL'

interface MovementBase {
  companyId: number
  productId: number
  warehouseId: number
  date: string
  qtyMilli: number
  referenceType: string
  referenceId: number | null
  referenceNo: string | null
  userId: number | null
}

function getBalance(db: DB, productId: number, warehouseId: number): { qty: number; value: number } {
  const row = db.prepare('SELECT qty_milli, value_paise FROM stock_balances WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId) as
    | { qty_milli: number; value_paise: number }
    | undefined
  return { qty: row?.qty_milli ?? 0, value: row?.value_paise ?? 0 }
}

function saveBalance(db: DB, companyId: number, productId: number, warehouseId: number, qty: number, value: number): void {
  db.prepare(
    `INSERT INTO stock_balances (company_id, product_id, warehouse_id, qty_milli, value_paise) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET qty_milli = excluded.qty_milli, value_paise = excluded.value_paise,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(companyId, productId, warehouseId, qty, value)
}

const insertMovement = (db: DB, m: MovementBase, type: string, qtyIn: number, qtyOut: number, unitCost: number, value: number, balanceQty: number): void => {
  db.prepare(
    `INSERT INTO stock_movements (company_id, product_id, warehouse_id, movement_date, movement_type, qty_in_milli, qty_out_milli,
       unit_cost_paise, value_paise, balance_qty_milli, reference_type, reference_id, reference_no, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(m.companyId, m.productId, m.warehouseId, m.date, type, qtyIn, qtyOut, unitCost, value, balanceQty, m.referenceType, m.referenceId, m.referenceNo, m.userId)
}

/** Receive stock at a total value (moving-average valuation). Call inside a transaction. */
export function stockIn(db: DB, m: MovementBase & { type: InType; valuePaise: number }): void {
  if (m.qtyMilli <= 0) throw businessRule('Stock-in quantity must be positive')
  if (m.valuePaise < 0) throw businessRule('Stock value cannot be negative')
  const bal = getBalance(db, m.productId, m.warehouseId)
  const qty = bal.qty + m.qtyMilli
  const value = bal.value + m.valuePaise
  insertMovement(db, m, m.type, m.qtyMilli, 0, divRound(m.valuePaise * 1000, m.qtyMilli), m.valuePaise, qty)
  saveBalance(db, m.companyId, m.productId, m.warehouseId, qty, value)
}

/**
 * Issue stock; returns the cost (paise) actually removed from the valuation.
 * By default at moving-average cost. With valuePaise (returns, cancellations) the
 * given value is removed instead, capped so the remaining valuation never goes
 * negative; issuing the entire balance always removes the entire value.
 */
export function stockOut(db: DB, m: MovementBase & { type: OutType; productLabel: string; valuePaise?: number }): number {
  if (m.qtyMilli <= 0) throw businessRule('Stock-out quantity must be positive')
  const bal = getBalance(db, m.productId, m.warehouseId)
  if (bal.qty < m.qtyMilli) {
    throw businessRule(`Insufficient stock for ${m.productLabel}: available ${milliToString(bal.qty)}, required ${milliToString(m.qtyMilli)}`)
  }
  const cost =
    m.qtyMilli === bal.qty
      ? bal.value
      : m.valuePaise != null
        ? Math.max(0, Math.min(m.valuePaise, bal.value))
        : divRound(bal.value * m.qtyMilli, bal.qty)
  const qty = bal.qty - m.qtyMilli
  insertMovement(db, m, m.type, 0, m.qtyMilli, divRound(cost * 1000, m.qtyMilli), cost, qty)
  saveBalance(db, m.companyId, m.productId, m.warehouseId, qty, bal.value - cost)
  return cost
}
