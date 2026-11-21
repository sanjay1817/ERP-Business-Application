import { beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../src/main/db/connection'
import type { ServiceContext } from '../src/main/services/context'
import type { InitReport } from '../src/main/db/bootstrap'
import { dashboardSummary, trialBalance } from '../src/main/services/reports'
import { postPurchaseInvoice, postSalesInvoice } from '../src/main/services/posting'
import { postJournal, accountId } from '../src/main/services/ledger'
import { listCustomers, listSuppliers } from '../src/main/services/parties'
import { computeLine, computeTotals, divRound, parseScaled, toPaise } from '@shared/money'
import { buildGstin, financialYearOf, isValidGstin } from '@shared/india'
import { demoDb, TEST_TODAY } from './helpers'

let db: DB
let ctx: ServiceContext
let report: InitReport
const asOf = TEST_TODAY.toISOString().slice(0, 10)
const one = <T>(sql: string, ...p: unknown[]): T => db.prepare(sql).get(...p) as T

beforeAll(async () => {
  ;({ db, ctx, report } = await demoDb())
})

describe('decimal-safe money', () => {
  it('parses decimals without floating point error', () => {
    expect(toPaise('0.1') + toPaise('0.2')).toBe(toPaise('0.3'))
    expect(toPaise('1,23,456.785')).toBe(12345679)
    expect(parseScaled('-2.345', 2)).toBe(-235)
    expect(divRound(5, 2)).toBe(3)
    expect(divRound(-5, 2)).toBe(-3)
  })
  it('splits intra-state GST into CGST+SGST that sum exactly', () => {
    const l = computeLine({ qtyMilli: 3000, ratePaise: 33333, discountPaise: 0, taxRateBps: 1800 }, false)
    expect(l.taxablePaise).toBe(99999)
    expect(l.cgst + l.sgst).toBe(18000)
    const t = computeTotals([{ ...l, discountPaise: 0 }])
    expect(t.grandTotalPaise % 100).toBe(0)
    expect(t.grandTotalPaise - t.roundOffPaise).toBe(l.totalPaise)
  })
  it('validates GSTIN check digits and FY labels', () => {
    const g = buildGstin('33', 'AAKCS4821M')
    expect(isValidGstin(g)).toBe(true)
    expect(isValidGstin(g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A'))).toBe(false)
    expect(financialYearOf('2026-03-31')).toBe('2025-26')
    expect(financialYearOf('2026-04-01')).toBe('2026-27')
  })
})

describe('demo data', () => {
  it('has the requested volumes', () => {
    const d = report.demo!
    expect(d.customers).toBe(10)
    expect(d.suppliers).toBe(5)
    expect(d.products).toBe(20)
    expect(d.warehouses).toBe(3)
    expect(d.salesInvoices).toBeGreaterThanOrEqual(25)
    expect(d.purchaseInvoices).toBeGreaterThanOrEqual(10)
    expect(d.receipts).toBeGreaterThan(0)
    expect(d.payments).toBeGreaterThan(0)
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM products WHERE company_id=? AND item_type='SERVICE'`, ctx.companyId).n).toBe(6)
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM stock_movements WHERE movement_type='OPENING'`).n).toBeGreaterThan(0)
  })

  it('is clearly labelled DEMO', () => {
    const c = one<{ name: string; is_demo: number }>('SELECT name, is_demo FROM companies WHERE id = ?', ctx.companyId)
    expect(c.is_demo).toBe(1)
    expect(c.name).toContain('DEMO')
  })
})

describe('accounting invariants (rules 1–4)', () => {
  it('every journal is balanced and the trial balance nets to zero', () => {
    const unbalanced = db.prepare(`SELECT je.id FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      GROUP BY je.id HAVING SUM(l.debit_paise) <> SUM(l.credit_paise) OR SUM(l.debit_paise) <> je.total_debit_paise`).all()
    expect(unbalanced).toEqual([])
    const tb = trialBalance(ctx)
    const dr = tb.reduce((s, r) => s + r.debitPaise, 0)
    const cr = tb.reduce((s, r) => s + r.creditPaise, 0)
    expect(dr).toBe(cr)
    expect(dr).toBeGreaterThan(0)
  })

  it('every posted invoice has a journal; every goods line has a stock movement', () => {
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM sales_invoices WHERE status='POSTED' AND journal_entry_id IS NULL`).n).toBe(0)
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM purchase_invoices WHERE status='POSTED' AND journal_entry_id IS NULL`).n).toBe(0)
    const missing = one<{ n: number }>(`SELECT COUNT(*) n FROM sales_invoice_items it JOIN products p ON p.id = it.product_id
      WHERE p.track_inventory = 1 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.reference_type='SALES_INVOICE' AND m.reference_id = it.invoice_id AND m.product_id = it.product_id)`)
    expect(missing.n).toBe(0)
    const serviceMoves = one<{ n: number }>(`SELECT COUNT(*) n FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE p.item_type = 'SERVICE'`)
    expect(serviceMoves.n).toBe(0)
  })

  it('stock balances equal the sum of movements, and the Stock-in-Hand ledger equals stock value', () => {
    const drift = db.prepare(`SELECT b.product_id FROM stock_balances b WHERE b.qty_milli <> (SELECT COALESCE(SUM(qty_in_milli - qty_out_milli),0)
      FROM stock_movements m WHERE m.product_id = b.product_id AND m.warehouse_id = b.warehouse_id)`).all()
    expect(drift).toEqual([])
    const stockValue = one<{ v: number }>('SELECT SUM(value_paise) v FROM stock_balances WHERE company_id = ?', ctx.companyId).v
    const ledger = one<{ v: number }>(`SELECT SUM(l.debit_paise - l.credit_paise) v FROM journal_entry_lines l WHERE l.account_id = ?`, accountId(db, ctx.companyId, 'INVENTORY')).v
    expect(ledger).toBe(stockValue)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM stock_balances WHERE qty_milli < 0').n).toBe(0)
  })

  it('party balances (receivables/payables) reconcile to the control accounts', () => {
    const ar = listCustomers(ctx, { includeInactive: true }).reduce((s, c) => s + c.balancePaise, 0)
    const ap = listSuppliers(ctx, { includeInactive: true }).reduce((s, c) => s + c.balancePaise, 0)
    const dash = dashboardSummary(ctx, asOf)
    expect(dash.kpis.receivablesPaise).toBe(ar)
    expect(dash.kpis.payablesPaise).toBe(ap)
    expect(ar).toBeGreaterThan(0)
    expect(ap).toBeGreaterThan(0)
  })

  it('dashboard figures are derived from transactions', () => {
    const dash = dashboardSummary(ctx, asOf)
    const sales = one<{ t: number; n: number }>(`SELECT SUM(grand_total_paise) t, COUNT(*) n FROM sales_invoices WHERE company_id=? AND status='POSTED'`, ctx.companyId)
    expect(dash.kpis.salesPaise).toBe(sales.t)
    expect(dash.kpis.salesCount).toBe(sales.n)
    expect(dash.monthly).toHaveLength(6)
    expect(dash.monthly.reduce((s, m) => s + m.salesPaise, 0)).toBeGreaterThan(0)
    expect(dash.topCustomers.length).toBeGreaterThan(0)
    expect(dash.salesMix.map((m) => m.itemType)).toEqual(['GOODS', 'SERVICE'])
  })
})

describe('immutability & corrections (rules 5–6)', () => {
  it('blocks edits and deletes of posted invoices, lines, journals, movements and audit logs', () => {
    const inv = one<{ id: number }>(`SELECT id FROM sales_invoices WHERE status='POSTED' LIMIT 1`)
    expect(() => db.prepare('UPDATE sales_invoices SET grand_total_paise = 1 WHERE id = ?').run(inv.id)).toThrow(/cannot be edited/)
    expect(() => db.prepare('DELETE FROM sales_invoices WHERE id = ?').run(inv.id)).toThrow(/cannot be deleted/)
    expect(() => db.prepare('UPDATE sales_invoice_items SET qty_milli = 1 WHERE invoice_id = ?').run(inv.id)).toThrow(/posted sales invoice/)
    expect(() => db.prepare('UPDATE journal_entry_lines SET debit_paise = debit_paise + 1 WHERE id = 1').run()).toThrow(/reversal/)
    expect(() => db.prepare('DELETE FROM journal_entries WHERE id = 1').run()).toThrow(/reversal/)
    expect(() => db.prepare('DELETE FROM stock_movements WHERE id = 1').run()).toThrow(/adjustment/)
    expect(() => db.prepare('UPDATE audit_logs SET summary = ? WHERE id = 1').run('x')).toThrow(/immutable/)
    const p = one<{ id: number }>(`SELECT id FROM purchase_invoices WHERE status='POSTED' LIMIT 1`)
    expect(() => db.prepare('UPDATE purchase_invoices SET supplier_id = supplier_id WHERE id = ?').run(p.id)).toThrow(/cannot be edited/)
  })

  it('rejects unbalanced journals', () => {
    expect(() =>
      db.transaction(() =>
        postJournal(db, { companyId: ctx.companyId, userId: ctx.userId, entryDate: asOf, sourceType: 'MANUAL', narration: 'bad', lines: [
          { accountId: accountId(db, ctx.companyId, 'CASH'), debitPaise: 100 },
          { accountId: accountId(db, ctx.companyId, 'CAPITAL'), creditPaise: 99 }
        ] })
      )()
    ).toThrow(/not balanced/)
  })
})

describe('transactions & numbering (rules 9–10)', () => {
  it('numbers invoices uniquely per company and financial year', () => {
    const dupes = db.prepare('SELECT invoice_no FROM sales_invoices GROUP BY company_id, financial_year, invoice_no HAVING COUNT(*) > 1').all()
    expect(dupes).toEqual([])
    const inv = one<{ company_id: number; financial_year: string; invoice_no: string; customer_id: number }>('SELECT * FROM sales_invoices LIMIT 1')
    expect(inv.invoice_no).toMatch(/^INV\/2026-27\/\d{4}$/)
    expect(() =>
      db.prepare(`INSERT INTO sales_invoices (company_id, financial_year, invoice_no, invoice_date, customer_id, place_of_supply) VALUES (?, ?, ?, ?, ?, '33')`)
        .run(inv.company_id, inv.financial_year, inv.invoice_no, asOf, inv.customer_id)
    ).toThrow(/UNIQUE/)
  })

  it('rejects a duplicate supplier bill number', () => {
    const p = one<{ supplier_id: number; supplier_invoice_no: string }>('SELECT supplier_id, supplier_invoice_no FROM purchase_invoices LIMIT 1')
    const product = one<{ id: number }>(`SELECT id FROM products WHERE item_type='GOODS' LIMIT 1`)
    const wh = one<{ id: number }>('SELECT id FROM warehouses WHERE company_id = ? LIMIT 1', ctx.companyId)
    expect(() =>
      postPurchaseInvoice(ctx, { supplierId: p.supplier_id, invoiceDate: asOf, supplierInvoiceNo: p.supplier_invoice_no, supplierInvoiceDate: asOf, warehouseId: wh.id,
        lines: [{ productId: product.id, qtyMilli: 1000, ratePaise: 100 }] })
    ).toThrow(/UNIQUE/)
  })

  it('rolls back the whole sale when stock is insufficient', () => {
    const before = {
      inv: one<{ n: number }>('SELECT COUNT(*) n FROM sales_invoices').n,
      je: one<{ n: number }>('SELECT COUNT(*) n FROM journal_entries').n,
      sm: one<{ n: number }>('SELECT COUNT(*) n FROM stock_movements').n,
      seq: one<{ n: number }>(`SELECT next_number n FROM document_sequences WHERE doc_type='SALES_INVOICE'`).n
    }
    const customer = one<{ id: number }>('SELECT id FROM customers WHERE company_id = ? LIMIT 1', ctx.companyId)
    const service = one<{ id: number }>(`SELECT id FROM products WHERE item_type='SERVICE' LIMIT 1`)
    const goods = one<{ id: number }>(`SELECT id FROM products WHERE code='LAP-14I5'`)
    const wh = one<{ id: number }>('SELECT id FROM warehouses WHERE company_id = ? LIMIT 1', ctx.companyId)
    expect(() =>
      postSalesInvoice(ctx, { customerId: customer.id, invoiceDate: asOf, warehouseId: wh.id, lines: [
        { productId: service.id, qtyMilli: 1000, ratePaise: 100000 },
        { productId: goods.id, qtyMilli: 999000, ratePaise: 100000 }
      ] })
    ).toThrow(/Insufficient stock/)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM sales_invoices').n).toBe(before.inv)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM journal_entries').n).toBe(before.je)
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM stock_movements').n).toBe(before.sm)
    expect(one<{ n: number }>(`SELECT next_number n FROM document_sequences WHERE doc_type='SALES_INVOICE'`).n).toBe(before.seq)
  })

  it('posts a services-only sale without touching stock and writes an audit entry', () => {
    const customer = one<{ id: number; state_code: string }>(`SELECT id, state_code FROM customers WHERE company_id = ? AND state_code <> '33' LIMIT 1`, ctx.companyId)
    const service = one<{ id: number }>(`SELECT id FROM products WHERE code='SVC-CONS'`)
    const wh = one<{ id: number }>('SELECT id FROM warehouses WHERE company_id = ? LIMIT 1', ctx.companyId)
    const sm = one<{ n: number }>('SELECT COUNT(*) n FROM stock_movements').n
    const res = postSalesInvoice(ctx, { customerId: customer.id, invoiceDate: asOf, warehouseId: wh.id, lines: [{ productId: service.id, qtyMilli: 2500, ratePaise: 350000 }] })
    const inv = one<{ is_inter_state: number; igst_paise: number; cgst_paise: number; taxable_paise: number }>('SELECT * FROM sales_invoices WHERE id = ?', res.id)
    expect(inv.is_inter_state).toBe(1)
    expect(inv.cgst_paise).toBe(0)
    expect(inv.igst_paise).toBe(Math.round(inv.taxable_paise * 0.18))
    expect(one<{ n: number }>('SELECT COUNT(*) n FROM stock_movements').n).toBe(sm)
    expect(one<{ n: number }>(`SELECT COUNT(*) n FROM audit_logs WHERE entity_type='sales_invoice' AND entity_id = ?`, res.id).n).toBe(1)
  })
})
