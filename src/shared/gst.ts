/**
 * Phase 4 — GST, e-invoice and e-way bill: input schemas, DTOs and the pure
 * classification / eligibility rules (shared by main and renderer, unit-tested).
 *
 * Nothing here files a return or talks to a government system. Thresholds and
 * limits are never hard-coded: they come from effective-dated compliance rules.
 */
import { z } from 'zod'
import { GSTIN_PATTERN, HSN_SAC_PATTERN, PINCODE_PATTERN, STATE_CODES, VEHICLE_PATTERN, isValidGstin } from './india'

// ───────── Reference values ─────────
export const TAX_CATEGORIES = ['TAXABLE', 'NIL_RATED', 'EXEMPT', 'NON_GST', 'ZERO_RATED'] as const
export type TaxCategory = (typeof TAX_CATEGORIES)[number]
export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = { TAXABLE: 'Taxable', NIL_RATED: 'Nil rated', EXEMPT: 'Exempt', NON_GST: 'Non-GST', ZERO_RATED: 'Zero rated' }

export const REGISTRATION_TYPES = ['REGULAR', 'COMPOSITION', 'SEZ_UNIT', 'SEZ_DEVELOPER', 'CASUAL', 'ISD'] as const
export const OUTWARD_CLASSES = ['B2B', 'B2CL', 'B2CS', 'EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP'] as const
export type OutwardClass = (typeof OUTWARD_CLASSES)[number]
export const OUTWARD_CLASS_LABELS: Record<OutwardClass, string> = {
  B2B: 'B2B (registered)', B2CL: 'B2C Large (inter-state)', B2CS: 'B2C Small', EXPWP: 'Export with IGST', EXPWOP: 'Export under LUT/bond', SEZWP: 'SEZ with IGST', SEZWOP: 'SEZ without IGST'
}
export const NOTE_CLASSES = ['CDNR', 'CDNUR', 'B2CS_ADJ'] as const
export type NoteClass = (typeof NOTE_CLASSES)[number]

export const ITC_ELIGIBILITY = ['PENDING', 'ELIGIBLE', 'INELIGIBLE', 'BLOCKED'] as const
export type ItcEligibility = (typeof ITC_ELIGIBILITY)[number] | 'NOT_AVAILABLE'
export const ITC_LABELS: Record<ItcEligibility, string> = {
  PENDING: 'Pending review', ELIGIBLE: 'Eligible', INELIGIBLE: 'Ineligible', BLOCKED: 'Blocked (s.17(5))', NOT_AVAILABLE: 'No ITC (unregistered supplier)'
}
export const ITC_TYPES = ['INPUTS', 'CAPITAL_GOODS', 'INPUT_SERVICES'] as const

export const RULE_KEYS = [
  'B2CL_INVOICE_THRESHOLD_PAISE', 'EINVOICE_AATO_THRESHOLD_PAISE', 'EINVOICE_REPORTING_LIMIT_DAYS', 'EINVOICE_REPORTING_LIMIT_AATO_PAISE', 'IRN_CANCEL_WINDOW_HOURS',
  'EWB_CONSIGNMENT_THRESHOLD_PAISE', 'EWB_KM_PER_DAY_REGULAR', 'EWB_KM_PER_DAY_ODC', 'EWB_CANCEL_WINDOW_HOURS', 'EWB_EXTENSION_WINDOW_HOURS', 'EWB_MAX_DISTANCE_KM',
  'HSN_MIN_DIGITS_SMALL', 'HSN_MIN_DIGITS_LARGE', 'HSN_LARGE_AATO_PAISE', 'GST_RECON_TOLERANCE_PAISE'
] as const
export type RuleKey = (typeof RULE_KEYS)[number]
/** Values of every rule effective on one date. */
export type RuleSet = Record<RuleKey, number>
export const RULE_UNITS: Record<RuleKey, 'paise' | 'days' | 'hours' | 'km' | 'digits'> = {
  B2CL_INVOICE_THRESHOLD_PAISE: 'paise', EINVOICE_AATO_THRESHOLD_PAISE: 'paise', EINVOICE_REPORTING_LIMIT_DAYS: 'days', EINVOICE_REPORTING_LIMIT_AATO_PAISE: 'paise',
  IRN_CANCEL_WINDOW_HOURS: 'hours', EWB_CONSIGNMENT_THRESHOLD_PAISE: 'paise', EWB_KM_PER_DAY_REGULAR: 'km', EWB_KM_PER_DAY_ODC: 'km', EWB_CANCEL_WINDOW_HOURS: 'hours',
  EWB_EXTENSION_WINDOW_HOURS: 'hours', EWB_MAX_DISTANCE_KM: 'km', HSN_MIN_DIGITS_SMALL: 'digits', HSN_MIN_DIGITS_LARGE: 'digits', HSN_LARGE_AATO_PAISE: 'paise',
  GST_RECON_TOLERANCE_PAISE: 'paise'
}

export const INTEGRATION_SERVICES = ['EINVOICE', 'EWAYBILL', 'GST_RETURNS'] as const
export type IntegrationService = (typeof INTEGRATION_SERVICES)[number]
export const INTEGRATION_MODES = ['DEMO', 'SANDBOX', 'LIVE'] as const
export type IntegrationMode = (typeof INTEGRATION_MODES)[number]
export const ERROR_CLASSES = ['VALIDATION', 'AUTH', 'DUPLICATE', 'NOT_FOUND', 'BUSINESS', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'PROVIDER', 'NOT_CONFIGURED', 'UNKNOWN'] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]
export const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'PROVIDER'])

export const IRN_CANCEL_REASONS = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Others' } as const
export const EWB_EXTEND_REASONS = { 1: 'Natural calamity', 2: 'Law and order situation', 3: 'Transshipment', 4: 'Accident', 99: 'Others' } as const

// ───────── Pure rules ─────────

/** Party registration types as stored on customers/suppliers. */
export type PartyRegType = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED' | 'CONSUMER' | 'SEZ' | 'OVERSEAS'

export interface OutwardInput {
  partyRegType: PartyRegType | string
  partyGstin: string | null
  interState: boolean
  /** Invoice value (grand total) used for the B2C Large test. */
  invoiceValuePaise: number
  igstPaise: number
  b2clThresholdPaise: number
}

/** GSTR-1 section of an outward invoice. */
export function classifyOutward(i: OutwardInput): OutwardClass {
  if (i.partyRegType === 'OVERSEAS') return i.igstPaise > 0 ? 'EXPWP' : 'EXPWOP'
  if (i.partyRegType === 'SEZ') return i.igstPaise > 0 ? 'SEZWP' : 'SEZWOP'
  if (i.partyGstin) return 'B2B'
  return i.interState && i.invoiceValuePaise > i.b2clThresholdPaise ? 'B2CL' : 'B2CS'
}

/** Credit notes: registered (incl. SEZ) → CDNR; exports and B2C Large → CDNUR; other B2C → adjust B2CS. */
export function classifyNote(originalClass: OutwardClass | null, i: Omit<OutwardInput, 'igstPaise'>): NoteClass {
  if (i.partyGstin || i.partyRegType === 'SEZ') return 'CDNR'
  if (i.partyRegType === 'OVERSEAS') return 'CDNUR'
  if (originalClass === 'B2CL' || (i.interState && i.invoiceValuePaise > i.b2clThresholdPaise)) return 'CDNUR'
  return 'B2CS_ADJ'
}

export const isZeroRatedClass = (c: OutwardClass): boolean => c.startsWith('EXP') || c.startsWith('SEZ')

/** Minimum HSN digits for the company's turnover, from the effective rules. */
export function minHsnDigits(rules: RuleSet, aatoPaise: number | null): number {
  return aatoPaise != null && aatoPaise > rules.HSN_LARGE_AATO_PAISE ? rules.HSN_MIN_DIGITS_LARGE : rules.HSN_MIN_DIGITS_SMALL
}

/** GST invoice-number rule: up to 16 characters; letters, digits, '/' and '-'. */
export const DOC_NO_PATTERN = /^[A-Za-z0-9/-]{1,16}$/
export function invalidDocumentNumber(no: string): string | null {
  if (!DOC_NO_PATTERN.test(no)) return 'Use at most 16 characters: letters, digits, "/" or "-"'
  if (/^[0/-]/.test(no)) return 'Must not start with 0, "/" or "-"'
  return null
}

export interface EInvoiceEligibilityInput {
  companyGstin: string | null
  einvoiceEnabled: boolean
  exemptReason: string | null
  aatoPaise: number | null
  documentKind: string
  documentStatus: string
  documentDate: string
  partyRegType: string | null
  partyGstin: string | null
  /** Has an original invoice reference (credit notes). */
  hasOriginalReference: boolean
  today: string
  rules: RuleSet
}

export interface EInvoiceEligibility {
  applicable: boolean
  documentType: 'INV' | 'CRN' | 'DBN' | null
  supplyType: string | null
  blockers: string[]
  notes: string[]
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)

/** Whether a document needs (and can get) an IRN. Never assumes applicability the user has not confirmed. */
export function eInvoiceEligibility(i: EInvoiceEligibilityInput): EInvoiceEligibility {
  const blockers: string[] = []
  const notes: string[] = []
  const documentType = i.documentKind === 'SALES_INVOICE' ? 'INV' : i.documentKind === 'CREDIT_NOTE' || i.documentKind === 'SALES_RETURN' ? 'CRN' : null
  if (!documentType) blockers.push('Only sales invoices and credit notes can be e-invoiced')
  if (!i.companyGstin) blockers.push('The company has no GSTIN')
  if (i.exemptReason) blockers.push(`E-invoicing is marked as not applicable: ${i.exemptReason}`)
  else if (!i.einvoiceEnabled) {
    if (i.aatoPaise != null && i.aatoPaise >= i.rules.EINVOICE_AATO_THRESHOLD_PAISE)
      blockers.push('Aggregate turnover is at or above the e-invoicing threshold, but e-invoicing is not enabled. Confirm applicability and enable it in GST → Configuration.')
    else blockers.push('E-invoicing is not enabled for this company (GST → Configuration)')
  }
  if (i.documentStatus !== 'POSTED') blockers.push(`Document is ${i.documentStatus.toLowerCase()}; only posted documents can be registered`)
  let supplyType: string | null = null
  if (i.partyRegType === 'OVERSEAS') supplyType = 'EXP'
  else if (i.partyRegType === 'SEZ') supplyType = 'SEZ'
  else if (i.partyGstin) supplyType = 'B2B'
  else blockers.push('Buyer is unregistered (B2C). IRN applies to B2B, SEZ and export documents only')
  if (documentType === 'CRN' && !i.hasOriginalReference) blockers.push('Credit note has no original invoice reference')
  const age = daysBetween(i.documentDate, i.today)
  if (i.aatoPaise != null && i.aatoPaise >= i.rules.EINVOICE_REPORTING_LIMIT_AATO_PAISE && age > i.rules.EINVOICE_REPORTING_LIMIT_DAYS)
    blockers.push(`Document is ${age} days old; the IRP reporting limit for this turnover is ${i.rules.EINVOICE_REPORTING_LIMIT_DAYS} days`)
  if (i.aatoPaise == null) notes.push('Aggregate turnover is not recorded; reporting time limits could not be checked')
  return { applicable: blockers.length === 0, documentType, supplyType, blockers, notes }
}

export interface EwbApplicabilityInput {
  goodsValuePaise: number
  /** Value of goods including tax, excluding exempt goods. */
  consignmentValuePaise: number
  hasGoods: boolean
  rules: RuleSet
}
export type EwbRequirement = 'REQUIRED' | 'NOT_REQUIRED' | 'NOT_APPLICABLE'
/** Indicative only: states may notify different limits and there are commodity/transport exemptions. */
export function ewbRequirement(i: EwbApplicabilityInput): { requirement: EwbRequirement; reason: string } {
  if (!i.hasGoods) return { requirement: 'NOT_APPLICABLE', reason: 'No movement of goods (services only)' }
  if (i.consignmentValuePaise > i.rules.EWB_CONSIGNMENT_THRESHOLD_PAISE)
    return { requirement: 'REQUIRED', reason: `Consignment value exceeds the configured limit` }
  return { requirement: 'NOT_REQUIRED', reason: 'Consignment value is within the configured limit (an e-way bill may still be generated voluntarily; check state rules)' }
}

const IST_MS = 330 * 60000
/** Validity end: N days by distance, each day ending at midnight IST of the following day (Rule 138(10) method). */
export function ewbValidUntil(fromIso: string, distanceKm: number, kmPerDay: number): string {
  const days = Math.max(1, Math.ceil(distanceKm / kmPerDay))
  const ist = new Date(Date.parse(fromIso) + IST_MS)
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 59)
  return new Date(end - IST_MS).toISOString()
}

/** Whether `now` is within the extension window around `validUpto`. */
export function canExtendAt(validUpto: string, now: Date, windowHours: number): boolean {
  const diff = now.getTime() - Date.parse(validUpto)
  return Math.abs(diff) <= windowHours * 3600000
}

// ───────── Input schemas ─────────
const id = z.number().int().positive()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'Use a valid date')
const optText = (max: number) => z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null)), z.string().max(max, `Must be at most ${max} characters`).nullable())
const stateCode = z.enum(STATE_CODES as [string, ...string[]], { error: 'Select a valid state' })
const gstin = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(GSTIN_PATTERN, 'GSTIN format is invalid').refine(isValidGstin, 'GSTIN check digit or state code is invalid'))
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month as YYYY-MM')
const requestKey = z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'Invalid request key')
const paise = z.number().int().min(0).max(1e13)

export const GstPeriodInput = z
  .object({
    from: isoDate, to: isoDate,
    gstin: z.string().max(15).optional(),
    status: z.enum(['POSTED', 'CANCELLED', 'ALL']).default('POSTED'),
    category: z.string().max(20).optional()
  })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'End date must be on or after the start date' })
export type GstPeriodInputT = z.input<typeof GstPeriodInput>
export const ReturnPeriodInput = z.object({ period, gstin: z.string().max(15).optional() }).strict()
export type ReturnPeriodInputT = z.infer<typeof ReturnPeriodInput>

export const RegistrationSaveInput = z
  .object({
    id: id.optional(),
    gstin,
    registrationType: z.enum(REGISTRATION_TYPES),
    stateCode,
    branchId: id.nullable().optional(),
    legalName: optText(150),
    tradeName: optText(150),
    address: optText(300),
    pincode: optText(6).refine((v) => v === null || PINCODE_PATTERN.test(v), 'PIN code must be 6 digits'),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    isPrimary: z.boolean(),
    isActive: z.boolean().default(true)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.gstin.slice(0, 2) !== v.stateCode) ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'State must match the state code in the GSTIN' })
    if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'Must be on or after the effective-from date' })
  })
export type RegistrationSaveInputT = z.input<typeof RegistrationSaveInput>

export const GstSettingsInput = z
  .object({
    aatoPaise: paise.nullable(),
    aatoFy: z.string().regex(/^\d{4}-\d{2}$/, 'Use a financial year like 2025-26').nullable(),
    einvoiceEnabled: z.boolean(),
    einvoiceExemptReason: optText(200),
    returnFrequency: z.enum(['MONTHLY', 'QUARTERLY']),
    lutNumber: optText(30),
    lutValidFrom: isoDate.nullable(),
    lutValidUpto: isoDate.nullable()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.lutValidFrom && v.lutValidUpto && v.lutValidUpto < v.lutValidFrom) ctx.addIssue({ code: 'custom', path: ['lutValidUpto'], message: 'Must be after the start date' })
    if (v.einvoiceEnabled && v.einvoiceExemptReason) ctx.addIssue({ code: 'custom', path: ['einvoiceExemptReason'], message: 'Clear the exemption reason to enable e-invoicing' })
  })
export type GstSettingsInputT = z.input<typeof GstSettingsInput>

export const RuleSaveInput = z
  .object({ id: id.optional(), ruleKey: z.enum(RULE_KEYS), valueNum: z.number().int().min(0).max(1e13), effectiveFrom: isoDate, effectiveTo: isoDate.nullable().optional(), sourceNote: optText(200) })
  .strict()
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'Must be on or after the effective-from date' })

export const HsnSaveInput = z
  .object({
    id: id.optional(),
    code: z.string().trim().regex(HSN_SAC_PATTERN, 'HSN/SAC must be 4 to 8 digits'),
    description: z.string().trim().min(2, 'Description is required').max(200),
    kind: z.enum(['GOODS', 'SERVICE']),
    defaultUqc: optText(10),
    isActive: z.boolean().default(true)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'SERVICE' && !v.code.startsWith('99')) ctx.addIssue({ code: 'custom', path: ['code'], message: 'SAC codes for services start with 99' })
    if (v.kind === 'GOODS' && v.code.startsWith('99')) ctx.addIssue({ code: 'custom', path: ['code'], message: 'Codes starting with 99 are SAC (services)' })
  })

export const HsnRateSaveInput = z
  .object({
    id: id.optional(),
    hsnCode: z.string().trim().regex(HSN_SAC_PATTERN, 'HSN/SAC must be 4 to 8 digits'),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    taxCategory: z.enum(TAX_CATEGORIES),
    rateBps: z.number().int().min(0).max(10000),
    cessBps: z.number().int().min(0).max(100000).default(0),
    reverseCharge: z.boolean().default(false),
    notes: optText(300)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'Must be on or after the effective-from date' })
    if (v.taxCategory !== 'TAXABLE' && v.rateBps !== 0) ctx.addIssue({ code: 'custom', path: ['rateBps'], message: 'Nil-rated, exempt, non-GST and zero-rated supplies carry a 0% rate' })
  })
export const TaxRateDatesInput = z
  .object({ id, effectiveFrom: isoDate.nullable(), effectiveTo: isoDate.nullable() })
  .strict()
  .refine((v) => !v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { path: ['effectiveTo'], message: 'Must be after the start date' })

export const PURCHASE_GST_KINDS = ['PURCHASE_INVOICE', 'PURCHASE_RETURN', 'DEBIT_NOTE'] as const
export const ItcClassifyInput = z
  .object({
    documents: z.array(z.object({ kind: z.enum(PURCHASE_GST_KINDS), id }).strict()).min(1).max(500),
    eligibility: z.enum(ITC_ELIGIBILITY),
    itcType: z.enum(ITC_TYPES),
    reverseCharge: z.boolean(),
    reason: optText(200)
  })
  .strict()
  .refine((v) => v.eligibility === 'ELIGIBLE' || v.eligibility === 'PENDING' || !!v.reason, { path: ['reason'], message: 'Give a reason for ineligible or blocked credit' })

export const ReturnPrepareInput = z.object({ returnType: z.enum(['GSTR1', 'GSTR3B']), period, gstin: z.string().max(15).optional() }).strict()
export const ReturnExportInput = z.object({ id, format: z.enum(['XLSX', 'JSON']) }).strict()
export const ReturnListInput = z.object({ returnType: z.enum(['GSTR1', 'GSTR3B']).optional() }).strict().optional()

export const ReconImportInput = z
  .object({
    label: z.string().trim().min(2).max(80),
    source: z.enum(['SUPPLIER_STATEMENT', 'GSTR2B_CSV', 'OTHER']),
    periodFrom: isoDate,
    periodTo: isoDate,
    csv: z.string().min(1, 'Paste the CSV contents').max(2_000_000)
  })
  .strict()
  .refine((v) => v.periodFrom <= v.periodTo, { path: ['periodTo'], message: 'End date must be on or after the start date' })
export const ReconReviewInput = z
  .object({ lineIds: z.array(id).min(1).max(1000), reviewStatus: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'ON_HOLD']), note: optText(300) })
  .strict()

export const IntegrationSaveInput = z
  .object({
    service: z.enum(INTEGRATION_SERVICES),
    mode: z.enum(INTEGRATION_MODES),
    providerName: optText(80),
    apiBaseUrl: optText(300).refine((v) => v === null || /^https:\/\/[^\s]+$/.test(v), 'Must be an https:// URL from your authorised provider'),
    timeoutMs: z.number().int().min(1000).max(120000),
    maxRetries: z.number().int().min(0).max(5)
  })
  .strict()
  .refine((v) => v.mode === 'DEMO' || (!!v.providerName && !!v.apiBaseUrl), { path: ['apiBaseUrl'], message: 'Sandbox/live mode needs the provider name and the API base URL from your authorised provider' })
export const CredentialSaveInput = z
  .object({
    service: z.enum(INTEGRATION_SERVICES),
    environment: z.enum(['SANDBOX', 'LIVE']),
    username: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(200),
    clientId: z.string().trim().max(200).optional(),
    clientSecret: z.string().max(400).optional()
  })
  .strict()
export const CredentialRef = z.object({ service: z.enum(INTEGRATION_SERVICES), environment: z.enum(['SANDBOX', 'LIVE']) }).strict()
export const ApiLogInput = z.object({ entityType: z.string().max(30).optional(), entityId: id.optional(), service: z.enum(INTEGRATION_SERVICES).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict().optional()

export const EINVOICE_KINDS = ['SALES_INVOICE', 'CREDIT_NOTE', 'SALES_RETURN'] as const
export const EInvoiceDocRef = z.object({ documentKind: z.enum(EINVOICE_KINDS), documentId: id }).strict()
export const EInvoiceGenerateInput = z.object({ documentKind: z.enum(EINVOICE_KINDS), documentId: id, requestKey }).strict()
export const EInvoiceCancelInput = z
  .object({ id, reasonCode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), remarks: z.string().trim().min(3, 'Enter remarks (at least 3 characters)').max(100) })
  .strict()
export const EInvoiceListInput = z.object({ from: isoDate.optional(), to: isoDate.optional(), status: z.enum(['PENDING', 'GENERATED', 'FAILED', 'CANCELLED']).optional() }).strict().optional()

const vehicleNo = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.replace(/[\s-]/g, '').toUpperCase()) : (v ?? null)),
  z.string().regex(VEHICLE_PATTERN, 'Vehicle number format is invalid (e.g. KA01AB1234)').nullable()
)
export const TRANSIN_PATTERN = /^[0-9]{2}[0-9A-Z]{13}$/
const transporterId = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(TRANSIN_PATTERN, 'Transporter ID must be a 15-character GSTIN or TRANSIN'))

export const TransporterSaveInput = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(2, 'Name is required').max(120),
    transporterId,
    phone: optText(20).refine((v) => v === null || /^[0-9+\-\s]{7,20}$/.test(v), 'Phone number is invalid'),
    contactPerson: optText(100),
    address: optText(300),
    stateCode: stateCode.nullable().optional(),
    email: optText(120).refine((v) => v === null || z.email().safeParse(v).success, 'Email address is invalid'),
    modes: z.array(z.enum(['ROAD', 'RAIL', 'AIR', 'SHIP'])).min(1, 'Select at least one mode'),
    isActive: z.boolean().default(true)
  })
  .strict()
  .superRefine((v, ctx) => {
    // A GSTIN-format ID must carry a valid check digit; other 15-character IDs are treated as TRANSIN.
    if (GSTIN_PATTERN.test(v.transporterId) && !isValidGstin(v.transporterId)) ctx.addIssue({ code: 'custom', path: ['transporterId'], message: 'GSTIN check digit or state code is invalid' })
  })
export const VEHICLE_BODY_TYPES = ['TRUCK', 'TEMPO', 'VAN', 'CONTAINER', 'TRAILER', 'PICKUP', 'OTHER'] as const
export const VehicleSaveInput = z
  .object({
    id: id.optional(),
    vehicleNo: vehicleNo.refine((v) => v !== null, 'Vehicle number is required'),
    vehicleType: z.enum(['REGULAR', 'ODC']),
    bodyType: z.enum(VEHICLE_BODY_TYPES),
    transporterId: id.nullable().optional(),
    capacityKg: z.number().int().positive().max(1_000_000).nullable().optional(),
    isOwn: z.boolean(),
    isActive: z.boolean().default(true)
  })
  .strict()
export const TransportDocSaveInput = z
  .object({
    id: id.optional(),
    transportMode: z.enum(['ROAD', 'RAIL', 'AIR', 'SHIP']),
    docNo: z.string().trim().min(1, 'Document number is required').max(15, 'At most 15 characters'),
    docDate: isoDate,
    transporterId: id.nullable().optional(),
    vehicleId: id.nullable().optional(),
    sourceKind: z.enum(['SALES_INVOICE', 'DELIVERY_CHALLAN']).nullable().optional(),
    sourceId: id.nullable().optional(),
    fromPlace: optText(80),
    toPlace: optText(80),
    distanceKm: z.number().int().min(1).max(4000).nullable().optional(),
    notes: optText(300)
  })
  .strict()
  .refine((v) => (v.sourceKind == null) === (v.sourceId == null), { path: ['sourceId'], message: 'Select the source document' })
export const TransportDocListInput = z.object({ sourceKind: z.enum(['SALES_INVOICE', 'DELIVERY_CHALLAN']).optional(), sourceId: id.optional() }).strict().optional()

export const EWB_SOURCE_KINDS = ['SALES_INVOICE', 'DELIVERY_CHALLAN'] as const
export const EwbSourceRef = z.object({ kind: z.enum(EWB_SOURCE_KINDS), id }).strict()
export const EwbTransporterInput = z.object({ id, transporterId: id }).strict()
export const EwbExtendInput = z
  .object({
    id,
    reasonCode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(99)]),
    remarks: z.string().trim().min(3).max(100),
    currentPlace: z.string().trim().min(2).max(50),
    currentStateCode: stateCode,
    remainingDistanceKm: z.number().int().min(1).max(4000),
    transportMode: z.enum(['ROAD', 'RAIL', 'AIR', 'SHIP']),
    vehicleNo
  })
  .strict()
  .refine((v) => v.transportMode !== 'ROAD' || !!v.vehicleNo, { path: ['vehicleNo'], message: 'Vehicle number is required for road transport' })
export const EwbListInput = z
  .object({ status: z.enum(['ACTIVE', 'PART_A_ONLY', 'CANCELLED', 'EXPIRED']).optional(), from: isoDate.optional(), to: isoDate.optional(), expiringWithinHours: z.number().int().min(1).max(240).optional() })
  .strict()
  .optional()

// ───────── DTOs ─────────
export interface GstRegistration {
  id: number; gstin: string; registrationType: string; stateCode: string; branchId: number | null; branchName: string | null
  legalName: string | null; tradeName: string | null; address: string | null; pincode: string | null
  effectiveFrom: string; effectiveTo: string | null; isPrimary: boolean; isActive: boolean
}
export interface GstSettings {
  aatoPaise: number | null; aatoFy: string | null; einvoiceEnabled: boolean; einvoiceExemptReason: string | null
  returnFrequency: 'MONTHLY' | 'QUARTERLY'; lutNumber: string | null; lutValidFrom: string | null; lutValidUpto: string | null; updatedAt: string | null
}
export interface ComplianceRule {
  id: number; companySpecific: boolean; ruleKey: RuleKey; valueNum: number; unit: string; effectiveFrom: string; effectiveTo: string | null
  description: string; sourceNote: string | null; activeToday: boolean
}
export interface HsnCode { id: number; code: string; description: string; kind: 'GOODS' | 'SERVICE'; defaultUqc: string | null; isActive: boolean; productCount: number; currentRate: HsnRateRule | null }
export interface HsnRateRule {
  id: number; hsnCode: string; effectiveFrom: string; effectiveTo: string | null; taxCategory: TaxCategory; rateBps: number; cessBps: number
  reverseCharge: boolean; notes: string | null; source: 'USER' | 'PRODUCT_MASTER'
}
export interface TaxRateRow { id: number; name: string; rateBps: number; cessBps: number; isActive: boolean; effectiveFrom: string | null; effectiveTo: string | null; productCount: number }
export interface GstConfig {
  company: { name: string; gstin: string | null; stateCode: string; legalName: string | null }
  registrations: GstRegistration[]
  settings: GstSettings
  rules: ComplianceRule[]
  effectiveToday: RuleSet
  taxRates: TaxRateRow[]
  branches: Array<{ id: number; code: string; name: string; gstin: string | null; stateCode: string }>
}

export interface GstDocLine {
  hsn: string; description: string; uqc: string; qtyMilli: number; ratePct: number; taxablePaise: number
  igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; category: TaxCategory; itemType: 'GOODS' | 'SERVICE'
}
export interface GstOutwardDoc {
  kind: 'SALES_INVOICE' | 'CREDIT_NOTE' | 'SALES_RETURN'
  id: number; number: string; date: string; status: string; route: string
  partyId: number; partyName: string; partyGstin: string | null; partyRegType: string; placeOfSupply: string; interState: boolean
  sellerGstin: string | null
  section: OutwardClass | NoteClass
  /** For notes: the original invoice. */
  originalNo: string | null; originalDate: string | null
  invoiceValuePaise: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number
  /** Taxable value of nil/exempt/non-GST lines (reported separately). */
  nilPaise: number; exemptPaise: number; nonGstPaise: number
  sign: 1 | -1
  einvoice: { status: string; irn: string | null; isDemo: boolean } | null
  lines: GstDocLine[]
}
export interface GstInwardDoc {
  kind: 'PURCHASE_INVOICE' | 'PURCHASE_RETURN' | 'DEBIT_NOTE'
  id: number; number: string; date: string; status: string; route: string
  partyId: number; partyName: string; partyGstin: string | null; partyRegType: string
  supplierRef: string | null; supplierRefDate: string | null; placeOfSupply: string; interState: boolean
  originalNo: string | null
  invoiceValuePaise: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number
  nilExemptPaise: number
  sign: 1 | -1
  itc: { eligibility: ItcEligibility; itcType: string; reverseCharge: boolean; reason: string | null; classifiedAt: string | null; stored: boolean }
  rcmSuggested: boolean
  /** RCM tax self-assessed on the taxable value (when the supplier charged none). */
  rcmTaxPaise: number
  lines: GstDocLine[]
}
export interface TaxTotals { count: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; valuePaise: number }
export interface HsnSummaryRow { hsn: string; description: string; uqc: string; qtyMilli: number; ratePct: number; valuePaise: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; kind: 'GOODS' | 'SERVICE' }
export interface RateSummaryRow { ratePct: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
export interface GstSalesRegister {
  from: string; to: string; gstin: string | null
  docs: GstOutwardDoc[]
  bySection: Record<string, TaxTotals>
  hsn: HsnSummaryRow[]
  rates: RateSummaryRow[]
  totals: TaxTotals
  /** Output GST per the ledger accounts for the same period (posted journals), for reconciliation. */
  ledger: { igstPaise: number; cgstPaise: number; sgstPaise: number; agrees: boolean }
}
export interface GstPurchaseRegister {
  from: string; to: string; gstin: string | null
  docs: GstInwardDoc[]
  byEligibility: Record<string, TaxTotals>
  hsn: HsnSummaryRow[]
  rates: RateSummaryRow[]
  totals: TaxTotals
  rcm: TaxTotals
  ledger: { igstPaise: number; cgstPaise: number; sgstPaise: number; agrees: boolean }
}

export const ISSUE_CATEGORIES = ['MISSING_GSTIN', 'INVALID_REFERENCE', 'MISSING_HSN', 'CLASSIFICATION', 'DUPLICATE_REFERENCE', 'TAX_DIFFERENCE', 'MISSING_INFO', 'ITC_REVIEW'] as const
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]
export const ISSUE_LABELS: Record<IssueCategory, string> = {
  MISSING_GSTIN: 'Missing / invalid GSTIN', INVALID_REFERENCE: 'Invalid document reference', MISSING_HSN: 'Missing / short HSN', CLASSIFICATION: 'Tax classification',
  DUPLICATE_REFERENCE: 'Duplicate document reference', TAX_DIFFERENCE: 'Tax calculation difference', MISSING_INFO: 'Missing mandatory information', ITC_REVIEW: 'ITC needs review'
}
export interface GstIssue {
  category: IssueCategory; severity: 'ERROR' | 'WARNING'; kind: string; id: number; number: string; date: string; partyName: string | null; message: string; route: string
}
export interface GstValidationReport { from: string; to: string; issues: GstIssue[]; errors: number; warnings: number; checkedDocuments: number; byCategory: Record<string, number> }

export interface Gstr1Section { key: string; label: string; count: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; valuePaise: number }
export interface Gstr1Data {
  returnType: 'GSTR1'; period: string; gstin: string; from: string; to: string
  sections: Gstr1Section[]
  b2b: Array<{ gstin: string; name: string; number: string; date: string; valuePaise: number; pos: string; reverseCharge: boolean; type: string; ratePct: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }>
  b2cl: Array<{ number: string; date: string; valuePaise: number; pos: string; ratePct: number; taxablePaise: number; igstPaise: number; cessPaise: number }>
  b2cs: Array<{ pos: string; supplyType: 'INTER' | 'INTRA'; ratePct: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }>
  exp: Array<{ type: 'WPAY' | 'WOPAY'; number: string; date: string; valuePaise: number; ratePct: number; taxablePaise: number; igstPaise: number }>
  sez: Array<{ gstin: string; name: string; type: 'SEZWP' | 'SEZWOP'; number: string; date: string; valuePaise: number; pos: string; ratePct: number; taxablePaise: number; igstPaise: number }>
  cdnr: Array<{ gstin: string; name: string; noteNo: string; noteDate: string; noteType: 'C' | 'D'; originalNo: string | null; valuePaise: number; pos: string; ratePct: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }>
  cdnur: Array<{ urType: string; noteNo: string; noteDate: string; noteType: 'C' | 'D'; originalNo: string | null; valuePaise: number; pos: string; ratePct: number; taxablePaise: number; igstPaise: number; cessPaise: number }>
  nil: Array<{ description: string; nilPaise: number; exemptPaise: number; nonGstPaise: number }>
  hsn: HsnSummaryRow[]
  docs: Array<{ nature: string; from: string; to: string; total: number; cancelled: number }>
  outwardDebitNotes: 'NOT_SUPPORTED'
}
export interface Gstr3bRow { key: string; label: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }
export interface Gstr3bData {
  returnType: 'GSTR3B'; period: string; gstin: string; from: string; to: string
  outward: Gstr3bRow[]
  interStateUnregistered: Array<{ pos: string; taxablePaise: number; igstPaise: number }>
  interStateComposition: Array<{ pos: string; taxablePaise: number; igstPaise: number }>
  itc: Gstr3bRow[]
  itcPending: { count: number; igstPaise: number; cgstPaise: number; sgstPaise: number }
  inwardExempt: Array<{ label: string; interPaise: number; intraPaise: number }>
  indicativeNet: Array<{ head: 'IGST' | 'CGST' | 'SGST' | 'CESS'; liabilityPaise: number; itcPaise: number; netPaise: number }>
}
export interface ReturnPreparation {
  id: number; returnType: 'GSTR1' | 'GSTR3B'; period: string; gstin: string; status: 'PREPARED' | 'EXPORTED'
  validationErrors: number; validationWarnings: number; preparedAt: string; preparedBy: string | null; exportedAt: string | null; exportFormat: string | null
  /** True when posted transactions for the period changed after this snapshot. */
  stale: boolean
  data: Gstr1Data | Gstr3bData
}
export interface GstOverview {
  period: string; from: string; to: string; gstin: string | null
  outputTaxPaise: number; itcEligiblePaise: number; itcPendingPaise: number; itcPendingCount: number; itcBlockedPaise: number; rcmTaxPaise: number
  indicativeNetPaise: number
  validationErrors: number; validationWarnings: number
  einvoice: { enabled: boolean; eligiblePending: number; generated: number; failed: number }
  ewaybill: { active: number; expiringSoon: number; requiredMissing: number }
  preparations: Array<{ returnType: string; period: string; status: string; preparedAt: string; stale: boolean }>
  months: Array<{ month: string; outputPaise: number; itcPaise: number }>
}

export interface ReconBatch { id: number; label: string; source: string; periodFrom: string; periodTo: string; rowCount: number; createdAt: string; createdBy: string | null; counts: Record<string, number>; pendingReview: number }
export interface ReconLine {
  id: number; rowNo: number; supplierGstin: string | null; supplierName: string | null; invoiceNo: string; invoiceDate: string; documentType: string
  taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number
  matchStatus: string; matched: { kind: string; id: number; number: string; supplierRef: string | null; date: string; taxablePaise: number; taxPaise: number; route: string } | null
  diffTaxablePaise: number; diffTaxPaise: number; matchNote: string | null
  reviewStatus: string; reviewNote: string | null; reviewedAt: string | null
}
export interface ReconBookOnly { kind: string; id: number; number: string; supplierRef: string | null; supplierGstin: string | null; partyName: string; date: string; taxablePaise: number; taxPaise: number; route: string }
export interface ReconDetail { batch: ReconBatch; lines: ReconLine[]; booksOnly: ReconBookOnly[]; disclaimer: string }
export const RECON_STATUS_LABELS: Record<string, string> = {
  MATCHED: 'Matched', VALUE_DIFFERENCE: 'Value difference', GSTIN_MISMATCH: 'GSTIN differs', PROBABLE: 'Probable match', NOT_IN_BOOKS: 'Not in purchase register',
  DUPLICATE_IN_STATEMENT: 'Duplicate in statement', DUPLICATE_IN_BOOKS: 'Duplicate in books', UNMATCHED: 'Unmatched'
}

export interface IntegrationSetting { service: IntegrationService; mode: IntegrationMode; providerName: string | null; apiBaseUrl: string | null; timeoutMs: number; maxRetries: number; updatedAt: string | null; connected: false; status: string }
export interface CredentialStatus { service: IntegrationService; environment: 'SANDBOX' | 'LIVE'; stored: boolean; usernameHint: string | null; updatedAt: string | null }
export interface IntegrationOverview { settings: IntegrationSetting[]; credentials: CredentialStatus[]; secureStorageAvailable: boolean; notice: string }
export interface ApiRequestRow {
  id: number; service: string; provider: string; environment: string; operation: string; entityType: string | null; entityId: number | null; requestKey: string
  attempt: number; outcome: 'SUCCESS' | 'FAILED'; errorClass: string | null; errorCode: string | null; errorMessage: string | null; retryable: boolean
  requestSummary: string | null; responseRef: string | null; durationMs: number; userName: string | null; createdAt: string
}

export interface EInvoiceRow {
  id: number; documentKind: string; documentId: number; documentNo: string; documentDate: string; documentType: string; supplyType: string
  buyerName: string | null; buyerGstin: string | null; totalValuePaise: number; provider: string; environment: string; isDemo: boolean
  status: 'PENDING' | 'GENERATED' | 'FAILED' | 'CANCELLED'; irn: string | null; ackNo: string | null; ackDate: string | null
  errorCode: string | null; errorMessage: string | null; attempts: number; lastAttemptAt: string | null; cancelledAt: string | null; createdAt: string
  route: string
}
export interface EInvoiceDetail extends EInvoiceRow {
  requestKey: string; signedInvoice: string | null; signedQr: string | null; responseRef: string | null
  cancelReasonCode: number | null; cancelRemarks: string | null; cancellable: boolean; cancelDeadline: string | null
  history: Array<{ at: string; event: string; detail: string }>
  apiRequests: ApiRequestRow[]
}
export interface EInvoiceCandidate {
  documentKind: string; documentId: number; documentNo: string; documentDate: string; buyerName: string; buyerGstin: string | null; partyRegType: string
  totalValuePaise: number; route: string; eligibility: EInvoiceEligibility; validation: string[]; einvoice: { id: number; status: string; irn: string | null } | null
}
export interface EInvoiceWorkspace {
  enabled: boolean; mode: IntegrationMode; provider: string; isDemo: boolean
  candidates: EInvoiceCandidate[]
  records: EInvoiceRow[]
  counts: Record<string, number>
}

export interface Transporter { id: number; name: string; transporterId: string; idType: 'GSTIN' | 'TRANSIN'; phone: string | null; contactPerson: string | null; address: string | null; stateCode: string | null; email: string | null; modes: string[]; isActive: boolean; vehicleCount: number; ewbCount: number }
export interface Vehicle { id: number; vehicleNo: string; vehicleType: 'REGULAR' | 'ODC'; bodyType: string; transporterId: number | null; transporterName: string | null; capacityKg: number | null; isOwn: boolean; isActive: boolean; ewbCount: number }
export interface TransportDoc {
  id: number; transportMode: string; docNo: string; docDate: string; transporterId: number | null; transporterName: string | null; vehicleId: number | null; vehicleNo: string | null
  sourceKind: string | null; sourceId: number | null; sourceNo: string | null; sourceRoute: string | null; fromPlace: string | null; toPlace: string | null; distanceKm: number | null; notes: string | null
  ewbNo: string | null; createdAt: string
}
export interface TransportMasters { transporters: Transporter[]; vehicles: Vehicle[]; documents: TransportDoc[]; modes: Array<{ code: string; label: string; partBDocument: string }> }
export interface EwbSourceCandidate {
  kind: 'SALES_INVOICE' | 'DELIVERY_CHALLAN'; id: number; number: string; date: string; partyName: string; partyGstin: string | null; route: string
  goodsValuePaise: number; consignmentValuePaise: number; requirement: EwbRequirement; reason: string; activeEwbNo: string | null; transportDocs: number
}
export interface EwbPreview {
  source: EwbSourceCandidate
  partA: { supplyType: string; subSupplyType: string; documentType: string; documentNo: string; documentDate: string; transactionType: string; from: { gstin: string | null; name: string; address: string; stateCode: string; pincode: string | null }; to: { gstin: string | null; name: string; address: string; stateCode: string; pincode: string | null }; items: Array<{ productName: string; hsn: string; qtyMilli: number; unit: string; taxablePaise: number; taxRateBps: number }>; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalValuePaise: number }
  errors: string[]
  warnings: string[]
}
