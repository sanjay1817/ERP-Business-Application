import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Ban, FileCheck2, FileDown, Printer, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { IRN_CANCEL_REASONS, type EInvoiceCandidate, type EInvoiceDetail, type EInvoiceRow, type EInvoiceWorkspace } from '@shared/gst'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, DemoBadge, EmptyState, ErrorBanner, Field, Input, KeyValue, PageHeader, Select, Spinner, Tabs } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { HtmlPreview } from '../../components/HtmlPreview'
import { PeriodBar, SummaryStrip, usePeriod } from '../finance/shared'
import { DemoProviderBanner } from '../gst/common'

const STATUS_TONE = { PENDING: 'gray', GENERATED: 'green', FAILED: 'red', CANCELLED: 'amber' } as const
const KIND_LABEL: Record<string, string> = { SALES_INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', SALES_RETURN: 'Sales return (credit note)' }
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)

export function EInvoiceWorkspacePage() {
  const { session, can } = useSession()
  const nav = useNavigate()
  const toast = useToast()
  const period = usePeriod()
  const [tab, setTab] = useState<'ready' | 'blocked' | 'records'>('ready')
  const [busy, setBusy] = useState<string | null>(null)
  /** One request key per document per attempt: double clicks cannot create two IRN requests. */
  const keys = useRef(new Map<string, string>())
  const p = period.ready ? { from: period.from!, to: period.to! } : null
  const { data, error, loading, reload } = useQuery<EInvoiceWorkspace | null>(() => (p ? api('einvoice:workspace', p) : Promise.resolve(null)), [JSON.stringify(p), session?.company?.id])
  const ready = (data?.candidates ?? []).filter((c) => c.eligibility.applicable && !c.einvoice?.irn && c.einvoice?.status !== 'FAILED')
  const blocked = (data?.candidates ?? []).filter((c) => !c.eligibility.applicable)
  const generate = async (c: EInvoiceCandidate) => {
    const id = `${c.documentKind}:${c.documentId}`
    if (busy) return
    const requestKey = keys.current.get(id) ?? newKey()
    keys.current.set(id, requestKey)
    setBusy(id)
    try {
      const e = await api('einvoice:generate', { documentKind: c.documentKind as 'SALES_INVOICE', documentId: c.documentId, requestKey })
      toast('success', `${e.isDemo ? 'DEMO ' : ''}IRN generated for ${c.documentNo}`, e.isDemo ? 'Not registered with the IRP' : undefined)
      keys.current.delete(id)
      reload()
    } catch (err) {
      toast('error', `IRN not generated for ${c.documentNo}`, (err as Error).message)
      keys.current.delete(id) // the failed record keeps its key; a retry is done from the record
      reload()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <PageHeader title="E-Invoice (IRN)" description="Register B2B, SEZ and export invoices and credit notes with the Invoice Registration Portal through the configured provider." badge={data?.isDemo ? <DemoBadge label="DEMO PROVIDER" /> : undefined} />
      {data?.isDemo && <DemoProviderBanner what="IRNs and acknowledgement numbers" />}
      {data && !data.isDemo && <div className="mb-4 rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 text-[13px] text-violet-900"><strong>{data.mode} mode — not connected.</strong> No authorised adapter is installed, so every request fails safely and is recorded as failed.</div>}
      {data && !data.enabled && <div className="mb-4 rounded-lg border border-line bg-slate-50 px-4 py-3 text-[13px] text-ink-2">E-invoicing is not enabled for this company. Confirm applicability and enable it in <Link className="font-semibold text-brand-700" to="/gst/config?tab=settings">GST → Configuration</Link>.</div>}
      <Card bodyClassName="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2"><PeriodBar period={period} /></div>
        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? <Spinner /> : data && (
          <>
            <SummaryStrip items={[{ label: 'Ready for IRN', value: ready.length }, { label: 'Not eligible / blocked', value: blocked.length }, { label: 'Generated', value: data.counts.GENERATED, tone: 'good' }, { label: 'Failed', value: data.counts.FAILED, tone: data.counts.FAILED ? 'bad' : undefined }, { label: 'Cancelled', value: data.counts.CANCELLED }]} />
            <div className="mb-3"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'ready', label: 'Ready', count: ready.length }, { value: 'blocked', label: 'Not eligible', count: blocked.length }, { value: 'records', label: 'E-invoice register', count: data.records.length }]} /></div>
            {tab === 'ready' && (
              <DataTable rows={ready} rowKey={(c) => `${c.documentKind}:${c.documentId}`} empty={<EmptyState title="Nothing waiting for an IRN" message="Posted B2B, SEZ and export documents of the period appear here." />} columns={[
                { key: 'd', header: 'Date', render: (c) => formatDate(c.documentDate) },
                { key: 'n', header: 'Document', render: (c) => <span><Link className="font-semibold text-brand-700 hover:underline" to={c.route}>{c.documentNo}</Link><span className="block text-[11.5px] text-ink-3">{KIND_LABEL[c.documentKind]} · {c.eligibility.supplyType}</span></span> },
                { key: 'b', header: 'Buyer', render: (c) => <span>{c.buyerName}<br /><span className="font-mono text-[11.5px] text-ink-3">{c.buyerGstin ?? titleCase(c.partyRegType)}</span></span>, wrap: true },
                { key: 'v', header: 'Value', align: 'right', render: (c) => formatINR(c.totalValuePaise) },
                { key: 'x', header: 'Document check', render: (c) => (c.validation.length ? <span className="text-[12px] text-red-700">{c.validation.join(' · ')}</span> : <Badge tone="green">Ready</Badge>), wrap: true },
                { key: 'a', header: '', render: (c) => can('einvoice.manage') && <Button disabled={c.validation.length > 0 || !!busy} loading={busy === `${c.documentKind}:${c.documentId}`} icon={<FileCheck2 className="size-4" />} onClick={() => void generate(c)}>Generate IRN</Button> }
              ]} />
            )}
            {tab === 'blocked' && (
              <DataTable rows={blocked} rowKey={(c) => `${c.documentKind}:${c.documentId}`} empty={<EmptyState title="No blocked documents" />} columns={[
                { key: 'd', header: 'Date', render: (c) => formatDate(c.documentDate) },
                { key: 'n', header: 'Document', render: (c) => <Link className="font-semibold text-brand-700 hover:underline" to={c.route}>{c.documentNo}</Link> },
                { key: 'b', header: 'Buyer', render: (c) => c.buyerName, wrap: true },
                { key: 'r', header: 'Why not', render: (c) => <span className="text-[12.5px]">{c.eligibility.blockers.join(' · ')}</span>, wrap: true }
              ]} />
            )}
            {tab === 'records' && <RecordsTable rows={data.records} onOpen={(r) => nav(`/einvoice/${r.id}`)} />}
          </>
        )}
      </Card>
    </div>
  )
}

function RecordsTable({ rows, onOpen }: { rows: EInvoiceRow[]; onOpen: (r: EInvoiceRow) => void }) {
  return (
    <DataTable rows={rows} rowKey={(r) => r.id} onRowClick={onOpen} empty={<EmptyState title="No e-invoice requests yet" />} columns={[
      { key: 'd', header: 'Document', render: (r) => <span><span className="font-semibold">{r.documentNo}</span><span className="block text-[11.5px] text-ink-3">{r.documentType} · {formatDate(r.documentDate)}</span></span>, sortValue: (r) => r.documentDate },
      { key: 'b', header: 'Buyer', render: (r) => <span>{r.buyerName}<br /><span className="font-mono text-[11.5px] text-ink-3">{r.buyerGstin ?? r.supplyType}</span></span>, wrap: true },
      { key: 'v', header: 'Value', align: 'right', render: (r) => formatINR(r.totalValuePaise) },
      { key: 'i', header: 'IRN / Ack', render: (r) => (r.irn ? <span className="font-mono text-[11.5px]">{r.irn.slice(0, 22)}…<span className="block">{r.ackNo}</span></span> : <span className="text-[12px] text-red-700">{r.errorMessage ?? '—'}</span>), wrap: true },
      { key: 'a', header: 'Attempts', align: 'right', render: (r) => r.attempts },
      { key: 's', header: 'Status', render: (r) => <span className="flex gap-1"><Badge tone={STATUS_TONE[r.status]}>{titleCase(r.status)}</Badge>{r.isDemo && <DemoBadge />}</span>, sortValue: (r) => r.status }
    ]} />
  )
}

export function EInvoiceDetailPage() {
  const { id } = useParams()
  const { can } = useSession()
  const toast = useToast()
  const { data: e, error, loading, reload } = useQuery<EInvoiceDetail>(() => api('einvoice:get', { id: Number(id) }), [id])
  const [busy, setBusy] = useState<string | null>(null)
  const [cancel, setCancel] = useState<{ reasonCode: string; remarks: string } | null>(null)
  const [cancelErr, setCancelErr] = useState<Error | null>(null)
  const [preview, setPreview] = useState(false)
  const act = async (name: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(name)
    try {
      await fn()
      toast('success', ok)
      reload()
    } catch (err) {
      toast('error', `${titleCase(name)} failed`, (err as Error).message)
      reload()
    } finally {
      setBusy(null)
    }
  }
  if (loading && !e) return <Spinner />
  if (!e) return <ErrorBanner error={error} onRetry={reload} />
  const manage = can('einvoice.manage')
  return (
    <div>
      <PageHeader title={`E-invoice · ${e.documentNo}`} description={`${KIND_LABEL[e.documentKind]} dated ${formatDate(e.documentDate)} · ${e.supplyType}`} badge={<span className="flex gap-1.5"><Badge tone={STATUS_TONE[e.status]}>{titleCase(e.status)}</Badge>{e.isDemo && <DemoBadge label="DEMO · NOT REGISTERED" />}</span>}
        actions={<span className="flex flex-wrap gap-1.5">
          <Link to={e.route}><Button variant="secondary">Open document</Button></Link>
          {(e.status === 'GENERATED' || e.status === 'CANCELLED') && <><Button variant="secondary" onClick={() => setPreview(true)}>Preview</Button><Button variant="secondary" icon={<Printer className="size-4" />} loading={busy === 'print'} onClick={() => void act('print', () => api('einvoice:print', { id: e.id }), 'Sent to printer')}>Print</Button><Button variant="secondary" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} onClick={() => void act('pdf', async () => { const r = await api('einvoice:exportPdf', { id: e.id }); if (!r.path) throw new Error('Save cancelled') }, 'PDF saved')}>PDF</Button></>}
          {manage && e.irn && <Button variant="secondary" icon={<Search className="size-4" />} loading={busy === 'status'} onClick={() => void act('status', () => api('einvoice:status', { id: e.id }), 'Status retrieved')}>Check status</Button>}
          {manage && e.status === 'FAILED' && <Button icon={<RotateCcw className="size-4" />} loading={busy === 'retry'} onClick={() => void act('retry', () => api('einvoice:retry', { id: e.id }), 'IRN generated on retry')}>Retry</Button>}
          {manage && e.status === 'GENERATED' && <Button variant="danger" icon={<Ban className="size-4" />} disabled={!e.cancellable} onClick={() => setCancel({ reasonCode: '2', remarks: '' })}>Cancel IRN</Button>}
        </span>} />
      {e.isDemo && <DemoProviderBanner what="This IRN and acknowledgement" />}
      <div className="grid grid-cols-[1fr_380px] items-start gap-4">
        <div className="space-y-4">
          <Card title="Registration">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div className="col-span-2"><KeyValue label="IRN" value={e.irn ? <span className="font-mono text-[12.5px] break-all">{e.irn}</span> : 'Not generated'} /></div>
              <KeyValue label="Ack. number" value={e.ackNo} />
              <KeyValue label="Ack. date" value={formatDateTime(e.ackDate)} />
              <KeyValue label="Provider" value={`${e.provider} (${e.environment})`} />
              <KeyValue label="Request reference" value={<span className="font-mono text-[12px]">{e.requestKey}</span>} />
              <KeyValue label="Response reference" value={e.responseRef} />
              <KeyValue label="Cancellation window" value={e.cancelDeadline ? `${e.cancellable ? 'Open until' : 'Closed at'} ${formatDateTime(e.cancelDeadline)}` : '—'} />
              <div className="col-span-2"><KeyValue label="Signed QR code" value={e.signedQr ? 'Stored' : <span className="text-amber-800">{e.isDemo ? 'None — the demo provider never produces a signed QR code' : 'Not received'}</span>} /></div>
              {e.status === 'FAILED' && <div className="col-span-2"><KeyValue label="Error" value={<span className="text-red-700">{e.errorCode}: {e.errorMessage}</span>} /></div>}
              {e.status === 'CANCELLED' && <div className="col-span-2"><KeyValue label="Cancelled" value={`${formatDateTime(e.cancelledAt)} — ${IRN_CANCEL_REASONS[(e.cancelReasonCode ?? 4) as 1]}: ${e.cancelRemarks}`} /></div>}
            </dl>
          </Card>
          <Card title="API request history" subtitle="Every attempt, including retries and status checks. No credentials are recorded." bodyClassName="p-0">
            <DataTable rows={e.apiRequests} rowKey={(r) => r.id} empty={<EmptyState title="No requests recorded" />} columns={[
              { key: 't', header: 'Time', render: (r) => formatDateTime(r.createdAt) },
              { key: 'o', header: 'Operation', render: (r) => <span>{titleCase(r.operation.replace(':', ' '))}<span className="block text-[11.5px] text-ink-3">attempt {r.attempt} · {r.durationMs} ms</span></span> },
              { key: 'r', header: 'Result', render: (r) => <span className="flex flex-col items-start gap-0.5"><Badge tone={r.outcome === 'SUCCESS' ? 'green' : 'red'}>{r.outcome === 'SUCCESS' ? 'Success' : 'Failed'}</Badge>{r.errorClass && <span className="text-[11.5px] text-ink-3">{r.errorClass}{r.retryable ? ' · retryable' : ''}</span>}</span> },
              { key: 'm', header: 'Detail', render: (r) => <span className="text-[12px]">{r.errorMessage ?? r.responseRef ?? r.requestSummary}</span>, wrap: true }
            ]} />
          </Card>
        </div>
        <Card title="History">
          <ol className="space-y-2 border-l-2 border-line pl-4">
            {e.history.map((h, i) => <li key={i} className="text-[13px]"><span className="font-semibold">{titleCase(h.event)}</span> · <span className="text-ink-2">{h.detail}</span><br /><span className="text-[12px] text-ink-3">{formatDateTime(h.at)}</span></li>)}
          </ol>
          <Button className="mt-3" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={reload}>Refresh</Button>
        </Card>
      </div>
      <HtmlPreview open={preview} title={`E-invoice print — ${e.documentNo}`} load={() => api('einvoice:printHtml', { id: e.id })} onClose={() => setPreview(false)} />
      <Modal open={!!cancel} title={`Cancel IRN for ${e.documentNo}`} onClose={() => { setCancel(null); setCancelErr(null) }} footer={<><Button variant="secondary" onClick={() => setCancel(null)}>Keep</Button><Button variant="danger" loading={busy === 'cancel'} onClick={async () => {
        if (!cancel) return
        setBusy('cancel')
        setCancelErr(null)
        try {
          await api('einvoice:cancel', { id: e.id, reasonCode: Number(cancel.reasonCode) as 1, remarks: cancel.remarks })
          toast('success', 'IRN cancelled')
          setCancel(null)
          reload()
        } catch (err) {
          setCancelErr(err as Error)
        } finally {
          setBusy(null)
        }
      }}>Cancel IRN</Button></>}>
        {cancelErr && <ErrorBanner error={cancelErr} />}
        {cancel && <div className="grid gap-3">
          <p className="text-[13px] text-ink-2">Cancelling the IRN does not cancel the invoice in the books. After the cancellation window, issue a credit note instead.</p>
          <Field label="Reason"><Select value={cancel.reasonCode} onChange={(ev) => setCancel({ ...cancel, reasonCode: ev.target.value })}>{Object.entries(IRN_CANCEL_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Remarks" required><Input value={cancel.remarks} onChange={(ev) => setCancel({ ...cancel, remarks: ev.target.value })} maxLength={100} /></Field>
        </div>}
      </Modal>
    </div>
  )
}
