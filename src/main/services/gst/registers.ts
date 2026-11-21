/**
 * GST sales and purchase registers, read from posted documents (never drafts).
 * Each document is classified for GSTR-1 / GSTR-3B using the effective-dated
 * rules and the HSN rate master. Totals are checked against the GST ledger
 * accounts so the registers can be proven to match the books.
 */
import { docRoute } from '@shared/documents'
import {
  classifyNote, classifyOutward, type GstDocLine, type GstInwardDoc, type GstOutwardDoc, type GstPurchaseRegister, type GstSalesRegister, type HsnRateRule,
  type HsnSummaryRow, type ItcEligibility, type OutwardClass, type RateSummaryRow, type TaxCategory, type TaxTotals
} from '@shared/gst'
import type { RuleSet } from '@shared/gst'
import { splitTaxAmount } from '@shared/tax'
import { percentOf } from '@shared/money'
import type { ServiceContext } from '../context'
import { primaryGstin, rateRuleAt, rulesAt } from './config'

type Row = Record<string, unknown>

export interface RegisterFilter {
  from: string
  to: string
  gstin?: string
  status?: 'POSTED' | 'CANCELLED' | 'ALL'
  category?: string
}

const emptyTotals = (): TaxTotals => ({ count: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0, valuePaise: 0 })
function add(t: TaxTotals, d: { sign: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; invoiceValuePaise: number }): void {
  t.count += 1
  t.taxablePaise += d.sign * d.taxablePaise
  t.igstPaise += d.sign * d.igstPaise
  t.cgstPaise += d.sign * d.cgstPaise
  t.sgstPaise += d.sign * d.sgstPaise
  t.cessPaise += d.sign * d.cessPaise
  t.valuePaise += d.sign * d.invoiceValuePaise
}

/** GSTIN of the registration a document belongs to (branch registration, else primary). */
function gstinResolver(ctx: ServiceContext): (branchId: number | null) => string | null {
  const byBranch = new Map((ctx.db.prepare('SELECT branch_id, gstin FROM gst_registrations WHERE company_id = ? AND branch_id IS NOT NULL AND is_active = 1').all(ctx.companyId) as Array<{ branch_id: number; gstin: string }>).map((r) => [r.branch_id, r.gstin]))
  const primary = primaryGstin(ctx)
  return (branchId) => (branchId != null && byBranch.get(branchId)) || primary
}

function lineCategory(rule: HsnRateRule | null, rateBps: number): TaxCategory {
  if (rule) return rule.taxCategory
  return rateBps === 0 ? 'NIL_RATED' : 'TAXABLE'
}

const statusSql = (status: RegisterFilter['status'], col = 'status') =>
  status === 'ALL' ? `${col} IN ('POSTED','CANCELLED')` : status === 'CANCELLED' ? `${col} = 'CANCELLED'` : `${col} = 'POSTED'`

function loadLines(ctx: ServiceContext, table: 'sales_invoice_items' | 'purchase_invoice_items' | 'trade_document_lines', fk: string, ids: number[], dateOf: (docId: number) => string, cache: Map<string, HsnRateRule | null>): Map<number, Array<GstDocLine & { reverseCharge: boolean; ruleFound: boolean; rateBps: number; ruleRateBps: number | null; productCode: string }>> {
  const out = new Map<number, Array<GstDocLine & { reverseCharge: boolean; ruleFound: boolean; rateBps: number; ruleRateBps: number | null; productCode: string }>>()
  if (!ids.length) return out
  const rows = ctx.db
    .prepare(
      `SELECT l.${fk} AS doc_id, l.hsn_sac, l.description, l.item_type, l.qty_milli, l.taxable_paise, l.tax_rate_bps, l.igst_paise, l.cgst_paise, l.sgst_paise, l.cess_paise, u.code AS uqc, p.code AS product_code
       FROM ${table} l JOIN units u ON u.id = l.unit_id JOIN products p ON p.id = l.product_id WHERE l.${fk} IN (${ids.join(',')}) ORDER BY l.${fk}, l.line_no`
    )
    .all() as Row[]
  for (const r of rows) {
    const docId = r.doc_id as number
    const rule = rateRuleAt(ctx, r.hsn_sac as string, dateOf(docId), cache)
    const list = out.get(docId) ?? []
    list.push({
      hsn: r.hsn_sac as string, description: (r.description as string) ?? '', uqc: r.uqc as string, qtyMilli: r.qty_milli as number, ratePct: (r.tax_rate_bps as number) / 100,
      rateBps: r.tax_rate_bps as number, taxablePaise: r.taxable_paise as number, igstPaise: r.igst_paise as number, cgstPaise: r.cgst_paise as number, sgstPaise: r.sgst_paise as number,
      cessPaise: r.cess_paise as number, category: lineCategory(rule, r.tax_rate_bps as number), itemType: r.item_type as 'GOODS' | 'SERVICE',
      reverseCharge: !!rule?.reverseCharge, ruleFound: !!rule, ruleRateBps: rule ? rule.rateBps : null, productCode: r.product_code as string
    })
    out.set(docId, list)
  }
  return out
}

export type OutwardDocX = GstOutwardDoc & { branchId: number | null; lineMeta: Array<{ ruleFound: boolean; rateBps: number; productCode: string }>; headerTaxablePaise: number; partyPincode: string | null; partyAddress: string | null }

/** All outward documents (invoices, credit notes, sales returns) in a period. */
export function outwardDocs(ctx: ServiceContext, f: RegisterFilter): OutwardDocX[] {
  const db = ctx.db
  const ruleCache = new Map<string, HsnRateRule | null>()
  const gstinOf = gstinResolver(ctx)
  const inv = db
    .prepare(
      `SELECT si.id, si.invoice_no AS number, si.invoice_date AS date, si.status, si.customer_id AS party_id, c.name AS party_name, si.customer_gstin AS party_gstin,
              c.gst_registration_type AS reg_type, c.pincode AS party_pincode, c.address_line1 AS party_address, si.place_of_supply, si.is_inter_state, si.branch_id, si.grand_total_paise, si.taxable_paise,
              si.igst_paise, si.cgst_paise, si.sgst_paise, si.cess_paise, NULL AS original_id
       FROM sales_invoices si JOIN customers c ON c.id = si.customer_id
       WHERE si.company_id = ? AND ${statusSql(f.status, 'si.status')} AND si.invoice_date BETWEEN ? AND ? ORDER BY si.invoice_date, si.id`
    )
    .all(ctx.companyId, f.from, f.to) as Row[]
  const notes = db
    .prepare(
      `SELECT td.id, td.doc_type, td.doc_no AS number, td.doc_date AS date, td.status, td.customer_id AS party_id, c.name AS party_name, td.party_gstin,
              c.gst_registration_type AS reg_type, c.pincode AS party_pincode, c.address_line1 AS party_address, td.place_of_supply, td.is_inter_state, NULL AS branch_id, td.grand_total_paise, td.taxable_paise,
              td.igst_paise, td.cgst_paise, td.sgst_paise, td.cess_paise, CASE WHEN td.source_type = 'SALES_INVOICE' THEN td.source_id END AS original_id
       FROM trade_documents td JOIN customers c ON c.id = td.customer_id
       WHERE td.company_id = ? AND td.doc_type IN ('CREDIT_NOTE','SALES_RETURN') AND ${statusSql(f.status, 'td.status')} AND td.doc_date BETWEEN ? AND ? ORDER BY td.doc_date, td.id`
    )
    .all(ctx.companyId, f.from, f.to) as Row[]

  const invDates = new Map(inv.map((r) => [r.id as number, r.date as string]))
  const noteDates = new Map(notes.map((r) => [r.id as number, r.date as string]))
  const ruleSets = new Map<string, RuleSet>()
  const invLines = loadLines(ctx, 'sales_invoice_items', 'invoice_id', inv.map((r) => r.id as number), (id) => invDates.get(id)!, ruleCache)
  const noteLines = loadLines(ctx, 'trade_document_lines', 'document_id', notes.map((r) => r.id as number), (id) => noteDates.get(id)!, ruleCache)
  const einv = new Map<string, { status: string; irn: string | null; isDemo: boolean }>()
  for (const e of db.prepare(`SELECT document_kind, document_id, status, irn, is_demo FROM einvoices WHERE company_id = ? ORDER BY id`).all(ctx.companyId) as Row[]) {
    const key = `${e.document_kind}:${e.document_id}`
    const prev = einv.get(key)
    if (!prev || e.status === 'GENERATED' || e.status === 'PENDING' || prev.status === 'FAILED') einv.set(key, { status: e.status as string, irn: e.irn as string | null, isDemo: e.is_demo === 1 })
  }
  const origStmt = db.prepare(`SELECT invoice_no, invoice_date, grand_total_paise, igst_paise, is_inter_state, customer_gstin FROM sales_invoices WHERE id = ?`)

  const build = (r: Row, kind: GstOutwardDoc['kind'], lines: ReturnType<typeof invLines.get>): OutwardDocX => {
    const ls = lines ?? []
    const reportable = ls.filter((l) => l.category === 'TAXABLE' || l.category === 'ZERO_RATED')
    const sumL = (k: 'taxablePaise' | 'igstPaise' | 'cgstPaise' | 'sgstPaise' | 'cessPaise', arr = reportable) => arr.reduce((s, l) => s + l[k], 0)
    const cat = (c: TaxCategory) => ls.filter((l) => l.category === c).reduce((s, l) => s + l.taxablePaise, 0)
    const interState = r.is_inter_state === 1
    const partyGstin = (r.party_gstin as string | null) || null
    const base = { partyRegType: r.reg_type as string, partyGstin, interState, invoiceValuePaise: r.grand_total_paise as number, b2clThresholdPaise: rulesAt(ctx, r.date as string, ruleSets).B2CL_INVOICE_THRESHOLD_PAISE }
    let section: GstOutwardDoc['section']
    let originalNo: string | null = null
    let originalDate: string | null = null
    if (kind === 'SALES_INVOICE') section = classifyOutward({ ...base, igstPaise: r.igst_paise as number })
    else {
      const o = r.original_id ? (origStmt.get(r.original_id) as Row | undefined) : undefined
      originalNo = (o?.invoice_no as string) ?? null
      originalDate = (o?.invoice_date as string) ?? null
      const origClass: OutwardClass | null = o ? classifyOutward({ ...base, invoiceValuePaise: o.grand_total_paise as number, igstPaise: o.igst_paise as number }) : null
      section = classifyNote(origClass, { ...base, invoiceValuePaise: (o?.grand_total_paise as number) ?? base.invoiceValuePaise })
    }
    return {
      kind, id: r.id as number, number: r.number as string, date: r.date as string, status: r.status as string, route: docRoute(kind, r.id as number),
      partyId: r.party_id as number, partyName: r.party_name as string, partyGstin, partyRegType: r.reg_type as string, placeOfSupply: r.place_of_supply as string, interState,
      sellerGstin: gstinOf(r.branch_id as number | null), section, originalNo, originalDate,
      invoiceValuePaise: r.grand_total_paise as number, taxablePaise: sumL('taxablePaise'), igstPaise: sumL('igstPaise'), cgstPaise: sumL('cgstPaise'), sgstPaise: sumL('sgstPaise'), cessPaise: sumL('cessPaise'),
      nilPaise: cat('NIL_RATED'), exemptPaise: cat('EXEMPT'), nonGstPaise: cat('NON_GST'),
      sign: kind === 'SALES_INVOICE' ? 1 : -1,
      einvoice: einv.get(`${kind}:${r.id}`) ?? null,
      lines: ls.map(({ reverseCharge: _r, ruleFound: _f, rateBps: _b, ruleRateBps: _q, productCode: _p, ...l }) => l),
      lineMeta: ls.map((l) => ({ ruleFound: l.ruleFound, rateBps: l.rateBps, productCode: l.productCode })),
      branchId: r.branch_id as number | null, headerTaxablePaise: r.taxable_paise as number,
      partyPincode: r.party_pincode as string | null, partyAddress: r.party_address as string | null
    }
  }
  let docs = [...inv.map((r) => build(r, 'SALES_INVOICE', invLines.get(r.id as number))), ...notes.map((r) => build(r, r.doc_type as 'CREDIT_NOTE' | 'SALES_RETURN', noteLines.get(r.id as number)))]
  if (f.gstin) docs = docs.filter((d) => d.sellerGstin === f.gstin)
  if (f.category) docs = docs.filter((d) => d.section === f.category)
  return docs.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
}

export type InwardDocX = GstInwardDoc & { branchId: number | null; lineMeta: Array<{ ruleFound: boolean; rateBps: number; productCode: string }>; chargesTaxablePaise: number; headerTaxablePaise: number }

/** Purchase invoices, purchase returns and debit notes in a period, with their ITC classification. */
export function inwardDocs(ctx: ServiceContext, f: RegisterFilter): InwardDocX[] {
  const db = ctx.db
  const ruleCache = new Map<string, HsnRateRule | null>()
  const gstinOf = gstinResolver(ctx)
  const inv = db
    .prepare(
      `SELECT pi.id, 'PURCHASE_INVOICE' AS kind, pi.invoice_no AS number, pi.invoice_date AS date, pi.status, pi.supplier_id AS party_id, s.name AS party_name, pi.supplier_gstin AS party_gstin,
              s.gst_registration_type AS reg_type, pi.supplier_invoice_no AS supplier_ref, pi.supplier_invoice_date AS supplier_ref_date, pi.place_of_supply, pi.is_inter_state, pi.branch_id,
              pi.grand_total_paise, pi.taxable_paise, pi.igst_paise, pi.cgst_paise, pi.sgst_paise, pi.cess_paise, pi.freight_paise + pi.other_charges_paise AS charges, NULL AS original_id
       FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pi.company_id = ? AND ${statusSql(f.status, 'pi.status')} AND pi.invoice_date BETWEEN ? AND ?`
    )
    .all(ctx.companyId, f.from, f.to) as Row[]
  const notes = db
    .prepare(
      `SELECT td.id, td.doc_type AS kind, td.doc_no AS number, td.doc_date AS date, td.status, td.supplier_id AS party_id, s.name AS party_name, td.party_gstin,
              s.gst_registration_type AS reg_type, td.supplier_ref, td.supplier_ref_date, td.place_of_supply, td.is_inter_state, NULL AS branch_id,
              td.grand_total_paise, td.taxable_paise, td.igst_paise, td.cgst_paise, td.sgst_paise, td.cess_paise, 0 AS charges, CASE WHEN td.source_type = 'PURCHASE_INVOICE' THEN td.source_id END AS original_id
       FROM trade_documents td JOIN suppliers s ON s.id = td.supplier_id
       WHERE td.company_id = ? AND td.doc_type IN ('PURCHASE_RETURN','DEBIT_NOTE') AND ${statusSql(f.status, 'td.status')} AND td.doc_date BETWEEN ? AND ?`
    )
    .all(ctx.companyId, f.from, f.to) as Row[]
  const invDates = new Map(inv.map((r) => [r.id as number, r.date as string]))
  const noteDates = new Map(notes.map((r) => [r.id as number, r.date as string]))
  const invLines = loadLines(ctx, 'purchase_invoice_items', 'invoice_id', inv.map((r) => r.id as number), (i) => invDates.get(i)!, ruleCache)
  const noteLines = loadLines(ctx, 'trade_document_lines', 'document_id', notes.map((r) => r.id as number), (i) => noteDates.get(i)!, ruleCache)
  const itc = new Map((db.prepare('SELECT * FROM purchase_itc WHERE company_id = ?').all(ctx.companyId) as Row[]).map((r) => [`${r.document_kind}:${r.document_id}`, r]))
  const origStmt = db.prepare('SELECT invoice_no FROM purchase_invoices WHERE id = ?')

  const build = (r: Row, lines: ReturnType<typeof invLines.get>): InwardDocX => {
    const kind = r.kind as GstInwardDoc['kind']
    const ls = lines ?? []
    const partyGstin = (r.party_gstin as string | null) || null
    const stored = itc.get(`${kind}:${r.id}`) ?? (r.original_id ? itc.get(`PURCHASE_INVOICE:${r.original_id}`) : undefined)
    const ownRow = itc.get(`${kind}:${r.id}`)
    const reverseCharge = stored ? stored.reverse_charge === 1 : false
    let eligibility: ItcEligibility = stored ? (stored.eligibility as ItcEligibility) : 'PENDING'
    if (!partyGstin && !reverseCharge) eligibility = 'NOT_AVAILABLE'
    const interState = r.is_inter_state === 1
    const tax = (r.igst_paise as number) + (r.cgst_paise as number) + (r.sgst_paise as number)
    // Reverse charge: the recipient pays the tax; when the supplier charged none, assess it on the line rates.
    let rcmTax = 0
    if (reverseCharge) rcmTax = tax > 0 ? tax : ls.reduce((s, l) => s + percentOf(l.taxablePaise, l.ruleRateBps ?? l.rateBps), 0)
    const rcmSplit = reverseCharge && tax === 0 ? splitTaxAmount(rcmTax, interState) : null
    const nilExempt = ls.filter((l) => l.category !== 'TAXABLE' && l.category !== 'ZERO_RATED').reduce((s, l) => s + l.taxablePaise, 0)
    return {
      kind, id: r.id as number, number: r.number as string, date: r.date as string, status: r.status as string, route: docRoute(kind, r.id as number),
      partyId: r.party_id as number, partyName: r.party_name as string, partyGstin, partyRegType: r.reg_type as string,
      supplierRef: (r.supplier_ref as string | null)?.startsWith('~DRAFT-') ? null : (r.supplier_ref as string | null), supplierRefDate: r.supplier_ref_date as string | null,
      placeOfSupply: r.place_of_supply as string, interState, originalNo: r.original_id ? ((origStmt.get(r.original_id) as { invoice_no: string } | undefined)?.invoice_no ?? null) : null,
      invoiceValuePaise: r.grand_total_paise as number, taxablePaise: r.taxable_paise as number,
      igstPaise: rcmSplit ? rcmSplit.igst : (r.igst_paise as number), cgstPaise: rcmSplit ? rcmSplit.cgst : (r.cgst_paise as number), sgstPaise: rcmSplit ? rcmSplit.sgst : (r.sgst_paise as number), cessPaise: r.cess_paise as number,
      nilExemptPaise: nilExempt,
      sign: kind === 'PURCHASE_INVOICE' ? 1 : -1,
      itc: { eligibility, itcType: (stored?.itc_type as string) ?? 'INPUTS', reverseCharge, reason: (stored?.reason as string | null) ?? null, classifiedAt: (ownRow?.updated_at as string | null) ?? null, stored: !!ownRow },
      rcmSuggested: ls.some((l) => l.reverseCharge),
      rcmTaxPaise: rcmTax,
      lines: ls.map(({ reverseCharge: _r, ruleFound: _f, rateBps: _b, ruleRateBps: _q, productCode: _p, ...l }) => l),
      lineMeta: ls.map((l) => ({ ruleFound: l.ruleFound, rateBps: l.rateBps, productCode: l.productCode })),
      branchId: r.branch_id as number | null, chargesTaxablePaise: r.charges as number, headerTaxablePaise: r.taxable_paise as number
    }
  }
  let docs = [...inv.map((r) => build(r, invLines.get(r.id as number))), ...notes.map((r) => build(r, noteLines.get(r.id as number)))]
  const recv = docs.map((d) => ({ d, g: gstinOf(d.branchId) }))
  if (f.gstin) docs = recv.filter((x) => x.g === f.gstin).map((x) => x.d)
  if (f.category) docs = docs.filter((d) => d.itc.eligibility === f.category || (f.category === 'RCM' && d.itc.reverseCharge))
  return docs.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
}

function hsnSummary(ctx: ServiceContext, docs: Array<{ sign: number; lines: GstDocLine[] }>): HsnSummaryRow[] {
  const master = new Map((ctx.db.prepare('SELECT code, description FROM hsn_codes WHERE company_id = ?').all(ctx.companyId) as Array<{ code: string; description: string }>).map((r) => [r.code, r.description]))
  const map = new Map<string, HsnSummaryRow>()
  for (const d of docs)
    for (const l of d.lines) {
      const key = `${l.hsn}|${l.uqc}|${l.ratePct}`
      const h = map.get(key) ?? { hsn: l.hsn, description: master.get(l.hsn) ?? l.description, uqc: l.uqc, qtyMilli: 0, ratePct: l.ratePct, valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0, kind: l.itemType }
      h.qtyMilli += d.sign * l.qtyMilli
      h.taxablePaise += d.sign * l.taxablePaise
      h.igstPaise += d.sign * l.igstPaise
      h.cgstPaise += d.sign * l.cgstPaise
      h.sgstPaise += d.sign * l.sgstPaise
      h.cessPaise += d.sign * l.cessPaise
      h.valuePaise += d.sign * (l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise + l.cessPaise)
      map.set(key, h)
    }
  return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.ratePct - b.ratePct)
}

function rateSummary(docs: Array<{ sign: number; lines: GstDocLine[] }>): RateSummaryRow[] {
  const map = new Map<number, RateSummaryRow>()
  for (const d of docs)
    for (const l of d.lines) {
      const r = map.get(l.ratePct) ?? { ratePct: l.ratePct, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }
      r.taxablePaise += d.sign * l.taxablePaise
      r.igstPaise += d.sign * l.igstPaise
      r.cgstPaise += d.sign * l.cgstPaise
      r.sgstPaise += d.sign * l.sgstPaise
      r.cessPaise += d.sign * l.cessPaise
      map.set(l.ratePct, r)
    }
  return [...map.values()].sort((a, b) => a.ratePct - b.ratePct)
}

/** Net GST posted to the given accounts by the original postings of the given document kinds (cancellation reversals excluded). */
function ledgerTax(ctx: ServiceContext, kinds: string[], keys: string[], from: string, to: string, creditPositive: boolean): Record<string, number> {
  const rows = ctx.db
    .prepare(
      `SELECT a.system_key AS k, COALESCE(SUM(l.credit_paise - l.debit_paise), 0) AS v FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE je.company_id = ? AND je.entry_date BETWEEN ? AND ? AND COALESCE(je.source_kind, je.source_type) IN (${kinds.map(() => '?').join(',')})
         AND a.system_key IN (${keys.map(() => '?').join(',')}) GROUP BY a.system_key`
    )
    .all(ctx.companyId, from, to, ...kinds, ...keys) as Array<{ k: string; v: number }>
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]))
  for (const r of rows) out[r.k] = creditPositive ? r.v : -r.v
  return out
}

export function salesRegister(ctx: ServiceContext, f: RegisterFilter): GstSalesRegister {
  const docs = outwardDocs(ctx, f)
  const bySection: Record<string, TaxTotals> = {}
  const totals = emptyTotals()
  for (const d of docs) {
    bySection[d.section] ??= emptyTotals()
    if (d.status !== 'CANCELLED') {
      add(bySection[d.section], d)
      add(totals, d)
    } else bySection[d.section].count += 1
  }
  const live = docs.filter((d) => d.status !== 'CANCELLED')
  // Reconciliation with the ledger: every non-draft document of the period (incl. later-cancelled ones) vs their original postings.
  const all = f.status === 'ALL' && !f.gstin && !f.category ? docs : outwardDocs(ctx, { from: f.from, to: f.to, status: 'ALL' })
  // Tax on nil/exempt lines is zero by definition; include all lines' tax for the comparison.
  const allTax = all.reduce((s, d) => ({ i: s.i + d.sign * d.lines.reduce((a, l) => a + l.igstPaise, 0), c: s.c + d.sign * d.lines.reduce((a, l) => a + l.cgstPaise, 0), s: s.s + d.sign * d.lines.reduce((a, l) => a + l.sgstPaise, 0) }), { i: 0, c: 0, s: 0 })
  const led = ledgerTax(ctx, ['SALES_INVOICE', 'CREDIT_NOTE', 'SALES_RETURN'], ['OUTPUT_IGST', 'OUTPUT_CGST', 'OUTPUT_SGST'], f.from, f.to, true)
  return {
    from: f.from, to: f.to, gstin: f.gstin ?? null, docs, bySection, hsn: hsnSummary(ctx, live), rates: rateSummary(live), totals,
    ledger: { igstPaise: led.OUTPUT_IGST, cgstPaise: led.OUTPUT_CGST, sgstPaise: led.OUTPUT_SGST, agrees: led.OUTPUT_IGST === allTax.i && led.OUTPUT_CGST === allTax.c && led.OUTPUT_SGST === allTax.s }
  }
}

export function purchaseRegister(ctx: ServiceContext, f: RegisterFilter): GstPurchaseRegister {
  const docs = inwardDocs(ctx, f)
  const byEligibility: Record<string, TaxTotals> = {}
  const totals = emptyTotals()
  const rcm = emptyTotals()
  for (const d of docs) {
    if (d.status === 'CANCELLED') continue
    byEligibility[d.itc.eligibility] ??= emptyTotals()
    add(byEligibility[d.itc.eligibility], d)
    add(totals, d)
    if (d.itc.reverseCharge) add(rcm, d)
  }
  const live = docs.filter((d) => d.status !== 'CANCELLED')
  const all = inwardDocs(ctx, { from: f.from, to: f.to, status: 'ALL' })
  // Ledger holds the tax charged by suppliers (self-assessed RCM tax is not posted by the ERP).
  const charged = all.reduce(
    (s, d) => {
      const rcmAssessed = d.itc.reverseCharge && d.rcmTaxPaise > 0 && d.lines.every((l) => l.igstPaise + l.cgstPaise + l.sgstPaise === 0)
      return rcmAssessed ? s : { i: s.i + d.sign * d.igstPaise, c: s.c + d.sign * d.cgstPaise, s: s.s + d.sign * d.sgstPaise }
    },
    { i: 0, c: 0, s: 0 }
  )
  const led = ledgerTax(ctx, ['PURCHASE_INVOICE', 'PURCHASE_RETURN', 'DEBIT_NOTE'], ['INPUT_IGST', 'INPUT_CGST', 'INPUT_SGST'], f.from, f.to, false)
  return {
    from: f.from, to: f.to, gstin: f.gstin ?? null, docs, byEligibility, hsn: hsnSummary(ctx, live), rates: rateSummary(live), totals, rcm,
    ledger: { igstPaise: led.INPUT_IGST, cgstPaise: led.INPUT_CGST, sgstPaise: led.INPUT_SGST, agrees: led.INPUT_IGST === charged.i && led.INPUT_CGST === charged.c && led.INPUT_SGST === charged.s }
  }
}

