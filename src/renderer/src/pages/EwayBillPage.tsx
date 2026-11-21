import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Ban, CalendarClock, Clock, FileDown, Plus, Printer, Search, Truck, UserRoundCog } from 'lucide-react'
import type { EwayBill } from '@shared/types'
import { EWB_CANCEL_REASONS, EWB_PARTB_REASONS, TRANSPORT_MODES } from '@shared/schemas'
import { EWB_EXTEND_REASONS, type ApiRequestRow, type EwbPreview, type EwbSourceCandidate, type TransportMasters } from '@shared/gst'
import { GST_STATES } from '@shared/india'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { useToast } from '../lib/toast'
import { integer, text, useForm } from '../lib/form'
import { formatDate, formatDateTime, formatINR, formatPercentBps, milliToString, stateName, titleCase } from '../lib/format'
import { Badge, Button, Card, DataTable, DemoBadge, Drawer, EmptyState, ErrorBanner, Field, FormSection, Input, KeyValue, PageHeader, Select, Spinner, Tabs, cx } from '../components/ui'
import { PeriodBar, usePeriod } from './finance/shared'
import { HtmlPreview } from '../components/HtmlPreview'

const STATUS_TONE = { ACTIVE: 'green', PART_A_ONLY: 'amber', CANCELLED: 'red', EXPIRED: 'gray' } as const
const STATUS_LABEL = { ACTIVE: 'Active', PART_A_ONLY: 'Part A only', CANCELLED: 'Cancelled', EXPIRED: 'Expired' }
const REQ_TONE = { REQUIRED: 'amber', NOT_REQUIRED: 'gray', NOT_APPLICABLE: 'gray' } as const
const REQ_LABEL = { REQUIRED: 'Likely required', NOT_REQUIRED: 'Within limit', NOT_APPLICABLE: 'Not applicable' }
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

function DemoDisclaimer() {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p>
        <strong>DEMO MODE — mock provider.</strong> Numbers shown here (prefixed “DEMO”) are generated locally for demonstration. They are{' '}
        <strong>not government-issued e-way bills</strong> and are not valid for transporting goods. Applicability shown is indicative and based on the configured rules — state limits and exemptions differ.
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-lg border border-line">
      <h3 className="border-b border-line bg-slate-50 px-4 py-2 text-[12px] font-bold tracking-wider text-ink-3 uppercase">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4">{children}</dl>
    </section>
  )
}

const expiryText = (e: EwayBill) => (e.hoursToExpiry === null ? '—' : e.hoursToExpiry < 0 ? `expired ${Math.abs(Math.round(e.hoursToExpiry))} h ago` : `${Math.round(e.hoursToExpiry)} h left`)

function Detail({ ewb, onChanged }: { ewb: EwayBill; onChanged: (e: EwayBill) => void }) {
  const { can } = useSession()
  const toast = useToast()
  const [mode, setMode] = useState<'view' | 'partb' | 'cancel' | 'transporter' | 'extend'>('view')
  const masters = useQuery<TransportMasters>(() => api('transport:masters'))
  const log = useQuery<ApiRequestRow[]>(() => api('integration:apiLog', { entityType: 'ewaybill', entityId: ewb.id }), [ewb.id, ewb.history.length])
  const partB = useForm({ transportMode: ewb.transportMode, vehicleNo: ewb.vehicleNo ?? '', transportDocNo: ewb.transportDocNo ?? '', reason: ewb.vehicleNo ? 'BREAKDOWN' : 'FIRST_TIME', remarks: '' })
  const cancel = useForm({ reasonCode: '3', remarks: '' })
  const trans = useForm({ transporterId: '' })
  const ext = useForm({ reasonCode: '3', remarks: '', currentPlace: '', currentStateCode: ewb.toStateCode, remainingDistanceKm: '', transportMode: ewb.transportMode, vehicleNo: ewb.vehicleNo ?? '' })
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const live = ewb.status === 'ACTIVE' || ewb.status === 'PART_A_ONLY'
  const editable = can('ewaybill.manage') && live
  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name)
    try {
      const r = await fn()
      if (ok) toast('success', ok)
      if (r && typeof r === 'object' && 'ewbNo' in (r as object)) onChanged(r as EwayBill)
    } catch (e) {
      toast('error', `${titleCase(name)} failed`, (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-navy-900 px-5 py-4 text-white">
        <Truck className="size-6 text-brand-500" />
        <div>
          <p className="text-[11px] tracking-wider text-navy-300 uppercase">E-way bill no.</p>
          <p className="font-mono text-[20px] font-bold">{ewb.ewbNo}</p>
        </div>
        {ewb.isDemo && <DemoBadge label="DEMO · NOT GOVERNMENT-ISSUED" />}
        <Badge tone={STATUS_TONE[ewb.status]} className="ml-auto">{STATUS_LABEL[ewb.status]}</Badge>
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        <Button variant="secondary" onClick={() => setPreview(true)}>Preview</Button>
        <Button variant="secondary" icon={<Printer className="size-4" />} loading={busy === 'print'} onClick={() => void run('print', () => api('ewaybill:print', { id: ewb.id }))}>Print</Button>
        <Button variant="secondary" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} onClick={() => void run('pdf', async () => { const r = await api('ewaybill:exportPdf', { id: ewb.id }); if (r.path) toast('success', 'PDF saved', r.path) })}>PDF</Button>
        {can('ewaybill.manage') && <Button variant="secondary" icon={<Search className="size-4" />} loading={busy === 'status'} onClick={() => void run('status', () => api('ewaybill:status', { id: ewb.id }), 'Status retrieved')}>Check status</Button>}
        {ewb.sourceRoute && <Link to={ewb.sourceRoute}><Button variant="ghost">Open {ewb.sourceKind === 'DELIVERY_CHALLAN' ? 'challan' : 'invoice'}</Button></Link>}
      </div>

      <HtmlPreview open={preview} title={`E-way bill print — ${ewb.ewbNo}`} load={() => api('ewaybill:printHtml', { id: ewb.id })} onClose={() => setPreview(false)} />
      <Section title="Validity">
        <KeyValue label="Generated" value={formatDateTime(ewb.ewbDate)} />
        <KeyValue label="Valid until" value={ewb.validUpto ? <span>{formatDateTime(ewb.validUpto)} <span className={cx('text-[12px]', ewb.hoursToExpiry !== null && ewb.hoursToExpiry < 24 ? 'text-amber-700' : 'text-ink-3')}>({expiryText(ewb)})</span></span> : <span className="text-amber-700">Not valid for movement until Part B is entered</span>} />
        <KeyValue label="Distance" value={`${ewb.distanceKm} km · ${ewb.vehicleType === 'ODC' ? 'over-dimensional cargo' : 'regular cargo'}`} />
        <KeyValue label="Extensions" value={ewb.extensionCount || 'None'} />
        <KeyValue label="Cancellation" value={ewb.status === 'CANCELLED' ? 'Cancelled' : ewb.canCancel ? `Allowed until ${formatDateTime(ewb.cancelDeadline)}` : 'Window has passed'} />
        <KeyValue label="Last status check" value={ewb.lastStatusCheckAt ? `${formatDateTime(ewb.lastStatusCheckAt)} · ${titleCase(ewb.providerStatus ?? '')}` : '—'} />
      </Section>

      <Section title="Part A — document & parties">
        <KeyValue label="Document" value={`${titleCase(ewb.documentType)} ${ewb.documentNo}`} />
        <KeyValue label="Document date" value={formatDate(ewb.documentDate)} />
        <KeyValue label="Supply type" value={`${titleCase(ewb.supplyType)} · ${titleCase(ewb.subSupplyType)}`} />
        <KeyValue label="Transaction type" value={titleCase(ewb.transactionType)} />
        <KeyValue label="Consignor (from)" value={<>{ewb.fromName}<br /><span className="font-mono text-[12.5px]">{ewb.fromGstin ?? 'URP'}</span><br /><span className="text-ink-2">{ewb.fromAddress}, {stateName(ewb.fromStateCode)} {ewb.fromPincode}</span></>} />
        <KeyValue label="Consignee (to)" value={<>{ewb.toName}<br /><span className="font-mono text-[12.5px]">{ewb.toGstin ?? 'URP'}</span><br /><span className="text-ink-2">{ewb.toAddress}, {stateName(ewb.toStateCode)} {ewb.toPincode}</span></>} />
        <div className="col-span-2">
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-[11px] text-ink-3 uppercase"><tr><th className="py-1">Item</th><th>HSN</th><th className="text-right">Qty</th><th className="text-right">Taxable</th><th className="text-right">GST</th></tr></thead>
            <tbody>{ewb.items.map((i, n) => <tr key={n} className="tabular border-t border-slate-100"><td className="py-1.5">{i.productName}</td><td className="font-mono">{i.hsn}</td><td className="text-right">{milliToString(i.qtyMilli)} {i.unit}</td><td className="text-right">{formatINR(i.taxablePaise)}</td><td className="text-right">{formatPercentBps(i.taxRateBps)}</td></tr>)}</tbody>
          </table>
          <p className="tabular mt-2 text-right text-[13px]">Taxable {formatINR(ewb.taxablePaise)} · CGST {formatINR(ewb.cgstPaise)} · SGST {formatINR(ewb.sgstPaise)} · IGST {formatINR(ewb.igstPaise)} · <strong>Total {formatINR(ewb.totalValuePaise)}</strong></p>
        </div>
      </Section>

      <Section title="Part B — transport">
        <KeyValue label="Mode" value={titleCase(ewb.transportMode)} />
        <KeyValue label="Vehicle no." value={<span className="font-mono">{ewb.vehicleNo ?? '—'}</span>} />
        <KeyValue label="Transporter" value={ewb.transporterName ? <>{ewb.transporterName}<br /><span className="font-mono text-[12.5px]">{ewb.transporterGstin}</span></> : '—'} />
        <KeyValue label="Transport doc." value={ewb.transportDocNo ? `${ewb.transportDocNo}${ewb.transportDocDate ? ` · ${formatDate(ewb.transportDocDate)}` : ''}` : '—'} />
      </Section>

      {ewb.status === 'CANCELLED' && (
        <Section title="Cancellation">
          <KeyValue label="Reason" value={ewb.cancelReason} />
          <KeyValue label="Cancelled at" value={formatDateTime(ewb.cancelledAt)} />
          <div className="col-span-2"><KeyValue label="Remarks" value={ewb.cancelRemarks} /></div>
        </Section>
      )}

      {mode === 'partb' && (
        <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
          {partB.formError && <ErrorBanner error={new Error(partB.formError)} />}
          <FormSection title="Update vehicle / Part B">
            <Field label="Mode" error={partB.errors.transportMode}><Select {...partB.bind('transportMode')}>{TRANSPORT_MODES.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
            <Field label="Vehicle no." error={partB.errors.vehicleNo}><Input {...partB.bind('vehicleNo')} list="ewb-vehicles" className="font-mono uppercase" placeholder="TN09AB1234" /></Field>
            <Field label="Transport doc. no." error={partB.errors.transportDocNo}><Input {...partB.bind('transportDocNo')} /></Field>
            <Field label="Reason" error={partB.errors.reason}><Select {...partB.bind('reason')}>{EWB_PARTB_REASONS.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select></Field>
          </FormSection>
          <datalist id="ewb-vehicles">{masters.data?.vehicles.filter((v) => v.isActive).map((v) => <option key={v.id} value={v.vehicleNo} />)}</datalist>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode('view')}>Back</Button>
            <Button loading={partB.saving} onClick={async () => {
              const v = partB.values
              const r = await partB.submit(() => ({ id: ewb.id, transportMode: text(v, 'transportMode'), vehicleNo: text(v, 'vehicleNo'), transportDocNo: text(v, 'transportDocNo'), reason: text(v, 'reason'), remarks: text(v, 'remarks') }), (p) => api('ewaybill:updatePartB', p), (e) => `Part B updated for ${e.ewbNo}`)
              if (r) (setMode('view'), onChanged(r))
            }}>Update Part B</Button>
          </div>
        </div>
      )}
      {mode === 'transporter' && (
        <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
          {trans.formError && <ErrorBanner error={new Error(trans.formError)} />}
          <FormSection title="Change transporter">
            <Field label="Transporter" error={trans.errors.transporterId} className="col-span-2"><Select {...trans.bind('transporterId')}><option value="">Select…</option>{masters.data?.transporters.filter((t) => t.isActive && t.id !== ewb.transporterId).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.transporterId}</option>)}</Select></Field>
          </FormSection>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode('view')}>Back</Button>
            <Button loading={trans.saving} onClick={async () => {
              const r = await trans.submit(() => ({ id: ewb.id, transporterId: Number(trans.values.transporterId) || 0 }), (p) => api('ewaybill:updateTransporter', p), (e) => `Transporter updated for ${e.ewbNo}`)
              if (r) (setMode('view'), onChanged(r))
            }}>Update transporter</Button>
          </div>
        </div>
      )}
      {mode === 'extend' && (
        <div className="mb-4 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
          {ext.formError && <ErrorBanner error={new Error(ext.formError)} />}
          <FormSection title="Extend validity">
            <Field label="Reason" error={ext.errors.reasonCode}><Select {...ext.bind('reasonCode')}>{Object.entries(EWB_EXTEND_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Remaining distance (km)" required error={ext.errors.remainingDistanceKm}><Input {...ext.bind('remainingDistanceKm')} inputMode="numeric" /></Field>
            <Field label="Current place" required error={ext.errors.currentPlace}><Input {...ext.bind('currentPlace')} /></Field>
            <Field label="Current state" error={ext.errors.currentStateCode}><Select {...ext.bind('currentStateCode')}>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select></Field>
            <Field label="Mode" error={ext.errors.transportMode}><Select {...ext.bind('transportMode')}>{TRANSPORT_MODES.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
            <Field label="Vehicle no." error={ext.errors.vehicleNo}><Input {...ext.bind('vehicleNo')} className="font-mono uppercase" /></Field>
            <Field label="Remarks" required error={ext.errors.remarks} className="col-span-2"><Input {...ext.bind('remarks')} /></Field>
          </FormSection>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode('view')}>Back</Button>
            <Button loading={ext.saving} onClick={async () => {
              const v = ext.values
              const r = await ext.submit(() => ({ id: ewb.id, reasonCode: Number(v.reasonCode), remarks: text(v, 'remarks'), currentPlace: text(v, 'currentPlace'), currentStateCode: text(v, 'currentStateCode'), remainingDistanceKm: integer(v, 'remainingDistanceKm'), transportMode: text(v, 'transportMode'), vehicleNo: text(v, 'vehicleNo') }), (p) => api('ewaybill:extend', p), (e) => `Validity of ${e.ewbNo} extended`)
              if (r) (setMode('view'), onChanged(r))
            }}>Extend validity</Button>
          </div>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50/50 p-4">
          {cancel.formError && <ErrorBanner error={new Error(cancel.formError)} />}
          <FormSection title="Cancel e-way bill">
            <Field label="Reason" error={cancel.errors.reasonCode}><Select {...cancel.bind('reasonCode')}>{Object.entries(EWB_CANCEL_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Remarks" required error={cancel.errors.remarks}><Input {...cancel.bind('remarks')} /></Field>
          </FormSection>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMode('view')}>Back</Button>
            <Button variant="danger" loading={cancel.saving} onClick={async () => {
              const r = await cancel.submit(() => ({ id: ewb.id, reasonCode: Number(cancel.values.reasonCode), remarks: text(cancel.values, 'remarks') }), (p) => api('ewaybill:cancel', p), (e) => `E-way bill ${e.ewbNo} cancelled`)
              if (r) (setMode('view'), onChanged(r))
            }}>Confirm cancellation</Button>
          </div>
        </div>
      )}
      {mode === 'view' && editable && (
        <div className="mb-5 flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Truck className="size-4" />} onClick={() => setMode('partb')}>Update vehicle / Part B</Button>
          <Button variant="secondary" icon={<UserRoundCog className="size-4" />} onClick={() => setMode('transporter')}>Change transporter</Button>
          {ewb.canExtend ? <Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => setMode('extend')}>Extend validity</Button> : ewb.status === 'ACTIVE' && <span className="flex items-center gap-1 text-[12.5px] text-ink-3"><CalendarClock className="size-3.5" />Extension opens close to expiry</span>}
          {ewb.canCancel ? <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setMode('cancel')}>Cancel</Button> : <span className="flex items-center gap-1 text-[12.5px] text-ink-3"><Clock className="size-3.5" />Cancellation window has passed</span>}
        </div>
      )}
      {ewb.status === 'EXPIRED' && can('ewaybill.manage') && ewb.canExtend && <div className="mb-5"><Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => setMode('extend')}>Extend validity (within the window after expiry)</Button></div>}

      <section className="mb-5">
        <h3 className="mb-2 text-[12px] font-bold tracking-wider text-ink-3 uppercase">History</h3>
        <ol className="space-y-2 border-l-2 border-line pl-4">
          {ewb.history.map((h, i) => <li key={i} className="text-[13px]"><span className="font-semibold">{titleCase(h.event)}</span> · <span className="text-ink-2">{h.detail}</span><br /><span className="text-[12px] text-ink-3">{formatDateTime(h.at)}</span></li>)}
        </ol>
      </section>
      <section>
        <h3 className="mb-2 text-[12px] font-bold tracking-wider text-ink-3 uppercase">Provider requests</h3>
        {(log.data ?? []).length === 0 ? <p className="text-[12.5px] text-ink-3">No requests recorded after generation.</p> : (
          <ul className="space-y-1 text-[12.5px]">{log.data!.map((r) => <li key={r.id}><Badge tone={r.outcome === 'SUCCESS' ? 'green' : 'red'}>{r.outcome === 'SUCCESS' ? 'OK' : 'Failed'}</Badge> {titleCase(r.operation)} · attempt {r.attempt} · {formatDateTime(r.createdAt)}{r.errorMessage && <span className="text-red-700"> — {r.errorMessage}</span>}</li>)}</ul>
        )}
      </section>
    </>
  )
}

type Filter = 'ALL' | 'ACTIVE' | 'PART_A_ONLY' | 'EXPIRING' | 'EXPIRED' | 'CANCELLED'
export default function EwayBillPage() {
  const { can, session } = useSession()
  const nav = useNavigate()
  const [filter, setFilter] = useState<Filter>('ALL')
  const list = useQuery<EwayBill[]>(() => api('ewaybill:list'), [session?.company?.id])
  const [selected, setSelected] = useState<EwayBill | null>(null)
  const all = list.data ?? []
  const expiring = all.filter((e) => e.status === 'ACTIVE' && e.hoursToExpiry !== null && e.hoursToExpiry >= 0 && e.hoursToExpiry <= 24)
  const rows = filter === 'ALL' ? all : filter === 'EXPIRING' ? expiring : all.filter((e) => e.status === filter)
  const count = (s: string) => all.filter((e) => e.status === s).length
  return (
    <div>
      <PageHeader title="E-Way Bill" badge={<DemoBadge label="DEMO PROVIDER" />} description="Register, expiry monitoring and the Part A / Part B workflow for invoices and delivery challans. Connected to the mock provider only."
        actions={<span className="flex gap-2"><Link to="/masters/transport"><Button variant="secondary">Transport masters</Button></Link>{can('ewaybill.manage') && <Button icon={<Plus className="size-4" />} onClick={() => nav('/ewaybill/new')}>New e-way bill</Button>}</span>} />
      <DemoDisclaimer />
      {expiring.length > 0 && <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900"><Clock className="size-4" /><span><strong>{expiring.length}</strong> active e-way bill(s) expire within 24 hours.</span><button className="ml-auto font-semibold underline" onClick={() => setFilter('EXPIRING')}>Show</button></div>}
      <div className="mb-3"><Tabs value={filter} onChange={setFilter} tabs={[{ value: 'ALL', label: 'All', count: all.length }, { value: 'ACTIVE', label: 'Active', count: count('ACTIVE') }, { value: 'PART_A_ONLY', label: 'Part A only', count: count('PART_A_ONLY') }, { value: 'EXPIRING', label: 'Expiring ≤ 24 h', count: expiring.length }, { value: 'EXPIRED', label: 'Expired', count: count('EXPIRED') }, { value: 'CANCELLED', label: 'Cancelled', count: count('CANCELLED') }]} /></div>
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <Card bodyClassName="p-0">
        {list.loading && !list.data ? <Spinner /> : (
          <DataTable rows={rows} rowKey={(r) => r.id} onRowClick={setSelected} empty={<EmptyState title="No e-way bills" />} columns={[
            { key: 'no', header: 'E-way bill no.', render: (r) => <span className="flex items-center gap-2 font-mono font-semibold whitespace-nowrap">{r.ewbNo}{r.isDemo && <DemoBadge />}</span> },
            { key: 'doc', header: 'Document', render: (r) => <span className="text-[12.5px] whitespace-nowrap"><span className="font-mono">{r.documentNo}</span><span className="block text-[11.5px] text-ink-3">{r.sourceKind === 'DELIVERY_CHALLAN' ? 'Delivery challan' : 'Tax invoice'}</span></span> },
            { key: 'to', header: 'Consignee · route', render: (r) => <span>{r.toName}<span className="block text-[11.5px] text-ink-3">{stateName(r.fromStateCode)} → {stateName(r.toStateCode)}</span></span>, wrap: true },
            { key: 'vehicle', header: 'Vehicle', render: (r) => <span className="font-mono">{r.vehicleNo ?? '—'}</span> },
            { key: 'value', header: 'Value', align: 'right', render: (r) => formatINR(r.totalValuePaise) },
            { key: 'valid', header: 'Valid until', render: (r) => (r.validUpto ? <span>{formatDateTime(r.validUpto)}<span className={cx('block text-[11.5px]', r.hoursToExpiry !== null && r.hoursToExpiry <= 24 && r.status === 'ACTIVE' ? 'font-semibold text-amber-700' : 'text-ink-3')}>{expiryText(r)}</span></span> : '—'), sortValue: (r) => r.validUpto },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> }
          ]} />
        )}
      </Card>
      <Drawer open={!!selected} onClose={() => setSelected(null)} title="E-way bill details" subtitle={selected?.documentNo} width="w-[780px]">
        {selected && <Detail key={selected.id + selected.status + (selected.vehicleNo ?? '') + selected.history.length} ewb={selected} onChanged={(e) => (setSelected(e), list.reload())} />}
      </Drawer>
    </div>
  )
}

/** Guided creation: source → validation & Part A → transport (Part B) → submit. */
export function EwayBillNewPage() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const period = usePeriod()
  const kind = params.get('kind') as 'SALES_INVOICE' | 'DELIVERY_CHALLAN' | null
  const id = Number(params.get('id')) || null
  const p = period.ready ? { from: period.from!, to: period.to! } : null
  const sources = useQuery<EwbSourceCandidate[] | null>(() => (p && !id ? api('ewaybill:sources', p) : Promise.resolve(null)), [JSON.stringify(p), id])
  const preview = useQuery<EwbPreview | null>(() => (kind && id ? api('ewaybill:preview', { kind, id }) : Promise.resolve(null)), [kind, id])
  const masters = useQuery<TransportMasters>(() => api('transport:masters'))
  const form = useForm({ transportMode: 'ROAD', transporterId: '', vehicleId: '', vehicleNo: '', vehicleType: 'REGULAR', transportDocumentId: '', transportDocNo: '', transportDocDate: '', distanceKm: '' })
  const key = useRef(newKey())
  const v = form.values
  const docsForSource = useMemo(() => (masters.data?.documents ?? []).filter((d) => d.sourceKind === kind && d.sourceId === id), [masters.data, kind, id])
  const choose = (s: EwbSourceCandidate) => setParams({ ...Object.fromEntries(params), kind: s.kind, id: String(s.id) }, { replace: false })
  return (
    <div>
      <PageHeader title="New e-way bill" description="Select the posted invoice or delivery challan, check Part A, then enter transport details (Part B)." badge={<DemoBadge label="DEMO PROVIDER" />} actions={<Button variant="secondary" icon={<ArrowLeft className="size-4" />} onClick={() => nav('/ewaybill')}>Register</Button>} />
      <DemoDisclaimer />
      {!id ? (
        <Card title="1 · Source document" bodyClassName="p-4">
          <div className="mb-3"><PeriodBar period={period} /></div>
          <ErrorBanner error={sources.error} onRetry={sources.reload} />
          {sources.loading && !sources.data ? <Spinner /> : (
            <DataTable rows={sources.data ?? []} rowKey={(s) => `${s.kind}:${s.id}`} onRowClick={(s) => !s.activeEwbNo && choose(s)} empty={<EmptyState title="No posted invoices or challans with goods in this period" />} columns={[
              { key: 'd', header: 'Date', render: (s) => formatDate(s.date), sortValue: (s) => s.date },
              { key: 'n', header: 'Document', render: (s) => <span><span className="font-semibold">{s.number}</span><span className="block text-[11.5px] text-ink-3">{s.kind === 'DELIVERY_CHALLAN' ? 'Delivery challan' : 'Sales invoice'}</span></span> },
              { key: 'p', header: 'Consignee', render: (s) => <span>{s.partyName}<br /><span className="font-mono text-[11.5px] text-ink-3">{s.partyGstin ?? 'URP'}</span></span>, wrap: true },
              { key: 'v', header: 'Consignment value', align: 'right', render: (s) => formatINR(s.consignmentValuePaise) },
              { key: 'r', header: 'E-way bill', render: (s) => (s.activeEwbNo ? <Badge tone="green">Active · {s.activeEwbNo}</Badge> : <span title={s.reason}><Badge tone={REQ_TONE[s.requirement]}>{REQ_LABEL[s.requirement]}</Badge></span>) },
              { key: 't', header: 'Transport docs', align: 'right', render: (s) => s.transportDocs || '—' }
            ]} />
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-[1fr_440px] items-start gap-4">
          <Card title="2 · Part A — consignor, consignee and goods" actions={<Button variant="ghost" onClick={() => setParams({}, { replace: false })}>Change document</Button>}>
            <ErrorBanner error={preview.error} onRetry={preview.reload} />
            {preview.data && (() => {
              const a = preview.data.partA
              return (
                <>
                  {preview.data.errors.length > 0 && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800"><strong>Cannot be generated:</strong><ul className="ml-4 list-disc">{preview.data.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
                  {preview.data.warnings.length > 0 && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900"><ul className="ml-4 list-disc">{preview.data.warnings.map((e) => <li key={e}>{e}</li>)}</ul></div>}
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <KeyValue label="Document" value={<Link className="text-brand-700 hover:underline" to={preview.data.source.route}>{titleCase(a.documentType)} {a.documentNo} · {formatDate(a.documentDate)}</Link>} />
                    <KeyValue label="Supply" value={`${titleCase(a.supplyType)} · ${titleCase(a.subSupplyType)} · ${titleCase(a.transactionType)}`} />
                    <KeyValue label="From" value={<>{a.from.name}<br /><span className="font-mono text-[12.5px]">{a.from.gstin ?? 'URP'}</span><br /><span className="text-ink-2">{a.from.address}, {stateName(a.from.stateCode)} {a.from.pincode ?? <span className="text-red-700">no PIN</span>}</span></>} />
                    <KeyValue label="To" value={<>{a.to.name}<br /><span className="font-mono text-[12.5px]">{a.to.gstin ?? 'URP'}</span><br /><span className="text-ink-2">{a.to.address}, {stateName(a.to.stateCode)} {a.to.pincode ?? <span className="text-red-700">no PIN</span>}</span></>} />
                  </dl>
                  <table className="mt-3 w-full text-[12.5px]">
                    <thead className="text-left text-[11px] text-ink-3 uppercase"><tr><th className="py-1">Item</th><th>HSN</th><th className="text-right">Qty</th><th className="text-right">Taxable</th><th className="text-right">GST</th></tr></thead>
                    <tbody>{a.items.map((i, n) => <tr key={n} className="tabular border-t border-slate-100"><td className="py-1.5">{i.productName}</td><td className="font-mono">{i.hsn}</td><td className="text-right">{milliToString(i.qtyMilli)} {i.unit}</td><td className="text-right">{formatINR(i.taxablePaise)}</td><td className="text-right">{formatPercentBps(i.taxRateBps)}</td></tr>)}</tbody>
                  </table>
                  <p className="tabular mt-2 text-right text-[13px]">Taxable {formatINR(a.taxablePaise)} · Tax {formatINR(a.cgstPaise + a.sgstPaise + a.igstPaise)} · <strong>Total {formatINR(a.totalValuePaise)}</strong></p>
                </>
              )
            })()}
          </Card>
          <Card title="3 · Part B — transport">
            {form.formError && <ErrorBanner error={new Error(form.formError)} />}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode" error={form.errors.transportMode}><Select {...form.bind('transportMode')}>{TRANSPORT_MODES.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select></Field>
              <Field label="Approx. distance (km)" required error={form.errors.distanceKm}><Input {...form.bind('distanceKm')} inputMode="numeric" /></Field>
              <Field label="Transporter" error={form.errors.transporterId} className="col-span-2"><Select {...form.bind('transporterId')}><option value="">— Own vehicle / none —</option>{masters.data?.transporters.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.transporterId} ({t.modes.join(', ').toLowerCase()})</option>)}</Select></Field>
              {v.transportMode === 'ROAD' && <>
                <Field label="Vehicle (master)" error={form.errors.vehicleId}><Select {...form.bind('vehicleId')}><option value="">Enter number instead…</option>{masters.data?.vehicles.filter((x) => x.isActive && (!v.transporterId || !x.transporterId || String(x.transporterId) === v.transporterId)).map((x) => <option key={x.id} value={x.id}>{x.vehicleNo} · {titleCase(x.bodyType)}{x.vehicleType === 'ODC' ? ' · ODC' : ''}</option>)}</Select></Field>
                <Field label="Vehicle no." error={form.errors.vehicleNo} hint="Empty = Part A only (transporter needed)"><Input {...form.bind('vehicleNo')} disabled={!!v.vehicleId} className="font-mono uppercase" placeholder="TN09AB1234" /></Field>
              </>}
              <Field label="Transport document" className="col-span-2" error={form.errors.transportDocumentId}><Select {...form.bind('transportDocumentId')}><option value="">Enter manually…</option>{docsForSource.map((d) => <option key={d.id} value={d.id}>{d.docNo} · {formatDate(d.docDate)} · {d.transporterName ?? ''}</option>)}</Select></Field>
              {!v.transportDocumentId && <>
                <Field label={`${v.transportMode === 'ROAD' ? 'LR' : v.transportMode === 'RAIL' ? 'RR' : v.transportMode === 'AIR' ? 'AWB' : 'BL'} number`} error={form.errors.transportDocNo} hint={v.transportMode === 'ROAD' ? 'Optional for road' : 'Required'}><Input {...form.bind('transportDocNo')} /></Field>
                <Field label="Document date" error={form.errors.transportDocDate}><Input type="date" {...form.bind('transportDocDate')} /></Field>
              </>}
              <Field label="Cargo" error={form.errors.vehicleType}><Select {...form.bind('vehicleType')} disabled={!!v.vehicleId}><option value="REGULAR">Regular</option><option value="ODC">Over-dimensional cargo</option></Select></Field>
            </div>
            <div className="mt-4 flex justify-end">
              <Button disabled={!preview.data || preview.data.errors.length > 0} loading={form.saving} onClick={async () => {
                const r = await form.submit(() => ({
                  sourceKind: kind, sourceId: id, requestKey: key.current, transportMode: text(v, 'transportMode'), transporterId: v.transporterId ? Number(v.transporterId) : null,
                  vehicleId: v.vehicleId ? Number(v.vehicleId) : null, vehicleNo: v.vehicleId ? null : text(v, 'vehicleNo'), vehicleType: text(v, 'vehicleType'),
                  transportDocumentId: v.transportDocumentId ? Number(v.transportDocumentId) : null, transportDocNo: v.transportDocumentId ? null : text(v, 'transportDocNo'), transportDocDate: v.transportDocumentId ? null : text(v, 'transportDocDate') || null,
                  distanceKm: integer(v, 'distanceKm')
                }), (payload) => api('ewaybill:generate', payload), (e) => `DEMO e-way bill ${e.ewbNo} generated`)
                if (r) nav('/ewaybill')
              }}>Submit (DEMO)</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
