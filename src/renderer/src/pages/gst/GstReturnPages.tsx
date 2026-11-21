import { useState } from 'react'
import { Link } from 'react-router-dom'
import { FileJson, FileSpreadsheet, ListChecks } from 'lucide-react'
import type { Gstr1Data, Gstr3bData, ReturnPreparation } from '@shared/gst'
import type { ReportDoc } from '@shared/finance'
import { stateName } from '@shared/india'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, milliToString } from '../../lib/format'
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, Tabs } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { ReportView } from '../ReportsPage'
import { GstNav, Money, MonthBar, NotFiledBanner, TaxTable, monthLabel, monthRange, usePeriodMonth } from './common'

function Preparations({ type, period, onPrepared }: { type: 'GSTR1' | 'GSTR3B'; period: string; onPrepared: number }) {
  const { can, session } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<ReportDoc | null>(null)
  const { data, reload } = useQuery<ReturnPreparation[]>(() => api('gst:preparations', { returnType: type }), [type, onPrepared, session?.company?.id])
  const rows = (data ?? []).filter((p) => p.period === period)
  const exp = async (p: ReturnPreparation, format: 'XLSX' | 'JSON') => {
    setBusy(`${p.id}${format}`)
    try {
      const r = await api('gst:exportPreparation', { id: p.id, format })
      if (r.path) toast('success', `${format === 'JSON' ? 'JSON' : 'Excel'} file saved (not filed)`, r.path)
      reload()
    } catch (e) {
      toast('error', 'Export failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card title="Prepared snapshots" subtitle="Frozen at preparation. Exported files are for review / your filing process — nothing is sent to the GST portal.">
      {rows.length === 0 ? <p className="text-[13px] text-ink-3">Not prepared for {monthLabel(period)} yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {rows.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
              <span className="font-semibold">#{p.id}</span>
              <span className="text-ink-2">{formatDateTime(p.preparedAt)} by {p.preparedBy ?? '—'}</span>
              <Badge tone="blue">{p.status === 'EXPORTED' ? `Exported (${p.exportFormat})` : 'Prepared'} · not filed</Badge>
              {p.validationWarnings > 0 && <Badge tone="amber">{p.validationWarnings} warnings</Badge>}
              {p.stale && <Badge tone="red">Out of date — transactions changed</Badge>}
              <span className="ml-auto flex gap-1.5">
                <Button variant="ghost" onClick={async () => setPreview(await api('gst:previewPreparation', { id: p.id }))}>Preview</Button>
                {can('reports.export') && <Button variant="secondary" icon={<FileSpreadsheet className="size-4" />} loading={busy === `${p.id}XLSX`} onClick={() => void exp(p, 'XLSX')}>Excel</Button>}
                {can('reports.export') && <Button variant="secondary" icon={<FileJson className="size-4" />} loading={busy === `${p.id}JSON`} onClick={() => void exp(p, 'JSON')}>JSON</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!preview} title={preview?.title ?? ''} subtitle={preview?.subtitle} onClose={() => setPreview(null)} width="max-w-6xl">{preview && <ReportView doc={preview} />}</Modal>
    </Card>
  )
}

function PrepareButton({ type, period, onDone }: { type: 'GSTR1' | 'GSTR3B'; period: string; onDone: () => void }) {
  const { can } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Error | null>(null)
  if (!can('gst.manage')) return null
  return (
    <div className="flex flex-col items-end gap-1">
      <Button icon={<ListChecks className="size-4" />} loading={busy} onClick={async () => {
        setBusy(true)
        setErr(null)
        try {
          const p = await api('gst:prepare', { returnType: type, period })
          toast('success', `${type === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} prepared (#${p.id}) — not filed`)
          onDone()
        } catch (e) {
          setErr(e as Error)
        } finally {
          setBusy(false)
        }
      }}>Prepare snapshot</Button>
      {err && <p className="max-w-md text-right text-[12px] text-red-700">{err.message} <Link className="underline" to={`/gst/validation?from=${monthRange(period).from}&to=${monthRange(period).fullTo}`}>Open validation</Link></p>}
    </div>
  )
}

const amt = { right: true }
export function Gstr1Page() {
  const { session } = useSession()
  const { period, set } = usePeriodMonth()
  const [tab, setTab] = useState('summary')
  const [n, setN] = useState(0)
  const { data, error, loading, reload } = useQuery<Gstr1Data>(() => api('gst:gstr1', { period }), [period, session?.company?.id, n])
  return (
    <div>
      <PageHeader title="GSTR-1 preparation" description="Outward supplies for the month, by return table, computed live from posted documents." actions={<PrepareButton type="GSTR1" period={period} onDone={() => setN((x) => x + 1)} />} />
      <GstNav />
      <div className="mb-4"><MonthBar period={period} onChange={set} /></div>
      <NotFiledBanner>Outward debit notes (supplementary invoices) are not a document type in this ERP, so that part of table 9B stays empty.</NotFiledBanner>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <div className="space-y-4">
          <Card bodyClassName="p-4">
            <div className="mb-3 flex items-center justify-between"><p className="text-[13px] text-ink-2">GSTIN <span className="font-mono font-semibold text-ink">{data.gstin || '—'}</span> · {formatDate(data.from)} – {formatDate(data.to)}</p>
              <Tabs value={tab} onChange={setTab} tabs={[{ value: 'summary', label: 'Summary' }, { value: 'b2b', label: 'B2B', count: data.b2b.length }, { value: 'b2c', label: 'B2C', count: data.b2cl.length + data.b2cs.length }, { value: 'exp', label: 'Export / SEZ', count: data.exp.length + data.sez.length }, { value: 'cdn', label: 'Credit notes', count: data.cdnr.length + data.cdnur.length }, { value: 'nil', label: 'Nil / exempt' }, { value: 'hsn', label: 'HSN', count: data.hsn.length }, { value: 'docs', label: 'Documents' }]} />
            </div>
            {tab === 'summary' && <TaxTable rows={data.sections} cols={[{ h: 'Table', v: (s) => s.label }, { h: 'Count', v: (s) => s.count, ...amt }, { h: 'Taxable', v: (s) => <Money p={s.taxablePaise} />, ...amt }, { h: 'IGST', v: (s) => <Money p={s.igstPaise} />, ...amt }, { h: 'CGST', v: (s) => <Money p={s.cgstPaise} />, ...amt }, { h: 'SGST', v: (s) => <Money p={s.sgstPaise} />, ...amt }, { h: 'Cess', v: (s) => <Money p={s.cessPaise} />, ...amt }]} />}
            {tab === 'b2b' && <TaxTable rows={data.b2b} cols={[{ h: 'Buyer GSTIN', v: (r) => <span className="font-mono">{r.gstin}</span> }, { h: 'Name', v: (r) => r.name }, { h: 'Invoice', v: (r) => r.number }, { h: 'Date', v: (r) => formatDate(r.date) }, { h: 'Value', v: (r) => <Money p={r.valuePaise} />, ...amt }, { h: 'POS', v: (r) => r.pos }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, ...amt }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, ...amt }]} />}
            {tab === 'b2c' && (
              <div className="space-y-3">
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">5 — B2C Large (invoice-wise)</h3>
                <TaxTable rows={data.b2cl} cols={[{ h: 'Invoice', v: (r) => r.number }, { h: 'Date', v: (r) => formatDate(r.date) }, { h: 'Value', v: (r) => <Money p={r.valuePaise} />, ...amt }, { h: 'POS', v: (r) => `${r.pos} ${stateName(r.pos)}` }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} />
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">7 — B2C Small (by place of supply and rate, net of credit notes)</h3>
                <TaxTable rows={data.b2cs} cols={[{ h: 'Place of supply', v: (r) => `${r.pos} ${stateName(r.pos)}` }, { h: 'Supply', v: (r) => (r.supplyType === 'INTER' ? 'Inter-state' : 'Intra-state') }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, ...amt }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, ...amt }]} />
              </div>
            )}
            {tab === 'exp' && (
              <div className="space-y-3">
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">6A — Exports</h3>
                <TaxTable rows={data.exp} cols={[{ h: 'Type', v: (r) => (r.type === 'WPAY' ? 'With IGST' : 'Under LUT/bond') }, { h: 'Invoice', v: (r) => r.number }, { h: 'Date', v: (r) => formatDate(r.date) }, { h: 'Value', v: (r) => <Money p={r.valuePaise} />, ...amt }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} />
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">6B — Supplies to SEZ</h3>
                <TaxTable rows={data.sez} cols={[{ h: 'GSTIN', v: (r) => <span className="font-mono">{r.gstin}</span> }, { h: 'Name', v: (r) => r.name }, { h: 'Type', v: (r) => (r.type === 'SEZWP' ? 'With IGST' : 'Without IGST') }, { h: 'Invoice', v: (r) => r.number }, { h: 'Date', v: (r) => formatDate(r.date) }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} />
              </div>
            )}
            {tab === 'cdn' && (
              <div className="space-y-3">
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">9B — Credit notes to registered persons</h3>
                <TaxTable rows={data.cdnr} cols={[{ h: 'GSTIN', v: (r) => <span className="font-mono">{r.gstin}</span> }, { h: 'Name', v: (r) => r.name }, { h: 'Note', v: (r) => r.noteNo }, { h: 'Date', v: (r) => formatDate(r.noteDate) }, { h: 'Against', v: (r) => r.originalNo ?? '—' }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, ...amt }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, ...amt }]} />
                <h3 className="text-[12px] font-bold tracking-wider text-ink-3 uppercase">9B — Credit notes to unregistered persons (B2C Large / exports)</h3>
                <TaxTable rows={data.cdnur} cols={[{ h: 'Type', v: (r) => r.urType }, { h: 'Note', v: (r) => r.noteNo }, { h: 'Date', v: (r) => formatDate(r.noteDate) }, { h: 'Against', v: (r) => r.originalNo ?? '—' }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} />
              </div>
            )}
            {tab === 'nil' && <TaxTable rows={data.nil} cols={[{ h: 'Description', v: (r) => r.description }, { h: 'Nil rated', v: (r) => <Money p={r.nilPaise} />, ...amt }, { h: 'Exempted', v: (r) => <Money p={r.exemptPaise} />, ...amt }, { h: 'Non-GST', v: (r) => <Money p={r.nonGstPaise} />, ...amt }]} />}
            {tab === 'hsn' && <TaxTable rows={data.hsn} cols={[{ h: 'HSN/SAC', v: (r) => <span className="font-mono">{r.hsn}</span> }, { h: 'Description', v: (r) => r.description }, { h: 'UQC', v: (r) => r.uqc }, { h: 'Qty', v: (r) => milliToString(r.qtyMilli), ...amt }, { h: 'Rate', v: (r) => `${r.ratePct}%`, ...amt }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, ...amt }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, ...amt }, { h: 'Value', v: (r) => <Money p={r.valuePaise} />, ...amt }]} />}
            {tab === 'docs' && <TaxTable rows={data.docs} cols={[{ h: 'Nature of document', v: (r) => r.nature }, { h: 'From', v: (r) => r.from }, { h: 'To', v: (r) => r.to }, { h: 'Total', v: (r) => r.total, ...amt }, { h: 'Cancelled', v: (r) => r.cancelled, ...amt }, { h: 'Net issued', v: (r) => r.total - r.cancelled, ...amt }]} />}
          </Card>
          <Preparations type="GSTR1" period={period} onPrepared={n} />
        </div>
      )}
    </div>
  )
}

export function Gstr3bPage() {
  const { session } = useSession()
  const { period, set } = usePeriodMonth()
  const [n, setN] = useState(0)
  const { data, error, loading, reload } = useQuery<Gstr3bData>(() => api('gst:gstr3b', { period }), [period, session?.company?.id, n])
  const taxCols = [
    { h: 'Taxable', v: (r: { taxablePaise: number }) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r: { igstPaise: number }) => <Money p={r.igstPaise} />, ...amt },
    { h: 'CGST', v: (r: { cgstPaise: number }) => <Money p={r.cgstPaise} />, ...amt }, { h: 'SGST', v: (r: { sgstPaise: number }) => <Money p={r.sgstPaise} />, ...amt }, { h: 'Cess', v: (r: { cessPaise: number }) => <Money p={r.cessPaise} />, ...amt }
  ]
  return (
    <div>
      <PageHeader title="GSTR-3B preparation" description="Summary of liability and input tax credit for the month, computed live from posted documents and ITC classification." actions={<PrepareButton type="GSTR3B" period={period} onDone={() => setN((x) => x + 1)} />} />
      <GstNav />
      <div className="mb-4"><MonthBar period={period} onChange={set} /></div>
      <NotFiledBanner>ITC that has not been classified is excluded. Interest, late fee and the actual set-off are computed on the portal.</NotFiledBanner>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <div className="space-y-4">
          <Card title="3.1 — Outward supplies and inward supplies liable to reverse charge" bodyClassName="p-4">
            <TaxTable rows={data.outward} cols={[{ h: 'Nature of supplies', v: (r) => r.label, w: '46%' }, ...taxCols]} />
          </Card>
          <div className="grid grid-cols-2 gap-4">
            <Card title="3.2 — Inter-state supplies to unregistered persons" bodyClassName="p-4">
              <TaxTable rows={data.interStateUnregistered} cols={[{ h: 'Place of supply', v: (r) => `${r.pos} ${stateName(r.pos)}` }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} />
              {data.interStateComposition.length > 0 && <><h3 className="mt-3 mb-1 text-[12px] font-bold tracking-wider text-ink-3 uppercase">To composition taxpayers</h3><TaxTable rows={data.interStateComposition} cols={[{ h: 'Place of supply', v: (r) => `${r.pos} ${stateName(r.pos)}` }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, ...amt }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, ...amt }]} /></>}
            </Card>
            <Card title="5 — Exempt, nil-rated and non-GST inward supplies" bodyClassName="p-4">
              <TaxTable rows={data.inwardExempt} cols={[{ h: 'Nature', v: (r) => r.label }, { h: 'Inter-state', v: (r) => <Money p={r.interPaise} />, ...amt }, { h: 'Intra-state', v: (r) => <Money p={r.intraPaise} />, ...amt }]} />
            </Card>
          </div>
          <Card title="4 — Eligible ITC" subtitle={data.itcPending.count ? `${data.itcPending.count} document(s) with ${formatINR(data.itcPending.igstPaise + data.itcPending.cgstPaise + data.itcPending.sgstPaise)} of tax await classification and are excluded` : 'All input tax in the period is classified'} actions={data.itcPending.count ? <Link className="text-[12.5px] font-semibold text-brand-700" to={`/gst/purchases?from=${data.from}&to=${data.to}&category=PENDING`}>Review pending ITC →</Link> : undefined} bodyClassName="p-4">
            <TaxTable rows={data.itc} cols={[{ h: 'Details', v: (r) => <span className={r.key === '4C' ? 'font-semibold' : ''}>{r.label}</span>, w: '46%' }, ...taxCols.slice(1)]} />
          </Card>
          <Card title="Indicative position (no cross-utilisation)" bodyClassName="p-4">
            <TaxTable rows={data.indicativeNet} cols={[{ h: 'Tax head', v: (r) => r.head }, { h: 'Liability', v: (r) => <Money p={r.liabilityPaise} />, ...amt }, { h: 'Eligible ITC', v: (r) => <Money p={r.itcPaise} />, ...amt }, { h: 'Difference', v: (r) => <Money p={r.netPaise} className="font-semibold" />, ...amt }]} />
            <p className="mt-2 text-[12px] text-ink-3">A negative difference means credit exceeds liability for that head. The portal applies the statutory order of utilisation; this table does not.</p>
          </Card>
          <Preparations type="GSTR3B" period={period} onPrepared={n} />
        </div>
      )}
    </div>
  )
}
