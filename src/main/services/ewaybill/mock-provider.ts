import { randomInt } from 'node:crypto'
import { isValidGstin } from '@shared/india'
import { canExtendAt, type ErrorClass } from '@shared/gst'
import { ProviderError } from '../integrations/runner'
import { computeValidity, EwbProviderError, type EwayBillProvider, type EwbCancelRequest, type EwbExtendRequest, type EwbGenerateRequest, type EwbGenerateResponse, type EwbPartBRequest } from './provider'

/**
 * DEMO provider: applies the main portal validations locally and returns
 * clearly-marked DEMO numbers. It never contacts any government system and
 * its output is NOT a legally valid e-way bill.
 */
export class MockEwayBillProvider implements EwayBillProvider {
  readonly id = 'DEMO'
  readonly isDemo = true
  readonly environment = 'DEMO' as const
  /** Test hook: transient faults consumed one per call. */
  readonly faults: ErrorClass[] = []
  private readonly byKey = new Map<string, EwbGenerateResponse>()

  private fault(): void {
    const f = this.faults.shift()
    if (f) throw new ProviderError(f, `DEMO_${f}`, `DEMO: simulated ${f.toLowerCase().replace('_', ' ')} error`)
  }

  async generate(req: EwbGenerateRequest, now = new Date()) {
    this.fault()
    if (req.requestKey && this.byKey.has(req.requestKey)) return this.byKey.get(req.requestKey)!
    if (req.from.gstin && !isValidGstin(req.from.gstin)) throw new EwbProviderError('Consignor GSTIN is invalid', 'fromGstin')
    if (req.to.gstin && !isValidGstin(req.to.gstin)) throw new EwbProviderError('Consignee GSTIN is invalid', 'toGstin')
    if (!req.from.pincode || !/^[1-9][0-9]{5}$/.test(req.from.pincode)) throw new EwbProviderError('Consignor PIN code is required (6 digits)', 'fromPincode')
    if (req.subSupplyType !== 'EXPORT' && (!req.to.pincode || !/^[1-9][0-9]{5}$/.test(req.to.pincode))) throw new EwbProviderError('Consignee PIN code is required (6 digits)', 'toPincode')
    if (req.items.length === 0) throw new EwbProviderError('At least one goods line (HSN) is required')
    for (const item of req.items) if (!/^[0-9]{4,8}$/.test(item.hsn) || item.hsn.startsWith('99')) throw new EwbProviderError(`Item ${item.productName} needs a goods HSN code`, 'hsn')
    if (req.documentDate > now.toISOString().slice(0, 10)) throw new EwbProviderError('Document date cannot be in the future', 'documentDate')
    const max = req.maxDistanceKm ?? 4000
    if (req.distanceKm < 1 || req.distanceKm > max) throw new EwbProviderError(`Approximate distance must be between 1 and ${max} km`, 'distanceKm')
    const hasPartB = req.transportMode === 'ROAD' ? !!req.vehicleNo : !!req.transportDocNo
    if (!hasPartB && !req.transporterGstin) throw new EwbProviderError('Provide Part B (vehicle / transport document) or a transporter for Part A only')

    // DEMO + 10 digits; real EWB numbers are 12 digits with no prefix, so these can't be confused.
    const ewbNo = `DEMO${String(randomInt(0, 10 ** 10)).padStart(10, '0')}`
    const res = { ewbNo, ewbDate: now.toISOString(), validUpto: hasPartB ? computeValidity(now, req.distanceKm, req.vehicleType, req.kmPerDay) : null }
    if (req.requestKey) this.byKey.set(req.requestKey, res)
    return res
  }

  async updatePartB(req: EwbPartBRequest, now = new Date()) {
    this.fault()
    if (req.transportMode === 'ROAD' && !req.vehicleNo) throw new EwbProviderError('Vehicle number is required for road transport', 'vehicleNo')
    if (req.transportMode !== 'ROAD' && !req.transportDocNo) throw new EwbProviderError('Transport document number is required', 'transportDocNo')
    return { validUpto: computeValidity(now, req.distanceKm, req.vehicleType, req.kmPerDay), updatedAt: now.toISOString() }
  }

  async cancel(req: EwbCancelRequest, now = new Date()) {
    this.fault()
    const hours = req.windowHours ?? 24
    const ageMs = now.getTime() - new Date(req.generatedAt).getTime()
    if (ageMs > hours * 3600 * 1000) throw new EwbProviderError(`E-way bills can only be cancelled within ${hours} hours of generation`)
    return { cancelledAt: now.toISOString() }
  }

  async updateTransporter(req: { ewbNo: string; transporterGstin: string }, now = new Date()) {
    this.fault()
    if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(req.transporterGstin)) throw new EwbProviderError('Transporter ID must be a 15-character GSTIN or TRANSIN', 'transporterId')
    return { updatedAt: now.toISOString() }
  }

  async extendValidity(req: EwbExtendRequest, now = new Date()) {
    this.fault()
    if (!canExtendAt(req.validUpto, now, req.windowHours)) throw new EwbProviderError(`Validity can be extended only within ${req.windowHours} hours before or after it expires`)
    if (req.transportMode === 'ROAD' && !req.vehicleNo) throw new EwbProviderError('Vehicle number is required for road transport', 'vehicleNo')
    // The extension runs from the later of now and the current expiry.
    const base = new Date(Math.max(now.getTime(), Date.parse(req.validUpto)))
    return { validUpto: computeValidity(base, req.remainingDistanceKm, req.vehicleType, req.kmPerDay), updatedAt: now.toISOString() }
  }

  async getStatus(req: { ewbNo: string; validUpto: string | null; cancelled: boolean }, now = new Date()) {
    this.fault()
    const status = req.cancelled ? 'CANCELLED' : req.validUpto && Date.parse(req.validUpto) < now.getTime() ? 'EXPIRED' : 'ACTIVE'
    return { status: status as 'ACTIVE' | 'CANCELLED' | 'EXPIRED', validUpto: req.validUpto, checkedAt: now.toISOString() }
  }
}

export const LIVE_EWB_NOT_INSTALLED = 'No authorised e-way bill API adapter is installed. Live generation needs API access granted to this GSTIN (directly or through a GSP), credentials, and an adapter built from the current official specification. No request was sent.'

/** Placeholder for an authorised integration: refuses every call and never reports success. */
export class LiveEwayBillProvider implements EwayBillProvider {
  readonly id: string
  readonly isDemo = false
  constructor(readonly environment: 'SANDBOX' | 'LIVE', providerName: string | null) {
    this.id = providerName ?? `${environment}-UNCONFIGURED`
  }
  private refuse(): never {
    throw new ProviderError('NOT_CONFIGURED', 'LIVE_ADAPTER_NOT_INSTALLED', LIVE_EWB_NOT_INSTALLED)
  }
  async generate(): Promise<EwbGenerateResponse> { return this.refuse() }
  async updatePartB(): Promise<{ validUpto: string; updatedAt: string }> { return this.refuse() }
  async cancel(): Promise<{ cancelledAt: string }> { return this.refuse() }
  async updateTransporter(): Promise<{ updatedAt: string }> { return this.refuse() }
  async extendValidity(): Promise<{ validUpto: string; updatedAt: string }> { return this.refuse() }
  async getStatus(): Promise<{ status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'NOT_FOUND'; validUpto: string | null; checkedAt: string }> { return this.refuse() }
}
