/**
 * Commercial document engine: draft → validate → post → (cancel by reversal).
 *
 * Posting a document runs in ONE transaction: number allocation, stock movements
 * (goods with inventory tracking only), a balanced journal, invoice settlement
 * (returns/notes) and an audit entry. Any failure rolls everything back.
 * Draft numbers ("DRAFT-12") never consume the legal number series; the real
 * number is assigned only when posting, so posted numbers have no gaps.
 */
import { randomUUID } from 'node:crypto'
import {
  KINDS, isInvoiceKind, type DocumentDetail, type DocumentKind, type DocumentSaveParsed, type ValidationResult
} from '@shared/documents'
import { financialYearOf } from '@shared/india'
import { formatINR, milliToString } from '@shared/money'
import { allocateProportionally, computeTaxCharge, computeTaxDocument, computeTaxLine, isInterStateSupply, mulDivRound, TaxCalculationError } from '@shared/tax'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { AppError, businessRule, notFound, validation } from '../errors'
import { stockIn, stockOut } from '../inventory'
import { accountId, postJournal, type JournalLineInput, type SystemAccount } from '../ledger'
import { nextDocumentNumber } from '../sequences'
import { childrenOf, consumedQty, DRAFT_REF_PREFIX, loadDocument, loadHeader, loadLines, settledAmount, storeFor, type SourceLine } from './store'

const todayIso = (): string => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, n: number): string => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)
const normalizeRef = (s: string): string => s.toUpperCase().replace(/[\s\-/_.]/g, '')

interface PartyRow {
  id: number; code: string; name: string; gstin: string | null; gst_registration_type: string; state_code: string; is_active: number
  address_line1: string | null; address_line2: string | null; city: string | null; pincode: string | null
  shipping_address_line1?: string | null; shipping_address_line2?: string | null; shipping_city?: string | null; shipping_state_code?: string | null; shipping_pincode?: string | null
  credit_days?: number; payment_terms_days?: number; credit_limit_paise?: number
}

interface ProductRow {
  id: number; code: string; name: string; item_type: 'GOODS' | 'SERVICE'; hsn_sac: string; unit_id: number; rate_bps: number; track_inventory: number; is_active: number
}

function loadParty(ctx: ServiceContext, kind: DocumentKind, partyId: number): PartyRow {
  const table = KINDS[kind].party === 'CUSTOMER' ? 'customers' : 'suppliers'
  const p = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`).get(partyId, ctx.companyId) as PartyRow | undefined
  if (!p) throw validation('Please correct the highlighted fields', { partyId: `Select a valid ${KINDS[kind].party === 'CUSTOMER' ? 'customer' : 'supplier'}` })
  return p
}

const address = (...parts: Array<string | null | undefined>): string | null => {
  const s = parts.filter((p) => p && p.trim()).join(', ')
  return s || null
}

function companyRow(ctx: ServiceContext): { state_code: string; fy_start_month: number } {
  const c = ctx.db.prepare('SELECT state_code, fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { state_code: string; fy_start_month: number } | undefined
  if (!c) throw notFound('Company')
  return c
}

function activeTaxRates(ctx: ServiceContext): Set<number> {
  return new Set((ctx.db.prepare('SELECT rate_bps FROM tax_rates WHERE is_active = 1').all() as Array<{ rate_bps: number }>).map((r) => r.rate_bps))
}

// ───────────────────────── Save draft ─────────────────────────

/** `opts.audit = false` is used by one-step posting, where only the POST is a user-visible action. */
export function saveDraft(ctx: ServiceContext, input: DocumentSaveParsed, opts: { audit?: boolean } = {}): DocumentDetail {
  const cfg = KINDS[input.kind]
  const s = storeFor(input.kind)
  const db = ctx.db
  return inTransaction(db, () => {
    if (input.id) {
      const existing = loadHeader(ctx, input.kind, input.id)
      if (existing.status !== 'DRAFT') throw businessRule(`${cfg.label} ${existing._number} is ${existing.status.toLowerCase()} and cannot be edited`)
    }
    const company = companyRow(ctx)
    const fieldErrors: Record<string, string> = {}

    // Party
    let party: PartyRow | null = null
    if (input.partyId) {
      party = loadParty(ctx, input.kind, input.partyId)
      if (!party.is_active) fieldErrors.partyId = `${party.name} is inactive`
    } else if (cfg.partyRequired && isInvoiceKind(input.kind)) {
      // Invoices need a party even as drafts; other drafts may pick one later (checked when posting).
      fieldErrors.partyId = `Select a ${cfg.party === 'CUSTOMER' ? 'customer' : 'supplier'}`
    }

    // Source document
    let sourceLines = new Map<number, SourceLine>()
    if (input.sourceKind && input.sourceId) {
      if (!cfg.sources.includes(input.sourceKind)) throw businessRule(`A ${cfg.label} cannot be created from a ${KINDS[input.sourceKind].label}`)
      const src = loadHeader(ctx, input.sourceKind, input.sourceId)
      if (src.status !== 'POSTED') throw businessRule(`Source ${KINDS[input.sourceKind].label} ${src._number} is not posted`)
      if (src._party_id && input.partyId && src._party_id !== input.partyId) fieldErrors.partyId = 'Party must match the source document'
      sourceLines = new Map(loadLines(db, input.sourceKind, input.sourceId).map((l) => [l.id, l]))
    } else if (cfg.sourceRequired) {
      throw businessRule(`A ${cfg.label} must be created from a ${cfg.sources.map((x) => KINDS[x].label).join(' or ')}`)
    }
    const lineLinked = !!input.sourceKind && cfg.lineLinkedSource.includes(input.sourceKind)
    const isReturn = input.kind === 'SALES_RETURN' || input.kind === 'PURCHASE_RETURN'

    // Warehouse
    let warehouseId = input.warehouseId ?? null
    if (warehouseId) {
      if (!db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND company_id = ? AND is_active = 1').get(warehouseId, ctx.companyId)) fieldErrors.warehouseId = 'Select a valid warehouse'
    } else if (cfg.stock !== 'NONE' || isInvoiceKind(input.kind)) {
      const src = input.sourceKind && input.sourceId ? (loadHeader(ctx, input.sourceKind, input.sourceId).warehouse_id as number | null) : null
      warehouseId = src ?? (db.prepare('SELECT id FROM warehouses WHERE company_id = ? AND is_active = 1 ORDER BY id LIMIT 1').get(ctx.companyId) as { id: number } | undefined)?.id ?? null
    }

    // Place of supply & supply type
    const pos =
      input.placeOfSupply ??
      (cfg.party === 'CUSTOMER' ? (party?.shipping_state_code ?? party?.state_code ?? company.state_code) : company.state_code)
    const interState = party
      ? cfg.party === 'CUSTOMER'
        ? isInterStateSupply({ supplierState: company.state_code, placeOfSupply: pos, partyRegistrationType: party.gst_registration_type })
        : isInterStateSupply({ supplierState: party.state_code, placeOfSupply: pos, partyRegistrationType: party.gst_registration_type })
      : false
    const pricingMode = isReturn ? 'EXCLUSIVE' : input.pricingMode

    // Lines
    const rates = activeTaxRates(ctx)
    const productStmt = db.prepare(
      `SELECT p.id, p.code, p.name, p.item_type, p.hsn_sac, p.unit_id, t.rate_bps, p.track_inventory, p.is_active
       FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id WHERE p.id = ? AND p.company_id = ?`
    )
    type Prepared = { product: ProductRow; qtyMilli: number; ratePaise: number; discountBps: number | null; discountPaise: number; taxRateBps: number; description: string | null; sourceLineId: number | null; cost: number }
    const prepared: Prepared[] = []
    input.lines.forEach((l, i) => {
      const product = productStmt.get(l.productId, ctx.companyId) as ProductRow | undefined
      if (!product) return void (fieldErrors[`lines.${i}.productId`] = 'Select a valid item')
      if (!product.is_active) fieldErrors[`lines.${i}.productId`] = `${product.code} is inactive`
      if (!cfg.allowServices && product.item_type === 'SERVICE') fieldErrors[`lines.${i}.productId`] = `Services cannot be added to a ${cfg.label}`
      let ratePaise = l.ratePaise
      let discountBps = l.discountBps ?? null
      let discountPaise = l.discountPaise ?? 0
      let taxRateBps = l.taxRateBps ?? product.rate_bps
      let sourceLineId = l.sourceLineId ?? null
      if (sourceLineId) {
        const src = sourceLines.get(sourceLineId)
        if (!src) {
          fieldErrors[`lines.${i}.sourceLineId`] = 'Line does not belong to the source document'
          sourceLineId = null
        } else if (src.product_id !== product.id) {
          fieldErrors[`lines.${i}.productId`] = 'Item must match the source line'
        } else if (isReturn) {
          // Returns are valued at the original net (post-discount, pre-tax) unit price and tax rate.
          ratePaise = mulDivRound(src.taxable_paise, 1000, src.qty_milli)
          discountBps = null
          discountPaise = 0
          taxRateBps = src.tax_rate_bps
        }
      } else if (lineLinked && isReturn) {
        fieldErrors[`lines.${i}.productId`] = 'Returned lines must come from the source invoice'
      }
      if (!rates.has(taxRateBps)) fieldErrors[`lines.${i}.taxRateBps`] = 'Select a GST rate from the tax master'
      try {
        computeTaxLine({ qtyMilli: l.qtyMilli, ratePaise, discountBps, discountPaise, taxRateBps }, pricingMode, interState)
      } catch (e) {
        if (e instanceof TaxCalculationError) fieldErrors[`lines.${i}.discountPaise`] = e.message
        else throw e
      }
      prepared.push({ product, qtyMilli: l.qtyMilli, ratePaise, discountBps, discountPaise, taxRateBps, description: l.description ?? null, sourceLineId, cost: 0 })
    })
    if (cfg.charges) {
      if (input.freightPaise > 0 && !rates.has(input.freightTaxBps)) fieldErrors.freightTaxBps = 'Select a GST rate from the tax master'
      if (input.otherChargesPaise > 0 && !rates.has(input.otherChargesTaxBps)) fieldErrors.otherChargesTaxBps = 'Select a GST rate from the tax master'
    }

    // Supplier invoice number (purchase invoice): exact duplicates also rejected by the database.
    if (input.kind === 'PURCHASE_INVOICE' && input.supplierRef && party) {
      const dup = db
        .prepare(`SELECT invoice_no, supplier_invoice_no FROM purchase_invoices WHERE company_id = ? AND supplier_id = ? AND status <> 'CANCELLED' AND id <> ?`)
        .all(ctx.companyId, party.id, input.id ?? -1) as Array<{ invoice_no: string; supplier_invoice_no: string }>
      const hit = dup.find((d) => normalizeRef(d.supplier_invoice_no) === normalizeRef(input.supplierRef!) && d.supplier_invoice_no !== input.supplierRef)
      if (hit) fieldErrors.supplierRef = `Already recorded for this supplier as ${hit.invoice_no} (${hit.supplier_invoice_no})`
    }
    if (Object.keys(fieldErrors).length) throw validation('Please correct the highlighted fields', fieldErrors)

    const calc = computeTaxDocument({
      lines: prepared,
      charges: cfg.charges ? [{ amountPaise: input.freightPaise, taxRateBps: input.freightTaxBps }, { amountPaise: input.otherChargesPaise, taxRateBps: input.otherChargesTaxBps }] : [],
      pricingMode,
      interState
    })
    const freightTax = cfg.charges && input.freightPaise > 0 ? computeTaxCharge({ amountPaise: input.freightPaise, taxRateBps: input.freightTaxBps }, interState).taxPaise : 0
    const otherTax = cfg.charges && input.otherChargesPaise > 0 ? computeTaxCharge({ amountPaise: input.otherChargesPaise, taxRateBps: input.otherChargesTaxBps }, interState).taxPaise : 0

    const paymentTermsDays = input.paymentTermsDays ?? party?.credit_days ?? party?.payment_terms_days ?? 0
    const dueDate = input.dueDate ?? (isInvoiceKind(input.kind) ? addDays(input.date, paymentTermsDays) : null)
    const billing = input.billingAddress ?? (party ? address(party.address_line1, party.address_line2, party.city, party.pincode) : null)
    const shipping =
      input.shippingAddress ?? (party?.shipping_address_line1 ? address(party.shipping_address_line1, party.shipping_address_line2, party.shipping_city, party.shipping_pincode) : null)
    const fy = financialYearOf(input.date, company.fy_start_month)

    const values: Record<string, unknown> = {
      company_id: ctx.companyId,
      financial_year: fy,
      [s.dateCol]: input.date,
      due_date: dueDate,
      [s.partyCol]: party?.id ?? null,
      [s.gstinCol]: party?.gstin ?? null,
      place_of_supply: pos,
      warehouse_id: warehouseId,
      is_inter_state: interState ? 1 : 0,
      reference_no: input.referenceNo ?? null,
      billing_address: billing,
      shipping_address: shipping,
      payment_terms_days: paymentTermsDays,
      pricing_mode: pricingMode,
      subtotal_paise: calc.totals.subtotalPaise,
      discount_paise: calc.totals.discountPaise,
      taxable_paise: calc.totals.taxablePaise,
      cgst_paise: calc.totals.cgst,
      sgst_paise: calc.totals.sgst,
      igst_paise: calc.totals.igst,
      freight_paise: cfg.charges ? input.freightPaise : 0,
      freight_tax_bps: cfg.charges ? input.freightTaxBps : 0,
      freight_tax_paise: freightTax,
      other_charges_paise: cfg.charges ? input.otherChargesPaise : 0,
      other_charges_label: cfg.charges ? (input.otherChargesLabel ?? null) : null,
      other_charges_tax_bps: cfg.charges ? input.otherChargesTaxBps : 0,
      other_charges_tax_paise: otherTax,
      round_off_paise: calc.totals.roundOffPaise,
      grand_total_paise: calc.totals.grandTotalPaise,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      reason: input.reason ?? null,
      source_type: input.sourceKind ?? null,
      source_id: input.sourceId ?? null
    }
    if (s.refCol) values[s.refCol] = input.supplierRef ?? (input.kind === 'PURCHASE_INVOICE' ? `${DRAFT_REF_PREFIX}${randomUUID()}` : null)
    if (s.refDateCol) values[s.refDateCol] = input.supplierRefDate ?? (input.kind === 'PURCHASE_INVOICE' ? input.date : null)
    if (s.typed) values.doc_type = input.kind

    let docId: number
    if (input.id) {
      docId = input.id
      const cols = Object.keys(values)
      db.prepare(`UPDATE ${s.header} SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @__id`).run({ ...values, __id: docId })
      db.prepare(`DELETE FROM ${s.lines} WHERE ${s.fk} = ?`).run(docId)
    } else {
      values[s.numberCol] = `DRAFT-${randomUUID()}`
      values.status = 'DRAFT'
      values.created_by = ctx.userId
      const cols = Object.keys(values)
      docId = Number(db.prepare(`INSERT INTO ${s.header} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(values).lastInsertRowid)
      db.prepare(`UPDATE ${s.header} SET ${s.numberCol} = ? WHERE id = ?`).run(`DRAFT-${docId}`, docId)
    }

    const insertLine = db.prepare(
      `INSERT INTO ${s.lines} (${s.fk}, line_no, product_id, description, hsn_sac, item_type, qty_milli, unit_id, rate_paise, gross_paise, discount_bps, discount_paise,
         taxable_paise, tax_rate_bps, cgst_paise, sgst_paise, igst_paise, line_total_paise, cost_paise, source_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    prepared.forEach((p, i) => {
      const c = calc.lines[i]
      insertLine.run(docId, i + 1, p.product.id, p.description ?? p.product.name, p.product.hsn_sac, p.product.item_type, p.qtyMilli, p.product.unit_id, p.ratePaise,
        c.grossPaise, p.discountBps, c.discountPaise, c.taxablePaise, p.taxRateBps, c.cgst, c.sgst, c.igst, c.totalPaise, p.sourceLineId)
    })

    if (opts.audit !== false) writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: input.id ? 'DRAFT_UPDATE' : 'DRAFT_CREATE', entityType: input.kind.toLowerCase(), entityId: docId,
      summary: `${cfg.label} draft DRAFT-${docId} ${input.id ? 'updated' : 'created'}${party ? ` for ${party.name}` : ''}: ${prepared.length} lines, ${formatINR(calc.totals.grandTotalPaise)}`
    })
    return loadDocument(ctx, input.kind, docId)
  })
}

export function deleteDraft(ctx: ServiceContext, kind: DocumentKind, id: number): void {
  inTransaction(ctx.db, () => {
    const h = loadHeader(ctx, kind, id)
    if (h.status !== 'DRAFT') throw businessRule('Only drafts can be deleted; posted documents must be cancelled by reversal')
    const s = storeFor(kind)
    ctx.db.prepare(`DELETE FROM ${s.lines} WHERE ${s.fk} = ?`).run(id)
    ctx.db.prepare(`DELETE FROM ${s.header} WHERE id = ?`).run(id)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'DRAFT_DELETE', entityType: kind.toLowerCase(), entityId: id, summary: `${KINDS[kind].label} draft ${h._number} deleted` })
  })
}

// ───────────────────────── Validation ─────────────────────────

const tracked = (l: { itemType: string; trackInventory: boolean }) => l.itemType === 'GOODS' && l.trackInventory

export function validateDocument(ctx: ServiceContext, kind: DocumentKind, id: number): ValidationResult {
  const cfg = KINDS[kind]
  const db = ctx.db
  const doc = loadDocument(ctx, kind, id)
  const errors: string[] = []
  const warnings: string[] = []
  if (doc.status !== 'DRAFT') errors.push(`${cfg.label} is already ${doc.status.toLowerCase()}`)
  if (doc.lines.length === 0) errors.push('Add at least one line')
  if (cfg.partyRequired && !doc.partyId) errors.push(`Select a ${cfg.party === 'CUSTOMER' ? 'customer' : 'supplier'}`)
  if (doc.partyId) {
    const p = loadParty(ctx, kind, doc.partyId)
    if (!p.is_active) errors.push(`${p.name} is inactive`)
  }
  if (cfg.ledger && doc.date > todayIso()) errors.push('Document date cannot be in the future')
  if (cfg.ledger && doc.grandTotalPaise <= 0 && cfg.stock === 'NONE') errors.push('Document total must be greater than zero')
  for (const l of doc.lines) {
    const p = db.prepare('SELECT is_active FROM products WHERE id = ?').get(l.productId) as { is_active: number }
    if (!p.is_active) errors.push(`Line ${l.lineNo}: ${l.productCode} is inactive`)
    if (!cfg.allowServices && l.itemType === 'SERVICE') errors.push(`Line ${l.lineNo}: services are not allowed on a ${cfg.label}`)
  }

  // Source rules
  const source = doc.source
  if (cfg.sourceRequired && !source) errors.push(`Create this ${cfg.label} from a ${cfg.sources.map((x) => KINDS[x].label).join(' or ')}`)
  if (source && source.status !== 'POSTED') errors.push(`Source ${KINDS[source.kind].label} ${source.number} is ${source.status.toLowerCase()}`)
  const lineLinked = !!source && cfg.lineLinkedSource.includes(source.kind)
  if (lineLinked && source) {
    const srcLines = new Map(loadLines(db, source.kind, source.id).map((l) => [l.id, l]))
    for (const l of doc.lines) {
      if (!l.sourceLineId) {
        if (cfg.sourceRequired) errors.push(`Line ${l.lineNo}: must come from ${source.number}`)
        continue
      }
      const src = srcLines.get(l.sourceLineId)
      if (!src) {
        errors.push(`Line ${l.lineNo}: source line not found`)
        continue
      }
      const remaining = src.qty_milli - consumedQty(db, kind, source.kind, l.sourceLineId, id)
      if (l.qtyMilli > remaining) errors.push(`Line ${l.lineNo}: ${l.productCode} quantity ${milliToString(l.qtyMilli)} exceeds the remaining ${milliToString(Math.max(0, remaining))} on ${source.number}`)
    }
  }

  // Stock
  const needsWarehouse = cfg.stock !== 'NONE' && doc.lines.some((l) => tracked(l) && !(lineLinked && l.sourceLineId && (kind === 'SALES_INVOICE' || kind === 'PURCHASE_INVOICE')))
  if (needsWarehouse && !doc.warehouseId) errors.push('Select a warehouse')
  if (cfg.stock === 'OUT' && doc.warehouseId) {
    const need = new Map<number, { qty: number; code: string }>()
    for (const l of doc.lines) {
      if (!tracked(l)) continue
      if (kind === 'SALES_INVOICE' && lineLinked && l.sourceLineId) continue // stock already issued by the delivery challan
      const cur = need.get(l.productId) ?? { qty: 0, code: `${l.productCode} ${l.productName}` }
      cur.qty += l.qtyMilli
      need.set(l.productId, cur)
    }
    for (const [productId, n] of need) {
      const bal = (db.prepare('SELECT qty_milli q FROM stock_balances WHERE product_id = ? AND warehouse_id = ?').get(productId, doc.warehouseId) as { q: number } | undefined)?.q ?? 0
      if (bal < n.qty) errors.push(`Insufficient stock for ${n.code} in ${doc.warehouseName}: available ${milliToString(bal)}, required ${milliToString(n.qty)}`)
    }
  }

  // Purchase invoice: supplier bill number
  if (kind === 'PURCHASE_INVOICE') {
    if (!doc.supplierRef) errors.push('Enter the supplier invoice number')
    else if (doc.partyId) {
      const others = db
        .prepare(`SELECT invoice_no, supplier_invoice_no FROM purchase_invoices WHERE company_id = ? AND supplier_id = ? AND status <> 'CANCELLED' AND id <> ?`)
        .all(ctx.companyId, doc.partyId, id) as Array<{ invoice_no: string; supplier_invoice_no: string }>
      const hit = others.find((o) => normalizeRef(o.supplier_invoice_no) === normalizeRef(doc.supplierRef!))
      if (hit) errors.push(`Supplier invoice ${doc.supplierRef} is already recorded as ${hit.invoice_no}`)
    }
  }

  // Warnings
  if (kind === 'SALES_INVOICE' && doc.partyId) {
    const c = db.prepare('SELECT credit_limit_paise FROM customers WHERE id = ?').get(doc.partyId) as { credit_limit_paise: number }
    const bal = (db.prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.account_id AND a.system_key = 'AR' WHERE l.party_type = 'CUSTOMER' AND l.party_id = ?`).get(doc.partyId) as { b: number }).b
    if (c.credit_limit_paise > 0 && bal + doc.grandTotalPaise > c.credit_limit_paise)
      warnings.push(`Credit limit ${formatINR(c.credit_limit_paise)} will be exceeded (outstanding ${formatINR(bal)} + this invoice ${formatINR(doc.grandTotalPaise)})`)
    const goodsValue = doc.lines.filter((l) => l.itemType === 'GOODS').reduce((s, l) => s + l.totalPaise, 0)
    if (goodsValue > 5000000) warnings.push('Goods value exceeds ₹50,000 — an e-way bill is likely required for transport')
  }
  if (doc.dueDate && doc.dueDate < todayIso() && isInvoiceKind(kind)) warnings.push('Due date is already in the past')
  if (!doc.partyGstin && doc.partyId && cfg.side === 'PURCHASE' && cfg.ledger) warnings.push('Supplier is unregistered — no input tax credit is available on this document')
  return { ok: errors.length === 0, errors, warnings }
}

// ───────────────────────── Posting ─────────────────────────

class Journal {
  readonly lines: JournalLineInput[] = []
  constructor(private ctx: ServiceContext) {}
  private acc(key: SystemAccount) {
    return accountId(this.ctx.db, this.ctx.companyId, key)
  }
  dr(key: SystemAccount, amount: number, party?: { type: 'CUSTOMER' | 'SUPPLIER'; id: number }): Journal {
    if (amount < 0) return this.cr(key, -amount, party)
    if (amount > 0) this.lines.push({ accountId: this.acc(key), debitPaise: amount, partyType: party?.type, partyId: party?.id })
    return this
  }
  cr(key: SystemAccount, amount: number, party?: { type: 'CUSTOMER' | 'SUPPLIER'; id: number }): Journal {
    if (amount < 0) return this.dr(key, -amount, party)
    if (amount > 0) this.lines.push({ accountId: this.acc(key), creditPaise: amount, partyType: party?.type, partyId: party?.id })
    return this
  }
  /** Round-off: positive means the document total was rounded up. `partyIsDebited`: the party account is debited with the total. */
  roundOff(amount: number, partyIsDebited: boolean): Journal {
    return partyIsDebited ? this.cr('ROUND_OFF', amount) : this.dr('ROUND_OFF', amount)
  }
  /** Posts the journal; `kind` records the exact originating document kind. */
  post(date: string, kind: string, sourceId: number, narration: string): number | null {
    if (this.lines.length === 0) return null
    const sourceType = kind === 'SALES_INVOICE' || kind === 'PURCHASE_INVOICE' ? kind : kind.startsWith('CANCEL:') || kind.includes('RETURN') || kind.endsWith('_NOTE') ? 'REVERSAL' : 'MANUAL'
    return postJournal(this.ctx.db, { companyId: this.ctx.companyId, userId: this.ctx.userId, entryDate: date, sourceType, sourceKind: kind, sourceId, narration, lines: this.lines }).id
  }
}

interface PostEffects {
  journalId: number | null
  lineCosts: Map<number, number>
}

const prorate = (value: number, qty: number, srcQty: number) => mulDivRound(value, qty, srcQty)

function postEffects(ctx: ServiceContext, doc: DocumentDetail, number: string): PostEffects {
  const db = ctx.db
  const kind = doc.kind
  const cfg = KINDS[kind]
  const lineCosts = new Map<number, number>()
  const party = doc.partyId ? { type: cfg.party, id: doc.partyId } : undefined
  const srcLines = doc.source ? new Map(loadLines(db, doc.source.kind, doc.source.id).map((l) => [l.id, l])) : new Map<number, SourceLine>()
  const fromLinked = (l: DocumentDetail['lines'][number]) => !!(doc.source && cfg.lineLinkedSource.includes(doc.source.kind) && l.sourceLineId && srcLines.get(l.sourceLineId))
  const base = { companyId: ctx.companyId, warehouseId: doc.warehouseId ?? 0, date: doc.date, referenceType: kind, referenceId: doc.id, referenceNo: number, userId: ctx.userId }
  const out = (l: DocumentDetail['lines'][number], value?: number, type: 'SALE' | 'PURCHASE_REVERSAL' = 'SALE') =>
    stockOut(db, { ...base, productId: l.productId, qtyMilli: l.qtyMilli, type, productLabel: `${l.productCode} ${l.productName}`, valuePaise: value })
  const into = (l: DocumentDetail['lines'][number], value: number, type: 'PURCHASE' | 'SALE_REVERSAL' = 'PURCHASE') =>
    stockIn(db, { ...base, productId: l.productId, qtyMilli: l.qtyMilli, type, valuePaise: value })
  const sum = (pred: (l: DocumentDetail['lines'][number]) => boolean) => doc.lines.filter(pred).reduce((s, l) => s + l.taxablePaise, 0)
  const j = new Journal(ctx)
  const narration = `${cfg.label} ${number}${doc.partyName ? ` - ${doc.partyName}` : ''}`

  switch (kind) {
    case 'SALES_QUOTATION':
    case 'SALES_ORDER':
    case 'PURCHASE_REQUISITION':
    case 'PURCHASE_ORDER':
      return { journalId: null, lineCosts }

    case 'DELIVERY_CHALLAN': {
      let cost = 0
      for (const l of doc.lines) {
        if (!tracked(l)) continue
        const c = out(l)
        lineCosts.set(l.id, c)
        cost += c
      }
      j.dr('COGS', cost).cr('INVENTORY', cost)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration} (goods dispatched)`), lineCosts }
    }

    case 'SALES_INVOICE': {
      let cogs = 0
      for (const l of doc.lines) {
        if (!tracked(l)) continue
        if (fromLinked(l)) {
          const src = srcLines.get(l.sourceLineId!)!
          lineCosts.set(l.id, prorate(src.cost_paise, l.qtyMilli, src.qty_milli)) // stock & COGS already posted by the challan
        } else {
          const c = out(l)
          lineCosts.set(l.id, c)
          cogs += c
        }
      }
      j.dr('AR', doc.grandTotalPaise, party)
        .cr('SALES_GOODS', sum((l) => l.itemType === 'GOODS'))
        .cr('SALES_SERVICES', sum((l) => l.itemType === 'SERVICE'))
        .cr('OUTPUT_CGST', doc.cgstPaise).cr('OUTPUT_SGST', doc.sgstPaise).cr('OUTPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, true)
        .dr('COGS', cogs).cr('INVENTORY', cogs)
      return { journalId: j.post(doc.date, kind, doc.id, narration), lineCosts }
    }

    case 'SALES_RETURN': {
      let restored = 0
      for (const l of doc.lines) {
        if (!tracked(l) || !l.sourceLineId) continue
        const src = srcLines.get(l.sourceLineId)!
        const value = prorate(src.cost_paise, l.qtyMilli, src.qty_milli)
        into(l, value, 'SALE_REVERSAL')
        lineCosts.set(l.id, value)
        restored += value
      }
      j.dr('SALES_RETURNS', doc.taxablePaise)
        .dr('OUTPUT_CGST', doc.cgstPaise).dr('OUTPUT_SGST', doc.sgstPaise).dr('OUTPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, false)
        .cr('AR', doc.grandTotalPaise, party)
        .dr('INVENTORY', restored).cr('COGS', restored)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration} against ${doc.source?.number}`), lineCosts }
    }

    case 'CREDIT_NOTE': {
      j.dr('SALES_RETURNS', doc.taxablePaise)
        .dr('OUTPUT_CGST', doc.cgstPaise).dr('OUTPUT_SGST', doc.sgstPaise).dr('OUTPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, false)
        .cr('AR', doc.grandTotalPaise, party)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration}${doc.source ? ` against ${doc.source.number}` : ''}`), lineCosts }
    }

    case 'GOODS_RECEIPT': {
      let value = 0
      for (const l of doc.lines) {
        if (!tracked(l)) continue
        into(l, l.taxablePaise)
        lineCosts.set(l.id, l.taxablePaise)
        value += l.taxablePaise
      }
      j.dr('INVENTORY', value).cr('GRNI', value)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration} (goods received, not invoiced)`), lineCosts }
    }

    case 'PURCHASE_INVOICE': {
      const direct = doc.lines.filter((l) => tracked(l) && !fromLinked(l))
      // Freight on stocked goods is part of their cost (capitalised pro rata); otherwise it is an expense.
      const freightShares = direct.length ? allocateProportionally(doc.freightPaise, direct.map((l) => l.taxablePaise)) : []
      let inventory = 0
      let grni = 0
      let ppv = 0
      direct.forEach((l, i) => {
        const value = l.taxablePaise + freightShares[i]
        into(l, value)
        lineCosts.set(l.id, value)
        inventory += value
      })
      for (const l of doc.lines.filter((x) => tracked(x) && fromLinked(x))) {
        const src = srcLines.get(l.sourceLineId!)!
        const grnValue = prorate(src.cost_paise, l.qtyMilli, src.qty_milli)
        lineCosts.set(l.id, grnValue)
        grni += grnValue
        ppv += l.taxablePaise - grnValue
      }
      j.dr('INVENTORY', inventory)
        .dr('GRNI', grni)
        .dr('PPV', ppv)
        .dr('PURCHASE_SERVICES', sum((l) => !tracked(l)))
        .dr('FREIGHT_INWARD', direct.length ? 0 : doc.freightPaise)
        .dr('OTHER_PURCHASE_CHARGES', doc.otherChargesPaise)
        .dr('INPUT_CGST', doc.cgstPaise).dr('INPUT_SGST', doc.sgstPaise).dr('INPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, false)
        .cr('AP', doc.grandTotalPaise, party)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration} bill ${doc.supplierRef}`), lineCosts }
    }

    case 'PURCHASE_RETURN': {
      let removed = 0
      let goodsTaxable = 0
      for (const l of doc.lines) {
        if (!tracked(l) || !l.sourceLineId) continue
        const src = srcLines.get(l.sourceLineId)!
        const value = out(l, prorate(src.cost_paise, l.qtyMilli, src.qty_milli), 'PURCHASE_REVERSAL')
        lineCosts.set(l.id, value)
        removed += value
        goodsTaxable += l.taxablePaise
      }
      j.dr('AP', doc.grandTotalPaise, party)
        .cr('INVENTORY', removed)
        .cr('PPV', goodsTaxable - removed)
        .cr('PURCHASE_SERVICES', sum((l) => !tracked(l)))
        .cr('INPUT_CGST', doc.cgstPaise).cr('INPUT_SGST', doc.sgstPaise).cr('INPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, true)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration} against ${doc.source?.number}`), lineCosts }
    }

    case 'DEBIT_NOTE': {
      j.dr('AP', doc.grandTotalPaise, party)
        .cr('PURCHASE_ALLOWANCES', doc.taxablePaise)
        .cr('INPUT_CGST', doc.cgstPaise).cr('INPUT_SGST', doc.sgstPaise).cr('INPUT_IGST', doc.igstPaise)
        .roundOff(doc.roundOffPaise, true)
      return { journalId: j.post(doc.date, kind, doc.id, `${narration}${doc.source ? ` against ${doc.source.number}` : ''}`), lineCosts }
    }
  }
}

export function postDocument(ctx: ServiceContext, kind: DocumentKind, id: number): DocumentDetail {
  const cfg = KINDS[kind]
  const s = storeFor(kind)
  const db = ctx.db
  return inTransaction(db, () => {
    const v = validateDocument(ctx, kind, id)
    if (!v.ok) throw new AppError('BUSINESS_RULE', v.errors.join(' · '))
    const draft = loadDocument(ctx, kind, id)
    const company = companyRow(ctx)
    const fy = financialYearOf(draft.date, company.fy_start_month)
    const number = nextDocumentNumber(db, ctx.companyId, kind, fy)
    db.prepare(`UPDATE ${s.header} SET ${s.numberCol} = ?, financial_year = ? WHERE id = ?`).run(number, fy, id)

    const effects = postEffects(ctx, { ...draft, number }, number)
    const setCost = db.prepare(`UPDATE ${s.lines} SET cost_paise = ? WHERE id = ?`)
    for (const [lineId, cost] of effects.lineCosts) setCost.run(cost, lineId)
    db.prepare(`UPDATE ${s.header} SET status = 'POSTED', journal_entry_id = ?, posted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), posted_by = ? WHERE id = ?`).run(effects.journalId, ctx.userId, id)

    // Returns and notes settle the invoice they were raised against (up to its balance).
    if (cfg.settlesSource && draft.source && isInvoiceKind(draft.source.kind)) {
      const srcGrand = loadHeader(ctx, draft.source.kind, draft.source.id).grand_total_paise
      const balance = srcGrand - settledAmount(db, draft.source.kind, draft.source.id)
      const amount = Math.min(balance, draft.grandTotalPaise)
      if (amount > 0)
        db.prepare(`INSERT INTO payment_allocations (company_id, source_type, source_id, invoice_type, invoice_id, amount_paise, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(ctx.companyId, kind, id, draft.source.kind, draft.source.id, amount, ctx.userId)
    }

    writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'POST', entityType: kind.toLowerCase(), entityId: id,
      summary: `${cfg.label} ${number} posted${draft.partyName ? ` for ${draft.partyName}` : ''}: ${formatINR(draft.grandTotalPaise)}`,
      details: { number, draft: draft.number, journalId: effects.journalId, lines: draft.lines.length, warnings: v.warnings }
    })
    return loadDocument(ctx, kind, id)
  })
}

// ───────────────────────── Cancellation by reversal ─────────────────────────

export function cancelDocument(ctx: ServiceContext, kind: DocumentKind, id: number, reason: string): DocumentDetail {
  const cfg = KINDS[kind]
  const s = storeFor(kind)
  const db = ctx.db
  return inTransaction(db, () => {
    const doc = loadDocument(ctx, kind, id)
    if (doc.status !== 'POSTED') throw businessRule(doc.status === 'DRAFT' ? 'Drafts are deleted, not cancelled' : `${cfg.label} is already cancelled`)
    const live = childrenOf(db, kind, id).filter((c) => c.status !== 'CANCELLED')
    if (live.length) throw businessRule(`Cancel the documents created from it first: ${live.map((c) => c.number).join(', ')}`)
    if (isInvoiceKind(kind)) {
      const paid = doc.allocations.filter((a) => a.sourceType === 'RECEIPT' || a.sourceType === 'PAYMENT')
      if (paid.length) throw businessRule(`Payments ${paid.map((p) => p.number).join(', ')} are allocated to this invoice. Issue a ${kind === 'SALES_INVOICE' ? 'credit note' : 'debit note'} instead.`)
    }
    if (kind === 'SALES_INVOICE' && db.prepare(`SELECT 1 FROM ewaybill_records WHERE sales_invoice_id = ? AND status IN ('ACTIVE','PART_A_ONLY')`).get(id))
      throw businessRule('Cancel the e-way bill for this invoice first')
    if (kind === 'DELIVERY_CHALLAN' && db.prepare(`SELECT 1 FROM pragma_table_info('ewaybill_records') WHERE name = 'source_kind'`).get() &&
        db.prepare(`SELECT 1 FROM ewaybill_records WHERE source_kind = 'DELIVERY_CHALLAN' AND source_id = ? AND status IN ('ACTIVE','PART_A_ONLY')`).get(id))
      throw businessRule('Cancel the e-way bill for this delivery challan first')
    if ((kind === 'SALES_INVOICE' || kind === 'CREDIT_NOTE' || kind === 'SALES_RETURN') && db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'einvoices'`).get() &&
        db.prepare(`SELECT 1 FROM einvoices WHERE document_kind = ? AND document_id = ? AND status IN ('PENDING','GENERATED')`).get(kind, id))
      throw businessRule('This document has a registered e-invoice (IRN). Cancel the IRN first, or issue a credit note.')

    const today = todayIso()
    const rev = new Journal(ctx)
    // Reverse stock movements at their original values.
    const moves = db.prepare('SELECT * FROM stock_movements WHERE reference_type = ? AND reference_id = ? ORDER BY id').all(kind, id) as Array<{
      product_id: number; warehouse_id: number; qty_in_milli: number; qty_out_milli: number; value_paise: number
    }>
    for (const m of moves) {
      const base = { companyId: ctx.companyId, productId: m.product_id, warehouseId: m.warehouse_id, date: today, referenceType: kind, referenceId: id, referenceNo: `${doc.number} (cancelled)`, userId: ctx.userId }
      if (m.qty_out_milli > 0) {
        stockIn(db, { ...base, qtyMilli: m.qty_out_milli, type: 'SALE_REVERSAL', valuePaise: m.value_paise })
      } else {
        const p = db.prepare('SELECT code, name FROM products WHERE id = ?').get(m.product_id) as { code: string; name: string }
        const actual = stockOut(db, { ...base, qtyMilli: m.qty_in_milli, type: 'PURCHASE_REVERSAL', productLabel: `${p.code} ${p.name}`, valuePaise: m.value_paise })
        // Keep Stock-in-Hand equal to stock valuation if the remaining value differed.
        rev.dr('INVENTORY', m.value_paise - actual).cr('PPV', m.value_paise - actual)
      }
    }

    let reversalId: number | null = null
    const orig = db.prepare('SELECT journal_entry_id FROM ' + s.header + ' WHERE id = ?').get(id) as { journal_entry_id: number | null }
    if (orig.journal_entry_id) {
      const lines = db.prepare('SELECT account_id, debit_paise, credit_paise, party_type, party_id FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_no').all(orig.journal_entry_id) as Array<{
        account_id: number; debit_paise: number; credit_paise: number; party_type: 'CUSTOMER' | 'SUPPLIER' | null; party_id: number | null
      }>
      rev.lines.unshift(...lines.map((l) => ({ accountId: l.account_id, debitPaise: l.credit_paise, creditPaise: l.debit_paise, partyType: l.party_type ?? undefined, partyId: l.party_id ?? undefined })))
      reversalId = rev.post(today, `CANCEL:${kind}`, id, `Cancellation of ${cfg.label} ${doc.number}: ${reason}`)
      db.prepare(`UPDATE journal_entries SET status = 'REVERSED' WHERE id = ?`).run(orig.journal_entry_id)
    }

    db.prepare(`UPDATE payment_allocations SET is_reversed = 1, reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE source_type = ? AND source_id = ? AND is_reversed = 0`).run(kind, id)
    db.prepare(
      `UPDATE ${s.header} SET status = 'CANCELLED', reversal_journal_entry_id = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancelled_by = ?, cancel_reason = ?${
        kind === 'PURCHASE_INVOICE' ? `, supplier_invoice_no = supplier_invoice_no || ' (cancelled #' || id || ')'` : ''
      } WHERE id = ?`
    ).run(reversalId, ctx.userId, reason, id)

    writeAudit(db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'CANCEL', entityType: kind.toLowerCase(), entityId: id,
      summary: `${cfg.label} ${doc.number} cancelled by reversal: ${reason}`, details: { reversalJournalId: reversalId, stockMovesReversed: moves.length }
    })
    return loadDocument(ctx, kind, id)
  })
}

// ───────────────────────── Conversion ─────────────────────────

/** Creates a DRAFT of `target` prefilled from a posted document; `overrides` adjust the draft before it is saved. */
export function convertDocument(ctx: ServiceContext, kind: DocumentKind, id: number, target: DocumentKind, overrides: Partial<DocumentSaveParsed> = {}): DocumentDetail {
  const src = loadDocument(ctx, kind, id)
  const tcfg = KINDS[target]
  if (!KINDS[kind].converts.includes(target) || !tcfg.sources.includes(kind)) throw businessRule(`A ${KINDS[kind].label} cannot be converted to a ${tcfg.label}`)
  if (src.status !== 'POSTED') throw businessRule('Only posted documents can be converted')
  const linked = tcfg.lineLinkedSource.includes(kind)
  const lines = src.lines
    .map((l) => {
      const remaining = linked ? l.qtyMilli - consumedQty(ctx.db, target, kind, l.id, null) : l.qtyMilli
      if (target === 'SALES_INVOICE' && kind === 'DELIVERY_CHALLAN' && !tracked(l)) return null
      return remaining > 0
        ? { productId: l.productId, description: l.description, qtyMilli: remaining, ratePaise: l.ratePaise, discountBps: l.discountBps, discountPaise: l.discountBps == null ? prorate(l.discountPaise, remaining, l.qtyMilli) : 0, taxRateBps: l.taxRateBps, sourceLineId: l.id }
        : null
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)
  if (lines.length === 0) throw businessRule(`Nothing remains on ${src.number} to ${target.includes('RETURN') ? 'return' : 'convert'}`)
  const isNote = target === 'CREDIT_NOTE' || target === 'DEBIT_NOTE'
  return saveDraft(ctx, {
    kind: target,
    partyId: src.partyId,
    date: todayIso(),
    dueDate: null,
    placeOfSupply: src.placeOfSupply,
    warehouseId: src.warehouseId,
    referenceNo: src.referenceNo,
    supplierRef: null,
    supplierRefDate: null,
    billingAddress: src.billingAddress,
    shippingAddress: src.shippingAddress,
    // Terms come from the party master (a requisition has no supplier, so its terms are meaningless).
    paymentTermsDays: isNote ? 0 : null,
    pricingMode: target.includes('RETURN') ? 'EXCLUSIVE' : src.pricingMode,
    notes: null,
    terms: src.terms,
    reason: null,
    freightPaise: tcfg.charges && KINDS[kind].charges ? src.freightPaise : 0,
    freightTaxBps: src.freightTaxBps,
    otherChargesPaise: tcfg.charges && KINDS[kind].charges ? src.otherChargesPaise : 0,
    otherChargesLabel: src.otherChargesLabel,
    otherChargesTaxBps: src.otherChargesTaxBps,
    sourceKind: kind,
    sourceId: id,
    lines,
    ...overrides
  })
}
