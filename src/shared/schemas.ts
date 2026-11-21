import { z } from 'zod'
import { GSTIN_PATTERN, HSN_SAC_PATTERN, PAN_PATTERN, PINCODE_PATTERN, STATE_CODES, VEHICLE_PATTERN, isValidGstin } from './india'

/** Trim strings; treat empty / missing as null. */
const optText = (max = 200) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null)),
    z.string().max(max, `Must be at most ${max} characters`).nullable()
  )

const reqText = (label: string, min = 1, max = 200) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`)

const upper = (schema: z.ZodType<string | null>) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), schema)

const optGstin = upper(
  optText(15).refine((v) => v === null || GSTIN_PATTERN.test(v), 'GSTIN format is invalid (15 characters, e.g. 29ABCDE1234F1Z5)')
    .refine((v) => v === null || isValidGstin(v), 'GSTIN check digit or state code is invalid')
)
const optPan = upper(optText(10).refine((v) => v === null || PAN_PATTERN.test(v), 'PAN format is invalid (e.g. ABCDE1234F)'))
const optPincode = optText(6).refine((v) => v === null || PINCODE_PATTERN.test(v), 'PIN code must be 6 digits')
const optPhone = optText(20).refine((v) => v === null || /^[0-9+\-\s]{7,20}$/.test(v), 'Phone number is invalid')
const optEmail = optText(120).refine((v) => v === null || z.email().safeParse(v).success, 'Email address is invalid')
const stateCode = z.enum(STATE_CODES as [string, ...string[]], { error: 'Select a valid state' })
const code = upper(
  z
    .string({ error: 'Code is required' })
    .min(1, 'Code is required')
    .max(20, 'Code must be at most 20 characters')
    .regex(/^[A-Z0-9][A-Z0-9\-/_]*$/, 'Code may contain letters, digits, - / _ only')
) as z.ZodType<string>

const paise = (label: string) => z.number({ error: `${label} is required` }).int(`${label} must be a whole number of paise`).min(0, `${label} cannot be negative`).max(1e13, `${label} is too large`)
const signedPaise = (label: string) => z.number({ error: `${label} is required` }).int().min(-1e13).max(1e13, `${label} is too large`)

export const id = z.number().int().positive()
export const NoInput = z.undefined()
export const IdInput = z.object({ id }).strict()
export const SetActiveInput = z.object({ id, isActive: z.boolean() }).strict()

export const LoginInput = z
  .object({
    username: z.string().trim().min(1, 'Username is required').max(50),
    password: z.string().min(1, 'Password is required').max(200)
  })
  .strict()

export const ListQuery = z
  .object({
    search: z.string().trim().max(100).optional(),
    includeInactive: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional()
  })
  .strict()
  .optional()

const companyFields = {
  code,
  name: reqText('Company name', 2, 150),
  legalName: optText(200),
  gstin: optGstin,
  pan: optPan,
  stateCode,
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(100),
  pincode: optPincode,
  phone: optPhone,
  email: optEmail,
  fyStartMonth: z.number().int().min(1).max(12).default(4),
  // Printed on invoices (optional)
  bankName: optText(100).optional(),
  bankAccountNo: optText(30).refine((v) => v == null || /^[0-9]{6,20}$/.test(v), 'Account number must be 6–20 digits').optional(),
  bankIfsc: upper(optText(11).refine((v) => v === null || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'IFSC format is invalid')).optional(),
  bankBranch: optText(100).optional(),
  upiId: optText(60).refine((v) => v == null || /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(v), 'UPI ID format is invalid (e.g. name@bank)').optional(),
  invoiceTerms: optText(2000).optional()
}
function refineCompany(v: { gstin: string | null; pan: string | null; stateCode: string }, ctx: z.RefinementCtx): void {
  if (v.gstin && v.gstin.slice(0, 2) !== v.stateCode)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN state code does not match the selected state' })
  if (v.gstin && v.pan && v.gstin.slice(2, 12) !== v.pan)
    ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN does not match the PAN inside the GSTIN' })
}
export const CompanyInput = z.object(companyFields).strict().superRefine(refineCompany)
export const CompanyUpdateInput = z.object({ id, ...companyFields }).strict().superRefine(refineCompany)

export const GST_REG_TYPES = ['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'SEZ', 'OVERSEAS'] as const
const GSTIN_REQUIRED: ReadonlyArray<string> = ['REGULAR', 'COMPOSITION', 'SEZ']

const partyBase = {
  code,
  name: reqText('Name', 2, 150),
  gstRegistrationType: z.enum(GST_REG_TYPES),
  gstin: optGstin,
  pan: optPan,
  contactPerson: optText(100),
  phone: optPhone,
  email: optEmail,
  addressLine1: optText(200),
  addressLine2: optText(200),
  city: optText(100),
  stateCode,
  pincode: optPincode
}

function refineParty(v: { gstRegistrationType: string; gstin: string | null; pan: string | null; stateCode: string }, ctx: z.RefinementCtx): void {
  if (GSTIN_REQUIRED.includes(v.gstRegistrationType) && !v.gstin)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'GSTIN is required for GST-registered parties' })
  if (!GSTIN_REQUIRED.includes(v.gstRegistrationType) && v.gstin)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Remove GSTIN or change registration type to Regular/Composition/SEZ' })
  if (v.gstin && v.gstin.slice(0, 2) !== v.stateCode)
    ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'State must match the state code in the GSTIN' })
  if (v.gstin && v.pan && v.gstin.slice(2, 12) !== v.pan)
    ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN does not match the PAN inside the GSTIN' })
}

const customerFields = {
  ...partyBase,
  partyType: z.enum(['BUSINESS', 'INDIVIDUAL']),
  shippingAddressLine1: optText(200),
  shippingAddressLine2: optText(200),
  shippingCity: optText(100),
  shippingStateCode: z.preprocess((v) => (v === '' ? null : v), stateCode.nullable().optional()),
  shippingPincode: optPincode,
  creditLimitPaise: paise('Credit limit'),
  creditDays: z.number().int().min(0, 'Credit days cannot be negative').max(365, 'Credit days must be 365 or less')
}
export const CustomerInput = z
  .object({ ...customerFields, openingBalancePaise: signedPaise('Opening balance').default(0) })
  .strict()
  .superRefine(refineParty)
/** Opening balances are posted to the ledger once; they cannot be changed by an edit. */
export const CustomerUpdateInput = z.object({ id, ...customerFields }).strict().superRefine(refineParty)

const supplierFields = {
  ...partyBase,
  paymentTermsDays: z.number().int().min(0).max(365, 'Payment terms must be 365 days or less'),
  bankAccountName: optText(100),
  bankAccountNo: optText(30).refine((v) => v === null || /^[0-9]{6,20}$/.test(v), 'Account number must be 6–20 digits'),
  bankIfsc: upper(optText(11).refine((v) => v === null || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'IFSC format is invalid'))
}
export const SupplierInput = z
  .object({ ...supplierFields, openingBalancePaise: signedPaise('Opening balance').default(0) })
  .strict()
  .superRefine(refineParty)
export const SupplierUpdateInput = z.object({ id, ...supplierFields }).strict().superRefine(refineParty)

const productFields = {
  code,
  name: reqText('Name', 2, 150),
  description: optText(500),
  itemType: z.enum(['GOODS', 'SERVICE']),
  categoryId: id.nullable().optional(),
  unitId: id,
  hsnSac: z.string({ error: 'HSN/SAC is required' }).trim().regex(HSN_SAC_PATTERN, 'HSN/SAC must be 4 to 8 digits'),
  taxRateId: id,
  salePricePaise: paise('Sale price'),
  purchasePricePaise: paise('Purchase price'),
  mrpPaise: paise('MRP').nullable().optional(),
  reorderLevelMilli: z.number().int().min(0, 'Reorder level cannot be negative'),
  trackInventory: z.boolean()
}
function refineProduct(v: { itemType: string; trackInventory: boolean; hsnSac: string; reorderLevelMilli: number; mrpPaise?: number | null; salePricePaise: number }, ctx: z.RefinementCtx): void {
  if (v.itemType === 'SERVICE') {
    if (v.trackInventory) ctx.addIssue({ code: 'custom', path: ['trackInventory'], message: 'Services cannot track inventory' })
    if (!v.hsnSac.startsWith('99')) ctx.addIssue({ code: 'custom', path: ['hsnSac'], message: 'Service SAC codes start with 99' })
    if (v.reorderLevelMilli > 0) ctx.addIssue({ code: 'custom', path: ['reorderLevelMilli'], message: 'Services do not have a reorder level' })
  } else if (v.hsnSac.startsWith('99')) {
    ctx.addIssue({ code: 'custom', path: ['hsnSac'], message: 'Codes starting with 99 are SAC (services); enter a goods HSN code' })
  }
  if (v.mrpPaise != null && v.mrpPaise > 0 && v.salePricePaise > v.mrpPaise)
    ctx.addIssue({ code: 'custom', path: ['salePricePaise'], message: 'Sale price cannot exceed MRP' })
}
export const ProductInput = z.object(productFields).strict().superRefine(refineProduct)
export const ProductUpdateInput = z.object({ id, ...productFields }).strict().superRefine(refineProduct)

export const SearchInput = z.object({ query: z.string().trim().min(1).max(100) }).strict()
export const AuditListInput = z
  .object({ entityType: z.string().max(50).optional(), limit: z.number().int().min(1).max(1000).optional() })
  .strict()
  .optional()
export const MovementListInput = z.object({ productId: id.optional(), limit: z.number().int().min(1).max(1000).optional() }).strict().optional()

export const TRANSPORT_MODES = ['ROAD', 'RAIL', 'AIR', 'SHIP'] as const
const vehicleNo = upper(optText(15).refine((v) => v === null || VEHICLE_PATTERN.test(v.replace(/[\s-]/g, '')), 'Vehicle number format is invalid (e.g. KA01AB1234)'))

export const EwbGenerateInput = z
  .object({
    /** Phase 1/2 callers pass salesInvoiceId; Phase 4 passes sourceKind + sourceId (invoice or delivery challan). */
    salesInvoiceId: id.optional(),
    sourceKind: z.enum(['SALES_INVOICE', 'DELIVERY_CHALLAN']).optional(),
    sourceId: id.optional(),
    /** Client-generated key: resubmitting the same form returns the first e-way bill. */
    requestKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'Invalid request key').optional(),
    vehicleId: id.nullable().optional(),
    transportDocumentId: id.nullable().optional(),
    transportMode: z.enum(TRANSPORT_MODES),
    transporterId: id.nullable().optional(),
    transportDocNo: optText(15),
    transportDocDate: optText(10),
    vehicleNo,
    vehicleType: z.enum(['REGULAR', 'ODC']).default('REGULAR'),
    distanceKm: z.number({ error: 'Distance is required' }).int().min(1, 'Distance must be at least 1 km').max(4000, 'Distance cannot exceed 4000 km')
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.salesInvoiceId && !(v.sourceKind && v.sourceId)) ctx.addIssue({ code: 'custom', path: ['sourceId'], message: 'Select the source invoice or delivery challan' })
    if (v.salesInvoiceId && v.sourceKind && !(v.sourceKind === 'SALES_INVOICE' && v.sourceId === v.salesInvoiceId)) ctx.addIssue({ code: 'custom', path: ['sourceId'], message: 'Source document is ambiguous' })
    if (v.transportMode === 'ROAD' && !v.vehicleNo && !v.vehicleId && !v.transporterId)
      ctx.addIssue({ code: 'custom', path: ['vehicleNo'], message: 'Enter a vehicle number (Part B) or select a transporter (Part A only)' })
    if (v.transportMode !== 'ROAD' && !v.transportDocNo && !v.transportDocumentId)
      ctx.addIssue({ code: 'custom', path: ['transportDocNo'], message: 'Transport document number is required for Rail/Air/Ship' })
  })

export const EWB_PARTB_REASONS = ['BREAKDOWN', 'TRANSSHIPMENT', 'OTHERS', 'FIRST_TIME'] as const
export const EwbPartBInput = z
  .object({
    id,
    transportMode: z.enum(TRANSPORT_MODES),
    vehicleNo,
    transportDocNo: optText(15),
    reason: z.enum(EWB_PARTB_REASONS),
    remarks: optText(100)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.transportMode === 'ROAD' && !v.vehicleNo) ctx.addIssue({ code: 'custom', path: ['vehicleNo'], message: 'Vehicle number is required for road transport' })
    if (v.transportMode !== 'ROAD' && !v.transportDocNo) ctx.addIssue({ code: 'custom', path: ['transportDocNo'], message: 'Transport document number is required for Rail/Air/Ship' })
  })

export const EWB_CANCEL_REASONS = { 1: 'Duplicate', 2: 'Order cancelled', 3: 'Data entry mistake', 4: 'Others' } as const
export const EwbCancelInput = z
  .object({ id, reasonCode: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), remarks: reqText('Remarks', 3, 100) })
  .strict()

export type LoginInputT = z.infer<typeof LoginInput>
export type ListQueryT = z.infer<typeof ListQuery>
export type CompanyInputT = z.infer<typeof CompanyInput>
export type CompanyUpdateInputT = z.infer<typeof CompanyUpdateInput>
export type CustomerInputT = z.infer<typeof CustomerInput>
export type CustomerUpdateInputT = z.infer<typeof CustomerUpdateInput>
export type SupplierInputT = z.infer<typeof SupplierInput>
export type SupplierUpdateInputT = z.infer<typeof SupplierUpdateInput>
export type ProductInputT = z.infer<typeof ProductInput>
export type ProductUpdateInputT = z.infer<typeof ProductUpdateInput>
export type EwbGenerateInputT = z.infer<typeof EwbGenerateInput>
export type EwbPartBInputT = z.infer<typeof EwbPartBInput>
export type EwbCancelInputT = z.infer<typeof EwbCancelInput>
