/**
 * Transport masters: transporters (GSTIN / TRANSIN), vehicles and transport documents
 * (LR / RR / AWB / BL), linked to sales invoices, delivery challans and e-way bills.
 */
import type { z } from 'zod'
import { docRoute } from '@shared/documents'
import { GSTIN_PATTERN } from '@shared/india'
import type { TransportDoc, TransportDocSaveInput, Transporter, TransporterSaveInput, TransportMasters, Vehicle, VehicleSaveInput } from '@shared/gst'
import { writeAudit } from './audit'
import { bool, inTransaction, type ServiceContext } from './context'
import { businessRule, notFound } from './errors'

type Row = Record<string, unknown>

export const TRANSPORT_MODE_INFO = [
  { code: 'ROAD', label: 'Road', partBDocument: 'Vehicle number (or LR number with vehicle)' },
  { code: 'RAIL', label: 'Rail', partBDocument: 'Railway receipt (RR) number and date' },
  { code: 'AIR', label: 'Air', partBDocument: 'Airway bill (AWB) number and date' },
  { code: 'SHIP', label: 'Ship', partBDocument: 'Bill of lading (BL) number and date' }
]

export function listTransporters(ctx: ServiceContext): Transporter[] {
  return (ctx.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM vehicles v WHERE v.transporter_id = t.id) AS vc, (SELECT COUNT(*) FROM ewaybill_records e WHERE e.transporter_id = t.id) AS ec FROM transporters t WHERE t.company_id = ? ORDER BY t.name`).all(ctx.companyId) as Row[]).map((r) => ({
    id: r.id as number, name: r.name as string, transporterId: r.transporter_id as string, idType: GSTIN_PATTERN.test(r.transporter_id as string) ? 'GSTIN' : 'TRANSIN',
    phone: r.phone as string | null, contactPerson: r.contact_person as string | null, address: r.address as string | null, stateCode: r.state_code as string | null, email: r.email as string | null,
    modes: String(r.modes ?? 'ROAD').split(',').filter(Boolean), isActive: bool(r.is_active), vehicleCount: r.vc as number, ewbCount: r.ec as number
  }))
}

export function listVehicles(ctx: ServiceContext): Vehicle[] {
  return (ctx.db.prepare(`SELECT v.*, t.name AS tname, (SELECT COUNT(*) FROM ewaybill_records e WHERE e.vehicle_no = v.vehicle_no AND e.company_id = v.company_id) AS ec FROM vehicles v LEFT JOIN transporters t ON t.id = v.transporter_id WHERE v.company_id = ? ORDER BY v.vehicle_no`).all(ctx.companyId) as Row[]).map((r) => ({
    id: r.id as number, vehicleNo: r.vehicle_no as string, vehicleType: r.vehicle_type as 'REGULAR' | 'ODC', bodyType: r.body_type as string, transporterId: r.transporter_id as number | null,
    transporterName: r.tname as string | null, capacityKg: r.capacity_kg as number | null, isOwn: bool(r.is_own), isActive: bool(r.is_active), ewbCount: r.ec as number
  }))
}

export function listTransportDocs(ctx: ServiceContext, f: { sourceKind?: string; sourceId?: number } = {}): TransportDoc[] {
  const where = ['d.company_id = ?']
  const args: unknown[] = [ctx.companyId]
  if (f.sourceKind) { where.push('d.source_kind = ?'); args.push(f.sourceKind) }
  if (f.sourceId) { where.push('d.source_id = ?'); args.push(f.sourceId) }
  return (
    ctx.db
      .prepare(
        `SELECT d.*, t.name AS tname, v.vehicle_no AS vno,
           CASE d.source_kind WHEN 'SALES_INVOICE' THEN (SELECT invoice_no FROM sales_invoices WHERE id = d.source_id) WHEN 'DELIVERY_CHALLAN' THEN (SELECT doc_no FROM trade_documents WHERE id = d.source_id) END AS sno,
           (SELECT ewb_no FROM ewaybill_records e WHERE e.transport_document_id = d.id ORDER BY e.id DESC LIMIT 1) AS ewb_no
         FROM transport_documents d LEFT JOIN transporters t ON t.id = d.transporter_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.id DESC`
      )
      .all(...args) as Row[]
  ).map((r) => ({
    id: r.id as number, transportMode: r.transport_mode as string, docNo: r.doc_no as string, docDate: r.doc_date as string, transporterId: r.transporter_id as number | null, transporterName: r.tname as string | null,
    vehicleId: r.vehicle_id as number | null, vehicleNo: r.vno as string | null, sourceKind: r.source_kind as string | null, sourceId: r.source_id as number | null, sourceNo: r.sno as string | null,
    sourceRoute: r.source_kind && r.source_id ? docRoute(r.source_kind as 'SALES_INVOICE', r.source_id as number) : null, fromPlace: r.from_place as string | null, toPlace: r.to_place as string | null,
    distanceKm: r.distance_km as number | null, notes: r.notes as string | null, ewbNo: r.ewb_no as string | null, createdAt: r.created_at as string
  }))
}

export function transportMasters(ctx: ServiceContext): TransportMasters {
  return { transporters: listTransporters(ctx), vehicles: listVehicles(ctx), documents: listTransportDocs(ctx), modes: TRANSPORT_MODE_INFO }
}

export function saveTransporter(ctx: ServiceContext, input: z.infer<typeof TransporterSaveInput>): Transporter[] {
  return inTransaction(ctx.db, () => {
    const vals = [input.name, input.transporterId, input.phone, input.contactPerson, input.address, input.stateCode ?? null, input.email, input.modes.join(','), input.isActive ? 1 : 0, ctx.userId]
    if (input.id) {
      if (!ctx.db.prepare('SELECT 1 FROM transporters WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId)) throw notFound('Transporter')
      ctx.db.prepare(`UPDATE transporters SET name=?, transporter_id=?, phone=?, contact_person=?, address=?, state_code=?, email=?, modes=?, is_active=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO transporters (name, transporter_id, phone, contact_person, address, state_code, email, modes, is_active, updated_by, company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, ctx.companyId)
    }
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: input.id ? 'UPDATE' : 'CREATE', entityType: 'transporter', summary: `Transporter ${input.name} (${input.transporterId}) saved` })
    return listTransporters(ctx)
  })
}

export function saveVehicle(ctx: ServiceContext, input: z.infer<typeof VehicleSaveInput>): Vehicle[] {
  return inTransaction(ctx.db, () => {
    if (input.transporterId && !ctx.db.prepare('SELECT 1 FROM transporters WHERE id = ? AND company_id = ?').get(input.transporterId, ctx.companyId)) throw businessRule('Select a valid transporter', { transporterId: 'Select a valid transporter' })
    if (input.isOwn && input.transporterId) throw businessRule('An own vehicle has no transporter', { transporterId: 'Clear the transporter for an own vehicle' })
    const vals = [input.vehicleNo, input.vehicleType, input.bodyType, input.transporterId ?? null, input.capacityKg ?? null, input.isOwn ? 1 : 0, input.isActive ? 1 : 0]
    if (input.id) {
      if (!ctx.db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId)) throw notFound('Vehicle')
      ctx.db.prepare(`UPDATE vehicles SET vehicle_no=?, vehicle_type=?, body_type=?, transporter_id=?, capacity_kg=?, is_own=?, is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO vehicles (vehicle_no, vehicle_type, body_type, transporter_id, capacity_kg, is_own, is_active, company_id) VALUES (?,?,?,?,?,?,?,?)`).run(...vals, ctx.companyId)
    }
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: input.id ? 'UPDATE' : 'CREATE', entityType: 'vehicle', summary: `Vehicle ${input.vehicleNo} saved` })
    return listVehicles(ctx)
  })
}

export function saveTransportDoc(ctx: ServiceContext, input: z.infer<typeof TransportDocSaveInput>): TransportDoc[] {
  return inTransaction(ctx.db, () => {
    if (input.transporterId && !ctx.db.prepare('SELECT 1 FROM transporters WHERE id = ? AND company_id = ?').get(input.transporterId, ctx.companyId)) throw businessRule('Select a valid transporter', { transporterId: 'Select a valid transporter' })
    if (input.vehicleId && !ctx.db.prepare('SELECT 1 FROM vehicles WHERE id = ? AND company_id = ?').get(input.vehicleId, ctx.companyId)) throw businessRule('Select a valid vehicle', { vehicleId: 'Select a valid vehicle' })
    if (input.transportMode === 'ROAD' && !input.vehicleId && !input.transporterId) throw businessRule('Road transport documents need a vehicle or a transporter', { vehicleId: 'Select a vehicle or transporter' })
    if (input.sourceKind && input.sourceId) {
      const ok = input.sourceKind === 'SALES_INVOICE'
        ? ctx.db.prepare(`SELECT 1 FROM sales_invoices WHERE id = ? AND company_id = ? AND status = 'POSTED'`).get(input.sourceId, ctx.companyId)
        : ctx.db.prepare(`SELECT 1 FROM trade_documents WHERE id = ? AND company_id = ? AND doc_type = 'DELIVERY_CHALLAN' AND status = 'POSTED'`).get(input.sourceId, ctx.companyId)
      if (!ok) throw businessRule('Link a posted sales invoice or delivery challan', { sourceId: 'Select a posted document' })
    }
    const vals = [input.transportMode, input.docNo, input.docDate, input.transporterId ?? null, input.vehicleId ?? null, input.sourceKind ?? null, input.sourceId ?? null, input.fromPlace, input.toPlace, input.distanceKm ?? null, input.notes]
    if (input.id) {
      if (!ctx.db.prepare('SELECT 1 FROM transport_documents WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId)) throw notFound('Transport document')
      if (ctx.db.prepare(`SELECT 1 FROM ewaybill_records WHERE transport_document_id = ? AND status IN ('ACTIVE','PART_A_ONLY')`).get(input.id)) throw businessRule('This document is on an active e-way bill; update Part B instead')
      ctx.db.prepare(`UPDATE transport_documents SET transport_mode=?, doc_no=?, doc_date=?, transporter_id=?, vehicle_id=?, source_kind=?, source_id=?, from_place=?, to_place=?, distance_km=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO transport_documents (transport_mode, doc_no, doc_date, transporter_id, vehicle_id, source_kind, source_id, from_place, to_place, distance_km, notes, company_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, ctx.companyId, ctx.userId)
    }
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: input.id ? 'UPDATE' : 'CREATE', entityType: 'transport_document', summary: `${input.transportMode} transport document ${input.docNo} saved` })
    return listTransportDocs(ctx)
  })
}
