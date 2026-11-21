/**
 * Commercial document kinds and their behaviour. One configuration drives the
 * posting engine (main) and the editors/lists (renderer).
 */
import { z } from 'zod'
import { STATE_CODES } from './india'

export const DOCUMENT_KINDS = [
  'SALES_QUOTATION', 'SALES_ORDER', 'DELIVERY_CHALLAN', 'SALES_INVOICE', 'SALES_RETURN', 'CREDIT_NOTE',
  'PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'PURCHASE_INVOICE', 'PURCHASE_RETURN', 'DEBIT_NOTE'
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]
export type Side = 'SALES' | 'PURCHASE'

export interface KindConfig {
  kind: DocumentKind
  side: Side
  label: string
  plural: string
  /** Title printed on the document. */
  printTitle: string
  /** Route segment under /sales or /purchase. */
  slug: string
  party: 'CUSTOMER' | 'SUPPLIER'
  partyRequired: boolean
  /** Physical stock effect when posted (goods with inventory tracking only). */
  stock: 'IN' | 'OUT' | 'NONE'
  /** Posts a journal when posted. */
  ledger: boolean
  /** Freight / other charges allowed. */
  charges: boolean
  /** Services may be included. */
  allowServices: boolean
  /** Documents this kind can be created from. */
  sources: DocumentKind[]
  /** Must be created from a source document. */
  sourceRequired: boolean
  /** Lines must reference source lines and cannot exceed their remaining quantity. */
  lineLinkedSource: DocumentKind[]
  /** Documents this kind can be converted into. */
  converts: DocumentKind[]
  /** Settles (reduces the balance of) its source invoice when posted. */
  settlesSource: boolean
  dueDateLabel: string
  supplierRefLabel: string | null
  description: string
}

const k = (c: Omit<KindConfig, 'lineLinkedSource' | 'settlesSource' | 'sourceRequired' | 'supplierRefLabel'> & Partial<KindConfig>): KindConfig => ({
  lineLinkedSource: [],
  settlesSource: false,
  sourceRequired: false,
  supplierRefLabel: null,
  ...c
})

export const KINDS: Record<DocumentKind, KindConfig> = {
  SALES_QUOTATION: k({
    kind: 'SALES_QUOTATION', side: 'SALES', label: 'Quotation', plural: 'Quotations', printTitle: 'QUOTATION', slug: 'quotations', party: 'CUSTOMER',
    partyRequired: true, stock: 'NONE', ledger: false, charges: false, allowServices: true, sources: [], converts: ['SALES_ORDER', 'SALES_INVOICE'],
    dueDateLabel: 'Valid until', description: 'Price offer to a customer. No stock or accounting effect.'
  }),
  SALES_ORDER: k({
    kind: 'SALES_ORDER', side: 'SALES', label: 'Sales Order', plural: 'Sales Orders', printTitle: 'SALES ORDER', slug: 'orders', party: 'CUSTOMER',
    partyRequired: true, stock: 'NONE', ledger: false, charges: false, allowServices: true, sources: ['SALES_QUOTATION'], converts: ['DELIVERY_CHALLAN', 'SALES_INVOICE'],
    dueDateLabel: 'Delivery by', description: 'Confirmed customer order. No stock or accounting effect.'
  }),
  DELIVERY_CHALLAN: k({
    kind: 'DELIVERY_CHALLAN', side: 'SALES', label: 'Delivery Challan', plural: 'Delivery Challans', printTitle: 'DELIVERY CHALLAN', slug: 'challans', party: 'CUSTOMER',
    partyRequired: true, stock: 'OUT', ledger: true, charges: false, allowServices: false, sources: ['SALES_ORDER'], converts: ['SALES_INVOICE'],
    dueDateLabel: 'Expected invoice by', description: 'Goods dispatched before invoicing. Reduces stock (cost moved to COGS); the invoice made from it does not reduce stock again.'
  }),
  SALES_INVOICE: k({
    kind: 'SALES_INVOICE', side: 'SALES', label: 'Sales Invoice', plural: 'Sales Invoices', printTitle: 'TAX INVOICE', slug: 'invoices', party: 'CUSTOMER',
    partyRequired: true, stock: 'OUT', ledger: true, charges: false, allowServices: true, sources: ['SALES_QUOTATION', 'SALES_ORDER', 'DELIVERY_CHALLAN'],
    lineLinkedSource: ['DELIVERY_CHALLAN'], converts: ['SALES_RETURN', 'CREDIT_NOTE'], dueDateLabel: 'Due date',
    description: 'Debits the customer, credits revenue and output GST; reduces stock for goods.'
  }),
  SALES_RETURN: k({
    kind: 'SALES_RETURN', side: 'SALES', label: 'Sales Return', plural: 'Sales Returns', printTitle: 'CREDIT NOTE (SALES RETURN)', slug: 'returns', party: 'CUSTOMER',
    partyRequired: true, stock: 'IN', ledger: true, charges: false, allowServices: true, sources: ['SALES_INVOICE'], sourceRequired: true, lineLinkedSource: ['SALES_INVOICE'],
    converts: [], settlesSource: true, dueDateLabel: 'Due date', description: 'Goods returned against an invoice. Restores stock at original cost and credits the customer.'
  }),
  CREDIT_NOTE: k({
    kind: 'CREDIT_NOTE', side: 'SALES', label: 'Credit Note', plural: 'Credit Notes', printTitle: 'CREDIT NOTE', slug: 'credit-notes', party: 'CUSTOMER',
    partyRequired: true, stock: 'NONE', ledger: true, charges: false, allowServices: true, sources: ['SALES_INVOICE'], converts: [], settlesSource: true,
    dueDateLabel: 'Due date', description: 'Price reduction or allowance to a customer. Reverses revenue and output GST; no stock effect.'
  }),
  PURCHASE_REQUISITION: k({
    kind: 'PURCHASE_REQUISITION', side: 'PURCHASE', label: 'Purchase Requisition', plural: 'Purchase Requisitions', printTitle: 'PURCHASE REQUISITION', slug: 'requisitions',
    party: 'SUPPLIER', partyRequired: false, stock: 'NONE', ledger: false, charges: false, allowServices: true, sources: [], converts: ['PURCHASE_ORDER'],
    dueDateLabel: 'Required by', description: 'Internal request to buy. Supplier is optional. No stock or accounting effect.'
  }),
  PURCHASE_ORDER: k({
    kind: 'PURCHASE_ORDER', side: 'PURCHASE', label: 'Purchase Order', plural: 'Purchase Orders', printTitle: 'PURCHASE ORDER', slug: 'orders', party: 'SUPPLIER',
    partyRequired: true, stock: 'NONE', ledger: false, charges: true, allowServices: true, sources: ['PURCHASE_REQUISITION'], converts: ['GOODS_RECEIPT', 'PURCHASE_INVOICE'],
    dueDateLabel: 'Delivery by', description: 'Order placed with a supplier. No stock or accounting effect.'
  }),
  GOODS_RECEIPT: k({
    kind: 'GOODS_RECEIPT', side: 'PURCHASE', label: 'Goods Receipt Note', plural: 'Goods Receipts', printTitle: 'GOODS RECEIPT NOTE', slug: 'goods-receipts', party: 'SUPPLIER',
    partyRequired: true, stock: 'IN', ledger: true, charges: false, allowServices: false, sources: ['PURCHASE_ORDER'], converts: ['PURCHASE_INVOICE'],
    dueDateLabel: 'Invoice expected by', supplierRefLabel: 'Supplier challan no.',
    description: 'Goods received before the bill. Adds stock and credits "Goods Received Not Invoiced"; the bill made from it clears that account.'
  }),
  PURCHASE_INVOICE: k({
    kind: 'PURCHASE_INVOICE', side: 'PURCHASE', label: 'Purchase Invoice', plural: 'Purchase Invoices', printTitle: 'PURCHASE INVOICE', slug: 'invoices', party: 'SUPPLIER',
    partyRequired: true, stock: 'IN', ledger: true, charges: true, allowServices: true, sources: ['PURCHASE_ORDER', 'GOODS_RECEIPT'], lineLinkedSource: ['GOODS_RECEIPT'],
    converts: ['PURCHASE_RETURN', 'DEBIT_NOTE'], dueDateLabel: 'Due date', supplierRefLabel: 'Supplier invoice no.',
    description: 'Credits the supplier; debits inventory (goods, incl. freight) or expenses (services) and input GST.'
  }),
  PURCHASE_RETURN: k({
    kind: 'PURCHASE_RETURN', side: 'PURCHASE', label: 'Purchase Return', plural: 'Purchase Returns', printTitle: 'DEBIT NOTE (PURCHASE RETURN)', slug: 'returns', party: 'SUPPLIER',
    partyRequired: true, stock: 'OUT', ledger: true, charges: false, allowServices: true, sources: ['PURCHASE_INVOICE'], sourceRequired: true, lineLinkedSource: ['PURCHASE_INVOICE'],
    converts: [], settlesSource: true, dueDateLabel: 'Due date', supplierRefLabel: 'Supplier credit note no.',
    description: 'Goods returned to a supplier against a bill. Removes stock at original cost and debits the supplier.'
  }),
  DEBIT_NOTE: k({
    kind: 'DEBIT_NOTE', side: 'PURCHASE', label: 'Debit Note', plural: 'Debit Notes', printTitle: 'DEBIT NOTE', slug: 'debit-notes', party: 'SUPPLIER',
    partyRequired: true, stock: 'NONE', ledger: true, charges: false, allowServices: true, sources: ['PURCHASE_INVOICE'], converts: [], settlesSource: true,
    dueDateLabel: 'Due date', supplierRefLabel: 'Supplier credit note no.', description: 'Price reduction claimed from a supplier. Reverses purchase cost and input GST; no stock effect.'
  })
}

export const SIDE_KINDS: Record<Side, DocumentKind[]> = {
  SALES: DOCUMENT_KINDS.filter((x) => KINDS[x].side === 'SALES'),
  PURCHASE: DOCUMENT_KINDS.filter((x) => KINDS[x].side === 'PURCHASE')
}

export const kindBySlug = (side: Side, slug: string): DocumentKind | undefined => SIDE_KINDS[side].find((x) => KINDS[x].slug === slug)
export const docRoute = (kind: DocumentKind, id?: number | 'new'): string =>
  `/${KINDS[kind].side === 'SALES' ? 'sales' : 'purchase'}/${KINDS[kind].slug}${id ? `/${id}` : ''}`
export const isInvoiceKind = (kind: string): kind is 'SALES_INVOICE' | 'PURCHASE_INVOICE' => kind === 'SALES_INVOICE' || kind === 'PURCHASE_INVOICE'

// ───────── Input schemas ─────────
const id = z.number().int().positive()
const isoDate = z
  .string({ error: 'Date is required' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, 'Use a valid date')
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : (v ?? null)), z.string().max(max, `Must be at most ${max} characters`).nullable())
const money = (label: string) => z.number({ error: `${label} is required` }).int(`${label} must be whole paise`).min(0, `${label} cannot be negative`).max(1e12, `${label} is too large`)
const taxBps = z.number().int().min(0).max(10000)

export const DocumentLineInput = z
  .object({
    productId: id,
    description: optText(300).optional(),
    qtyMilli: z.number({ error: 'Quantity is required' }).int('Quantity can have at most 3 decimals').positive('Quantity must be greater than zero').max(1e9, 'Quantity is too large'),
    ratePaise: money('Rate'),
    discountBps: z.number().int().min(0, 'Discount cannot be negative').max(10000, 'Discount cannot exceed 100%').nullable().optional(),
    discountPaise: money('Discount').optional(),
    taxRateBps: taxBps.nullable().optional(),
    sourceLineId: id.nullable().optional()
  })
  .strict()

export const DocumentSaveInput = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    id: id.optional(),
    partyId: id.nullable().optional(),
    date: isoDate,
    dueDate: isoDate.nullable().optional(),
    placeOfSupply: z.enum(STATE_CODES as [string, ...string[]], { error: 'Select a valid place of supply' }).nullable().optional(),
    warehouseId: id.nullable().optional(),
    referenceNo: optText(50).optional(),
    supplierRef: optText(30).optional(),
    supplierRefDate: isoDate.nullable().optional(),
    billingAddress: optText(500).optional(),
    shippingAddress: optText(500).optional(),
    paymentTermsDays: z.number().int().min(0, 'Payment terms cannot be negative').max(365, 'Payment terms must be 365 days or less').nullable().optional(),
    pricingMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']).default('EXCLUSIVE'),
    notes: optText(1000).optional(),
    terms: optText(2000).optional(),
    reason: optText(200).optional(),
    freightPaise: money('Freight').default(0),
    freightTaxBps: taxBps.default(0),
    otherChargesPaise: money('Other charges').default(0),
    otherChargesLabel: optText(60).optional(),
    otherChargesTaxBps: taxBps.default(0),
    sourceKind: z.enum(DOCUMENT_KINDS).nullable().optional(),
    sourceId: id.nullable().optional(),
    lines: z.array(DocumentLineInput).max(300, 'At most 300 lines per document')
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.dueDate && v.dueDate < v.date) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Must be on or after the document date' })
    if (!KINDS[v.kind].charges && (v.freightPaise > 0 || v.otherChargesPaise > 0)) ctx.addIssue({ code: 'custom', path: ['freightPaise'], message: 'Charges are not allowed on this document' })
    if ((v.sourceKind == null) !== (v.sourceId == null)) ctx.addIssue({ code: 'custom', path: ['sourceId'], message: 'Source document is incomplete' })
  })
export type DocumentSaveInputT = z.input<typeof DocumentSaveInput>
export type DocumentSaveParsed = z.output<typeof DocumentSaveInput>

export const DocumentRef = z.object({ kind: z.enum(DOCUMENT_KINDS), id }).strict()
export const DocumentCancelInput = z.object({ kind: z.enum(DOCUMENT_KINDS), id, reason: z.string().trim().min(3, 'Enter a reason (at least 3 characters)').max(200) }).strict()
export const DocumentConvertInput = z.object({ kind: z.enum(DOCUMENT_KINDS), id, target: z.enum(DOCUMENT_KINDS) }).strict()
export const DocumentListInput = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
    search: z.string().trim().max(100).optional(),
    partyId: id.optional(),
    limit: z.number().int().min(1).max(1000).optional()
  })
  .strict()
export const RegisterInput = z
  .object({
    side: z.enum(['SALES', 'PURCHASE']),
    from: isoDate.optional(),
    to: isoDate.optional(),
    search: z.string().trim().max(100).optional(),
    paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE']).optional(),
    includeCancelled: z.boolean().optional()
  })
  .strict()
export const SideInput = z.object({ side: z.enum(['SALES', 'PURCHASE']) }).strict()

export const PAYMENT_MODES = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CARD'] as const
export const PaymentCreateInput = z
  .object({
    type: z.enum(['RECEIPT', 'PAYMENT']),
    partyId: id,
    date: isoDate,
    amountPaise: z.number({ error: 'Amount is required' }).int().positive('Amount must be greater than zero').max(1e12),
    mode: z.enum(PAYMENT_MODES),
    accountId: id,
    referenceNo: optText(50).optional(),
    notes: optText(300).optional(),
    allocations: z.array(z.object({ invoiceId: id, amountPaise: z.number().int().positive('Allocation must be positive') }).strict()).max(500).default([]),
    /** Client-generated key: resubmitting the same form returns the first posting instead of posting twice. */
    requestKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/, 'Invalid request key').optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    const total = v.allocations.reduce((s, a) => s + a.amountPaise, 0)
    if (total > v.amountPaise) ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'Allocated total exceeds the payment amount' })
    if (new Set(v.allocations.map((a) => a.invoiceId)).size !== v.allocations.length) ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'An invoice is allocated twice' })
    if (v.mode === 'CHEQUE' && !v.referenceNo) ctx.addIssue({ code: 'custom', path: ['referenceNo'], message: 'Cheque number is required' })
  })
export type PaymentCreateInputT = z.input<typeof PaymentCreateInput>
export const PaymentRef = z.object({ type: z.enum(['RECEIPT', 'PAYMENT']), id }).strict()
export const PaymentListInput = z.object({ type: z.enum(['RECEIPT', 'PAYMENT']), search: z.string().trim().max(100).optional(), partyId: id.optional() }).strict()
export const OpenInvoicesInput = z.object({ type: z.enum(['RECEIPT', 'PAYMENT']), partyId: id }).strict()

// ───────── DTOs ─────────
export type DocStatus = 'DRAFT' | 'POSTED' | 'CANCELLED'
export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'NA'

export interface DocumentLine {
  id: number
  lineNo: number
  productId: number
  productCode: string
  productName: string
  itemType: 'GOODS' | 'SERVICE'
  trackInventory: boolean
  description: string | null
  hsnSac: string
  unitCode: string
  qtyMilli: number
  ratePaise: number
  discountBps: number | null
  discountPaise: number
  grossPaise: number
  taxablePaise: number
  taxRateBps: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalPaise: number
  costPaise: number
  sourceLineId: number | null
  /** For lines linked to a source line: quantity still available (excluding this document). */
  sourceRemainingMilli: number | null
}

export interface DocumentLink {
  kind: DocumentKind
  id: number
  number: string
  status: DocStatus
  date: string
}

export interface DocumentDetail {
  id: number
  kind: DocumentKind
  number: string
  status: DocStatus
  financialYear: string
  date: string
  dueDate: string | null
  partyId: number | null
  partyCode: string | null
  partyName: string | null
  partyGstin: string | null
  partyRegistrationType: string | null
  partyStateCode: string | null
  placeOfSupply: string
  isInterState: boolean
  warehouseId: number | null
  warehouseName: string | null
  referenceNo: string | null
  supplierRef: string | null
  supplierRefDate: string | null
  billingAddress: string | null
  shippingAddress: string | null
  paymentTermsDays: number
  pricingMode: 'EXCLUSIVE' | 'INCLUSIVE'
  notes: string | null
  terms: string | null
  reason: string | null
  freightPaise: number
  freightTaxBps: number
  otherChargesPaise: number
  otherChargesLabel: string | null
  otherChargesTaxBps: number
  subtotalPaise: number
  discountPaise: number
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  roundOffPaise: number
  grandTotalPaise: number
  /** Receipts/payments and notes applied to this invoice. */
  settledPaise: number
  balanceDuePaise: number
  paymentStatus: PaymentStatus
  source: DocumentLink | null
  children: DocumentLink[]
  allocations: Array<{ sourceType: string; sourceId: number; number: string; date: string; amountPaise: number }>
  journalEntryNo: string | null
  reversalEntryNo: string | null
  postedAt: string | null
  cancelledAt: string | null
  cancelReason: string | null
  createdAt: string
  updatedAt: string
  lines: DocumentLine[]
}

export interface DocumentRow {
  id: number
  kind: DocumentKind
  number: string
  status: DocStatus
  date: string
  dueDate: string | null
  partyName: string | null
  referenceNo: string | null
  supplierRef: string | null
  sourceNumber: string | null
  taxablePaise: number
  taxPaise: number
  grandTotalPaise: number
  balanceDuePaise: number
  paymentStatus: PaymentStatus
  lineCount: number
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface RegisterRow {
  id: number
  kind: 'SALES_INVOICE' | 'PURCHASE_INVOICE'
  number: string
  date: string
  dueDate: string | null
  partyId: number
  partyName: string
  partyGstin: string | null
  partyRef: string | null
  status: DocStatus
  isInterState: boolean
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  grandTotalPaise: number
  settledPaise: number
  balanceDuePaise: number
  paymentStatus: PaymentStatus
  overdueDays: number
}

export interface OpenInvoice {
  invoiceId: number
  number: string
  date: string
  dueDate: string | null
  partyRef: string | null
  grandTotalPaise: number
  balancePaise: number
  overdueDays: number
}

export interface PaymentDetail {
  id: number
  type: 'RECEIPT' | 'PAYMENT'
  number: string
  date: string
  partyId: number
  partyName: string
  amountPaise: number
  mode: string
  accountId: number
  accountName: string
  referenceNo: string | null
  notes: string | null
  status: string
  allocatedPaise: number
  unallocatedPaise: number
  journalEntryNo: string | null
  allocations: Array<{ invoiceId: number; number: string; date: string; amountPaise: number }>
  createdAt: string
}

export interface PaymentRow {
  id: number
  type: 'RECEIPT' | 'PAYMENT'
  number: string
  date: string
  partyName: string
  amountPaise: number
  mode: string
  accountName: string
  referenceNo: string | null
  allocatedPaise: number
  unallocatedPaise: number
}

export interface ModuleSummary {
  side: Side
  asOf: string
  financialYear: string
  monthTotalPaise: number
  monthCount: number
  fyTotalPaise: number
  outstandingPaise: number
  overduePaise: number
  overdueCount: number
  settledThisMonthPaise: number
  draftCount: number
  pending: Array<{ kind: DocumentKind; label: string; count: number; valuePaise: number }>
  recent: DocumentRow[]
  overdue: RegisterRow[]
}
