/** Amount in words using the Indian numbering system (thousand, lakh, crore). */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ')
}

/** Whole number to words, Indian grouping. 0 → "Zero". */
export function numberToWordsIndian(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Expected a non-negative whole number')
  if (value === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(value / 1e7)
  let rest = value % 1e7
  if (crore) parts.push(`${numberToWordsIndian(crore)} Crore`)
  const lakh = Math.floor(rest / 1e5)
  rest %= 1e5
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  const thousand = Math.floor(rest / 1000)
  rest %= 1000
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (rest) parts.push(threeDigits(rest))
  return parts.join(' ')
}

/** e.g. 12345678 paise → "Indian Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only" */
export function amountInWordsINR(paise: number): string {
  const negative = paise < 0
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / 100)
  const p = abs % 100
  const words = `Indian Rupees ${numberToWordsIndian(rupees)}${p ? ` and ${twoDigits(p)} Paise` : ''} Only`
  return negative ? `Minus ${words}` : words
}
