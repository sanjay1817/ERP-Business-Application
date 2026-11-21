/**
 * Decimal-safe money & quantity arithmetic.
 *
 * - Money is stored as INTEGER paise (1 INR = 100 paise).
 * - Quantities are stored as INTEGER milli-units (1 unit = 1000 milli).
 * - Tax rates are stored as INTEGER basis points (18% = 1800 bps).
 *
 * All arithmetic is done on integers; values never pass through binary floating
 * point fractions when parsed from user input.
 */

export const PAISE_PER_RUPEE = 100
export const MILLI_PER_UNIT = 1000
export const BPS_PER_UNIT = 10000

/** Round half away from zero for an exact rational numerator/denominator. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Division by zero')
  const sign = Math.sign(numerator) * Math.sign(denominator)
  const n = Math.abs(numerator)
  const d = Math.abs(denominator)
  const q = Math.floor(n / d)
  const r = n - q * d
  const rounded = r * 2 >= d ? q + 1 : q
  return sign * rounded
}

function assertSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is out of safe range`)
  return value
}

/** Parse a decimal string/number into an integer scaled by 10^scale without float error. */
export function parseScaled(input: string | number, scale: number): number {
  const raw = typeof input === 'number' ? numberToPlainString(input) : input.trim().replace(/,/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Invalid number: "${input}"`)
  const negative = raw.startsWith('-')
  const [intPart, fracPart = ''] = raw.replace('-', '').split('.')
  const factor = 10 ** scale
  const frac = fracPart.padEnd(scale + 1, '0')
  let value = Number(intPart) * factor + Number(frac.slice(0, scale) || '0')
  if (Number(frac[scale]) >= 5) value += 1 // round half up on the first dropped digit
  return assertSafe(negative ? -value : value, 'Number')
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error('Invalid number')
  // toFixed(6) avoids exponent notation for typical business values.
  return n.toFixed(6)
}

export const toPaise = (rupees: string | number): number => parseScaled(rupees, 2)
export const toMilli = (qty: string | number): number => parseScaled(qty, 3)
export const toBps = (percent: string | number): number => parseScaled(percent, 2)

/** Amount (paise) for qty (milli) × rate (paise per unit). */
export function lineAmount(qtyMilli: number, ratePaise: number): number {
  return assertSafe(divRound(qtyMilli * ratePaise, MILLI_PER_UNIT), 'Line amount')
}

/** Percentage (bps) of an amount in paise. */
export function percentOf(amountPaise: number, bps: number): number {
  return divRound(amountPaise * bps, BPS_PER_UNIT)
}

export function paiseToRupeesString(paise: number): string {
  const negative = paise < 0
  const abs = Math.abs(paise)
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return negative ? `-${s}` : s
}

export function milliToString(milli: number): string {
  const negative = milli < 0
  const abs = Math.abs(milli)
  const whole = Math.floor(abs / 1000)
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/** Display only — formats paise as ₹ with Indian digit grouping. */
export function formatINR(paise: number): string {
  // `+ 0` turns -0 (e.g. a negated zero balance) into 0, so nothing prints as "-₹0.00".
  return inrFormatter.format(paise / 100 + 0)
}

/** Compact display: ₹12.4 L, ₹1.2 Cr. */
export function formatINRCompact(paise: number): string {
  const rupees = paise / 100
  const abs = Math.abs(rupees)
  if (abs >= 1e7) return `₹${(rupees / 1e7).toFixed(2)} Cr`
  if (abs >= 1e5) return `₹${(rupees / 1e5).toFixed(2)} L`
  if (abs >= 1e3) return `₹${(rupees / 1e3).toFixed(1)} K`
  return formatINR(paise)
}

export interface TaxSplit {
  cgst: number
  sgst: number
  igst: number
}

/** Split GST on a taxable value: intra-state → CGST+SGST (halves), inter-state → IGST. */
export function splitGst(taxablePaise: number, rateBps: number, interState: boolean): TaxSplit {
  const tax = percentOf(taxablePaise, rateBps)
  if (interState) return { cgst: 0, sgst: 0, igst: tax }
  const cgst = divRound(tax, 2)
  return { cgst, sgst: tax - cgst, igst: 0 }
}

export interface LineInput {
  qtyMilli: number
  ratePaise: number
  discountPaise: number
  taxRateBps: number
}

export interface LineComputed extends TaxSplit {
  grossPaise: number
  taxablePaise: number
  totalPaise: number
}

export function computeLine(line: LineInput, interState: boolean): LineComputed {
  const grossPaise = lineAmount(line.qtyMilli, line.ratePaise)
  if (line.discountPaise < 0 || line.discountPaise > grossPaise) {
    throw new Error('Discount must be between zero and the line amount')
  }
  const taxablePaise = grossPaise - line.discountPaise
  const split = splitGst(taxablePaise, line.taxRateBps, interState)
  return { grossPaise, taxablePaise, ...split, totalPaise: taxablePaise + split.cgst + split.sgst + split.igst }
}

export interface DocumentTotals extends TaxSplit {
  taxablePaise: number
  discountPaise: number
  roundOffPaise: number
  grandTotalPaise: number
}

/** Sum computed lines and round the grand total to the nearest rupee. */
export function computeTotals(lines: Array<LineComputed & { discountPaise: number }>): DocumentTotals {
  const t = lines.reduce(
    (acc, l) => ({
      taxablePaise: acc.taxablePaise + l.taxablePaise,
      discountPaise: acc.discountPaise + l.discountPaise,
      cgst: acc.cgst + l.cgst,
      sgst: acc.sgst + l.sgst,
      igst: acc.igst + l.igst
    }),
    { taxablePaise: 0, discountPaise: 0, cgst: 0, sgst: 0, igst: 0 }
  )
  const exact = t.taxablePaise + t.cgst + t.sgst + t.igst
  const rounded = divRound(exact, 100) * 100
  return { ...t, roundOffPaise: rounded - exact, grandTotalPaise: rounded }
}
