/** Indian GST reference data and validators. */

export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '96', name: 'Foreign Country' },
  { code: '97', name: 'Other Territory' }
]

export const STATE_CODES = GST_STATES.map((s) => s.code)

export function stateName(code: string | null | undefined): string {
  return GST_STATES.find((s) => s.code === code)?.name ?? ''
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/
export const HSN_SAC_PATTERN = /^[0-9]{4,8}$/
export const PINCODE_PATTERN = /^[1-9][0-9]{5}$/
export const VEHICLE_PATTERN = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$|^TM[A-Z0-9]{6,}$/

/** GSTIN check digit (mod-36 Luhn variant used by GSTN). */
export function gstinCheckDigit(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i])
    if (value < 0) throw new Error('Invalid GSTIN character')
    const product = value * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]
}

export function isValidGstin(gstin: string): boolean {
  if (!GSTIN_PATTERN.test(gstin)) return false
  if (!STATE_CODES.includes(gstin.slice(0, 2))) return false
  return gstinCheckDigit(gstin.slice(0, 14)) === gstin[14]
}

/** Build a checksum-valid GSTIN from state code + PAN + entity number (used by demo data). */
export function buildGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`
  return first14 + gstinCheckDigit(first14)
}

/** Indian financial year label (April–March), e.g. "2026-27". */
export function financialYearOf(isoDate: string, startMonth = 4): string {
  const [y, m] = isoDate.split('-').map(Number)
  const startYear = m >= startMonth ? y : y - 1
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
}

export function financialYearRange(fy: string, startMonth = 4): { from: string; to: string } {
  const startYear = Number(fy.slice(0, 4))
  const mm = String(startMonth).padStart(2, '0')
  const from = `${startYear}-${mm}-01`
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0))
  return { from, to: end.toISOString().slice(0, 10) }
}
