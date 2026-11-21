import type { Lookups, Product } from '@shared/types'
import type { ListQueryT, ProductInputT, ProductUpdateInputT } from '@shared/schemas'
import { GST_STATES } from '@shared/india'
import { diff, writeAudit } from './audit'
import { bool, inTransaction, type ServiceContext } from './context'
import { businessRule, notFound, validation } from './errors'

interface ProductRow {
  id: number; code: string; name: string; description: string | null; item_type: 'GOODS' | 'SERVICE'; category_id: number | null; category_name: string | null
  unit_id: number; unit_code: string; hsn_sac: string; tax_rate_id: number; rate_bps: number; sale_price_paise: number; purchase_price_paise: number
  mrp_paise: number | null; reorder_level_milli: number; track_inventory: number; stock_qty_milli: number; stock_value_paise: number
  is_active: number; created_at: string; updated_at: string
}

const SELECT = `SELECT p.*, c.name AS category_name, u.code AS unit_code, t.rate_bps,
    COALESCE((SELECT SUM(qty_milli) FROM stock_balances b WHERE b.product_id = p.id), 0) AS stock_qty_milli,
    COALESCE((SELECT SUM(value_paise) FROM stock_balances b WHERE b.product_id = p.id), 0) AS stock_value_paise
  FROM products p
  JOIN units u ON u.id = p.unit_id
  JOIN tax_rates t ON t.id = p.tax_rate_id
  LEFT JOIN categories c ON c.id = p.category_id`

const toProduct = (r: ProductRow): Product => ({
  id: r.id, code: r.code, name: r.name, description: r.description, itemType: r.item_type, categoryId: r.category_id, categoryName: r.category_name,
  unitId: r.unit_id, unitCode: r.unit_code, hsnSac: r.hsn_sac, taxRateId: r.tax_rate_id, taxRateBps: r.rate_bps,
  salePricePaise: r.sale_price_paise, purchasePricePaise: r.purchase_price_paise, mrpPaise: r.mrp_paise, reorderLevelMilli: r.reorder_level_milli,
  trackInventory: bool(r.track_inventory), stockQtyMilli: r.stock_qty_milli, stockValuePaise: r.stock_value_paise,
  isActive: bool(r.is_active), createdAt: r.created_at, updatedAt: r.updated_at
})

export function listProducts(ctx: ServiceContext, q: ListQueryT): Product[] {
  const where = ['p.company_id = @companyId']
  if (!q?.includeInactive) where.push('p.is_active = 1')
  if (q?.search) where.push('(p.name LIKE @like OR p.code LIKE @like OR p.hsn_sac LIKE @like OR IFNULL(c.name,\'\') LIKE @like)')
  return (
    ctx.db
      .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT @limit OFFSET @offset`)
      .all({ companyId: ctx.companyId, like: `%${q?.search ?? ''}%`, limit: q?.limit ?? 500, offset: q?.offset ?? 0 }) as ProductRow[]
  ).map(toProduct)
}

export function getProduct(ctx: ServiceContext, id: number): Product {
  const row = ctx.db.prepare(`${SELECT} WHERE p.id = ? AND p.company_id = ?`).get(id, ctx.companyId) as ProductRow | undefined
  if (!row) throw notFound('Product')
  return toProduct(row)
}

/** Foreign-key targets must exist and belong to this company (FKs alone can't check tenancy). */
function checkReferences(ctx: ServiceContext, input: ProductInputT): void {
  const errors: Record<string, string> = {}
  if (input.categoryId != null && !ctx.db.prepare('SELECT 1 FROM categories WHERE id = ? AND company_id = ?').get(input.categoryId, ctx.companyId)) errors.categoryId = 'Select a valid category'
  if (!ctx.db.prepare('SELECT 1 FROM units WHERE id = ?').get(input.unitId)) errors.unitId = 'Select a valid unit'
  if (!ctx.db.prepare('SELECT 1 FROM tax_rates WHERE id = ? AND is_active = 1').get(input.taxRateId)) errors.taxRateId = 'Select a valid GST rate'
  if (Object.keys(errors).length) throw validation('Please correct the highlighted fields', errors)
}

const params = (ctx: ServiceContext, v: ProductInputT | ProductUpdateInputT) => ({
  ...v,
  companyId: ctx.companyId,
  categoryId: v.categoryId ?? null,
  mrpPaise: v.mrpPaise ?? null,
  trackInventory: v.trackInventory ? 1 : 0
})

export function createProduct(ctx: ServiceContext, input: ProductInputT): Product {
  return inTransaction(ctx.db, () => {
    checkReferences(ctx, input)
    const res = ctx.db
      .prepare(
        `INSERT INTO products (company_id, code, name, description, item_type, category_id, unit_id, hsn_sac, tax_rate_id,
           sale_price_paise, purchase_price_paise, mrp_paise, reorder_level_milli, track_inventory)
         VALUES (@companyId, @code, @name, @description, @itemType, @categoryId, @unitId, @hsnSac, @taxRateId,
           @salePricePaise, @purchasePricePaise, @mrpPaise, @reorderLevelMilli, @trackInventory)`
      )
      .run(params(ctx, input))
    const product = getProduct(ctx, Number(res.lastInsertRowid))
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'CREATE', entityType: 'product', entityId: product.id, summary: `${product.itemType === 'SERVICE' ? 'Service' : 'Product'} ${product.code} - ${product.name} created`, details: product })
    return product
  })
}

export function updateProduct(ctx: ServiceContext, input: ProductUpdateInputT): Product {
  return inTransaction(ctx.db, () => {
    const before = getProduct(ctx, input.id)
    checkReferences(ctx, input)
    const hasMovements = !!ctx.db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1').get(input.id)
    if (hasMovements && input.itemType !== before.itemType) throw businessRule('Item type cannot be changed after stock transactions exist', { itemType: 'Locked: stock transactions exist' })
    if (hasMovements && before.trackInventory && !input.trackInventory) throw businessRule('Inventory tracking cannot be switched off after stock transactions exist', { trackInventory: 'Locked: stock transactions exist' })
    ctx.db
      .prepare(
        `UPDATE products SET code=@code, name=@name, description=@description, item_type=@itemType, category_id=@categoryId, unit_id=@unitId,
           hsn_sac=@hsnSac, tax_rate_id=@taxRateId, sale_price_paise=@salePricePaise, purchase_price_paise=@purchasePricePaise, mrp_paise=@mrpPaise,
           reorder_level_milli=@reorderLevelMilli, track_inventory=@trackInventory, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id=@id AND company_id=@companyId`
      )
      .run(params(ctx, input))
    const after = getProduct(ctx, input.id)
    const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>)
    delete changes.stockQtyMilli
    delete changes.stockValuePaise
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'UPDATE', entityType: 'product', entityId: input.id, summary: `Product ${after.code} updated (${Object.keys(changes).join(', ') || 'no changes'})`, details: changes })
    return after
  })
}

export function setProductActive(ctx: ServiceContext, id: number, isActive: boolean): Product {
  return inTransaction(ctx.db, () => {
    const p = getProduct(ctx, id)
    ctx.db.prepare(`UPDATE products SET is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(isActive ? 1 : 0, id)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: isActive ? 'ACTIVATE' : 'DEACTIVATE', entityType: 'product', entityId: id, summary: `Product ${p.code} ${isActive ? 'activated' : 'deactivated'}` })
    return getProduct(ctx, id)
  })
}

export function getLookups(ctx: ServiceContext): Lookups {
  const db = ctx.db
  return {
    categories: db.prepare('SELECT id, name FROM categories WHERE company_id = ? AND is_active = 1 ORDER BY name').all(ctx.companyId) as Lookups['categories'],
    units: db.prepare('SELECT id, code, name FROM units ORDER BY code').all() as Lookups['units'],
    taxRates: db.prepare('SELECT id, name, rate_bps AS rateBps FROM tax_rates WHERE is_active = 1 ORDER BY rate_bps').all() as Lookups['taxRates'],
    warehouses: db.prepare('SELECT id, code, name FROM warehouses WHERE company_id = ? AND is_active = 1 ORDER BY name').all(ctx.companyId) as Lookups['warehouses'],
    transporters: db.prepare('SELECT id, name, transporter_id AS transporterId FROM transporters WHERE company_id = ? AND is_active = 1 ORDER BY name').all(ctx.companyId) as Lookups['transporters'],
    states: [...GST_STATES],
    cashBankAccounts: db.prepare('SELECT id, code, name, system_key AS systemKey FROM chart_of_accounts WHERE company_id = ? AND is_bank = 1 AND is_active = 1 ORDER BY code').all(ctx.companyId) as Lookups['cashBankAccounts']
  }
}
