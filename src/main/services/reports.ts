import type {
  AuditRow, BankingOverview, DashboardSummary, GstSummaryRow, InvoiceRow, JournalRow, MovementRow, NotificationItem, RoleRow,
  SearchResult, StockRow, TrialBalanceRow, UserRow
} from '@shared/types'
import type { ListQueryT } from '@shared/schemas'
import { financialYearOf, financialYearRange } from '@shared/india'
import { formatINR, milliToString } from '@shared/money'
import { bool, type ServiceContext } from './context'
import { docRoute, KINDS, type DocumentKind } from '@shared/documents'

const today = (): string => new Date().toISOString().slice(0, 10)
type Row = Record<string, number | string | null>

function fyRange(ctx: ServiceContext, asOf: string): { fy: string; from: string; to: string } {
  const { fy_start_month } = ctx.db.prepare('SELECT fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { fy_start_month: number }
  const fy = financialYearOf(asOf, fy_start_month)
  return { fy, ...financialYearRange(fy, fy_start_month) }
}

function ledgerBalance(ctx: ServiceContext, keys: string[]): number {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS b FROM journal_entry_lines l
       JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.company_id = ? AND a.system_key IN (${keys.map(() => '?').join(',')})`
    )
    .get(ctx.companyId, ...keys) as { b: number }
  return row.b
}

function lastMonths(asOf: string, n: number): Array<{ month: string; label: string }> {
  const [y, m] = asOf.split('-').map(Number)
  const out: Array<{ month: string; label: string }> = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push({ month: d.toISOString().slice(0, 7), label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }) })
  }
  return out
}

export function dashboardSummary(ctx: ServiceContext, asOf = today()): DashboardSummary {
  const db = ctx.db
  const c = ctx.companyId
  const { fy, from, to } = fyRange(ctx, asOf)

  const sales = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(grand_total_paise),0) t, COALESCE(SUM(cgst_paise+sgst_paise+igst_paise),0) tax FROM sales_invoices WHERE company_id=? AND status='POSTED' AND invoice_date BETWEEN ? AND ?`).get(c, from, to) as { n: number; t: number; tax: number }
  const purchases = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(grand_total_paise),0) t, COALESCE(SUM(cgst_paise+sgst_paise+igst_paise),0) tax FROM purchase_invoices WHERE company_id=? AND status='POSTED' AND invoice_date BETWEEN ? AND ?`).get(c, from, to) as { n: number; t: number; tax: number }
  const receipts = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM payment_receipts WHERE company_id=? AND status='POSTED' AND receipt_date BETWEEN ? AND ?`).get(c, from, to) as { t: number }
  const payments = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) t FROM payment_vouchers WHERE company_id=? AND status='POSTED' AND voucher_date BETWEEN ? AND ?`).get(c, from, to) as { t: number }
  const stock = db.prepare('SELECT COALESCE(SUM(value_paise),0) v FROM stock_balances WHERE company_id = ?').get(c) as { v: number }

  const months = lastMonths(asOf, 6)
  const monthly = months.map(({ month, label }) => {
    const like = `${month}-%`
    const s = db.prepare(`SELECT COALESCE(SUM(taxable_paise),0) v FROM sales_invoices WHERE company_id=? AND status='POSTED' AND invoice_date LIKE ?`).get(c, like) as { v: number }
    const p = db.prepare(`SELECT COALESCE(SUM(taxable_paise),0) v FROM purchase_invoices WHERE company_id=? AND status='POSTED' AND invoice_date LIKE ?`).get(c, like) as { v: number }
    const r = db.prepare(`SELECT COALESCE(SUM(amount_paise),0) v FROM payment_receipts WHERE company_id=? AND status='POSTED' AND receipt_date LIKE ?`).get(c, like) as { v: number }
    return { month, label, salesPaise: s.v, purchasesPaise: p.v, receiptsPaise: r.v }
  })

  const topCustomers = db
    .prepare(`SELECT cu.id, cu.name, SUM(si.taxable_paise) AS salesPaise FROM sales_invoices si JOIN customers cu ON cu.id = si.customer_id
              WHERE si.company_id=? AND si.status='POSTED' AND si.invoice_date BETWEEN ? AND ? GROUP BY cu.id ORDER BY salesPaise DESC LIMIT 5`)
    .all(c, from, to) as DashboardSummary['topCustomers']

  const salesMix = db
    .prepare(`SELECT it.item_type AS itemType, SUM(it.taxable_paise) AS taxablePaise FROM sales_invoice_items it JOIN sales_invoices si ON si.id = it.invoice_id
              WHERE si.company_id=? AND si.status='POSTED' AND si.invoice_date BETWEEN ? AND ? GROUP BY it.item_type ORDER BY it.item_type`)
    .all(c, from, to) as DashboardSummary['salesMix']

  const recentInvoices = db
    .prepare(`SELECT * FROM (
                SELECT si.id, 'SALE' AS kind, si.invoice_no AS number, si.invoice_date AS date, cu.name AS party, si.grand_total_paise AS totalPaise, si.created_at
                FROM sales_invoices si JOIN customers cu ON cu.id = si.customer_id WHERE si.company_id=? AND si.status='POSTED'
                UNION ALL
                SELECT pi.id, 'PURCHASE', pi.invoice_no, pi.invoice_date, su.name, pi.grand_total_paise, pi.created_at
                FROM purchase_invoices pi JOIN suppliers su ON su.id = pi.supplier_id WHERE pi.company_id=? AND pi.status='POSTED')
              ORDER BY date DESC, created_at DESC LIMIT 8`)
    .all(c, c) as DashboardSummary['recentInvoices']

  const lowStock = lowStockItems(ctx).slice(0, 6)
  const counts = db
    .prepare(`SELECT (SELECT COUNT(*) FROM customers WHERE company_id=@c AND is_active=1) customers,
                     (SELECT COUNT(*) FROM suppliers WHERE company_id=@c AND is_active=1) suppliers,
                     (SELECT COUNT(*) FROM products WHERE company_id=@c AND is_active=1 AND item_type='GOODS') products,
                     (SELECT COUNT(*) FROM products WHERE company_id=@c AND is_active=1 AND item_type='SERVICE') services,
                     (SELECT COUNT(*) FROM warehouses WHERE company_id=@c AND is_active=1) warehouses`)
    .get({ c }) as DashboardSummary['counts']

  return {
    financialYear: fy,
    asOf,
    kpis: {
      salesPaise: sales.t,
      salesCount: sales.n,
      purchasesPaise: purchases.t,
      purchasesCount: purchases.n,
      receivablesPaise: ledgerBalance(ctx, ['AR']),
      payablesPaise: -ledgerBalance(ctx, ['AP']),
      cashBankPaise: ledgerBalance(ctx, ['CASH', 'BANK']),
      stockValuePaise: stock.v,
      gstOutputPaise: sales.tax,
      gstInputPaise: purchases.tax,
      receiptsPaise: receipts.t,
      paymentsPaise: payments.t
    },
    counts,
    monthly,
    topCustomers,
    salesMix,
    recentInvoices,
    lowStock
  }
}

function lowStockItems(ctx: ServiceContext): DashboardSummary['lowStock'] {
  return ctx.db
    .prepare(`SELECT p.id AS productId, p.code, p.name, COALESCE(SUM(b.qty_milli),0) AS qtyMilli, p.reorder_level_milli AS reorderLevelMilli
              FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
              WHERE p.company_id = ? AND p.is_active = 1 AND p.track_inventory = 1 AND p.reorder_level_milli > 0
              GROUP BY p.id HAVING qtyMilli <= p.reorder_level_milli ORDER BY (qtyMilli * 1.0 / p.reorder_level_milli), p.name`)
    .all(ctx.companyId) as DashboardSummary['lowStock']
}

function invoiceList(ctx: ServiceContext, kind: 'sales' | 'purchase', q: ListQueryT): InvoiceRow[] {
  const sales = kind === 'sales'
  const sql = `SELECT i.id, i.invoice_no AS invoiceNo, i.invoice_date AS invoiceDate, p.id AS partyId, p.name AS partyName,
      ${sales ? 'i.customer_gstin' : 'i.supplier_invoice_no'} AS partyRef, i.status, i.taxable_paise AS taxablePaise,
      (i.cgst_paise + i.sgst_paise + i.igst_paise) AS taxPaise, i.grand_total_paise AS grandTotalPaise, i.is_inter_state AS isInterState,
      (SELECT COUNT(*) FROM ${sales ? 'sales' : 'purchase'}_invoice_items it WHERE it.invoice_id = i.id) AS itemCount
    FROM ${sales ? 'sales_invoices' : 'purchase_invoices'} i JOIN ${sales ? 'customers' : 'suppliers'} p ON p.id = i.${sales ? 'customer' : 'supplier'}_id
    WHERE i.company_id = @c ${q?.search ? 'AND (i.invoice_no LIKE @like OR p.name LIKE @like)' : ''}
    ORDER BY i.invoice_date DESC, i.id DESC LIMIT @limit`
  return (ctx.db.prepare(sql).all({ c: ctx.companyId, like: `%${q?.search ?? ''}%`, limit: q?.limit ?? 500 }) as Array<Omit<InvoiceRow, 'isInterState'> & { isInterState: number }>).map((r) => ({ ...r, isInterState: bool(r.isInterState) }))
}
export const salesList = (ctx: ServiceContext, q: ListQueryT): InvoiceRow[] => invoiceList(ctx, 'sales', q)
export const purchaseList = (ctx: ServiceContext, q: ListQueryT): InvoiceRow[] => invoiceList(ctx, 'purchase', q)

export function stockSummary(ctx: ServiceContext): StockRow[] {
  return ctx.db
    .prepare(`SELECT p.id AS productId, p.code, p.name, c.name AS categoryName, u.code AS unitCode, w.id AS warehouseId, w.name AS warehouseName,
                b.qty_milli AS qtyMilli, b.value_paise AS valuePaise, p.reorder_level_milli AS reorderLevelMilli
              FROM stock_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id
              JOIN units u ON u.id = p.unit_id LEFT JOIN categories c ON c.id = p.category_id
              WHERE b.company_id = ? ORDER BY p.name, w.name`)
    .all(ctx.companyId) as StockRow[]
}

export function stockMovements(ctx: ServiceContext, q: { productId?: number; limit?: number } | undefined): MovementRow[] {
  return ctx.db
    .prepare(`SELECT m.id, m.movement_date AS movementDate, m.movement_type AS movementType, p.code AS productCode, p.name AS productName, w.name AS warehouseName,
                m.qty_in_milli AS qtyInMilli, m.qty_out_milli AS qtyOutMilli, m.unit_cost_paise AS unitCostPaise, m.value_paise AS valuePaise,
                m.reference_no AS referenceNo, m.balance_qty_milli AS balanceQtyMilli
              FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
              WHERE m.company_id = @c ${q?.productId ? 'AND m.product_id = @pid' : ''} ORDER BY m.movement_date DESC, m.id DESC LIMIT @limit`)
    .all({ c: ctx.companyId, pid: q?.productId ?? null, limit: q?.limit ?? 300 }) as MovementRow[]
}

export function trialBalance(ctx: ServiceContext): TrialBalanceRow[] {
  return (
    ctx.db
      .prepare(`SELECT a.id AS accountId, a.code, a.name, a.account_type AS accountType, COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS net
                FROM chart_of_accounts a LEFT JOIN journal_entry_lines l ON l.account_id = a.id
                WHERE a.company_id = ? AND a.is_group = 0 GROUP BY a.id HAVING net <> 0 ORDER BY a.code`)
      .all(ctx.companyId) as Array<Omit<TrialBalanceRow, 'debitPaise' | 'creditPaise'> & { net: number }>
  ).map(({ net, ...r }) => ({ ...r, debitPaise: net > 0 ? net : 0, creditPaise: net < 0 ? -net : 0 }))
}

export function journals(ctx: ServiceContext, q: ListQueryT): JournalRow[] {
  const headers = ctx.db
    .prepare(`SELECT id, entry_no AS entryNo, entry_date AS entryDate, COALESCE(source_kind, source_type) AS sourceType, narration, total_debit_paise AS totalPaise, status
              FROM journal_entries WHERE company_id = @c ${q?.search ? 'AND (entry_no LIKE @like OR narration LIKE @like)' : ''}
              ORDER BY entry_date DESC, id DESC LIMIT @limit`)
    .all({ c: ctx.companyId, like: `%${q?.search ?? ''}%`, limit: q?.limit ?? 200 }) as Array<Omit<JournalRow, 'lines'>>
  const linesStmt = ctx.db.prepare(
    `SELECT a.code AS accountCode, a.name AS accountName, l.debit_paise AS debitPaise, l.credit_paise AS creditPaise,
       CASE l.party_type WHEN 'CUSTOMER' THEN (SELECT name FROM customers WHERE id = l.party_id) WHEN 'SUPPLIER' THEN (SELECT name FROM suppliers WHERE id = l.party_id) END AS party
     FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? ORDER BY l.line_no`
  )
  return headers.map((h) => ({ ...h, lines: linesStmt.all(h.id) as JournalRow['lines'] }))
}

export function gstSummary(ctx: ServiceContext): GstSummaryRow[] {
  const { from, to } = fyRange(ctx, today())
  return gstSummaryRange(ctx, from, to)
}

/** Month-wise output and input GST for a period (credit/debit notes and returns netted). */
export function gstSummaryRange(ctx: ServiceContext, from: string, to: string): GstSummaryRow[] {
  const rows = ctx.db
    .prepare(`SELECT month, SUM(ot) ot, SUM(oc) oc, SUM(os) os, SUM(oi) oi, SUM(it) it, SUM(ic) ic, SUM(isg) isg, SUM(ii) ii FROM (
                SELECT substr(invoice_date,1,7) month, taxable_paise ot, cgst_paise oc, sgst_paise os, igst_paise oi, 0 it, 0 ic, 0 isg, 0 ii
                FROM sales_invoices WHERE company_id=@c AND status='POSTED' AND invoice_date BETWEEN @from AND @to
                UNION ALL
                SELECT substr(invoice_date,1,7), 0, 0, 0, 0, taxable_paise, cgst_paise, sgst_paise, igst_paise
                FROM purchase_invoices WHERE company_id=@c AND status='POSTED' AND invoice_date BETWEEN @from AND @to
                UNION ALL
                -- Credit notes / sales returns reduce output tax; debit notes / purchase returns reduce input tax.
                SELECT substr(doc_date,1,7),
                  CASE WHEN doc_type IN ('SALES_RETURN','CREDIT_NOTE') THEN -taxable_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('SALES_RETURN','CREDIT_NOTE') THEN -cgst_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('SALES_RETURN','CREDIT_NOTE') THEN -sgst_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('SALES_RETURN','CREDIT_NOTE') THEN -igst_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') THEN -taxable_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') THEN -cgst_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') THEN -sgst_paise ELSE 0 END,
                  CASE WHEN doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') THEN -igst_paise ELSE 0 END
                FROM trade_documents WHERE company_id=@c AND status='POSTED' AND doc_type IN ('SALES_RETURN','CREDIT_NOTE','PURCHASE_RETURN','DEBIT_NOTE')
                  AND doc_date BETWEEN @from AND @to)
              GROUP BY month ORDER BY month`)
    .all({ c: ctx.companyId, from, to }) as Array<Record<string, number> & { month: string }>
  return rows.map((r) => ({
    month: r.month, outputTaxablePaise: r.ot, outputCgstPaise: r.oc, outputSgstPaise: r.os, outputIgstPaise: r.oi,
    inputTaxablePaise: r.it, inputCgstPaise: r.ic, inputSgstPaise: r.isg, inputIgstPaise: r.ii
  }))
}

export function bankingOverview(ctx: ServiceContext): BankingOverview {
  const accounts = ctx.db
    .prepare(`SELECT a.id, a.code, a.name, COALESCE(SUM(l.debit_paise - l.credit_paise),0) AS balancePaise
              FROM chart_of_accounts a LEFT JOIN journal_entry_lines l ON l.account_id = a.id
              WHERE a.company_id = ? AND a.is_bank = 1 GROUP BY a.id ORDER BY a.code`)
    .all(ctx.companyId) as BankingOverview['accounts']
  const transactions = ctx.db
    .prepare(`SELECT * FROM (
                SELECT r.id, 'RECEIPT' kind, r.receipt_no number, r.receipt_date date, c.name party, r.mode, a.name account, r.amount_paise amountPaise, r.reference_no reference
                FROM payment_receipts r JOIN customers c ON c.id = r.customer_id JOIN chart_of_accounts a ON a.id = r.deposit_account_id WHERE r.company_id = @c
                UNION ALL
                SELECT v.id, 'PAYMENT', v.voucher_no, v.voucher_date, s.name, v.mode, a.name, v.amount_paise, v.reference_no
                FROM payment_vouchers v JOIN suppliers s ON s.id = v.supplier_id JOIN chart_of_accounts a ON a.id = v.paid_from_account_id WHERE v.company_id = @c)
              ORDER BY date DESC, number DESC LIMIT 300`)
    .all({ c: ctx.companyId }) as BankingOverview['transactions']
  return { accounts, transactions }
}

export function auditList(ctx: ServiceContext, q: { entityType?: string; limit?: number } | undefined): AuditRow[] {
  return ctx.db
    .prepare(`SELECT a.id, a.created_at AS createdAt, u.username, a.action, a.entity_type AS entityType, a.entity_id AS entityId, a.summary, a.details_json AS details
              FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
              WHERE (a.company_id = @c OR a.company_id IS NULL) ${q?.entityType ? 'AND a.entity_type = @et' : ''}
              ORDER BY a.id DESC LIMIT @limit`)
    .all({ c: ctx.companyId, et: q?.entityType ?? null, limit: q?.limit ?? 300 }) as AuditRow[]
}

export function userList(ctx: ServiceContext): UserRow[] {
  return (
    ctx.db
      .prepare(`SELECT u.id, u.username, u.full_name AS fullName, u.email, r.name AS roleName, u.is_active AS isActive, u.last_login_at AS lastLoginAt
                FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username`)
      .all() as Array<Omit<UserRow, 'isActive'> & { isActive: number }>
  ).map((u) => ({ ...u, isActive: bool(u.isActive) }))
}

export function roleList(ctx: ServiceContext): RoleRow[] {
  const roles = ctx.db.prepare('SELECT id, code, name FROM roles ORDER BY id').all() as Array<Omit<RoleRow, 'permissions'>>
  const perms = ctx.db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.code')
  return roles.map((r) => ({ ...r, permissions: (perms.all(r.id) as Array<{ code: string }>).map((p) => p.code) }))
}

export function globalSearch(ctx: ServiceContext, query: string): SearchResult[] {
  const like = `%${query}%`
  const c = ctx.companyId
  const db = ctx.db
  const out: SearchResult[] = []
  for (const r of db.prepare(`SELECT id, code, name, city, gstin FROM customers WHERE company_id=? AND (name LIKE ? OR code LIKE ? OR IFNULL(gstin,'') LIKE ?) LIMIT 5`).all(c, like, like, like) as Row[])
    out.push({ type: 'customer', id: r.id as number, title: r.name as string, subtitle: `Customer · ${r.code}${r.city ? ` · ${r.city}` : ''}`, route: `/masters/customers?open=${r.id}` })
  for (const r of db.prepare(`SELECT id, code, name, city FROM suppliers WHERE company_id=? AND (name LIKE ? OR code LIKE ? OR IFNULL(gstin,'') LIKE ?) LIMIT 5`).all(c, like, like, like) as Row[])
    out.push({ type: 'supplier', id: r.id as number, title: r.name as string, subtitle: `Supplier · ${r.code}${r.city ? ` · ${r.city}` : ''}`, route: `/masters/suppliers?open=${r.id}` })
  for (const r of db.prepare(`SELECT id, code, name, item_type, hsn_sac FROM products WHERE company_id=? AND (name LIKE ? OR code LIKE ? OR hsn_sac LIKE ?) LIMIT 5`).all(c, like, like, like) as Row[])
    out.push({ type: 'product', id: r.id as number, title: r.name as string, subtitle: `${r.item_type === 'SERVICE' ? 'Service' : 'Product'} · ${r.code} · HSN/SAC ${r.hsn_sac}`, route: `/masters/products?open=${r.id}` })
  for (const r of db.prepare(`SELECT si.id, si.invoice_no, si.grand_total_paise, cu.name FROM sales_invoices si JOIN customers cu ON cu.id = si.customer_id WHERE si.company_id=? AND si.invoice_no LIKE ? LIMIT 5`).all(c, like) as Row[])
    out.push({ type: 'sales_invoice', id: r.id as number, title: r.invoice_no as string, subtitle: `Sales invoice · ${r.name} · ${formatINR(r.grand_total_paise as number)}`, route: `/sales/invoices/${r.id}` })
  for (const r of db.prepare(`SELECT pi.id, pi.invoice_no, pi.grand_total_paise, su.name FROM purchase_invoices pi JOIN suppliers su ON su.id = pi.supplier_id WHERE pi.company_id=? AND (pi.invoice_no LIKE ? OR pi.supplier_invoice_no LIKE ?) LIMIT 5`).all(c, like, like) as Row[])
    out.push({ type: 'purchase_invoice', id: r.id as number, title: r.invoice_no as string, subtitle: `Purchase · ${r.name} · ${formatINR(r.grand_total_paise as number)}`, route: `/purchase/invoices/${r.id}` })
  for (const r of db.prepare(`SELECT d.id, d.doc_type, d.doc_no, d.grand_total_paise, COALESCE(cu.name, su.name) AS name FROM trade_documents d
      LEFT JOIN customers cu ON cu.id = d.customer_id LEFT JOIN suppliers su ON su.id = d.supplier_id
      WHERE d.company_id=? AND d.status <> 'DRAFT' AND (d.doc_no LIKE ? OR IFNULL(d.reference_no,'') LIKE ?) LIMIT 6`).all(c, like, like) as Row[]) {
    const kind = r.doc_type as DocumentKind
    out.push({ type: KINDS[kind].side === 'SALES' ? 'sales_invoice' : 'purchase_invoice', id: r.id as number, title: r.doc_no as string, subtitle: `${KINDS[kind].label} · ${r.name ?? '—'} · ${formatINR(r.grand_total_paise as number)}`, route: docRoute(kind, r.id as number) })
  }
  return out
}

export function notifications(ctx: ServiceContext): NotificationItem[] {
  const out: NotificationItem[] = []
  const company = ctx.db.prepare('SELECT is_demo FROM companies WHERE id = ?').get(ctx.companyId) as { is_demo: number }
  if (company.is_demo) out.push({ id: 'demo', severity: 'info', title: 'Demo company', message: 'You are working in the DEMO company. Sample data is for demonstration only.' })
  for (const item of lowStockItems(ctx))
    out.push({ id: `low-${item.productId}`, severity: item.qtyMilli === 0 ? 'critical' : 'warning', title: `Low stock: ${item.name}`, message: `${milliToString(item.qtyMilli)} on hand, reorder level ${milliToString(item.reorderLevelMilli)}`, route: '/inventory' })
  const over = ctx.db
    .prepare(`SELECT c.id, c.name, c.credit_limit_paise lim, COALESCE((SELECT SUM(l.debit_paise - l.credit_paise) FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id AND a.system_key = 'AR'
                WHERE l.party_type = 'CUSTOMER' AND l.party_id = c.id), 0) bal
              FROM customers c WHERE c.company_id = ? AND c.is_active = 1 AND c.credit_limit_paise > 0 AND bal > c.credit_limit_paise`)
    .all(ctx.companyId) as Array<{ id: number; name: string; lim: number; bal: number }>
  for (const c of over)
    out.push({ id: `credit-${c.id}`, severity: 'warning', title: `Credit limit exceeded: ${c.name}`, message: `Outstanding ${formatINR(c.bal)} vs limit ${formatINR(c.lim)}`, route: `/masters/customers?open=${c.id}` })
  return out
}
