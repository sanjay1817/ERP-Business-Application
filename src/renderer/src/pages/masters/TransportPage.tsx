import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { VEHICLE_BODY_TYPES, type TransportDoc, type TransportMasters, type Transporter, type Vehicle } from '@shared/gst'
import { GST_STATES } from '@shared/india'
import type { EwbSourceCandidate } from '@shared/gst'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Tabs } from '../../components/ui'
import { Modal } from '../../components/Modal'

type Tab = 'transporters' | 'vehicles' | 'documents' | 'modes'
const MODES = ['ROAD', 'RAIL', 'AIR', 'SHIP'] as const

export default function TransportPage() {
  const { session, can } = useSession()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('transporters')
  const q = useQuery<TransportMasters>(() => api('transport:masters'), [session?.company?.id])
  const manage = can('ewaybill.manage')
  const [t, setT] = useState<null | { id?: number; name: string; transporterId: string; phone: string; contactPerson: string; address: string; stateCode: string; email: string; modes: string[]; isActive: boolean }>(null)
  const [v, setV] = useState<null | { id?: number; vehicleNo: string; vehicleType: string; bodyType: string; transporterId: string; capacityKg: string; isOwn: boolean; isActive: boolean }>(null)
  const [d, setD] = useState<null | { id?: number; transportMode: string; docNo: string; docDate: string; transporterId: string; vehicleId: string; source: string; fromPlace: string; toPlace: string; distanceKm: string; notes: string }>(null)
  const [err, setErr] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const sources = useQuery<EwbSourceCandidate[] | null>(() => (d ? api('ewaybill:sources', { from: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), to: today }) : Promise.resolve(null)), [!!d])
  const save = async (fn: () => Promise<unknown>, ok: string, close: () => void) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      toast('success', ok)
      close()
      q.reload()
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }
  const m = q.data
  return (
    <div>
      <PageHeader title="Transport" description="Transporters, vehicles and transport documents (LR / RR / AWB / BL) used by delivery challans, invoices and e-way bills."
        actions={manage ? <span className="flex gap-2">
          {tab === 'transporters' && <Button icon={<Plus className="size-4" />} onClick={() => setT({ name: '', transporterId: '', phone: '', contactPerson: '', address: '', stateCode: '', email: '', modes: ['ROAD'], isActive: true })}>Add transporter</Button>}
          {tab === 'vehicles' && <Button icon={<Plus className="size-4" />} onClick={() => setV({ vehicleNo: '', vehicleType: 'REGULAR', bodyType: 'TRUCK', transporterId: '', capacityKg: '', isOwn: false, isActive: true })}>Add vehicle</Button>}
          {tab === 'documents' && <Button icon={<Plus className="size-4" />} onClick={() => setD({ transportMode: 'ROAD', docNo: '', docDate: today, transporterId: '', vehicleId: '', source: '', fromPlace: '', toPlace: '', distanceKm: '', notes: '' })}>Add transport document</Button>}
        </span> : undefined} />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'transporters', label: 'Transporters', count: m?.transporters.length }, { value: 'vehicles', label: 'Vehicles', count: m?.vehicles.length }, { value: 'documents', label: 'Transport documents', count: m?.documents.length }, { value: 'modes', label: 'Transport modes' }]} /></div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {q.loading && !m ? <Spinner /> : m && (
        <Card bodyClassName="p-0">
          {tab === 'transporters' && <DataTable<Transporter> rows={m.transporters} rowKey={(x) => x.id} onRowClick={manage ? (x) => setT({ id: x.id, name: x.name, transporterId: x.transporterId, phone: x.phone ?? '', contactPerson: x.contactPerson ?? '', address: x.address ?? '', stateCode: x.stateCode ?? '', email: x.email ?? '', modes: x.modes, isActive: x.isActive }) : undefined} empty={<EmptyState title="No transporters" />} columns={[
            { key: 'n', header: 'Name', render: (x) => <span className="font-semibold">{x.name}</span>, wrap: true },
            { key: 'i', header: 'Transporter ID', render: (x) => <span className="font-mono">{x.transporterId} <Badge tone="gray">{x.idType}</Badge></span> },
            { key: 'm', header: 'Modes', render: (x) => x.modes.map((mm) => titleCase(mm)).join(', ') },
            { key: 'c', header: 'Contact', render: (x) => [x.contactPerson, x.phone].filter(Boolean).join(' · ') || '—' },
            { key: 'v', header: 'Vehicles', align: 'right', render: (x) => x.vehicleCount },
            { key: 'e', header: 'E-way bills', align: 'right', render: (x) => x.ewbCount },
            { key: 'a', header: '', render: (x) => !x.isActive && <Badge tone="gray">Inactive</Badge> }
          ]} />}
          {tab === 'vehicles' && <DataTable<Vehicle> rows={m.vehicles} rowKey={(x) => x.id} onRowClick={manage ? (x) => setV({ id: x.id, vehicleNo: x.vehicleNo, vehicleType: x.vehicleType, bodyType: x.bodyType, transporterId: x.transporterId ? String(x.transporterId) : '', capacityKg: x.capacityKg ? String(x.capacityKg) : '', isOwn: x.isOwn, isActive: x.isActive }) : undefined} empty={<EmptyState title="No vehicles" />} columns={[
            { key: 'n', header: 'Vehicle no.', render: (x) => <span className="font-mono font-semibold">{x.vehicleNo}</span> },
            { key: 't', header: 'Type', render: (x) => `${titleCase(x.bodyType)}${x.vehicleType === 'ODC' ? ' · over-dimensional' : ''}` },
            { key: 'o', header: 'Owner', render: (x) => (x.isOwn ? <Badge tone="blue">Own vehicle</Badge> : x.transporterName ?? '—') },
            { key: 'c', header: 'Capacity', align: 'right', render: (x) => (x.capacityKg ? `${x.capacityKg.toLocaleString('en-IN')} kg` : '—') },
            { key: 'e', header: 'E-way bills', align: 'right', render: (x) => x.ewbCount },
            { key: 'a', header: '', render: (x) => !x.isActive && <Badge tone="gray">Inactive</Badge> }
          ]} />}
          {tab === 'documents' && <DataTable<TransportDoc> rows={m.documents} rowKey={(x) => x.id} empty={<EmptyState title="No transport documents" />} columns={[
            { key: 'd', header: 'Date', render: (x) => formatDate(x.docDate) },
            { key: 'n', header: 'Document', render: (x) => <span><span className="font-semibold">{x.docNo}</span><span className="block text-[11.5px] text-ink-3">{titleCase(x.transportMode)}</span></span> },
            { key: 't', header: 'Transporter / vehicle', render: (x) => [x.transporterName, x.vehicleNo].filter(Boolean).join(' · ') || '—' },
            { key: 's', header: 'For', render: (x) => (x.sourceRoute ? <Link className="text-brand-700 hover:underline" to={x.sourceRoute}>{x.sourceNo}</Link> : '—') },
            { key: 'r', header: 'Route', render: (x) => [x.fromPlace, x.toPlace].filter(Boolean).join(' → ') || '—' },
            { key: 'k', header: 'Distance', align: 'right', render: (x) => (x.distanceKm ? `${x.distanceKm} km` : '—') },
            { key: 'e', header: 'E-way bill', render: (x) => (x.ewbNo ? <span className="font-mono">{x.ewbNo}</span> : '—') }
          ]} />}
          {tab === 'modes' && (
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-[11.5px] text-ink-3 uppercase"><tr><th className="px-4 py-2 text-left">Mode</th><th className="px-4 py-2 text-left">Part B needs</th></tr></thead>
              <tbody>{m.modes.map((mm) => <tr key={mm.code} className="border-t border-slate-100"><td className="px-4 py-2 font-semibold">{mm.label}</td><td className="px-4 py-2 text-ink-2">{mm.partBDocument}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      )}
      <Modal open={!!t} title={t?.id ? 'Edit transporter' : 'Add transporter'} onClose={() => { setT(null); setErr(null) }} width="max-w-2xl" footer={<><Button variant="secondary" onClick={() => setT(null)}>Cancel</Button><Button loading={busy} onClick={() => t && void save(() => api('transport:saveTransporter', { ...(t.id ? { id: t.id } : {}), name: t.name, transporterId: t.transporterId, phone: t.phone, contactPerson: t.contactPerson, address: t.address, stateCode: t.stateCode || null, email: t.email, modes: t.modes as Array<'ROAD'>, isActive: t.isActive }), 'Transporter saved', () => setT(null))}>Save</Button></>}>
        {err && <ErrorBanner error={err} />}
        {t && <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required><Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="GSTIN / TRANSIN" required hint="15 characters; GSTIN check digit is verified"><Input className="font-mono uppercase" maxLength={15} value={t.transporterId} onChange={(e) => setT({ ...t, transporterId: e.target.value.toUpperCase() })} /></Field>
          <Field label="Contact person"><Input value={t.contactPerson} onChange={(e) => setT({ ...t, contactPerson: e.target.value })} /></Field>
          <Field label="Phone"><Input value={t.phone} onChange={(e) => setT({ ...t, phone: e.target.value })} /></Field>
          <Field label="Email"><Input value={t.email} onChange={(e) => setT({ ...t, email: e.target.value })} /></Field>
          <Field label="State"><Select value={t.stateCode} onChange={(e) => setT({ ...t, stateCode: e.target.value })}><option value="">—</option>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select></Field>
          <Field label="Address" className="col-span-2"><Input value={t.address} onChange={(e) => setT({ ...t, address: e.target.value })} /></Field>
          <div className="col-span-2 flex flex-wrap gap-4 text-[13px]">{MODES.map((mm) => <label key={mm} className="flex items-center gap-1.5"><input type="checkbox" checked={t.modes.includes(mm)} onChange={(e) => setT({ ...t, modes: e.target.checked ? [...t.modes, mm] : t.modes.filter((x) => x !== mm) })} />{titleCase(mm)}</label>)}<label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={t.isActive} onChange={(e) => setT({ ...t, isActive: e.target.checked })} />Active</label></div>
        </div>}
      </Modal>
      <Modal open={!!v} title={v?.id ? 'Edit vehicle' : 'Add vehicle'} onClose={() => { setV(null); setErr(null) }} footer={<><Button variant="secondary" onClick={() => setV(null)}>Cancel</Button><Button loading={busy} onClick={() => v && void save(() => api('transport:saveVehicle', { ...(v.id ? { id: v.id } : {}), vehicleNo: v.vehicleNo, vehicleType: v.vehicleType as 'REGULAR', bodyType: v.bodyType as 'TRUCK', transporterId: v.isOwn || !v.transporterId ? null : Number(v.transporterId), capacityKg: v.capacityKg ? Number(v.capacityKg) : null, isOwn: v.isOwn, isActive: v.isActive }), 'Vehicle saved', () => setV(null))}>Save</Button></>}>
        {err && <ErrorBanner error={err} />}
        {v && m && <div className="grid grid-cols-2 gap-3">
          <Field label="Vehicle number" required><Input className="font-mono uppercase" value={v.vehicleNo} onChange={(e) => setV({ ...v, vehicleNo: e.target.value.toUpperCase() })} placeholder="TN09AB1234" /></Field>
          <Field label="Body type"><Select value={v.bodyType} onChange={(e) => setV({ ...v, bodyType: e.target.value })}>{VEHICLE_BODY_TYPES.map((b) => <option key={b} value={b}>{titleCase(b)}</option>)}</Select></Field>
          <Field label="Cargo"><Select value={v.vehicleType} onChange={(e) => setV({ ...v, vehicleType: e.target.value })}><option value="REGULAR">Regular</option><option value="ODC">Over-dimensional cargo</option></Select></Field>
          <Field label="Capacity (kg)"><Input inputMode="numeric" value={v.capacityKg} onChange={(e) => setV({ ...v, capacityKg: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={v.isOwn} onChange={(e) => setV({ ...v, isOwn: e.target.checked })} />Own vehicle</label>
          <Field label="Transporter"><Select value={v.transporterId} disabled={v.isOwn} onChange={(e) => setV({ ...v, transporterId: e.target.value })}><option value="">—</option>{m.transporters.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        </div>}
      </Modal>
      <Modal open={!!d} title="Transport document" onClose={() => { setD(null); setErr(null) }} width="max-w-2xl" footer={<><Button variant="secondary" onClick={() => setD(null)}>Cancel</Button><Button loading={busy} onClick={() => {
        if (!d) return
        const [sk, sid] = d.source ? d.source.split(':') : [null, null]
        void save(() => api('transport:saveDoc', { transportMode: d.transportMode as 'ROAD', docNo: d.docNo, docDate: d.docDate, transporterId: d.transporterId ? Number(d.transporterId) : null, vehicleId: d.vehicleId ? Number(d.vehicleId) : null, sourceKind: (sk as 'SALES_INVOICE') ?? null, sourceId: sid ? Number(sid) : null, fromPlace: d.fromPlace, toPlace: d.toPlace, distanceKm: d.distanceKm ? Number(d.distanceKm) : null, notes: d.notes }), 'Transport document saved', () => setD(null))
      }}>Save</Button></>}>
        {err && <ErrorBanner error={err} />}
        {d && m && <div className="grid grid-cols-2 gap-3">
          <Field label="Mode"><Select value={d.transportMode} onChange={(e) => setD({ ...d, transportMode: e.target.value })}>{MODES.map((mm) => <option key={mm} value={mm}>{titleCase(mm)}</option>)}</Select></Field>
          <Field label="Document no. (LR / RR / AWB / BL)" required><Input value={d.docNo} maxLength={15} onChange={(e) => setD({ ...d, docNo: e.target.value })} /></Field>
          <Field label="Date" required><Input type="date" value={d.docDate} onChange={(e) => setD({ ...d, docDate: e.target.value })} /></Field>
          <Field label="Transporter"><Select value={d.transporterId} onChange={(e) => setD({ ...d, transporterId: e.target.value })}><option value="">—</option>{m.transporters.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Vehicle"><Select value={d.vehicleId} onChange={(e) => setD({ ...d, vehicleId: e.target.value })}><option value="">—</option>{m.vehicles.map((x) => <option key={x.id} value={x.id}>{x.vehicleNo}</option>)}</Select></Field>
          <Field label="For sales document"><Select value={d.source} onChange={(e) => setD({ ...d, source: e.target.value })}><option value="">— not linked —</option>{(sources.data ?? []).map((s) => <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>{s.number} · {s.partyName}</option>)}</Select></Field>
          <Field label="From"><Input value={d.fromPlace} onChange={(e) => setD({ ...d, fromPlace: e.target.value })} /></Field>
          <Field label="To"><Input value={d.toPlace} onChange={(e) => setD({ ...d, toPlace: e.target.value })} /></Field>
          <Field label="Distance (km)"><Input inputMode="numeric" value={d.distanceKm} onChange={(e) => setD({ ...d, distanceKm: e.target.value })} /></Field>
          <Field label="Notes"><Input value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  )
}
