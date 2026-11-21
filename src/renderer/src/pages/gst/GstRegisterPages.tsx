import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BadgeCheck, CircleAlert, FileCheck2, Landmark, Receipt, Truck } from 'lucide-react'
import {
  ISSUE_CATEGORIES, ISSUE_LABELS, ITC_ELIGIBILITY, ITC_LABELS, ITC_TYPES, type GstInwardDoc, type GstOutwardDoc, type GstOverview, type GstPurchaseRegister, type GstSalesRegister,
  type GstValidationReport, type HsnSummaryRow
} from '@shared/gst'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, milliToString, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Field, PageHeader, Select, Spinner, Tabs, cx, type Column } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { StatTile } from '../../components/StatTile'
import { CheckPill, PeriodBar, SummaryStrip, usePeriod } from '../finance/shared'
import { GstNav, ItcBadge, Money, MonthBar, NotFiledBanner, SectionBadge, TaxTable, monthLabel, sectionLabel, usePeriodMonth } from './common'

// ───────── Overview ─────────
export function GstOverviewPage() {
  const { session } = useSession()
  const nav = useNavigate()
  const { period, set } = usePeriodMonth()
  const { data, error, loading, reload } = useQuery<GstOverview>(() => api('gst:overview', { period }), [period, session?.company?.id])
  return (
    <div>
      <PageHeader title="GST Management" description="Registers, return preparation, ITC review and reconciliation from posted transactions." />
      <GstNav />
      <div className="mb-4"><MonthBar period={period} onChange={set} /></div>
      <NotFiledBanner />
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <div className="mb-4 grid grid-cols-4 gap-3">
            <StatTile label="Output tax" value={formatINR(data.outputTaxPaise)} sub={`${monthLabel(period)} · IGST + CGST + SGST`} icon={<Receipt className="size-4 text-brand-700" />} accent="bg-brand-50" onClick={() => nav(`/gst/sales?from=${data.from}&to=${data.to}`)} />
            <StatTile label="Eligible ITC (classified)" value={formatINR(data.itcEligiblePaise)} sub={data.itcBlockedPaise ? `${formatINR(data.itcBlockedPaise)} ineligible / blocked` : 'Net of supplier credit notes'} icon={<BadgeCheck className="size-4 text-emerald-700" />} accent="bg-emerald-50" onClick={() => nav(`/gst/purchases?from=${data.from}&to=${data.to}`)} />
            <StatTile label="ITC pending review" value={formatINR(data.itcPendingPaise)} sub={`${data.itcPendingCount} document(s) — excluded until classified`} icon={<CircleAlert className="size-4 text-amber-700" />} accent="bg-amber-50" onClick={() => nav(`/gst/purchases?from=${data.from}&to=${data.to}&category=PENDING`)} />
            <StatTile label="Indicative net (before set-off)" value={formatINR(data.indicativeNetPaise)} sub="Liability − eligible ITC; the portal computes the actual set-off" icon={<Landmark className="size-4 text-navy-700" />} accent="bg-slate-100" onClick={() => nav(`/gst/gstr3b?period=${period}`)} />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Card title="Readiness" subtitle={`${monthLabel(period)}`}>
              <ul className="space-y-2.5 text-[13px]">
                <li className="flex items-center justify-between">Validation errors <Link to={`/gst/validation?from=${data.from}&to=${data.to}`}><Badge tone={data.validationErrors ? 'red' : 'green'}>{data.validationErrors}</Badge></Link></li>
                <li className="flex items-center justify-between">Validation warnings <Badge tone={data.validationWarnings ? 'amber' : 'green'}>{data.validationWarnings}</Badge></li>
                <li className="flex items-center justify-between">Reverse-charge tax (3.1(d)) <span className="tabular font-semibold">{formatINR(data.rcmTaxPaise)}</span></li>
                {data.preparations.length === 0 ? <li className="text-ink-3">No return prepared for this period yet.</li> : data.preparations.map((p, i) => (
                  <li key={i} className="flex items-center justify-between">
                    {p.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} · {formatDateTime(p.preparedAt)}
                    <span className="flex gap-1"><Badge tone="blue">{p.status === 'EXPORTED' ? 'Exported' : 'Prepared'} · not filed</Badge>{p.stale && <Badge tone="amber">Out of date</Badge>}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="E-invoice & e-way bill" actions={<span className="flex gap-2"><Link className="text-[12.5px] font-semibold text-brand-700" to="/einvoice">E-invoice →</Link><Link className="text-[12.5px] font-semibold text-brand-700" to="/ewaybill">E-way bill →</Link></span>}>
              <ul className="space-y-2.5 text-[13px]">
                <li className="flex items-center justify-between"><span className="flex items-center gap-2"><FileCheck2 className="size-4 text-ink-3" />E-invoicing</span><Badge tone={data.einvoice.enabled ? 'green' : 'gray'}>{data.einvoice.enabled ? 'Enabled' : 'Not enabled'}</Badge></li>
                <li className="flex items-center justify-between">IRNs generated <span className="tabular font-semibold">{data.einvoice.generated}</span></li>
                <li className="flex items-center justify-between">Failed requests <Badge tone={data.einvoice.failed ? 'red' : 'green'}>{data.einvoice.failed}</Badge></li>
                <li className="flex items-center justify-between"><span className="flex items-center gap-2"><Truck className="size-4 text-ink-3" />Active e-way bills</span><span className="tabular font-semibold">{data.ewaybill.active}</span></li>
                <li className="flex items-center justify-between">Expiring in 24 hours <Badge tone={data.ewaybill.expiringSoon ? 'amber' : 'green'}>{data.ewaybill.expiringSoon}</Badge></li>
              </ul>
            </Card>
            <Card title="Last six months" subtitle="Output tax and eligible ITC" bodyClassName="p-0">
              <table className="w-full text-[12.5px]">
                <thead className="bg-slate-50 text-[11px] text-ink-3 uppercase"><tr><th className="px-4 py-2 text-left">Month</th><th className="px-4 py-2 text-right">Output</th><th className="px-4 py-2 text-right">ITC</th></tr></thead>
                <tbody className="tabular">
                  {data.months.map((m) => (
                    <tr key={m.month} className={cx('border-t border-slate-100', m.month === period && 'bg-brand-50/60 font-semibold')}>
                      <td className="px-4 py-1.5"><button className="hover:underline" onClick={() => set(m.month)}>{monthLabel(m.month)}</button></td>
                      <td className="px-4 py-1.5 text-right">{formatINR(m.outputPaise)}</td>
                      <td className="px-4 py-1.5 text-right">{formatINR(m.itcPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

// ───────── Shared filters ─────────
function useRegisterFilters() {
  const period = usePeriod()
  const status = (period.params.get('status') as 'POSTED' | 'CANCELLED' | 'ALL' | null) ?? 'POSTED'
  const category = period.params.get('category') ?? ''
  return { period, status, category }
}

function HsnTable({ rows }: { rows: HsnSummaryRow[] }) {
  return (
    <TaxTable
      rows={rows}
      cols={[
        { h: 'HSN/SAC', v: (r) => <span className="font-mono">{r.hsn}</span> }, { h: 'Description', v: (r) => r.description }, { h: 'UQC', v: (r) => r.uqc },
        { h: 'Qty', v: (r) => milliToString(r.qtyMilli), right: true }, { h: 'Rate', v: (r) => `${r.ratePct}%`, right: true }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, right: true },
        { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, right: true }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, right: true }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, right: true },
        { h: 'Total value', v: (r) => <Money p={r.valuePaise} />, right: true }
      ]}
    />
  )
}

// ───────── Sales register ─────────
export function GstSalesRegisterPage() {
  const { session } = useSession()
  const nav = useNavigate()
  const { period, status, category } = useRegisterFilters()
  const [tab, setTab] = useState<'docs' | 'sections' | 'hsn' | 'rates'>('docs')
  const p = period.ready ? { from: period.from!, to: period.to!, status, ...(category ? { category } : {}) } : null
  const { data, error, loading, reload } = useQuery<GstSalesRegister | null>(() => (p ? api('gst:salesRegister', p) : Promise.resolve(null)), [JSON.stringify(p), session?.company?.id])
  const cols: Column<GstOutwardDoc>[] = [
    { key: 'date', header: 'Date', render: (d) => formatDate(d.date), sortValue: (d) => d.date },
    { key: 'no', header: 'Document', render: (d) => <span><span className="font-semibold">{d.number}</span><span className="ml-1.5 text-[11.5px] text-ink-3">{titleCase(d.kind)}</span></span>, sortValue: (d) => d.number },
    { key: 'sec', header: 'Section', render: (d) => <SectionBadge s={d.section} />, sortValue: (d) => d.section },
    { key: 'party', header: 'Customer · POS', render: (d) => <span>{d.partyName}<br /><span className="font-mono text-[11.5px] text-ink-3">{d.partyGstin ?? 'Unregistered'} · POS {d.placeOfSupply} {d.interState ? 'inter' : 'intra'}</span></span>, wrap: true },
    { key: 't', header: 'Taxable', align: 'right', render: (d) => <span><Money p={d.sign * d.taxablePaise} />{d.nilPaise + d.exemptPaise + d.nonGstPaise > 0 && <span className="block text-[11px] text-ink-3">+ nil/exempt {formatINR(d.nilPaise + d.exemptPaise + d.nonGstPaise)}</span>}</span>, sortValue: (d) => d.sign * d.taxablePaise },
    { key: 'i', header: 'IGST', align: 'right', render: (d) => <Money p={d.sign * d.igstPaise} /> },
    { key: 'c', header: 'CGST + SGST', align: 'right', render: (d) => <Money p={d.sign * (d.cgstPaise + d.sgstPaise)} /> },
    { key: 'e', header: 'IRN · status', render: (d) => <span className="flex flex-col items-start gap-0.5">{d.einvoice ? <Badge tone={d.einvoice.status === 'GENERATED' ? 'green' : d.einvoice.status === 'FAILED' ? 'red' : 'gray'}>{d.einvoice.isDemo ? 'DEMO ' : ''}{titleCase(d.einvoice.status)}</Badge> : <span className="text-ink-3">No IRN</span>}{d.status !== 'POSTED' && <Badge tone="red">{titleCase(d.status)}</Badge>}</span> }
  ]
  const sections = data ? Object.entries(data.bySection) : []
  return (
    <div>
      <PageHeader title="GST Sales Register" description="Outward supplies classified for GSTR-1 (B2B, B2C, exports, SEZ, credit notes). Click a row to open the document." />
      <GstNav />
      <Card bodyClassName="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <PeriodBar period={period}>
            <div className="w-36"><Select aria-label="Status" value={status} onChange={(e) => period.set({ status: e.target.value === 'POSTED' ? undefined : e.target.value })}><option value="POSTED">Posted</option><option value="CANCELLED">Cancelled</option><option value="ALL">All statuses</option></Select></div>
            <div className="w-60"><Select aria-label="Tax category" value={category} onChange={(e) => period.set({ category: e.target.value || undefined })}>
              <option value="">All sections</option>
              {['B2B', 'B2CL', 'B2CS', 'EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP', 'CDNR', 'CDNUR', 'B2CS_ADJ'].map((s) => <option key={s} value={s}>{sectionLabel(s)}</option>)}
            </Select></div>
          </PeriodBar>
          {data && <span className="ml-auto"><CheckPill ok={data.ledger.agrees} okText="Agrees with output GST ledgers" badText="Differs from output GST ledgers" /></span>}
        </div>
        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? <Spinner /> : data && (
          <>
            <SummaryStrip items={[
              { label: 'Documents', value: data.docs.length }, { label: 'Taxable value', value: formatINR(data.totals.taxablePaise) }, { label: 'IGST', value: formatINR(data.totals.igstPaise) },
              { label: 'CGST + SGST', value: formatINR(data.totals.cgstPaise + data.totals.sgstPaise) }, { label: 'Invoice value', value: formatINR(data.totals.valuePaise) }
            ]} />
            <div className="mb-3"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'docs', label: 'Documents', count: data.docs.length }, { value: 'sections', label: 'By section', count: sections.length }, { value: 'hsn', label: 'HSN summary', count: data.hsn.length }, { value: 'rates', label: 'Tax summary', count: data.rates.length }]} /></div>
            {tab === 'docs' && <DataTable rows={data.docs} columns={cols} rowKey={(d) => `${d.kind}:${d.id}`} onRowClick={(d) => nav(d.route)} empty={<EmptyState title="No outward supplies in this period" />} maxHeight="max-h-[calc(100vh-440px)]" />}
            {tab === 'sections' && (
              <TaxTable rows={sections} cols={[
                { h: 'Section', v: ([k]) => <span className="flex items-center gap-2"><SectionBadge s={k} />{sectionLabel(k)}</span> }, { h: 'Docs', v: ([, t]) => t.count, right: true },
                { h: 'Taxable', v: ([, t]) => <Money p={t.taxablePaise} />, right: true }, { h: 'IGST', v: ([, t]) => <Money p={t.igstPaise} />, right: true },
                { h: 'CGST', v: ([, t]) => <Money p={t.cgstPaise} />, right: true }, { h: 'SGST', v: ([, t]) => <Money p={t.sgstPaise} />, right: true }, { h: 'Value', v: ([, t]) => <Money p={t.valuePaise} />, right: true }
              ]} />
            )}
            {tab === 'hsn' && <HsnTable rows={data.hsn} />}
            {tab === 'rates' && <TaxTable rows={data.rates} cols={[{ h: 'Rate', v: (r) => `${r.ratePct}%` }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, right: true }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, right: true }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, right: true }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, right: true }]} />}
            <p className="mt-2 text-[12px] text-ink-3">Ledger check: output IGST {formatINR(data.ledger.igstPaise)}, CGST {formatINR(data.ledger.cgstPaise)}, SGST {formatINR(data.ledger.sgstPaise)} posted by these documents in the period (cancellation reversals excluded).</p>
          </>
        )}
      </Card>
    </div>
  )
}

// ───────── Purchase register & ITC ─────────
export function GstPurchaseRegisterPage() {
  const { session, can } = useSession()
  const nav = useNavigate()
  const toast = useToast()
  const { period, status, category } = useRegisterFilters()
  const [tab, setTab] = useState<'docs' | 'hsn' | 'rates'>('docs')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [classify, setClassify] = useState(false)
  const [form, setForm] = useState({ eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: '' })
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const p = period.ready ? { from: period.from!, to: period.to!, status, ...(category ? { category } : {}) } : null
  const { data, error, loading, reload } = useQuery<GstPurchaseRegister | null>(() => (p ? api('gst:purchaseRegister', p) : Promise.resolve(null)), [JSON.stringify(p), session?.company?.id])
  const manage = can('gst.manage')
  const key = (d: GstInwardDoc) => `${d.kind}:${d.id}`
  const toggle = (d: GstInwardDoc) => setSelected((s) => { const n = new Set(s); n.has(key(d)) ? n.delete(key(d)) : n.add(key(d)); return n })
  const selectable = useMemo(() => (data?.docs ?? []).filter((d) => d.status === 'POSTED'), [data])
  const cols: Column<GstInwardDoc>[] = [
    ...(manage ? [{ key: 'sel', header: '', width: '32px', render: (d: GstInwardDoc) => d.status === 'POSTED' ? <input type="checkbox" aria-label={`Select ${d.number}`} checked={selected.has(key(d))} onClick={(e) => e.stopPropagation()} onChange={() => toggle(d)} /> : null } as Column<GstInwardDoc>] : []),
    { key: 'date', header: 'Date', render: (d) => formatDate(d.date), sortValue: (d) => d.date },
    { key: 'no', header: 'Document', render: (d) => <span><span className="font-semibold">{d.number}</span><span className="ml-1.5 text-[11.5px] text-ink-3">{titleCase(d.kind)}</span></span>, sortValue: (d) => d.number },
    { key: 'ref', header: 'Supplier ref.', render: (d) => <span>{d.supplierRef ?? '—'}{d.supplierRefDate && <span className="block text-[11.5px] text-ink-3">{formatDate(d.supplierRefDate)}</span>}</span> },
    { key: 'party', header: 'Supplier', render: (d) => <span>{d.partyName}<br /><span className="font-mono text-[11.5px] text-ink-3">{d.partyGstin ?? 'Unregistered'}</span></span>, wrap: true },
    { key: 't', header: 'Taxable', align: 'right', render: (d) => <Money p={d.sign * d.taxablePaise} />, sortValue: (d) => d.sign * d.taxablePaise },
    { key: 'i', header: 'Input IGST', align: 'right', render: (d) => <Money p={d.sign * d.igstPaise} /> },
    { key: 'c', header: 'CGST + SGST', align: 'right', render: (d) => <Money p={d.sign * (d.cgstPaise + d.sgstPaise)} /> },
    { key: 'itc', header: 'ITC', render: (d) => <span className="flex flex-col items-start gap-0.5"><ItcBadge e={d.itc.eligibility} />{d.itc.reverseCharge && <Badge tone="violet">Reverse charge</Badge>}{d.rcmSuggested && !d.itc.reverseCharge && <Badge tone="amber">RCM? check</Badge>}{d.status !== 'POSTED' && <Badge tone="red">{titleCase(d.status)}</Badge>}</span>, sortValue: (d) => d.itc.eligibility }
  ]
  const save = async () => {
    setBusy(true)
    setFormError(null)
    try {
      const documents = [...selected].map((k) => { const [kind, id] = k.split(':'); return { kind: kind as GstInwardDoc['kind'], id: Number(id) } })
      const r = await api('gst:classifyItc', { documents, eligibility: form.eligibility as 'ELIGIBLE', itcType: form.itcType as 'INPUTS', reverseCharge: form.reverseCharge, reason: form.reason || null })
      toast('success', `ITC classified for ${r.updated} document(s)`)
      setClassify(false)
      setSelected(new Set())
      reload()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const elig = data?.byEligibility ?? {}
  const tax = (k: string) => (elig[k] ? elig[k].igstPaise + elig[k].cgstPaise + elig[k].sgstPaise : 0)
  return (
    <div>
      <PageHeader title="GST Purchase Register & ITC" description="Inward supplies with input tax. Credit is counted only after it is classified as eligible — nothing is assumed eligible." actions={manage && selected.size > 0 ? <Button onClick={() => setClassify(true)}>Classify ITC ({selected.size})</Button> : undefined} />
      <GstNav />
      <Card bodyClassName="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <PeriodBar period={period}>
            <div className="w-36"><Select aria-label="Status" value={status} onChange={(e) => period.set({ status: e.target.value === 'POSTED' ? undefined : e.target.value })}><option value="POSTED">Posted</option><option value="CANCELLED">Cancelled</option><option value="ALL">All statuses</option></Select></div>
            <div className="w-60"><Select aria-label="ITC category" value={category} onChange={(e) => period.set({ category: e.target.value || undefined })}>
              <option value="">All ITC classifications</option>
              {[...ITC_ELIGIBILITY, 'NOT_AVAILABLE'].map((s) => <option key={s} value={s}>{ITC_LABELS[s as keyof typeof ITC_LABELS]}</option>)}
              <option value="RCM">Reverse charge only</option>
            </Select></div>
          </PeriodBar>
          {manage && selectable.length > 0 && <Button variant="ghost" onClick={() => setSelected(new Set(selectable.filter((d) => d.itc.eligibility === 'PENDING').map(key)))}>Select pending</Button>}
          {data && <span className="ml-auto"><CheckPill ok={data.ledger.agrees} okText="Agrees with input GST ledgers" badText="Differs from input GST ledgers" /></span>}
        </div>
        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? <Spinner /> : data && (
          <>
            <SummaryStrip items={[
              { label: 'Documents', value: data.docs.length }, { label: 'Taxable value', value: formatINR(data.totals.taxablePaise) },
              { label: 'Eligible ITC', value: formatINR(tax('ELIGIBLE')), tone: 'good' }, { label: 'Pending review', value: formatINR(tax('PENDING')), tone: tax('PENDING') ? 'bad' : undefined },
              { label: 'Ineligible / blocked', value: formatINR(tax('INELIGIBLE') + tax('BLOCKED')) }, { label: 'Reverse-charge tax', value: formatINR(data.rcm.igstPaise + data.rcm.cgstPaise + data.rcm.sgstPaise) }
            ]} />
            <div className="mb-3"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'docs', label: 'Documents', count: data.docs.length }, { value: 'hsn', label: 'HSN summary', count: data.hsn.length }, { value: 'rates', label: 'Tax summary', count: data.rates.length }]} /></div>
            {tab === 'docs' && <DataTable rows={data.docs} columns={cols} rowKey={key} onRowClick={(d) => nav(d.route)} empty={<EmptyState title="No inward supplies in this period" />} maxHeight="max-h-[calc(100vh-440px)]" />}
            {tab === 'hsn' && <HsnTable rows={data.hsn} />}
            {tab === 'rates' && <TaxTable rows={data.rates} cols={[{ h: 'Rate', v: (r) => `${r.ratePct}%` }, { h: 'Taxable', v: (r) => <Money p={r.taxablePaise} />, right: true }, { h: 'IGST', v: (r) => <Money p={r.igstPaise} />, right: true }, { h: 'CGST', v: (r) => <Money p={r.cgstPaise} />, right: true }, { h: 'SGST', v: (r) => <Money p={r.sgstPaise} />, right: true }]} />}
            <p className="mt-2 text-[12px] text-ink-3">Returns and debit notes inherit the classification of their bill unless classified separately. Self-assessed reverse-charge tax is shown for GSTR-3B but is not posted to the ledger by the ERP.</p>
          </>
        )}
      </Card>
      <Modal open={classify} title={`Classify input tax credit — ${selected.size} document(s)`} onClose={() => setClassify(false)} footer={<><Button variant="secondary" onClick={() => setClassify(false)}>Cancel</Button><Button loading={busy} onClick={() => void save()}>Save classification</Button></>}>
        {formError && <ErrorBanner error={new Error(formError)} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Eligibility"><Select value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value })}>{ITC_ELIGIBILITY.map((x) => <option key={x} value={x}>{ITC_LABELS[x]}</option>)}</Select></Field>
          <Field label="Type of credit"><Select value={form.itcType} onChange={(e) => setForm({ ...form, itcType: e.target.value })}>{ITC_TYPES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</Select></Field>
          <label className="col-span-2 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={form.reverseCharge} onChange={(e) => setForm({ ...form, reverseCharge: e.target.checked })} />Tax payable under reverse charge (RCM)</label>
          <Field label="Reason" className="col-span-2" hint="Required for ineligible or blocked credit"><input className="h-9 w-full rounded-lg border border-line px-2.5 text-[13px]" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={200} /></Field>
        </div>
        <p className="mt-3 text-[12px] text-ink-3">The classification is your decision and is recorded in the audit trail. It does not change the posted bill.</p>
      </Modal>
    </div>
  )
}

// ───────── Validation ─────────
export function GstValidationPage() {
  const { session } = useSession()
  const nav = useNavigate()
  const period = usePeriod()
  const [cat, setCat] = useState<string>('ALL')
  const p = period.ready ? { from: period.from!, to: period.to! } : null
  const { data, error, loading, reload } = useQuery<GstValidationReport | null>(() => (p ? api('gst:validate', p) : Promise.resolve(null)), [JSON.stringify(p), session?.company?.id])
  const rows = (data?.issues ?? []).filter((i) => cat === 'ALL' || i.category === cat)
  return (
    <div>
      <PageHeader title="GST Validation" description="Checks posted documents before return preparation. Errors block preparation; warnings are recorded with it." />
      <GstNav />
      <Card bodyClassName="p-4">
        <div className="mb-3"><PeriodBar period={period} /></div>
        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? <Spinner /> : data && (
          <>
            <SummaryStrip items={[{ label: 'Documents checked', value: data.checkedDocuments }, { label: 'Errors', value: data.errors, tone: data.errors ? 'bad' : 'good' }, { label: 'Warnings', value: data.warnings }]} />
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button onClick={() => setCat('ALL')} className={cx('rounded-full border px-3 py-1 text-[12.5px] font-semibold', cat === 'ALL' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-2')}>All · {data.issues.length}</button>
              {ISSUE_CATEGORIES.map((c) => (
                <button key={c} onClick={() => setCat(c)} className={cx('rounded-full border px-3 py-1 text-[12.5px] font-semibold', cat === c ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-2')}>{ISSUE_LABELS[c]} · {data.byCategory[c] ?? 0}</button>
              ))}
            </div>
            <DataTable
              rows={rows}
              rowKey={(i) => `${i.kind}:${i.id}:${i.message}`}
              onRowClick={(i) => nav(i.route)}
              empty={<EmptyState title="No issues found" message="Every posted document in this period passed the checks." />}
              columns={[
                { key: 's', header: 'Severity', render: (i) => <Badge tone={i.severity === 'ERROR' ? 'red' : 'amber'}>{i.severity === 'ERROR' ? 'Error' : 'Warning'}</Badge>, sortValue: (i) => i.severity },
                { key: 'c', header: 'Check', render: (i) => ISSUE_LABELS[i.category], sortValue: (i) => i.category },
                { key: 'd', header: 'Document', render: (i) => <span><span className="font-semibold">{i.number}</span><span className="block text-[11.5px] text-ink-3">{titleCase(i.kind)} · {formatDate(i.date)}</span></span> },
                { key: 'p', header: 'Party', render: (i) => i.partyName ?? '—', wrap: true },
                { key: 'm', header: 'Finding', render: (i) => i.message, wrap: true }
              ]}
            />
          </>
        )}
      </Card>
    </div>
  )
}
