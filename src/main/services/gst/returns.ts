/**
 * GSTR-1 / GSTR-3B preparation, validation and export.
 *
 * PREPARATION ONLY. Nothing here files a return or contacts the GST portal;
 * a preparation is a frozen snapshot that can be exported for review or for
 * the user's own filing process. Statuses are PREPARED and EXPORTED — never FILED.
 */
import { createHash } from 'node:crypto'
import { isValidGstin, stateName } from '@shared/india'
import {
  ISSUE_CATEGORIES, invalidDocumentNumber, isZeroRatedClass, minHsnDigits, type GstIssue, type GstOverview, type GstValidationReport, type Gstr1Data, type Gstr1Section,
  type Gstr3bData, type Gstr3bRow, type ReturnPreparation
} from '@shared/gst'
import type { RuleSet } from '@shared/gst'
import { percentOf } from '@shared/money'
import type { ReportDoc } from '@shared/finance'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { businessRule, notFound } from '../errors'
import { getSettings, primaryGstin, rulesAt, todayIso } from './config'
import { inwardDocs, outwardDocs, type InwardDocX, type OutwardDocX } from './registers'

export function periodRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` }
}

const normRef = (s: string) => s.toUpperCase().replace(/[\s\-/_.]/g, '')

// ───────── Validation ─────────

export function validateGst(ctx: ServiceContext, from: string, to: string, gstin?: string): GstValidationReport {
  const issues: GstIssue[] = []
  const settings = getSettings(ctx)
  const company = ctx.db.prepare('SELECT gstin, state_code FROM companies WHERE id = ?').get(ctx.companyId) as { gstin: string | null; state_code: string }
  const sellerGstin = gstin ?? primaryGstin(ctx)
  const push = (d: { kind: string; id: number; number: string; date: string; partyName: string | null; route: string }, category: GstIssue['category'], severity: GstIssue['severity'], message: string) =>
    issues.push({ category, severity, kind: d.kind, id: d.id, number: d.number, date: d.date, partyName: d.partyName, message, route: d.route })
  const out = outwardDocs(ctx, { from, to, gstin, status: 'POSTED' })
  const inw = inwardDocs(ctx, { from, to, gstin, status: 'POSTED' })
  const hsnMaster = new Set((ctx.db.prepare('SELECT code FROM hsn_codes WHERE company_id = ? AND is_active = 1').all(ctx.companyId) as Array<{ code: string }>).map((r) => r.code))

  if (!sellerGstin) issues.push({ category: 'MISSING_GSTIN', severity: 'ERROR', kind: 'COMPANY', id: ctx.companyId, number: '—', date: from, partyName: null, message: 'The company has no GSTIN; returns cannot be prepared', route: '/gst/config' })
  else if (!isValidGstin(sellerGstin)) issues.push({ category: 'MISSING_GSTIN', severity: 'ERROR', kind: 'COMPANY', id: ctx.companyId, number: sellerGstin, date: from, partyName: null, message: 'Company GSTIN check digit or state code is invalid', route: '/gst/config' })

  const ruleSets = new Map<string, RuleSet>()
  const rateStmt = ctx.db.prepare(`SELECT rate_bps, tax_category FROM hsn_rate_rules WHERE company_id = ? AND ? LIKE hsn_code || '%' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY LENGTH(hsn_code) DESC LIMIT 1`)
  const checkLines = (d: OutwardDocX | InwardDocX, date: string, aato: number | null) => {
    const rules = rulesAt(ctx, date, ruleSets)
    const digits = minHsnDigits(rules, aato)
    d.lines.forEach((l, i) => {
      const meta = d.lineMeta[i]
      if (!l.hsn) push(d, 'MISSING_HSN', 'ERROR', `Line ${i + 1} (${meta.productCode}) has no HSN/SAC`)
      else if (l.hsn.length < digits) push(d, 'MISSING_HSN', 'ERROR', `Line ${i + 1}: HSN ${l.hsn} has ${l.hsn.length} digits; at least ${digits} are required for this turnover`)
      else if (!hsnMaster.has(l.hsn)) push(d, 'MISSING_HSN', 'WARNING', `Line ${i + 1}: HSN ${l.hsn} is not in the HSN/SAC master`)
      if (!meta.ruleFound) push(d, 'CLASSIFICATION', 'WARNING', `Line ${i + 1}: no rate rule for HSN ${l.hsn} on ${date}; classification assumed from the ${meta.rateBps / 100}% rate`)
      else {
        const rule = rateStmt.get(ctx.companyId, l.hsn, date, date) as { rate_bps: number; tax_category: string }
        const rcmZero = 'itc' in d && d.itc.reverseCharge && meta.rateBps === 0
        // Zero-rated supplies under LUT/bond (export / SEZ without IGST) are correctly invoiced at 0%.
        const lutZero = 'section' in d && (d.section === 'EXPWOP' || d.section === 'SEZWOP') && meta.rateBps === 0
        if (rule.rate_bps !== meta.rateBps && !rcmZero && !lutZero) push(d, 'CLASSIFICATION', 'ERROR', `Line ${i + 1}: ${meta.rateBps / 100}% charged, but HSN ${l.hsn} is ${rule.rate_bps / 100}% (${rule.tax_category.toLowerCase().replace('_', ' ')}) on ${date}`)
        if (rule.tax_category !== 'TAXABLE' && l.igstPaise + l.cgstPaise + l.sgstPaise > 0) push(d, 'CLASSIFICATION', 'ERROR', `Line ${i + 1}: tax charged on a ${rule.tax_category.toLowerCase().replace('_', ' ')} supply`)
      }
      // Recompute line tax from the taxable value and rate (shared engine rounding: per line, CGST takes the odd paisa).
      const tax = percentOf(l.taxablePaise, meta.rateBps)
      const charged = l.igstPaise + l.cgstPaise + l.sgstPaise
      // 1 paisa tolerance: tax-inclusive prices derive tax as (price − taxable), which can differ from rate × taxable by rounding.
      if (Math.abs(charged - tax) > 1 && !(('itc' in d) && d.itc.reverseCharge && charged === 0))
        push(d, 'TAX_DIFFERENCE', 'ERROR', `Line ${i + 1}: tax ${(charged / 100).toFixed(2)} differs from ${(tax / 100).toFixed(2)} (${meta.rateBps / 100}% of ${(l.taxablePaise / 100).toFixed(2)})`)
      if (d.interState && (l.cgstPaise || l.sgstPaise)) push(d, 'CLASSIFICATION', 'ERROR', `Line ${i + 1}: CGST/SGST on an inter-state supply`)
      if (!d.interState && l.igstPaise) push(d, 'CLASSIFICATION', 'ERROR', `Line ${i + 1}: IGST on an intra-state supply`)
    })
  }

  // Outward
  const seenNo = new Map<string, OutwardDocX>()
  for (const d of out) {
    checkLines(d, d.date, settings.aatoPaise)
    const nErr = invalidDocumentNumber(d.number)
    if (nErr) push(d, 'INVALID_REFERENCE', 'ERROR', `Document number "${d.number}": ${nErr}`)
    const key = `${d.kind === 'SALES_INVOICE' ? 'INV' : 'CN'}|${normRef(d.number)}`
    if (seenNo.has(key)) push(d, 'DUPLICATE_REFERENCE', 'ERROR', `Same document number as ${seenNo.get(key)!.number} in this period`)
    seenNo.set(key, d)
    if ((d.partyRegType === 'REGULAR' || d.partyRegType === 'COMPOSITION' || d.partyRegType === 'SEZ') && !d.partyGstin) push(d, 'MISSING_GSTIN', 'ERROR', `${d.partyName} is ${d.partyRegType.toLowerCase()} but the document has no buyer GSTIN`)
    if (d.partyGstin && !isValidGstin(d.partyGstin)) push(d, 'MISSING_GSTIN', 'ERROR', `Buyer GSTIN ${d.partyGstin} is invalid`)
    if (d.partyGstin && d.partyRegType !== 'SEZ' && d.partyGstin.slice(0, 2) !== d.placeOfSupply && !d.interState && d.placeOfSupply !== company.state_code) push(d, 'CLASSIFICATION', 'WARNING', 'Place of supply differs from the buyer GSTIN state')
    const expectedInter = d.partyRegType === 'SEZ' || d.partyRegType === 'OVERSEAS' || d.placeOfSupply !== company.state_code
    if (expectedInter !== d.interState) push(d, 'CLASSIFICATION', 'ERROR', `Supply is recorded as ${d.interState ? 'inter' : 'intra'}-state but the place of supply (${stateName(d.placeOfSupply)}) implies ${expectedInter ? 'inter' : 'intra'}-state`)
    if (!d.placeOfSupply) push(d, 'MISSING_INFO', 'ERROR', 'Place of supply is missing')
    if (d.kind !== 'SALES_INVOICE' && !d.originalNo) push(d, 'INVALID_REFERENCE', 'ERROR', 'Credit note has no original invoice reference')
    if (d.section === 'EXPWOP' || d.section === 'SEZWOP') {
      const lutOk = settings.lutNumber && (!settings.lutValidFrom || settings.lutValidFrom <= d.date) && (!settings.lutValidUpto || settings.lutValidUpto >= d.date)
      if (!lutOk) push(d, 'MISSING_INFO', 'ERROR', 'Zero-rated supply without IGST needs a valid LUT/bond for the document date (GST → Configuration)')
    }
    if (d.section.startsWith('EXP')) push(d, 'MISSING_INFO', 'WARNING', 'Shipping bill number/date and port code are not captured by the ERP; add them on the portal')
    if (d.partyRegType !== 'OVERSEAS' && d.partyGstin && !d.partyPincode) push(d, 'MISSING_INFO', 'WARNING', 'Buyer PIN code is missing (required for e-invoice / e-way bill)')
  }
  // Inward
  const byGstinRef = new Map<string, InwardDocX>()
  for (const d of inw) {
    checkLines(d, d.date, settings.aatoPaise)
    if (d.kind === 'PURCHASE_INVOICE' && !d.supplierRef) push(d, 'INVALID_REFERENCE', 'ERROR', 'Supplier invoice number is missing')
    if (d.partyRegType === 'REGULAR' && !d.partyGstin) push(d, 'MISSING_GSTIN', 'ERROR', `${d.partyName} is registered but the bill has no supplier GSTIN`)
    if (d.partyGstin && !isValidGstin(d.partyGstin)) push(d, 'MISSING_GSTIN', 'ERROR', `Supplier GSTIN ${d.partyGstin} is invalid`)
    if (d.supplierRef && d.kind === 'PURCHASE_INVOICE') {
      const k = `${d.partyGstin ?? d.partyId}|${normRef(d.supplierRef)}`
      if (byGstinRef.has(k)) push(d, 'DUPLICATE_REFERENCE', 'ERROR', `Supplier invoice ${d.supplierRef} also recorded as ${byGstinRef.get(k)!.number}`)
      byGstinRef.set(k, d)
      const sameRefOther = inw.find((o) => o !== d && o.kind === 'PURCHASE_INVOICE' && o.supplierRef && normRef(o.supplierRef) === normRef(d.supplierRef!) && o.partyId !== d.partyId && Math.abs(o.invoiceValuePaise - d.invoiceValuePaise) < 100)
      if (sameRefOther) push(d, 'DUPLICATE_REFERENCE', 'WARNING', `Same supplier invoice number and value as ${sameRefOther.number} of ${sameRefOther.partyName}; confirm the supplier`)
    }
    if (d.itc.eligibility === 'PENDING') push(d, 'ITC_REVIEW', 'WARNING', 'Input tax credit has not been classified; it is excluded from GSTR-3B ITC until reviewed')
    if (d.rcmSuggested && !d.itc.reverseCharge) push(d, 'ITC_REVIEW', 'WARNING', 'An HSN/SAC on this bill is configured for reverse charge; confirm whether RCM applies')
    if (d.itc.reverseCharge && d.partyGstin && d.igstPaise + d.cgstPaise + d.sgstPaise > 0 && d.lines.some((l) => l.igstPaise + l.cgstPaise + l.sgstPaise > 0))
      push(d, 'CLASSIFICATION', 'WARNING', 'Marked as reverse charge but the supplier charged GST on the bill')
  }
  const byCategory: Record<string, number> = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, 0]))
  for (const i of issues) byCategory[i.category] += 1
  return { from, to, issues, errors: issues.filter((i) => i.severity === 'ERROR').length, warnings: issues.filter((i) => i.severity === 'WARNING').length, checkedDocuments: out.length + inw.length, byCategory }
}

// ───────── GSTR-1 ─────────

type Bucket = { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
const zero = (): Bucket => ({ taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 })
function rateGroups(d: OutwardDocX): Array<Bucket & { ratePct: number }> {
  const m = new Map<number, Bucket & { ratePct: number }>()
  for (const l of d.lines) {
    if (l.category !== 'TAXABLE' && l.category !== 'ZERO_RATED') continue
    const g = m.get(l.ratePct) ?? { ratePct: l.ratePct, ...zero() }
    g.taxablePaise += l.taxablePaise
    g.igstPaise += l.igstPaise
    g.cgstPaise += l.cgstPaise
    g.sgstPaise += l.sgstPaise
    g.cessPaise += l.cessPaise
    m.set(l.ratePct, g)
  }
  return [...m.values()]
}

export function gstr1(ctx: ServiceContext, period: string, gstin?: string): Gstr1Data {
  const { from, to } = periodRange(period)
  const seller = gstin ?? primaryGstin(ctx) ?? ''
  const docsAll = outwardDocs(ctx, { from, to, gstin, status: 'ALL' })
  const docs = docsAll.filter((d) => d.status === 'POSTED')
  const data: Gstr1Data = { returnType: 'GSTR1', period, gstin: seller, from, to, sections: [], b2b: [], b2cl: [], b2cs: [], exp: [], sez: [], cdnr: [], cdnur: [], nil: [], hsn: [], docs: [], outwardDebitNotes: 'NOT_SUPPORTED' }
  const b2cs = new Map<string, Gstr1Data['b2cs'][number]>()
  const nil = { interReg: [0, 0, 0], intraReg: [0, 0, 0], interUnreg: [0, 0, 0], intraUnreg: [0, 0, 0] }
  for (const d of docs) {
    const nilKey = `${d.interState ? 'inter' : 'intra'}${d.partyGstin ? 'Reg' : 'Unreg'}` as keyof typeof nil
    nil[nilKey][0] += d.sign * d.nilPaise
    nil[nilKey][1] += d.sign * d.exemptPaise
    nil[nilKey][2] += d.sign * d.nonGstPaise
    for (const g of rateGroups(d)) {
      if (d.kind === 'SALES_INVOICE') {
        if (d.section === 'B2B') data.b2b.push({ gstin: d.partyGstin!, name: d.partyName, number: d.number, date: d.date, valuePaise: d.invoiceValuePaise, pos: d.placeOfSupply, reverseCharge: false, type: 'Regular', ...g })
        else if (d.section === 'B2CL') data.b2cl.push({ number: d.number, date: d.date, valuePaise: d.invoiceValuePaise, pos: d.placeOfSupply, ratePct: g.ratePct, taxablePaise: g.taxablePaise, igstPaise: g.igstPaise, cessPaise: g.cessPaise })
        else if (d.section === 'EXPWP' || d.section === 'EXPWOP') data.exp.push({ type: d.section === 'EXPWP' ? 'WPAY' : 'WOPAY', number: d.number, date: d.date, valuePaise: d.invoiceValuePaise, ratePct: g.ratePct, taxablePaise: g.taxablePaise, igstPaise: g.igstPaise })
        else if (d.section === 'SEZWP' || d.section === 'SEZWOP') data.sez.push({ gstin: d.partyGstin ?? '', name: d.partyName, type: d.section, number: d.number, date: d.date, valuePaise: d.invoiceValuePaise, pos: d.placeOfSupply, ratePct: g.ratePct, taxablePaise: g.taxablePaise, igstPaise: g.igstPaise })
      }
      if ((d.kind === 'SALES_INVOICE' && d.section === 'B2CS') || d.section === 'B2CS_ADJ') {
        const key = `${d.placeOfSupply}|${g.ratePct}|${d.interState}`
        const r = b2cs.get(key) ?? { pos: d.placeOfSupply, supplyType: d.interState ? 'INTER' : 'INTRA', ratePct: g.ratePct, ...zero() }
        r.taxablePaise += d.sign * g.taxablePaise
        r.igstPaise += d.sign * g.igstPaise
        r.cgstPaise += d.sign * g.cgstPaise
        r.sgstPaise += d.sign * g.sgstPaise
        r.cessPaise += d.sign * g.cessPaise
        b2cs.set(key, r)
      }
      if (d.section === 'CDNR') data.cdnr.push({ gstin: d.partyGstin ?? '', name: d.partyName, noteNo: d.number, noteDate: d.date, noteType: 'C', originalNo: d.originalNo, valuePaise: d.invoiceValuePaise, pos: d.placeOfSupply, ...g })
      if (d.section === 'CDNUR') data.cdnur.push({ urType: d.partyRegType === 'OVERSEAS' ? (g.igstPaise > 0 ? 'EXPWP' : 'EXPWOP') : 'B2CL', noteNo: d.number, noteDate: d.date, noteType: 'C', originalNo: d.originalNo, valuePaise: d.invoiceValuePaise, pos: d.placeOfSupply, ratePct: g.ratePct, taxablePaise: g.taxablePaise, igstPaise: g.igstPaise, cessPaise: g.cessPaise })
    }
  }
  data.b2cs = [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.ratePct - b.ratePct)
  data.nil = [
    { description: 'Inter-state supplies to registered persons', nilPaise: nil.interReg[0], exemptPaise: nil.interReg[1], nonGstPaise: nil.interReg[2] },
    { description: 'Intra-state supplies to registered persons', nilPaise: nil.intraReg[0], exemptPaise: nil.intraReg[1], nonGstPaise: nil.intraReg[2] },
    { description: 'Inter-state supplies to unregistered persons', nilPaise: nil.interUnreg[0], exemptPaise: nil.interUnreg[1], nonGstPaise: nil.interUnreg[2] },
    { description: 'Intra-state supplies to unregistered persons', nilPaise: nil.intraUnreg[0], exemptPaise: nil.intraUnreg[1], nonGstPaise: nil.intraUnreg[2] }
  ]
  // HSN summary of every reported line (nil/exempt included), credit notes netted.
  const hsn = new Map<string, Gstr1Data['hsn'][number]>()
  for (const d of docs)
    for (const l of d.lines) {
      const key = `${l.hsn}|${l.uqc}|${l.ratePct}`
      const h = hsn.get(key) ?? { hsn: l.hsn, description: l.description, uqc: l.uqc, qtyMilli: 0, ratePct: l.ratePct, valuePaise: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0, kind: l.itemType }
      h.qtyMilli += d.sign * l.qtyMilli
      h.taxablePaise += d.sign * l.taxablePaise
      h.igstPaise += d.sign * l.igstPaise
      h.cgstPaise += d.sign * l.cgstPaise
      h.sgstPaise += d.sign * l.sgstPaise
      h.cessPaise += d.sign * l.cessPaise
      h.valuePaise += d.sign * (l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise + l.cessPaise)
      hsn.set(key, h)
    }
  data.hsn = [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn))
  // Documents issued (Table 13), cancelled ones counted.
  for (const [nature, kinds] of [['Invoices for outward supply', ['SALES_INVOICE']], ['Credit notes', ['CREDIT_NOTE', 'SALES_RETURN']]] as const) {
    const list = docsAll.filter((d) => (kinds as readonly string[]).includes(d.kind)).map((d) => ({ n: d.number, c: d.status === 'CANCELLED' })).sort((a, b) => a.n.localeCompare(b.n))
    if (list.length) data.docs.push({ nature, from: list[0].n, to: list[list.length - 1].n, total: list.length, cancelled: list.filter((x) => x.c).length })
  }
  const section = (key: string, label: string, rows: Array<Partial<Bucket> & { valuePaise?: number }>, count = rows.length): Gstr1Section => ({
    key, label, count,
    taxablePaise: rows.reduce((s, r) => s + (r.taxablePaise ?? 0), 0), igstPaise: rows.reduce((s, r) => s + (r.igstPaise ?? 0), 0),
    cgstPaise: rows.reduce((s, r) => s + (r.cgstPaise ?? 0), 0), sgstPaise: rows.reduce((s, r) => s + (r.sgstPaise ?? 0), 0), cessPaise: rows.reduce((s, r) => s + (r.cessPaise ?? 0), 0),
    valuePaise: 0
  })
  const uniq = (rows: Array<{ number?: string; noteNo?: string }>) => new Set(rows.map((r) => r.number ?? r.noteNo)).size
  data.sections = [
    section('b2b', '4A — B2B invoices', data.b2b, uniq(data.b2b)),
    section('b2cl', '5 — B2C Large invoices', data.b2cl, uniq(data.b2cl)),
    section('b2cs', '7 — B2C Small (net of credit notes)', data.b2cs),
    section('exp', '6A — Exports', data.exp, uniq(data.exp)),
    section('sez', '6B — SEZ supplies', data.sez, uniq(data.sez)),
    section('cdnr', '9B — Credit notes (registered)', data.cdnr.map((r) => ({ ...r, taxablePaise: -r.taxablePaise, igstPaise: -r.igstPaise, cgstPaise: -r.cgstPaise, sgstPaise: -r.sgstPaise, cessPaise: -r.cessPaise })), uniq(data.cdnr)),
    section('cdnur', '9B — Credit notes (unregistered)', data.cdnur.map((r) => ({ ...r, taxablePaise: -r.taxablePaise, igstPaise: -r.igstPaise, cessPaise: -r.cessPaise })), uniq(data.cdnur)),
    { ...section('nil', '8 — Nil rated, exempt, non-GST', []), taxablePaise: data.nil.reduce((s, r) => s + r.nilPaise + r.exemptPaise + r.nonGstPaise, 0) },
    section('hsn', '12 — HSN summary', data.hsn)
  ]
  return data
}

// ───────── GSTR-3B ─────────

export function gstr3b(ctx: ServiceContext, period: string, gstin?: string): Gstr3bData {
  const { from, to } = periodRange(period)
  const seller = gstin ?? primaryGstin(ctx) ?? ''
  const out = outwardDocs(ctx, { from, to, gstin, status: 'POSTED' })
  const inw = inwardDocs(ctx, { from, to, gstin, status: 'POSTED' })
  const row = (key: string, label: string): Gstr3bRow => ({ key, label, ...zero() })
  const a = row('3.1a', '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)')
  const b = row('3.1b', '(b) Outward taxable supplies (zero rated)')
  const c = row('3.1c', '(c) Other outward supplies (nil rated, exempted)')
  const d = row('3.1d', '(d) Inward supplies (liable to reverse charge)')
  const e = row('3.1e', '(e) Non-GST outward supplies')
  const unreg = new Map<string, { pos: string; taxablePaise: number; igstPaise: number }>()
  const comp = new Map<string, { pos: string; taxablePaise: number; igstPaise: number }>()
  for (const x of out) {
    const target = isZeroRatedClass(x.section as never) || x.partyRegType === 'SEZ' || x.partyRegType === 'OVERSEAS' ? b : a
    target.taxablePaise += x.sign * x.taxablePaise
    target.igstPaise += x.sign * x.igstPaise
    target.cgstPaise += x.sign * x.cgstPaise
    target.sgstPaise += x.sign * x.sgstPaise
    target.cessPaise += x.sign * x.cessPaise
    c.taxablePaise += x.sign * (x.nilPaise + x.exemptPaise)
    e.taxablePaise += x.sign * x.nonGstPaise
    if (x.interState && target === a && !x.partyGstin) {
      const r = unreg.get(x.placeOfSupply) ?? { pos: x.placeOfSupply, taxablePaise: 0, igstPaise: 0 }
      r.taxablePaise += x.sign * x.taxablePaise
      r.igstPaise += x.sign * x.igstPaise
      unreg.set(x.placeOfSupply, r)
    }
    if (x.interState && x.partyRegType === 'COMPOSITION') {
      const r = comp.get(x.placeOfSupply) ?? { pos: x.placeOfSupply, taxablePaise: 0, igstPaise: 0 }
      r.taxablePaise += x.sign * x.taxablePaise
      r.igstPaise += x.sign * x.igstPaise
      comp.set(x.placeOfSupply, r)
    }
  }
  const itcRcm = row('4A3', '4(A)(3) Inward supplies liable to reverse charge')
  const itcOther = row('4A5', '4(A)(5) All other ITC')
  const itcRev = row('4B1', '4(B)(1) Reversed: ineligible / blocked (s.17(5)) as classified')
  const pending = { count: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 }
  const exemptIn = { compInter: 0, compIntra: 0, nonGstInter: 0, nonGstIntra: 0 }
  for (const x of inw) {
    const t = (r: Gstr3bRow, s = x.sign) => {
      r.taxablePaise += s * x.taxablePaise
      r.igstPaise += s * x.igstPaise
      r.cgstPaise += s * x.cgstPaise
      r.sgstPaise += s * x.sgstPaise
      r.cessPaise += s * x.cessPaise
    }
    if (x.itc.reverseCharge) t(d)
    if (x.partyRegType === 'COMPOSITION' || x.partyRegType === 'UNREGISTERED' || x.nilExemptPaise) {
      const v = x.partyRegType === 'COMPOSITION' ? x.invoiceValuePaise : x.nilExemptPaise
      if (x.interState) exemptIn.compInter += x.sign * v
      else exemptIn.compIntra += x.sign * v
    }
    if (x.itc.eligibility === 'NOT_AVAILABLE') continue
    if (x.itc.eligibility === 'PENDING') {
      pending.count += 1
      pending.igstPaise += x.sign * x.igstPaise
      pending.cgstPaise += x.sign * x.cgstPaise
      pending.sgstPaise += x.sign * x.sgstPaise
      continue
    }
    const target = x.itc.reverseCharge ? itcRcm : itcOther
    t(target)
    if (x.itc.eligibility !== 'ELIGIBLE') t(itcRev)
  }
  const net = row('4C', '4(C) Net ITC available (A) − (B)')
  for (const k of ['taxablePaise', 'igstPaise', 'cgstPaise', 'sgstPaise', 'cessPaise'] as const) net[k] = itcRcm[k] + itcOther[k] - itcRev[k]
  const liability = { IGST: a.igstPaise + b.igstPaise + d.igstPaise, CGST: a.cgstPaise + d.cgstPaise, SGST: a.sgstPaise + d.sgstPaise, CESS: a.cessPaise + b.cessPaise + d.cessPaise }
  const itcAvail = { IGST: net.igstPaise, CGST: net.cgstPaise, SGST: net.sgstPaise, CESS: net.cessPaise }
  return {
    returnType: 'GSTR3B', period, gstin: seller, from, to,
    outward: [a, b, c, d, e],
    interStateUnregistered: [...unreg.values()].sort((x, y) => x.pos.localeCompare(y.pos)),
    interStateComposition: [...comp.values()],
    itc: [itcRcm, itcOther, itcRev, net],
    itcPending: pending,
    inwardExempt: [{ label: 'From composition, exempt and nil-rated suppliers', interPaise: exemptIn.compInter, intraPaise: exemptIn.compIntra }, { label: 'Non-GST supplies', interPaise: exemptIn.nonGstInter, intraPaise: exemptIn.nonGstIntra }],
    indicativeNet: (['IGST', 'CGST', 'SGST', 'CESS'] as const).map((h) => ({ head: h, liabilityPaise: liability[h], itcPaise: itcAvail[h], netPaise: liability[h] - itcAvail[h] }))
  }
}

// ───────── Preparations ─────────

/** Fingerprint of the posted documents behind a period, so a stale snapshot can be detected. */
function sourceHash(ctx: ServiceContext, from: string, to: string): string {
  const parts = [
    ctx.db.prepare(`SELECT GROUP_CONCAT(id || ':' || status || ':' || grand_total_paise) v FROM (SELECT id, status, grand_total_paise FROM sales_invoices WHERE company_id = ? AND status <> 'DRAFT' AND invoice_date BETWEEN ? AND ? ORDER BY id)`).get(ctx.companyId, from, to),
    ctx.db.prepare(`SELECT GROUP_CONCAT(id || ':' || status || ':' || grand_total_paise) v FROM (SELECT id, status, grand_total_paise FROM purchase_invoices WHERE company_id = ? AND status <> 'DRAFT' AND invoice_date BETWEEN ? AND ? ORDER BY id)`).get(ctx.companyId, from, to),
    ctx.db.prepare(`SELECT GROUP_CONCAT(id || ':' || status || ':' || grand_total_paise) v FROM (SELECT id, status, grand_total_paise FROM trade_documents WHERE company_id = ? AND status <> 'DRAFT' AND doc_type IN ('CREDIT_NOTE','SALES_RETURN','PURCHASE_RETURN','DEBIT_NOTE') AND doc_date BETWEEN ? AND ? ORDER BY id)`).get(ctx.companyId, from, to),
    ctx.db.prepare(`SELECT GROUP_CONCAT(document_kind || ':' || document_id || ':' || eligibility || ':' || reverse_charge) v FROM (SELECT * FROM purchase_itc WHERE company_id = ? ORDER BY id)`).get(ctx.companyId)
  ]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

type Row = Record<string, unknown>
function toPrep(ctx: ServiceContext, r: Row): ReturnPreparation {
  const { from, to } = periodRange(r.period as string)
  return {
    id: r.id as number, returnType: r.return_type as 'GSTR1' | 'GSTR3B', period: r.period as string, gstin: r.gstin as string, status: r.status as 'PREPARED' | 'EXPORTED',
    validationErrors: r.validation_errors as number, validationWarnings: r.validation_warnings as number, preparedAt: r.prepared_at as string, preparedBy: r.prepared_by_name as string | null,
    exportedAt: r.exported_at as string | null, exportFormat: r.export_format as string | null, stale: sourceHash(ctx, from, to) !== r.source_hash, data: JSON.parse(r.summary_json as string)
  }
}
const PREP_SELECT = `SELECT g.*, u.full_name AS prepared_by_name FROM gst_return_preparations g LEFT JOIN users u ON u.id = g.prepared_by`

export function listPreparations(ctx: ServiceContext, returnType?: 'GSTR1' | 'GSTR3B'): ReturnPreparation[] {
  return (ctx.db.prepare(`${PREP_SELECT} WHERE g.company_id = ? ${returnType ? 'AND g.return_type = ?' : ''} ORDER BY g.period DESC, g.id DESC`).all(...(returnType ? [ctx.companyId, returnType] : [ctx.companyId])) as Row[]).map((r) => toPrep(ctx, r))
}

export function getPreparation(ctx: ServiceContext, id: number): ReturnPreparation {
  const r = ctx.db.prepare(`${PREP_SELECT} WHERE g.id = ? AND g.company_id = ?`).get(id, ctx.companyId) as Row | undefined
  if (!r) throw notFound('Return preparation')
  return toPrep(ctx, r)
}

/** Freezes the computed return. Validation errors block preparation; warnings are recorded with it. */
export function prepareReturn(ctx: ServiceContext, returnType: 'GSTR1' | 'GSTR3B', period: string, gstin?: string): ReturnPreparation {
  const { from, to } = periodRange(period)
  if (from > todayIso()) throw businessRule('This return period has not started yet')
  const v = validateGst(ctx, from, to, gstin)
  if (v.errors > 0) throw businessRule(`${v.errors} validation error(s) must be corrected before preparing ${returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} (see GST → Validation)`)
  const data = returnType === 'GSTR1' ? gstr1(ctx, period, gstin) : gstr3b(ctx, period, gstin)
  if (!data.gstin) throw businessRule('The company has no GSTIN')
  return inTransaction(ctx.db, () => {
    const id = Number(
      ctx.db
        .prepare(`INSERT INTO gst_return_preparations (company_id, return_type, period, gstin, status, summary_json, validation_errors, validation_warnings, source_hash, prepared_by) VALUES (?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?)`)
        .run(ctx.companyId, returnType, period, data.gstin, JSON.stringify(data), v.errors, v.warnings, sourceHash(ctx, from, to), ctx.userId).lastInsertRowid
    )
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_RETURN_PREPARED', entityType: 'gst_return', entityId: id, summary: `${returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} ${period} prepared for ${data.gstin} (${v.warnings} warnings). Not filed.` })
    return getPreparation(ctx, id)
  })
}

export function markExported(ctx: ServiceContext, id: number, format: 'XLSX' | 'JSON'): void {
  ctx.db.prepare(`UPDATE gst_return_preparations SET status = 'EXPORTED', exported_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), exported_by = ?, export_format = ? WHERE id = ? AND company_id = ?`).run(ctx.userId, format, id, ctx.companyId)
  writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_RETURN_EXPORTED', entityType: 'gst_return', entityId: id, summary: `Return preparation #${id} exported (${format}). Not filed with the GST portal.` })
}

/** JSON export: the ERP's own documented preparation format (not the GSTN offline-tool upload schema). */
export function preparationJson(p: ReturnPreparation): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        format: 'SA-ERP-GST-PREPARATION', version: 1,
        notice: 'Prepared by SA Business ERP for review. This is NOT the GSTN offline-tool upload schema and has NOT been filed with the GST portal. Amounts are in paise.',
        returnType: p.returnType, period: p.period, gstin: p.gstin, preparedAt: p.preparedAt, validationWarnings: p.validationWarnings, data: p.data
      },
      null,
      2
    ),
    'utf8'
  )
}

/** Multi-section ReportDoc (one table with section header rows) for preview, Excel and PDF. */
export function preparationReport(companyName: string, p: ReturnPreparation, isDemo = false): ReportDoc {
  const rows: ReportDoc['rows'] = []
  const g = (label: string) => rows.push({ style: 'group', cells: { a: label } })
  const money = (cells: Record<string, string | number | null>, style?: 'subtotal' | 'total') => rows.push({ cells, ...(style ? { style } : {}) })
  const cols: ReportDoc['columns'] = [
    { key: 'a', label: 'Particulars', type: 'text', width: 46 }, { key: 'b', label: 'Ref / POS', type: 'text', width: 20 }, { key: 'n', label: 'Count', type: 'number' },
    { key: 't', label: 'Taxable', type: 'money' }, { key: 'i', label: 'IGST', type: 'money' }, { key: 'c', label: 'CGST', type: 'money' }, { key: 's', label: 'SGST', type: 'money' }, { key: 'x', label: 'Cess', type: 'money' }
  ]
  if (p.returnType === 'GSTR1') {
    const d = p.data as Gstr1Data
    g('Summary')
    for (const s of d.sections) money({ a: s.label, b: null, n: s.count, t: s.taxablePaise, i: s.igstPaise, c: s.cgstPaise, s: s.sgstPaise, x: s.cessPaise })
    g('4A — B2B invoices')
    for (const r of d.b2b) money({ a: `${r.number} · ${r.name} · ${r.ratePct}%`, b: `${r.gstin} / ${r.pos}`, n: null, t: r.taxablePaise, i: r.igstPaise, c: r.cgstPaise, s: r.sgstPaise, x: r.cessPaise })
    g('5 — B2C Large')
    for (const r of d.b2cl) money({ a: `${r.number} · ${r.ratePct}%`, b: r.pos, n: null, t: r.taxablePaise, i: r.igstPaise, c: null, s: null, x: r.cessPaise })
    g('6A / 6B — Exports and SEZ')
    for (const r of d.exp) money({ a: `${r.number} · Export ${r.type} · ${r.ratePct}%`, b: null, n: null, t: r.taxablePaise, i: r.igstPaise, c: null, s: null, x: null })
    for (const r of d.sez) money({ a: `${r.number} · ${r.name} · ${r.type} · ${r.ratePct}%`, b: `${r.gstin} / ${r.pos}`, n: null, t: r.taxablePaise, i: r.igstPaise, c: null, s: null, x: null })
    g('7 — B2C Small (by place of supply and rate)')
    for (const r of d.b2cs) money({ a: `${stateName(r.pos)} · ${r.supplyType === 'INTER' ? 'Inter' : 'Intra'}-state · ${r.ratePct}%`, b: r.pos, n: null, t: r.taxablePaise, i: r.igstPaise, c: r.cgstPaise, s: r.sgstPaise, x: r.cessPaise })
    g('9B — Credit notes')
    for (const r of d.cdnr) money({ a: `${r.noteNo} · ${r.name} against ${r.originalNo ?? '—'} · ${r.ratePct}%`, b: r.gstin, n: null, t: -r.taxablePaise, i: -r.igstPaise, c: -r.cgstPaise, s: -r.sgstPaise, x: -r.cessPaise })
    for (const r of d.cdnur) money({ a: `${r.noteNo} (${r.urType}) against ${r.originalNo ?? '—'} · ${r.ratePct}%`, b: r.pos, n: null, t: -r.taxablePaise, i: -r.igstPaise, c: null, s: null, x: -r.cessPaise })
    g('8 — Nil rated, exempt and non-GST (taxable column: nil + exempt + non-GST)')
    for (const r of d.nil) money({ a: r.description, b: null, n: null, t: r.nilPaise + r.exemptPaise + r.nonGstPaise, i: null, c: null, s: null, x: null })
    g('12 — HSN summary')
    for (const r of d.hsn) money({ a: `${r.hsn} · ${r.description} · ${r.ratePct}%`, b: r.uqc, n: r.qtyMilli / 1000, t: r.taxablePaise, i: r.igstPaise, c: r.cgstPaise, s: r.sgstPaise, x: r.cessPaise })
    g('13 — Documents issued')
    for (const r of d.docs) money({ a: `${r.nature}: ${r.from} to ${r.to}`, b: `${r.cancelled} cancelled`, n: r.total, t: null, i: null, c: null, s: null, x: null })
  } else {
    const d = p.data as Gstr3bData
    g('3.1 — Outward and reverse-charge inward supplies')
    for (const r of d.outward) money({ a: r.label, b: null, n: null, t: r.taxablePaise, i: r.igstPaise, c: r.cgstPaise, s: r.sgstPaise, x: r.cessPaise })
    g('3.2 — Inter-state supplies to unregistered persons')
    for (const r of d.interStateUnregistered) money({ a: stateName(r.pos), b: r.pos, n: null, t: r.taxablePaise, i: r.igstPaise, c: null, s: null, x: null })
    g('4 — Eligible ITC (only classified credit; pending review excluded)')
    for (const r of d.itc) money({ a: r.label, b: null, n: null, t: null, i: r.igstPaise, c: r.cgstPaise, s: r.sgstPaise, x: r.cessPaise }, r.key === '4C' ? 'subtotal' : undefined)
    money({ a: `Not yet classified (excluded): ${d.itcPending.count} documents`, b: null, n: d.itcPending.count, t: null, i: d.itcPending.igstPaise, c: d.itcPending.cgstPaise, s: d.itcPending.sgstPaise, x: null })
    g('5 — Exempt, nil-rated and non-GST inward supplies (taxable = inter-state, IGST column = intra-state)')
    for (const r of d.inwardExempt) money({ a: r.label, b: null, n: null, t: r.interPaise, i: r.intraPaise, c: null, s: null, x: null })
    g('Indicative net (no cross-utilisation; the portal computes the actual set-off)')
    for (const r of d.indicativeNet) money({ a: `${r.head}: liability ${(r.liabilityPaise / 100).toFixed(2)} − ITC ${(r.itcPaise / 100).toFixed(2)}`, b: r.head, n: null, t: r.netPaise, i: null, c: null, s: null, x: null })
  }
  return {
    kind: 'GST_SUMMARY',
    companyGstin: p.gstin,
    generatedAt: new Date().toISOString(),
    generatedBy: null,
    title: `${p.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} preparation — ${p.period}`,
    subtitle: `GSTIN ${p.gstin} · prepared ${p.preparedAt.slice(0, 10)} · NOT FILED`,
    companyName,
    columns: cols,
    rows,
    summary: [{ label: 'Status', value: p.status === 'EXPORTED' ? 'Exported (not filed)' : 'Prepared (not filed)' }, { label: 'Warnings', value: String(p.validationWarnings) }, ...(p.stale ? [{ label: 'Snapshot', value: 'Out of date — prepare again', tone: 'bad' as const }] : [])],
    notes: ['Prepared from posted transactions in SA Business ERP for review. It has not been filed with the GST portal.', 'Outward debit notes (supplementary invoices) are not a document type in the ERP.'],
    isDemo
  }
}

// ───────── Overview ─────────

export function gstOverview(ctx: ServiceContext, period: string, gstin?: string, now = new Date()): GstOverview {
  const { from, to } = periodRange(period)
  const g3 = gstr3b(ctx, period, gstin)
  const out = g3.outward
  const outputTax = out[0].igstPaise + out[0].cgstPaise + out[0].sgstPaise + out[1].igstPaise
  const net = g3.itc[3]
  const v = validateGst(ctx, from, to, gstin)
  const settings = getSettings(ctx)
  const einv = ctx.db.prepare(`SELECT status, COUNT(*) n FROM einvoices WHERE company_id = ? GROUP BY status`).all(ctx.companyId) as Array<{ status: string; n: number }>
  const ewbActive = ctx.db.prepare(`SELECT COUNT(*) n FROM ewaybill_records WHERE company_id = ? AND status IN ('ACTIVE','PART_A_ONLY') AND (valid_upto IS NULL OR valid_upto >= ?)`).get(ctx.companyId, now.toISOString()) as { n: number }
  const soon = ctx.db.prepare(`SELECT COUNT(*) n FROM ewaybill_records WHERE company_id = ? AND status = 'ACTIVE' AND valid_upto BETWEEN ? AND ?`).get(ctx.companyId, now.toISOString(), new Date(now.getTime() + 24 * 3600000).toISOString()) as { n: number }
  const months: GstOverview['months'] = []
  const [y, m] = period.split('-').map(Number)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    const p = d.toISOString().slice(0, 7)
    if (periodRange(p).from > todayIso()) continue
    const r = gstr3b(ctx, p, gstin)
    months.push({ month: p, outputPaise: r.outward[0].igstPaise + r.outward[0].cgstPaise + r.outward[0].sgstPaise + r.outward[1].igstPaise, itcPaise: r.itc[3].igstPaise + r.itc[3].cgstPaise + r.itc[3].sgstPaise })
  }
  return {
    period, from, to, gstin: g3.gstin || null,
    outputTaxPaise: outputTax,
    itcEligiblePaise: net.igstPaise + net.cgstPaise + net.sgstPaise,
    itcPendingPaise: g3.itcPending.igstPaise + g3.itcPending.cgstPaise + g3.itcPending.sgstPaise, itcPendingCount: g3.itcPending.count,
    itcBlockedPaise: g3.itc[2].igstPaise + g3.itc[2].cgstPaise + g3.itc[2].sgstPaise,
    rcmTaxPaise: out[3].igstPaise + out[3].cgstPaise + out[3].sgstPaise,
    indicativeNetPaise: g3.indicativeNet.slice(0, 3).reduce((s, r) => s + r.netPaise, 0),
    validationErrors: v.errors, validationWarnings: v.warnings,
    einvoice: { enabled: settings.einvoiceEnabled, eligiblePending: 0, generated: einv.find((e) => e.status === 'GENERATED')?.n ?? 0, failed: einv.find((e) => e.status === 'FAILED')?.n ?? 0 },
    ewaybill: { active: ewbActive.n, expiringSoon: soon.n, requiredMissing: 0 },
    preparations: listPreparations(ctx).filter((p) => p.period === period).map((p) => ({ returnType: p.returnType, period: p.period, status: p.status, preparedAt: p.preparedAt, stale: p.stale })),
    months
  }
}
