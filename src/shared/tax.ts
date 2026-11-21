/**
 * Reusable GST calculation service (pure, deterministic, integer-only).
 * Used by the main process when saving/posting documents and by the renderer
 * for live totals, so both sides always agree.
 *
 * Rules
 *  - Line-level tax: each line's tax is computed and rounded on that line.
 *  - Discount is applied BEFORE tax (it reduces the taxable value — CGST Act s.15(3)).
 *  - EXCLUSIVE pricing: rate is before GST.  INCLUSIVE pricing: rate already contains GST;
 *    taxable = net × 100 / (100 + rate%) and tax = net − taxable, so the line total equals the price charged.
 *  - Intra-state → CGST + SGST (half each; CGST takes the odd paisa, as in Phase 1). Inter-state, SEZ and export → IGST.
 *  - Invoice-level rounding to the nearest rupee (half away from zero), shown as a separate round-off.
 *
 * This is a calculation engine only. It does not file returns or talk to the GST portal.
 */
import { lineAmount, percentOf } from './money'

export type PricingMode = 'EXCLUSIVE' | 'INCLUSIVE'

export class TaxCalculationError extends Error {}

/** a × b / c rounded half away from zero, exact for large values (BigInt). */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) throw new TaxCalculationError('Division by zero')
  const n = BigInt(a) * BigInt(b)
  const d = BigInt(c)
  const neg = n < 0n !== d < 0n
  const an = n < 0n ? -n : n
  const ad = d < 0n ? -d : d
  let q = an / ad
  if ((an % ad) * 2n >= ad) q += 1n
  const result = Number(neg ? -q : q)
  if (!Number.isSafeInteger(result)) throw new TaxCalculationError('Amount is out of range')
  return result
}

export interface TaxSplitResult {
  cgst: number
  sgst: number
  igst: number
}

export function splitTaxAmount(tax: number, interState: boolean): TaxSplitResult {
  if (interState) return { cgst: 0, sgst: 0, igst: tax }
  const cgst = Math.ceil(tax / 2)
  return { cgst, sgst: tax - cgst, igst: 0 }
}

export interface SupplyContext {
  /** Supplier's state code (the company for sales, the supplier for purchases). */
  supplierState: string
  placeOfSupply: string
  /** Registration type of the counter-party (SEZ/OVERSEAS force IGST). */
  partyRegistrationType?: string | null
}

/** Inter-state if the place of supply differs from the supplier's state, or for SEZ/export supplies (IGST Act s.7(5)). */
export function isInterStateSupply(c: SupplyContext): boolean {
  if (c.partyRegistrationType === 'SEZ' || c.partyRegistrationType === 'OVERSEAS') return true
  return c.supplierState !== c.placeOfSupply
}

export interface TaxLineInput {
  qtyMilli: number
  ratePaise: number
  /** Percentage discount in basis points (takes precedence over discountPaise). */
  discountBps?: number | null
  /** Fixed discount amount in paise (in the same pricing basis as the rate). */
  discountPaise?: number
  taxRateBps: number
}

export interface TaxLineResult extends TaxSplitResult {
  /** Value before discount, excluding GST. */
  grossPaise: number
  /** Discount, excluding GST. */
  discountPaise: number
  taxablePaise: number
  taxPaise: number
  totalPaise: number
}

export interface TaxChargeInput {
  amountPaise: number
  taxRateBps: number
}

export interface TaxDocumentInput {
  lines: TaxLineInput[]
  charges?: TaxChargeInput[]
  pricingMode: PricingMode
  interState: boolean
}

export interface TaxDocumentTotals extends TaxSplitResult {
  subtotalPaise: number
  discountPaise: number
  chargesPaise: number
  taxablePaise: number
  taxPaise: number
  roundOffPaise: number
  grandTotalPaise: number
}

export interface TaxDocumentResult {
  lines: TaxLineResult[]
  charges: TaxLineResult[]
  totals: TaxDocumentTotals
}

function assertInt(v: number, label: string, min = 0): void {
  if (!Number.isSafeInteger(v) || v < min) throw new TaxCalculationError(`${label} must be a whole number ≥ ${min}`)
}

export function computeTaxLine(line: TaxLineInput, pricingMode: PricingMode, interState: boolean): TaxLineResult {
  assertInt(line.qtyMilli, 'Quantity', 1)
  assertInt(line.ratePaise, 'Rate')
  assertInt(line.taxRateBps, 'GST rate')
  if (line.taxRateBps > 10000) throw new TaxCalculationError('GST rate cannot exceed 100%')
  const base = lineAmount(line.qtyMilli, line.ratePaise)
  let discount: number
  if (line.discountBps != null) {
    assertInt(line.discountBps, 'Discount %')
    if (line.discountBps > 10000) throw new TaxCalculationError('Discount cannot exceed 100%')
    discount = percentOf(base, line.discountBps)
  } else {
    discount = line.discountPaise ?? 0
    assertInt(discount, 'Discount')
  }
  if (discount > base) throw new TaxCalculationError('Discount cannot exceed the line amount')
  const net = base - discount

  let gross: number
  let taxable: number
  let tax: number
  if (pricingMode === 'EXCLUSIVE') {
    gross = base
    taxable = net
    tax = percentOf(taxable, line.taxRateBps)
  } else {
    taxable = mulDivRound(net, 10000, 10000 + line.taxRateBps)
    tax = net - taxable
    gross = mulDivRound(base, 10000, 10000 + line.taxRateBps)
    if (gross < taxable) gross = taxable
  }
  const split = splitTaxAmount(tax, interState)
  return { grossPaise: gross, discountPaise: gross - taxable, taxablePaise: taxable, taxPaise: tax, ...split, totalPaise: taxable + tax }
}

/** Charges (freight etc.) are always entered exclusive of GST. */
export function computeTaxCharge(charge: TaxChargeInput, interState: boolean): TaxLineResult {
  assertInt(charge.amountPaise, 'Charge')
  assertInt(charge.taxRateBps, 'Charge GST rate')
  const tax = percentOf(charge.amountPaise, charge.taxRateBps)
  return { grossPaise: charge.amountPaise, discountPaise: 0, taxablePaise: charge.amountPaise, taxPaise: tax, ...splitTaxAmount(tax, interState), totalPaise: charge.amountPaise + tax }
}

export function roundToRupee(paise: number): number {
  return mulDivRound(paise, 1, 100) * 100
}

export function computeTaxDocument(input: TaxDocumentInput): TaxDocumentResult {
  const lines = input.lines.map((l) => computeTaxLine(l, input.pricingMode, input.interState))
  const charges = (input.charges ?? []).filter((c) => c.amountPaise > 0).map((c) => computeTaxCharge(c, input.interState))
  const sum = (arr: TaxLineResult[], k: keyof TaxLineResult) => arr.reduce((s, x) => s + x[k], 0)
  const all = [...lines, ...charges]
  const taxable = sum(all, 'taxablePaise')
  const cgst = sum(all, 'cgst')
  const sgst = sum(all, 'sgst')
  const igst = sum(all, 'igst')
  const exact = taxable + cgst + sgst + igst
  const grand = roundToRupee(exact)
  return {
    lines,
    charges,
    totals: {
      subtotalPaise: sum(lines, 'grossPaise'),
      discountPaise: sum(lines, 'discountPaise'),
      chargesPaise: sum(charges, 'taxablePaise'),
      taxablePaise: taxable,
      cgst,
      sgst,
      igst,
      taxPaise: cgst + sgst + igst,
      roundOffPaise: grand - exact,
      grandTotalPaise: grand
    }
  }
}

/** Split an amount across weights proportionally; remainders go to the largest weights so the parts sum exactly. */
export function allocateProportionally(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (amount === 0 || total === 0) return weights.map(() => 0)
  const parts = weights.map((w) => Math.floor((amount * w) / total))
  let rest = amount - parts.reduce((s, p) => s + p, 0)
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k][1]] += 1
  return parts
}

/** First-in-first-out allocation of a payment across open invoices (oldest first). */
export function allocateFifo(amountPaise: number, open: Array<{ invoiceId: number; balancePaise: number }>): Array<{ invoiceId: number; amountPaise: number }> {
  let left = amountPaise
  const out: Array<{ invoiceId: number; amountPaise: number }> = []
  for (const inv of open) {
    if (left <= 0) break
    const take = Math.min(left, inv.balancePaise)
    if (take > 0) out.push({ invoiceId: inv.invoiceId, amountPaise: take })
    left -= take
  }
  return out
}
