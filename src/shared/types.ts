/** Data transfer objects returned over IPC. Money = paise, qty = milli-units. */

export interface SessionInfo {
  userId: number
  username: string
  fullName: string
  roleCode: string
  roleName: string
  permissions: string[]
  company: CompanySummary | null
  /** Server-enforced: until the password is changed only the change-password and sign-out requests are accepted. */
  mustChangePassword?: boolean
  /** Which database is open (DEMO sample data or company books). */
  environment?: 'DEMO' | 'COMPANY' | null
}

export interface CompanySummary {
  id: number
  code: string
  name: string
  stateCode: string
  gstin: string | null
  isDemo: boolean
  financialYear: string
}

export interface Company {
  id: number
  code: string
  name: string
  legalName: string | null
  gstin: string | null
  pan: string | null
  stateCode: string
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  pincode: string | null
  phone: string | null
  email: string | null
  fyStartMonth: number
  bankName: string | null
  bankAccountNo: string | null
  bankIfsc: string | null
  bankBranch: string | null
  upiId: string | null
  invoiceTerms: string | null
  isDemo: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface PartyBase {
  id: number
  code: string
  name: string
  gstRegistrationType: string
  gstin: string | null
  pan: string | null
  contactPerson: string | null
  phone: string | null
  email: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  stateCode: string
  pincode: string | null
  openingBalancePaise: number
  /** Ledger balance: customers = receivable (+), suppliers = payable (+). */
  balancePaise: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Customer extends PartyBase {
  partyType: 'BUSINESS' | 'INDIVIDUAL'
  shippingAddressLine1: string | null
  shippingAddressLine2: string | null
  shippingCity: string | null
  shippingStateCode: string | null
  shippingPincode: string | null
  creditLimitPaise: number
  creditDays: number
}

export interface Supplier extends PartyBase {
  paymentTermsDays: number
  bankAccountName: string | null
  bankAccountNo: string | null
  bankIfsc: string | null
}

export interface Product {
  id: number
  code: string
  name: string
  description: string | null
  itemType: 'GOODS' | 'SERVICE'
  categoryId: number | null
  categoryName: string | null
  unitId: number
  unitCode: string
  hsnSac: string
  taxRateId: number
  taxRateBps: number
  salePricePaise: number
  purchasePricePaise: number
  mrpPaise: number | null
  reorderLevelMilli: number
  trackInventory: boolean
  stockQtyMilli: number
  stockValuePaise: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Lookups {
  categories: Array<{ id: number; name: string }>
  units: Array<{ id: number; code: string; name: string }>
  taxRates: Array<{ id: number; name: string; rateBps: number }>
  warehouses: Array<{ id: number; code: string; name: string }>
  transporters: Array<{ id: number; name: string; transporterId: string }>
  states: Array<{ code: string; name: string }>
  cashBankAccounts: Array<{ id: number; code: string; name: string; systemKey: string | null }>
}

export interface DashboardSummary {
  financialYear: string
  asOf: string
  kpis: {
    salesPaise: number
    salesCount: number
    purchasesPaise: number
    purchasesCount: number
    receivablesPaise: number
    payablesPaise: number
    cashBankPaise: number
    stockValuePaise: number
    gstOutputPaise: number
    gstInputPaise: number
    receiptsPaise: number
    paymentsPaise: number
  }
  counts: { customers: number; suppliers: number; products: number; services: number; warehouses: number }
  monthly: Array<{ month: string; label: string; salesPaise: number; purchasesPaise: number; receiptsPaise: number }>
  topCustomers: Array<{ id: number; name: string; salesPaise: number }>
  salesMix: Array<{ itemType: 'GOODS' | 'SERVICE'; taxablePaise: number }>
  recentInvoices: Array<{ id: number; kind: 'SALE' | 'PURCHASE'; number: string; date: string; party: string; totalPaise: number }>
  lowStock: Array<{ productId: number; code: string; name: string; qtyMilli: number; reorderLevelMilli: number }>
}

export interface InvoiceRow {
  id: number
  invoiceNo: string
  invoiceDate: string
  partyId: number
  partyName: string
  partyRef: string | null
  status: string
  taxablePaise: number
  taxPaise: number
  grandTotalPaise: number
  isInterState: boolean
  itemCount: number
}

export interface StockRow {
  productId: number
  code: string
  name: string
  categoryName: string | null
  unitCode: string
  warehouseId: number
  warehouseName: string
  qtyMilli: number
  valuePaise: number
  reorderLevelMilli: number
}

export interface MovementRow {
  id: number
  movementDate: string
  movementType: string
  productCode: string
  productName: string
  warehouseName: string
  qtyInMilli: number
  qtyOutMilli: number
  unitCostPaise: number
  valuePaise: number
  referenceNo: string | null
  balanceQtyMilli: number
}

export interface TrialBalanceRow {
  accountId: number
  code: string
  name: string
  accountType: string
  debitPaise: number
  creditPaise: number
}

export interface JournalRow {
  id: number
  entryNo: string
  entryDate: string
  sourceType: string
  narration: string | null
  totalPaise: number
  status: string
  lines: Array<{ accountCode: string; accountName: string; debitPaise: number; creditPaise: number; party: string | null }>
}

export interface GstSummaryRow {
  month: string
  outputTaxablePaise: number
  outputCgstPaise: number
  outputSgstPaise: number
  outputIgstPaise: number
  inputTaxablePaise: number
  inputCgstPaise: number
  inputSgstPaise: number
  inputIgstPaise: number
}

export interface BankingOverview {
  accounts: Array<{ id: number; code: string; name: string; balancePaise: number }>
  transactions: Array<{ id: number; kind: 'RECEIPT' | 'PAYMENT'; number: string; date: string; party: string; mode: string; account: string; amountPaise: number; reference: string | null }>
}

export interface AuditRow {
  id: number
  createdAt: string
  username: string | null
  action: string
  entityType: string
  entityId: number | null
  summary: string
  details: string | null
}

export interface UserRow {
  id: number
  username: string
  fullName: string
  email: string | null
  roleName: string
  isActive: boolean
  lastLoginAt: string | null
}

export interface RoleRow {
  id: number
  code: string
  name: string
  permissions: string[]
}

export interface SearchResult {
  type: 'customer' | 'supplier' | 'product' | 'sales_invoice' | 'purchase_invoice'
  id: number
  title: string
  subtitle: string
  route: string
}

export interface NotificationItem {
  id: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  route?: string
}

export interface LoginInfo {
  demoMode: boolean
  demoUsers: Array<{ username: string; password: string; role: string }>
  /** Which database is open (null = none yet: first-run setup). */
  environment?: 'DEMO' | 'COMPANY' | null
}

export interface UserAdminRow {
  id: number
  username: string
  fullName: string
  email: string | null
  roleCode: string
  roleName: string
  isActive: boolean
  lastLoginAt: string | null
  isLocked: boolean
  mustChangePassword: boolean
  passwordChangedAt: string | null
  createdAt: string
}

export interface AppInfo {
  appName: string
  version: string
  electron: string
  node: string
  sqlite: string
  databasePath: string
  schemaVersion: number
  logPath: string
  platform: string
  /** Phase 5: which database is open and where the data folder is. */
  environment?: 'DEMO' | 'COMPANY' | null
  dataDirectory?: string
  packaged?: boolean
}

export interface EwayBill {
  id: number
  provider: string
  isDemo: boolean
  ewbNo: string | null
  ewbDate: string | null
  validUpto: string | null
  status: 'ACTIVE' | 'PART_A_ONLY' | 'CANCELLED' | 'EXPIRED'
  documentType: string
  documentNo: string
  documentDate: string
  salesInvoiceId: number | null
  supplyType: string
  subSupplyType: string
  transactionType: string
  fromGstin: string | null
  fromName: string
  fromAddress: string
  fromStateCode: string
  fromPincode: string | null
  toGstin: string | null
  toName: string
  toAddress: string
  toStateCode: string
  toPincode: string | null
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalValuePaise: number
  items: Array<{ productName: string; hsn: string; qtyMilli: number; unit: string; taxablePaise: number; taxRateBps: number }>
  transportMode: string
  transporterName: string | null
  transporterGstin: string | null
  transportDocNo: string | null
  transportDocDate: string | null
  vehicleNo: string | null
  vehicleType: string
  distanceKm: number
  partBUpdatedAt: string | null
  cancelReason: string | null
  cancelRemarks: string | null
  cancelledAt: string | null
  createdAt: string
  history: Array<{ at: string; event: string; detail: string }>
  /** Phase 4: source document (sales invoice or delivery challan), masters and monitoring. */
  sourceKind: string | null
  sourceId: number | null
  sourceRoute: string | null
  transporterId: number | null
  vehicleId: number | null
  transportDocumentId: number | null
  environment: string
  extensionCount: number
  lastStatusCheckAt: string | null
  providerStatus: string | null
  /** Hours until expiry (negative once expired); null without Part B. */
  hoursToExpiry: number | null
  canCancel: boolean
  canExtend: boolean
  cancelDeadline: string | null
}

export interface EwbEligibleInvoice {
  id: number
  invoiceNo: string
  invoiceDate: string
  customerName: string
  grandTotalPaise: number
  hasEwayBill: boolean
}

export type IpcErrorCode =
  | 'UNKNOWN_CHANNEL'
  | 'UNTRUSTED_SENDER'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUSINESS_RULE'
  | 'INTERNAL'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'SETUP_REQUIRED'

export interface IpcError {
  code: IpcErrorCode
  message: string
  fieldErrors?: Record<string, string>
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }
