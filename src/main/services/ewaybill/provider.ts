/**
 * E-Way Bill provider abstraction.
 *
 * The ERP talks to this interface only. MockEwayBillProvider returns clearly marked
 * DEMO numbers; LiveEwayBillProvider is a placeholder that refuses every call until an
 * authorised adapter (built from the provider's current official specification) exists.
 * No endpoint, authentication scheme or response format is assumed here.
 */
import { ewbValidUntil } from '@shared/gst'

export type TransportMode = 'ROAD' | 'RAIL' | 'AIR' | 'SHIP'
export type VehicleType = 'REGULAR' | 'ODC'

export interface EwbParty {
  gstin: string | null // 'URP' semantics when null (unregistered person)
  name: string
  address: string
  stateCode: string
  pincode: string | null
}

export interface EwbItem {
  productName: string
  hsn: string
  qtyMilli: number
  unit: string
  taxablePaise: number
  taxRateBps: number
}

/** Kilometres per validity day, from the effective compliance rules. */
export interface KmPerDay { regular: number; odc: number }

export interface EwbGenerateRequest {
  supplyType: 'OUTWARD' | 'INWARD'
  subSupplyType: 'SUPPLY' | 'EXPORT' | 'JOB_WORK' | 'OTHERS'
  documentType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'DELIVERY_CHALLAN'
  documentNo: string
  documentDate: string // YYYY-MM-DD
  transactionType: 'REGULAR' | 'BILL_TO_SHIP_TO' | 'BILL_FROM_DISPATCH_FROM' | 'COMBINATION'
  from: EwbParty
  to: EwbParty
  items: EwbItem[]
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalValuePaise: number
  transportMode: TransportMode
  distanceKm: number
  transporterGstin: string | null
  transporterName: string | null
  transportDocNo: string | null
  transportDocDate: string | null
  vehicleNo: string | null
  vehicleType: VehicleType
  kmPerDay?: KmPerDay
  maxDistanceKm?: number
  requestKey?: string
}

export interface EwbGenerateResponse {
  ewbNo: string
  ewbDate: string // ISO timestamp
  /** null when only Part A was filed (no vehicle / transport document yet). */
  validUpto: string | null
}

export interface EwbPartBRequest {
  ewbNo: string
  generatedAt: string
  distanceKm: number
  vehicleType: VehicleType
  transportMode: TransportMode
  vehicleNo: string | null
  transportDocNo: string | null
  reason: string
  remarks: string | null
  kmPerDay?: KmPerDay
}

export interface EwbCancelRequest {
  ewbNo: string
  generatedAt: string
  reasonCode: 1 | 2 | 3 | 4
  remarks: string
  windowHours?: number
}

export interface EwbExtendRequest {
  ewbNo: string
  validUpto: string
  remainingDistanceKm: number
  vehicleType: VehicleType
  transportMode: TransportMode
  vehicleNo: string | null
  reasonCode: number
  remarks: string
  currentPlace: string
  currentStateCode: string
  windowHours: number
  kmPerDay: KmPerDay
}

export interface EwayBillProvider {
  /** Stored on each record, e.g. 'DEMO'. */
  readonly id: string
  /** True for any non-government provider. Records are flagged and labelled DEMO in the UI. */
  readonly isDemo: boolean
  readonly environment?: 'DEMO' | 'SANDBOX' | 'LIVE'
  generate(req: EwbGenerateRequest, now?: Date): Promise<EwbGenerateResponse>
  updatePartB(req: EwbPartBRequest, now?: Date): Promise<{ validUpto: string; updatedAt: string }>
  cancel(req: EwbCancelRequest, now?: Date): Promise<{ cancelledAt: string }>
  updateTransporter?(req: { ewbNo: string; transporterGstin: string }, now?: Date): Promise<{ updatedAt: string }>
  extendValidity?(req: EwbExtendRequest, now?: Date): Promise<{ validUpto: string; updatedAt: string }>
  getStatus?(req: { ewbNo: string; validUpto: string | null; cancelled: boolean }, now?: Date): Promise<{ status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'NOT_FOUND'; validUpto: string | null; checkedAt: string }>
}

/** Validation failure reported by a provider (non-retryable). */
export class EwbProviderError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message)
  }
}

/** Validity per CGST Rule 138(10) method; km/day defaults apply only when no rule set is passed. */
export function computeValidity(from: Date, distanceKm: number, vehicleType: VehicleType, kmPerDay: KmPerDay = { regular: 200, odc: 20 }): string {
  return ewbValidUntil(from.toISOString(), distanceKm, vehicleType === 'ODC' ? kmPerDay.odc : kmPerDay.regular)
}
