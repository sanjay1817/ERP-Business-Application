/**
 * E-invoice (IRN) provider interface.
 *
 * Two implementations ship:
 *  - MockEInvoiceProvider: local DEMO results. Its IRNs start with "DEMO-" (a real IRN is a
 *    64-character hexadecimal hash) and it never produces a signed invoice or a signed QR code.
 *  - LiveEInvoiceProvider: a placeholder for an authorised GSP/IRP adapter. It sends nothing and
 *    fails every call with NOT_CONFIGURED. Endpoints, authentication and payload mapping must be
 *    implemented from the provider's current official specification — none are invented here.
 */
import { createHash, randomInt } from 'node:crypto'
import { isValidGstin } from '@shared/india'
import { invalidDocumentNumber, type ErrorClass } from '@shared/gst'
import { ProviderError } from '../integrations/runner'

export interface EInvoiceItem {
  slNo: number; description: string; hsn: string; isService: boolean; qtyMilli: number; unit: string
  taxablePaise: number; gstRateBps: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; totalPaise: number
}
export interface EInvoiceParty { gstin: string | null; legalName: string; address: string; place: string; pincode: string | null; stateCode: string }
export interface EInvoicePayload {
  supplyType: 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP'
  documentType: 'INV' | 'CRN' | 'DBN'
  documentNo: string
  documentDate: string
  placeOfSupply: string
  seller: EInvoiceParty
  buyer: EInvoiceParty
  items: EInvoiceItem[]
  totals: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number; roundOffPaise: number; totalPaise: number }
  precedingDocument: { number: string; date: string } | null
}
export interface IrnResult {
  irn: string
  ackNo: string
  ackDate: string
  /** Signed JSON from the IRP (live only). DEMO returns an unsigned, clearly labelled summary. */
  signedInvoice: string | null
  /** Signed QR payload from the IRP (live only). Always null in DEMO. */
  signedQr: string | null
  responseRef: string
}
export interface EInvoiceProvider {
  readonly id: string
  readonly environment: 'DEMO' | 'SANDBOX' | 'LIVE'
  readonly isDemo: boolean
  generateIrn(payload: EInvoicePayload, requestKey: string, now: Date): Promise<IrnResult>
  /** Looks up an IRN already registered for a document (used after timeouts and duplicate responses). */
  getIrnByDocument(sellerGstin: string, documentType: string, documentNo: string, documentDate: string): Promise<IrnResult | null>
  cancelIrn(req: { irn: string; reasonCode: number; remarks: string }, now: Date): Promise<{ cancelledAt: string; responseRef: string }>
  getIrnStatus(irn: string): Promise<{ status: 'ACTIVE' | 'CANCELLED' | 'NOT_FOUND'; at: string | null }>
}

const fyOf = (iso: string) => {
  const [y, m] = iso.split('-').map(Number)
  return m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`
}

export type MockFault = ErrorClass | 'TIMEOUT_AFTER_SUCCESS'

/** Validates locally and returns DEMO results. Never contacts any system. */
export class MockEInvoiceProvider implements EInvoiceProvider {
  readonly id = 'DEMO'
  readonly environment = 'DEMO' as const
  readonly isDemo = true
  private readonly registry = new Map<string, IrnResult & { cancelledAt: string | null }>()
  private readonly byIrn = new Map<string, string>()
  /** Test hook: faults consumed one per call (e.g. ['TIMEOUT', 'NETWORK']). */
  readonly faults: MockFault[] = []

  private key(gstin: string, type: string, no: string, date: string) {
    return `${gstin}|${type}|${no.toUpperCase()}|${fyOf(date)}`
  }
  private fault(): MockFault | undefined {
    return this.faults.shift()
  }
  private raise(f: MockFault): never {
    const msg: Record<string, string> = { TIMEOUT: 'DEMO: simulated timeout', NETWORK: 'DEMO: simulated network failure', RATE_LIMIT: 'DEMO: simulated rate limit', PROVIDER: 'DEMO: simulated provider error (5xx)', AUTH: 'DEMO: simulated authentication failure' }
    throw new ProviderError(f as ErrorClass, `DEMO_${f}`, msg[f] ?? `DEMO: simulated ${f.toLowerCase()} error`)
  }

  validate(p: EInvoicePayload): void {
    const v = (field: string, message: string): never => { throw new ProviderError('VALIDATION', 'DEMO_VALIDATION', message, field) }
    if (!p.seller.gstin || !isValidGstin(p.seller.gstin)) v('sellerGstin', 'Seller GSTIN is invalid')
    if ((p.supplyType === 'B2B' || p.supplyType.startsWith('SEZ')) && (!p.buyer.gstin || !isValidGstin(p.buyer.gstin))) v('buyerGstin', 'Buyer GSTIN is required and must be valid')
    const numErr = invalidDocumentNumber(p.documentNo)
    if (numErr) v('documentNo', `Document number: ${numErr}`)
    if (!p.items.length) v('items', 'At least one item is required')
    for (const it of p.items) if (!/^[0-9]{4,8}$/.test(it.hsn)) v('hsn', `Item ${it.slNo}: HSN/SAC must be 4 to 8 digits`)
    if (!p.supplyType.startsWith('EXP') && !p.buyer.pincode) v('buyerPincode', 'Buyer PIN code is required')
    const sum = (k: keyof EInvoiceItem) => p.items.reduce((s, i) => s + (i[k] as number), 0)
    if (sum('taxablePaise') !== p.totals.taxablePaise) v('totals', 'Item taxable values do not add up to the document total')
    if (sum('igstPaise') !== p.totals.igstPaise || sum('cgstPaise') !== p.totals.cgstPaise || sum('sgstPaise') !== p.totals.sgstPaise) v('totals', 'Item tax amounts do not add up to the document tax')
    if (p.totals.taxablePaise + p.totals.igstPaise + p.totals.cgstPaise + p.totals.sgstPaise + p.totals.cessPaise + p.totals.roundOffPaise !== p.totals.totalPaise) v('totals', 'Document total does not equal taxable value + tax + round-off')
    if (p.documentType === 'CRN' && !p.precedingDocument) v('precedingDocument', 'Credit note needs the original invoice reference')
  }

  async generateIrn(p: EInvoicePayload, requestKey: string, now: Date): Promise<IrnResult> {
    const f = this.fault()
    if (f && f !== 'TIMEOUT_AFTER_SUCCESS') this.raise(f)
    this.validate(p)
    const key = this.key(p.seller.gstin!, p.documentType, p.documentNo, p.documentDate)
    const existing = this.registry.get(key)
    if (existing) throw new ProviderError('DUPLICATE', 'DEMO_DUPLICATE_IRN', 'DEMO: an IRN already exists for this document')
    const res: IrnResult = {
      irn: `DEMO-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`,
      ackNo: `DEMO${String(randomInt(0, 10 ** 10)).padStart(10, '0')}`,
      ackDate: now.toISOString(),
      signedInvoice: JSON.stringify({ notice: 'DEMO — NOT SIGNED BY ANY INVOICE REGISTRATION PORTAL. NOT A LEGALLY REGISTERED E-INVOICE.', documentNo: p.documentNo, documentDate: p.documentDate, totalPaise: p.totals.totalPaise }),
      signedQr: null,
      responseRef: `DEMO-REQ-${requestKey.slice(0, 12)}`
    }
    this.registry.set(key, { ...res, cancelledAt: null })
    this.byIrn.set(res.irn, key)
    if (f === 'TIMEOUT_AFTER_SUCCESS') throw new ProviderError('TIMEOUT', 'DEMO_TIMEOUT', 'DEMO: simulated timeout after the IRN was registered')
    return res
  }

  /** The real IRP keeps its records; the in-memory demo registry is rebuilt from the ERP's own records after a restart. */
  remember(r: { sellerGstin: string; documentType: string; documentNo: string; documentDate: string; irn: string; ackNo: string; ackDate: string; cancelledAt: string | null }): void {
    if (this.byIrn.has(r.irn)) return
    const key = this.key(r.sellerGstin, r.documentType, r.documentNo, r.documentDate)
    this.registry.set(key, { irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate, signedInvoice: null, signedQr: null, responseRef: 'DEMO-REHYDRATED', cancelledAt: r.cancelledAt })
    this.byIrn.set(r.irn, key)
  }

  async getIrnByDocument(gstin: string, type: string, no: string, date: string): Promise<IrnResult | null> {
    const r = this.registry.get(this.key(gstin, type, no, date))
    return r && !r.cancelledAt ? r : null
  }

  async cancelIrn(req: { irn: string; reasonCode: number; remarks: string }, now: Date) {
    const f = this.fault()
    if (f && f !== 'TIMEOUT_AFTER_SUCCESS') this.raise(f)
    const key = this.byIrn.get(req.irn)
    const r = key ? this.registry.get(key) : undefined
    if (!r) throw new ProviderError('NOT_FOUND', 'DEMO_IRN_NOT_FOUND', 'DEMO: IRN not found at the demo provider (it may have been created before the app restarted)')
    if (r.cancelledAt) throw new ProviderError('BUSINESS', 'DEMO_ALREADY_CANCELLED', 'DEMO: IRN is already cancelled')
    r.cancelledAt = now.toISOString()
    // A cancelled document number cannot be re-registered on the IRP; keep the registry entry.
    return { cancelledAt: r.cancelledAt, responseRef: `DEMO-CNL-${req.irn.slice(5, 17)}` }
  }

  async getIrnStatus(irn: string) {
    const key = this.byIrn.get(irn)
    const r = key ? this.registry.get(key) : undefined
    if (!r) return { status: 'NOT_FOUND' as const, at: null }
    return { status: r.cancelledAt ? ('CANCELLED' as const) : ('ACTIVE' as const), at: r.cancelledAt ?? r.ackDate }
  }
}

export const LIVE_NOT_INSTALLED = 'No authorised IRP/GSP adapter is installed. Live e-invoicing needs an API contract with an authorised provider, credentials for this GSTIN and an adapter built from the provider’s current specification. No request was sent.'

/** Placeholder: refuses every call. It never pretends to succeed. */
export class LiveEInvoiceProvider implements EInvoiceProvider {
  readonly id: string
  readonly isDemo = false
  constructor(readonly environment: 'SANDBOX' | 'LIVE', providerName: string | null) {
    this.id = providerName ?? `${environment}-UNCONFIGURED`
  }
  private refuse(): never {
    throw new ProviderError('NOT_CONFIGURED', 'LIVE_ADAPTER_NOT_INSTALLED', LIVE_NOT_INSTALLED)
  }
  async generateIrn(): Promise<IrnResult> { return this.refuse() }
  async getIrnByDocument(): Promise<IrnResult | null> { return this.refuse() }
  async cancelIrn(): Promise<{ cancelledAt: string; responseRef: string }> { return this.refuse() }
  async getIrnStatus(): Promise<{ status: 'ACTIVE' | 'CANCELLED' | 'NOT_FOUND'; at: string | null }> { return this.refuse() }
}
