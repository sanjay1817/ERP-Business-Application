import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Info, RefreshCw, Upload } from 'lucide-react'
import { RECON_STATUS_LABELS, type ReconBatch, type ReconDetail, type ReconLine } from '@shared/gst'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Spinner, cx, type Column } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { SummaryStrip } from '../finance/shared'
import { GstNav, Money } from './common'

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'violet' | 'gray'> = {
  MATCHED: 'green', VALUE_DIFFERENCE: 'amber', GSTIN_MISMATCH: 'amber', PROBABLE: 'violet', NOT_IN_BOOKS: 'red', DUPLICATE_IN_STATEMENT: 'gray', DUPLICATE_IN_BOOKS: 'amber', UNMATCHED: 'gray'
}
const REVIEW_TONE: Record<string, 'green' | 'amber' | 'red' | 'gray'> = { ACCEPTED: 'green', ON_HOLD: 'amber', REJECTED: 'red', PENDING: 'gray' }
const SAMPLE = 'supplier_gstin,supplier_name,invoice_no,invoice_date,type,taxable,igst,cgst,sgst,cess\n33AADCN4471P1Z?,Example Supplier,ABC/101,2026-10-05,INVOICE,10000.00,0.00,900.00,900.00,0.00'

export function GstReconListPage() {
  const { session, can } = useSession()
  const nav = useNavigate()
  const toast = useToast()
  const { data, error, loading, reload } = useQuery<ReconBatch[]>(() => api('gst:reconList'), [session?.company?.id])
  const [open, setOpen] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const [f, setF] = useState({ label: '', source: 'GSTR2B_CSV', periodFrom: `${today.slice(0, 7)}-01`, periodTo: today, csv: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Error | null>(null)
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api('gst:reconImport', { ...f, source: f.source as 'GSTR2B_CSV' })
      toast('success', `Imported ${r.batch.rowCount} rows`)
      setOpen(false)
      nav(`/gst/reconciliation/${r.batch.id}`)
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <PageHeader title="GST Reconciliation" description="Compare supplier statements or a GSTR-2B export with the purchase register." actions={can('gst.manage') ? <Button icon={<Upload className="size-4" />} onClick={() => setOpen(true)}>Import CSV</Button> : undefined} />
      <GstNav />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={data ?? []}
            rowKey={(b) => b.id}
            onRowClick={(b) => nav(`/gst/reconciliation/${b.id}`)}
            empty={<EmptyState title="No reconciliations yet" message="Import a supplier statement or GSTR-2B CSV to compare it with your purchase register." />}
            columns={[
              { key: 'l', header: 'Statement', render: (b) => <span className="font-semibold">{b.label}</span>, wrap: true },
              { key: 's', header: 'Source', render: (b) => titleCase(b.source) },
              { key: 'p', header: 'Period', render: (b) => `${formatDate(b.periodFrom)} – ${formatDate(b.periodTo)}` },
              { key: 'r', header: 'Rows', align: 'right', render: (b) => b.rowCount },
              { key: 'm', header: 'Matched', align: 'right', render: (b) => b.counts.MATCHED ?? 0 },
              { key: 'd', header: 'For review', align: 'right', render: (b) => <Badge tone={b.pendingReview ? 'amber' : 'green'}>{b.pendingReview}</Badge> },
              { key: 'c', header: 'Imported', render: (b) => `${formatDateTime(b.createdAt)}${b.createdBy ? ` · ${b.createdBy}` : ''}` }
            ]}
          />
        )}
      </Card>
      <Modal open={open} title="Import supplier statement (CSV)" onClose={() => setOpen(false)} width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={() => void submit()}>Import and match</Button></>}>
        {err && <ErrorBanner error={err} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label" required><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. GSTR-2B October 2026" /></Field>
          <Field label="Source"><Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="GSTR2B_CSV">GSTR-2B (CSV)</option><option value="SUPPLIER_STATEMENT">Supplier statement</option><option value="OTHER">Other</option></Select></Field>
          <Field label="Period from"><Input type="date" value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></Field>
          <Field label="Period to"><Input type="date" value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></Field>
          <Field label="CSV contents" className="col-span-2" hint="Header row required. Columns: supplier_gstin, supplier_name, invoice_no, invoice_date (YYYY-MM-DD or DD/MM/YYYY), type (INVOICE / CREDIT_NOTE), taxable, igst, cgst, sgst, cess — amounts in rupees.">
            <textarea className="h-48 w-full rounded-lg border border-line p-2.5 font-mono text-[12px]" value={f.csv} onChange={(e) => setF({ ...f, csv: e.target.value })} placeholder={SAMPLE} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}

export function GstReconDetailPage() {
  const { id } = useParams()
  const { can } = useSession()
  const toast = useToast()
  const [filter, setFilter] = useState('ALL')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [review, setReview] = useState<{ status: string; note: string } | null>(null)
  const { data, error, loading, reload } = useQuery<ReconDetail>(() => api('gst:reconGet', { id: Number(id) }), [id])
  const manage = can('gst.manage')
  const lines = (data?.lines ?? []).filter((l) => filter === 'ALL' || l.matchStatus === filter || (filter === 'REVIEW' && l.matchStatus !== 'MATCHED'))
  const cols: Column<ReconLine>[] = [
    ...(manage ? [{ key: 'sel', header: '', width: '32px', render: (l: ReconLine) => <input type="checkbox" aria-label={`Select row ${l.rowNo}`} checked={selected.has(l.id)} onChange={() => setSelected((s) => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })} /> } as Column<ReconLine>] : []),
    { key: 'r', header: '#', render: (l) => l.rowNo, sortValue: (l) => l.rowNo },
    { key: 'g', header: 'Supplier', render: (l) => <span>{l.supplierName ?? '—'}<br /><span className="font-mono text-[11.5px] text-ink-3">{l.supplierGstin ?? '—'}</span></span>, wrap: true },
    { key: 'n', header: 'Statement document', render: (l) => <span><span className="font-semibold">{l.invoiceNo}</span><span className="block text-[11.5px] text-ink-3">{formatDate(l.invoiceDate)} · {titleCase(l.documentType)}</span></span> },
    { key: 't', header: 'Taxable / tax', align: 'right', render: (l) => <span><Money p={l.taxablePaise} /><span className="block text-[11.5px] text-ink-3">{formatINR(l.igstPaise + l.cgstPaise + l.sgstPaise)}</span></span> },
    { key: 'b', header: 'In the books', render: (l) => (l.matched ? <Link className="text-brand-700 hover:underline" to={l.matched.route}>{l.matched.number}<span className="block text-[11.5px] text-ink-3">{l.matched.supplierRef} · {formatINR(l.matched.taxablePaise)} / {formatINR(l.matched.taxPaise)}</span></Link> : <span className="text-ink-3">—</span>) },
    { key: 's', header: 'Result · review', render: (l) => <span className="flex max-w-[280px] flex-col items-start gap-0.5"><span className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[l.matchStatus] ?? 'gray'}>{RECON_STATUS_LABELS[l.matchStatus] ?? l.matchStatus}</Badge>{l.matchStatus !== 'MATCHED' && <Badge tone={REVIEW_TONE[l.reviewStatus]}>Review: {titleCase(l.reviewStatus)}</Badge>}</span>{l.matchNote && <span className="text-[11.5px] whitespace-normal text-ink-3">{l.matchNote}</span>}{l.reviewNote && <span className="text-[11.5px] whitespace-normal text-ink-2">Note: {l.reviewNote}</span>}</span>, sortValue: (l) => l.matchStatus, wrap: true }
  ]
  const counts = data?.batch.counts ?? {}
  const saveReview = async () => {
    if (!review) return
    try {
      const r = await api('gst:reconReview', { lineIds: [...selected], reviewStatus: review.status as 'ACCEPTED', note: review.note || null })
      toast('success', `${r.updated} row(s) updated`)
      setReview(null)
      setSelected(new Set())
      reload()
    } catch (e) {
      toast('error', 'Could not update review', (e as Error).message)
    }
  }
  return (
    <div>
      <PageHeader title={data?.batch.label ?? 'Reconciliation'} description={data ? `${titleCase(data.batch.source)} · ${formatDate(data.batch.periodFrom)} – ${formatDate(data.batch.periodTo)}` : undefined}
        actions={manage ? <span className="flex gap-2">{selected.size > 0 && <Button onClick={() => setReview({ status: 'ACCEPTED', note: '' })}>Review {selected.size} row(s)</Button>}<Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={async () => { await api('gst:reconRematch', { id: Number(id) }); toast('success', 'Matched again'); reload() }}>Re-match</Button></span> : undefined} />
      <GstNav />
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50/60 px-4 py-3 text-[13px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0 text-brand-700" /><p>{data.disclaimer}</p></div>
          <SummaryStrip items={[{ label: 'Statement rows', value: data.batch.rowCount }, { label: 'Matched', value: counts.MATCHED ?? 0, tone: 'good' }, { label: 'Differences', value: (counts.VALUE_DIFFERENCE ?? 0) + (counts.GSTIN_MISMATCH ?? 0) + (counts.PROBABLE ?? 0) + (counts.DUPLICATE_IN_BOOKS ?? 0) }, { label: 'Not in books', value: counts.NOT_IN_BOOKS ?? 0 }, { label: 'Not in statement', value: data.booksOnly.length }, { label: 'Awaiting review', value: data.batch.pendingReview }]} />
          <Card bodyClassName="p-4">
            <div className="mb-3 flex flex-wrap gap-1.5">
              {['ALL', 'REVIEW', ...Object.keys(RECON_STATUS_LABELS).filter((k) => counts[k])].map((k) => (
                <button key={k} onClick={() => setFilter(k)} className={cx('rounded-full border px-3 py-1 text-[12.5px] font-semibold', filter === k ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-2')}>
                  {k === 'ALL' ? `All · ${data.lines.length}` : k === 'REVIEW' ? `Needs review · ${data.lines.filter((l) => l.matchStatus !== 'MATCHED').length}` : `${RECON_STATUS_LABELS[k]} · ${counts[k]}`}
                </button>
              ))}
            </div>
            <DataTable rows={lines} columns={cols} rowKey={(l) => l.id} maxHeight="max-h-[calc(100vh-480px)]" />
          </Card>
          <Card className="mt-4" title="In the purchase register but not in the statement" subtitle="Registered-supplier documents of the period with no statement row." bodyClassName="p-0">
            <DataTable rows={data.booksOnly} rowKey={(b) => `${b.kind}:${b.id}`} empty={<EmptyState title="Every registered-supplier document of the period appears in the statement" />} columns={[
              { key: 'd', header: 'Date', render: (b) => formatDate(b.date) },
              { key: 'n', header: 'Document', render: (b) => <Link className="font-semibold text-brand-700 hover:underline" to={b.route}>{b.number}</Link> },
              { key: 'r', header: 'Supplier ref.', render: (b) => b.supplierRef ?? '—' },
              { key: 'p', header: 'Supplier', render: (b) => <span>{b.partyName}<br /><span className="font-mono text-[11.5px] text-ink-3">{b.supplierGstin}</span></span>, wrap: true },
              { key: 't', header: 'Taxable', align: 'right', render: (b) => <Money p={b.taxablePaise} /> },
              { key: 'x', header: 'Tax', align: 'right', render: (b) => <Money p={b.taxPaise} /> }
            ]} />
          </Card>
        </>
      )}
      <Modal open={!!review} title={`Review ${selected.size} row(s)`} onClose={() => setReview(null)} footer={<><Button variant="secondary" onClick={() => setReview(null)}>Cancel</Button><Button onClick={() => void saveReview()}>Save</Button></>}>
        {review && (
          <div className="grid gap-3">
            <Field label="ITC review status"><Select value={review.status} onChange={(e) => setReview({ ...review, status: e.target.value })}><option value="ACCEPTED">Accepted</option><option value="ON_HOLD">On hold (follow up with supplier)</option><option value="REJECTED">Rejected (do not claim)</option><option value="PENDING">Pending</option></Select></Field>
            <Field label="Note"><Input value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} maxLength={300} /></Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
