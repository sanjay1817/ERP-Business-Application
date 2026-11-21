import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import {
  INTEGRATION_MODES, REGISTRATION_TYPES, RULE_KEYS, TAX_CATEGORIES, TAX_CATEGORY_LABELS, type ComplianceRule, type GstConfig, type HsnCode, type HsnRateRule, type IntegrationOverview, type RuleKey
} from '@shared/gst'
import { GST_STATES, stateName } from '@shared/india'
import { toPaise } from '@shared/money'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Tabs } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { GstNav } from './common'

type Tab = 'registrations' | 'settings' | 'hsn' | 'rates' | 'rules' | 'integrations'

function useSaver() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Error | null>(null)
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      toast('success', ok)
      return true
    } catch (e) {
      setErr(e as Error)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, err, run, clear: () => setErr(null) }
}

const ruleValue = (r: { ruleKey: string; valueNum: number; unit: string }) => (r.unit === 'paise' ? formatINR(r.valueNum) : `${r.valueNum} ${r.unit}`)

export default function GstConfigPage() {
  const { session, can } = useSession()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) ?? 'registrations'
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true })
  const cfg = useQuery<GstConfig>(() => api('gst:config'), [session?.company?.id])
  const manage = can('gst.manage')
  return (
    <div>
      <PageHeader title="GST Configuration" description="Registrations, turnover, HSN/SAC rates and compliance rules — all effective-dated and editable. Verify every value against the current notifications." />
      <GstNav />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'registrations', label: 'Registrations' }, { value: 'settings', label: 'Turnover & e-invoicing' }, { value: 'hsn', label: 'HSN / SAC & rates' }, { value: 'rates', label: 'Tax rate master' }, { value: 'rules', label: 'Compliance rules' }, { value: 'integrations', label: 'Integrations' }]} /></div>
      <ErrorBanner error={cfg.error} onRetry={cfg.reload} />
      {cfg.loading && !cfg.data ? <Spinner /> : cfg.data && (
        <>
          {tab === 'registrations' && <Registrations cfg={cfg.data} manage={manage} reload={cfg.reload} />}
          {tab === 'settings' && <Settings cfg={cfg.data} manage={manage} reload={cfg.reload} />}
          {tab === 'hsn' && <HsnMaster manage={manage} />}
          {tab === 'rates' && <TaxRates cfg={cfg.data} manage={manage} reload={cfg.reload} />}
          {tab === 'rules' && <Rules rules={cfg.data.rules} manage={manage} reload={cfg.reload} />}
          {tab === 'integrations' && <Integrations />}
        </>
      )}
    </div>
  )
}

function Registrations({ cfg, manage, reload }: { cfg: GstConfig; manage: boolean; reload: () => void }) {
  const s = useSaver()
  const blank = { id: 0, gstin: '', registrationType: 'REGULAR', stateCode: cfg.company.stateCode, branchId: '', legalName: cfg.company.legalName ?? '', tradeName: cfg.company.name, address: '', pincode: '', effectiveFrom: '2017-07-01', effectiveTo: '', isPrimary: cfg.registrations.length === 0, isActive: true }
  const [f, setF] = useState<typeof blank | null>(null)
  return (
    <Card title="GST registrations" subtitle="Each registration (GSTIN) of this company. Documents of a branch use that branch's registration; others use the primary one." actions={manage ? <Button icon={<Plus className="size-4" />} onClick={() => setF(blank)}>Add registration</Button> : undefined} bodyClassName="p-0">
      <DataTable rows={cfg.registrations} rowKey={(r) => r.id} onRowClick={manage ? (r) => setF({ ...blank, ...r, branchId: r.branchId ? String(r.branchId) : '', legalName: r.legalName ?? '', tradeName: r.tradeName ?? '', address: r.address ?? '', pincode: r.pincode ?? '', effectiveTo: r.effectiveTo ?? '' }) : undefined} columns={[
        { key: 'g', header: 'GSTIN', render: (r) => <span className="font-mono font-semibold">{r.gstin}</span> },
        { key: 't', header: 'Type', render: (r) => titleCase(r.registrationType) },
        { key: 's', header: 'State', render: (r) => `${r.stateCode} ${stateName(r.stateCode)}` },
        { key: 'b', header: 'Branch', render: (r) => r.branchName ?? '—' },
        { key: 'n', header: 'Trade name', render: (r) => r.tradeName ?? '—', wrap: true },
        { key: 'e', header: 'Effective', render: (r) => `${formatDate(r.effectiveFrom)} – ${r.effectiveTo ? formatDate(r.effectiveTo) : 'open'}` },
        { key: 'p', header: '', render: (r) => <span className="flex gap-1">{r.isPrimary && <Badge tone="blue">Primary</Badge>}{!r.isActive && <Badge tone="gray">Inactive</Badge>}</span> }
      ]} />
      <Modal open={!!f} title={f?.id ? 'Edit registration' : 'Add registration'} onClose={() => { setF(null); s.clear() }} width="max-w-2xl" footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => {
        if (!f) return
        if (await s.run(() => api('gst:saveRegistration', { ...(f.id ? { id: f.id } : {}), gstin: f.gstin, registrationType: f.registrationType as 'REGULAR', stateCode: f.stateCode, branchId: f.branchId ? Number(f.branchId) : null, legalName: f.legalName, tradeName: f.tradeName, address: f.address, pincode: f.pincode, effectiveFrom: f.effectiveFrom, effectiveTo: f.effectiveTo || null, isPrimary: f.isPrimary, isActive: f.isActive }), 'Registration saved')) { setF(null); reload() }
      }}>Save</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {f && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="GSTIN" required><Input className="font-mono uppercase" value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase(), stateCode: e.target.value.slice(0, 2) || f.stateCode })} maxLength={15} /></Field>
            <Field label="Registration type"><Select value={f.registrationType} onChange={(e) => setF({ ...f, registrationType: e.target.value })}>{REGISTRATION_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select></Field>
            <Field label="State"><Select value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}>{GST_STATES.map((st) => <option key={st.code} value={st.code}>{st.code} {st.name}</option>)}</Select></Field>
            <Field label="Branch"><Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">— none —</option>{cfg.branches.map((b) => <option key={b.id} value={b.id}>{b.code} {b.name}</option>)}</Select></Field>
            <Field label="Legal name"><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
            <Field label="Trade name"><Input value={f.tradeName} onChange={(e) => setF({ ...f, tradeName: e.target.value })} /></Field>
            <Field label="Address" className="col-span-2"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <Field label="PIN code"><Input value={f.pincode} onChange={(e) => setF({ ...f, pincode: e.target.value })} maxLength={6} /></Field>
            <div />
            <Field label="Effective from"><Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
            <Field label="Effective to" hint="Leave blank while active"><Input type="date" value={f.effectiveTo} onChange={(e) => setF({ ...f, effectiveTo: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} />Primary registration</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Active</label>
          </div>
        )}
      </Modal>
    </Card>
  )
}

function Settings({ cfg, manage, reload }: { cfg: GstConfig; manage: boolean; reload: () => void }) {
  const s = useSaver()
  const st = cfg.settings
  const [f, setF] = useState({ aato: st.aatoPaise != null ? String(st.aatoPaise / 100) : '', aatoFy: st.aatoFy ?? '', einvoiceEnabled: st.einvoiceEnabled, einvoiceExemptReason: st.einvoiceExemptReason ?? '', returnFrequency: st.returnFrequency, lutNumber: st.lutNumber ?? '', lutValidFrom: st.lutValidFrom ?? '', lutValidUpto: st.lutValidUpto ?? '' })
  const r = cfg.effectiveToday
  const aato = f.aato ? Number(f.aato) * 100 : null
  return (
    <div className="grid grid-cols-[1fr_360px] gap-4">
      <Card title="Turnover, e-invoicing and LUT" subtitle={st.updatedAt ? `Last updated ${formatDateTime(st.updatedAt)}` : 'Not set yet'} actions={manage ? <Button loading={s.busy} onClick={async () => {
        if (await s.run(() => api('gst:saveSettings', { aatoPaise: f.aato ? toPaise(f.aato) : null, aatoFy: f.aatoFy || null, einvoiceEnabled: f.einvoiceEnabled, einvoiceExemptReason: f.einvoiceExemptReason || null, returnFrequency: f.returnFrequency, lutNumber: f.lutNumber || null, lutValidFrom: f.lutValidFrom || null, lutValidUpto: f.lutValidUpto || null }), 'GST settings saved')) reload()
      }}>Save settings</Button> : undefined}>
        {s.err && <ErrorBanner error={s.err} />}
        <fieldset disabled={!manage} className="grid grid-cols-2 gap-3">
          <Field label="Aggregate annual turnover (₹)" hint="Previous financial year, all registrations on the PAN"><Input inputMode="decimal" value={f.aato} onChange={(e) => setF({ ...f, aato: e.target.value })} /></Field>
          <Field label="Turnover of financial year"><Input placeholder="2025-26" value={f.aatoFy} onChange={(e) => setF({ ...f, aatoFy: e.target.value })} /></Field>
          <label className="col-span-2 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.einvoiceEnabled} onChange={(e) => setF({ ...f, einvoiceEnabled: e.target.checked })} /><span><strong>E-invoicing applies to this company</strong> — confirm against the current threshold and exemptions before enabling.</span></label>
          <Field label="Exempt from e-invoicing because" className="col-span-2" hint="e.g. a notified exempt category. Leave blank if not exempt."><Input value={f.einvoiceExemptReason} onChange={(e) => setF({ ...f, einvoiceExemptReason: e.target.value })} /></Field>
          <Field label="Return frequency"><Select value={f.returnFrequency} onChange={(e) => setF({ ...f, returnFrequency: e.target.value as 'MONTHLY' })}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly (QRMP)</option></Select></Field>
          <Field label="LUT / bond reference" hint="For zero-rated supplies without IGST"><Input value={f.lutNumber} onChange={(e) => setF({ ...f, lutNumber: e.target.value })} /></Field>
          <Field label="LUT valid from"><Input type="date" value={f.lutValidFrom} onChange={(e) => setF({ ...f, lutValidFrom: e.target.value })} /></Field>
          <Field label="LUT valid up to"><Input type="date" value={f.lutValidUpto} onChange={(e) => setF({ ...f, lutValidUpto: e.target.value })} /></Field>
        </fieldset>
        {f.returnFrequency === 'QUARTERLY' && <p className="mt-3 text-[12px] text-amber-800">Quarterly (QRMP) return preparation is not implemented; returns are prepared month by month.</p>}
      </Card>
      <Card title="What the rules say today" subtitle="From Compliance rules (editable)">
        <ul className="space-y-2 text-[13px]">
          <li className="flex justify-between gap-2"><span>E-invoicing threshold</span><b className="tabular">{formatINR(r.EINVOICE_AATO_THRESHOLD_PAISE)}</b></li>
          <li className="flex justify-between gap-2"><span>Turnover entered</span><b className="tabular">{aato != null ? formatINR(aato) : 'not set'}</b></li>
          <li>{aato == null ? <Badge tone="gray">Enter turnover to check</Badge> : aato >= r.EINVOICE_AATO_THRESHOLD_PAISE ? <Badge tone="amber">At or above the e-invoicing threshold</Badge> : <Badge tone="green">Below the e-invoicing threshold</Badge>}</li>
          <li className="flex justify-between gap-2"><span>{r.EINVOICE_REPORTING_LIMIT_DAYS}-day IRP reporting limit from</span><b className="tabular">{formatINR(r.EINVOICE_REPORTING_LIMIT_AATO_PAISE)}</b></li>
          <li className="flex justify-between gap-2"><span>B2C Large invoice value above</span><b className="tabular">{formatINR(r.B2CL_INVOICE_THRESHOLD_PAISE)}</b></li>
          <li className="flex justify-between gap-2"><span>Minimum HSN digits</span><b>{aato != null && aato > r.HSN_LARGE_AATO_PAISE ? r.HSN_MIN_DIGITS_LARGE : r.HSN_MIN_DIGITS_SMALL}</b></li>
        </ul>
      </Card>
    </div>
  )
}

function HsnMaster({ manage }: { manage: boolean }) {
  const { session } = useSession()
  const toast = useToast()
  const list = useQuery<HsnCode[]>(() => api('gst:hsnList'), [session?.company?.id])
  const [sel, setSel] = useState<string | null>(null)
  const rates = useQuery<HsnRateRule[]>(() => (sel ? api('gst:hsnRates', { hsnCode: sel }) : Promise.resolve([])), [sel])
  const s = useSaver()
  const [code, setCode] = useState<{ id?: number; code: string; description: string; kind: string; defaultUqc: string } | null>(null)
  const [rate, setRate] = useState<{ id?: number; effectiveFrom: string; effectiveTo: string; taxCategory: string; rate: string; cess: string; reverseCharge: boolean; notes: string } | null>(null)
  const current = list.data?.find((h) => h.code === sel)
  return (
    <div className="grid grid-cols-[1fr_440px] items-start gap-4">
      <Card title="HSN / SAC master" subtitle="Rate shown is the one effective today" actions={manage ? <span className="flex gap-2"><Button variant="secondary" onClick={async () => { const r = await api('gst:importHsn'); toast('success', `${r.added} code(s) added from products`); list.reload() }}>Add from products</Button><Button icon={<Plus className="size-4" />} onClick={() => setCode({ code: '', description: '', kind: 'GOODS', defaultUqc: '' })}>Add code</Button></span> : undefined} bodyClassName="p-0">
        <ErrorBanner error={list.error} onRetry={list.reload} />
        <DataTable rows={list.data ?? []} rowKey={(h) => h.id} onRowClick={(h) => setSel(h.code)} maxHeight="max-h-[calc(100vh-360px)]" columns={[
          { key: 'c', header: 'Code', render: (h) => <span className="font-mono font-semibold">{h.code}</span>, sortValue: (h) => h.code },
          { key: 'd', header: 'Description', render: (h) => h.description, wrap: true },
          { key: 'k', header: 'Kind', render: (h) => titleCase(h.kind) },
          { key: 'r', header: 'Today', render: (h) => (h.currentRate ? <span className="flex gap-1"><Badge tone={h.currentRate.taxCategory === 'TAXABLE' ? 'blue' : 'violet'}>{h.currentRate.taxCategory === 'TAXABLE' ? `${h.currentRate.rateBps / 100}%` : TAX_CATEGORY_LABELS[h.currentRate.taxCategory]}</Badge>{h.currentRate.reverseCharge && <Badge tone="amber">RCM</Badge>}</span> : <Badge tone="red">No rate</Badge>) },
          { key: 'p', header: 'Products', align: 'right', render: (h) => h.productCount }
        ]} />
      </Card>
      <Card title={sel ? `Rates for ${sel}` : 'Effective-dated rates'} subtitle={current?.description ?? 'Select a code'} actions={manage && sel ? <Button icon={<Plus className="size-4" />} onClick={() => setRate({ effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: '', taxCategory: 'TAXABLE', rate: '18', cess: '0', reverseCharge: false, notes: '' })}>New rate</Button> : undefined}>
        {!sel ? <p className="text-[13px] text-ink-3">Rates are effective-dated: a new rate closes the previous open period the day before it starts. Documents are checked against the rate in force on their date.</p> : (
          <ul className="divide-y divide-slate-100">
            {(rates.data ?? []).map((r) => (
              <li key={r.id} className="py-2 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{formatDate(r.effectiveFrom)} – {r.effectiveTo ? formatDate(r.effectiveTo) : 'open'}</span>
                  <span className="flex gap-1"><Badge tone="blue">{r.taxCategory === 'TAXABLE' ? `${r.rateBps / 100}%` : TAX_CATEGORY_LABELS[r.taxCategory]}</Badge>{r.cessBps > 0 && <Badge tone="gray">Cess {r.cessBps / 100}%</Badge>}{r.reverseCharge && <Badge tone="amber">Reverse charge</Badge>}</span>
                </div>
                {r.notes && <p className="text-[12px] text-ink-3">{r.notes}</p>}
                {r.source === 'PRODUCT_MASTER' && <p className="text-[12px] text-amber-800">Copied from the product master during upgrade — verify.</p>}
              </li>
            ))}
            {rates.data?.length === 0 && <li className="py-2 text-[13px] text-red-700">No rate rule — documents with this code are flagged in validation.</li>}
          </ul>
        )}
      </Card>
      <Modal open={!!code} title="HSN / SAC code" onClose={() => { setCode(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setCode(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => { if (code && (await s.run(() => api('gst:saveHsn', { ...(code.id ? { id: code.id } : {}), code: code.code, description: code.description, kind: code.kind as 'GOODS', defaultUqc: code.defaultUqc || null, isActive: true }), 'Code saved'))) { setCode(null); list.reload() } }}>Save</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {code && <div className="grid grid-cols-2 gap-3">
          <Field label="Code (4–8 digits)" required><Input className="font-mono" value={code.code} onChange={(e) => setCode({ ...code, code: e.target.value })} maxLength={8} /></Field>
          <Field label="Kind"><Select value={code.kind} onChange={(e) => setCode({ ...code, kind: e.target.value })}><option value="GOODS">Goods (HSN)</option><option value="SERVICE">Service (SAC)</option></Select></Field>
          <Field label="Description" className="col-span-2" required><Input value={code.description} onChange={(e) => setCode({ ...code, description: e.target.value })} /></Field>
          <Field label="Default UQC"><Input value={code.defaultUqc} onChange={(e) => setCode({ ...code, defaultUqc: e.target.value.toUpperCase() })} maxLength={10} /></Field>
        </div>}
      </Modal>
      <Modal open={!!rate} title={`New rate for ${sel}`} onClose={() => { setRate(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setRate(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => {
        if (rate && sel && (await s.run(() => api('gst:saveHsnRate', { hsnCode: sel, effectiveFrom: rate.effectiveFrom, effectiveTo: rate.effectiveTo || null, taxCategory: rate.taxCategory as 'TAXABLE', rateBps: Math.round(Number(rate.rate) * 100), cessBps: Math.round(Number(rate.cess || '0') * 100), reverseCharge: rate.reverseCharge, notes: rate.notes || null }), 'Rate saved'))) { setRate(null); rates.reload(); list.reload() }
      }}>Save rate</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {rate && <div className="grid grid-cols-2 gap-3">
          <Field label="Effective from" required><Input type="date" value={rate.effectiveFrom} onChange={(e) => setRate({ ...rate, effectiveFrom: e.target.value })} /></Field>
          <Field label="Effective to"><Input type="date" value={rate.effectiveTo} onChange={(e) => setRate({ ...rate, effectiveTo: e.target.value })} /></Field>
          <Field label="Tax category"><Select value={rate.taxCategory} onChange={(e) => setRate({ ...rate, taxCategory: e.target.value, rate: e.target.value === 'TAXABLE' ? rate.rate : '0' })}>{TAX_CATEGORIES.map((c) => <option key={c} value={c}>{TAX_CATEGORY_LABELS[c]}</option>)}</Select></Field>
          <Field label="GST rate (%)"><Input inputMode="decimal" value={rate.rate} disabled={rate.taxCategory !== 'TAXABLE'} onChange={(e) => setRate({ ...rate, rate: e.target.value })} /></Field>
          <Field label="Cess (%)"><Input inputMode="decimal" value={rate.cess} onChange={(e) => setRate({ ...rate, cess: e.target.value })} /></Field>
          <label className="flex items-center gap-2 pt-6 text-[13px]"><input type="checkbox" checked={rate.reverseCharge} onChange={(e) => setRate({ ...rate, reverseCharge: e.target.checked })} />Reverse charge applies</label>
          <Field label="Notification / note" className="col-span-2"><Input value={rate.notes} onChange={(e) => setRate({ ...rate, notes: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  )
}

function TaxRates({ cfg, manage, reload }: { cfg: GstConfig; manage: boolean; reload: () => void }) {
  const s = useSaver()
  const [f, setF] = useState<{ id: number; name: string; from: string; to: string } | null>(null)
  return (
    <Card title="Tax rate master" subtitle="Rates selectable on documents. Effective dates document when a slab applies; HSN rates above decide what is correct for each item." bodyClassName="p-0">
      <DataTable rows={cfg.taxRates} rowKey={(t) => t.id} onRowClick={manage ? (t) => setF({ id: t.id, name: t.name, from: t.effectiveFrom ?? '', to: t.effectiveTo ?? '' }) : undefined} columns={[
        { key: 'n', header: 'Name', render: (t) => <span className="font-semibold">{t.name}</span> },
        { key: 'r', header: 'Rate', align: 'right', render: (t) => `${t.rateBps / 100}%` },
        { key: 'cg', header: 'CGST + SGST', align: 'right', render: (t) => `${t.rateBps / 200}% + ${t.rateBps / 200}%` },
        { key: 'ig', header: 'IGST', align: 'right', render: (t) => `${t.rateBps / 100}%` },
        { key: 'e', header: 'Effective', render: (t) => (t.effectiveFrom || t.effectiveTo ? `${t.effectiveFrom ? formatDate(t.effectiveFrom) : '…'} – ${t.effectiveTo ? formatDate(t.effectiveTo) : 'open'}` : <span className="text-ink-3">not set</span>) },
        { key: 'p', header: 'Products', align: 'right', render: (t) => t.productCount },
        { key: 'a', header: '', render: (t) => !t.isActive && <Badge tone="gray">Inactive</Badge> }
      ]} />
      <Modal open={!!f} title={f?.name ?? ''} onClose={() => { setF(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => { if (f && (await s.run(() => api('gst:saveTaxRateDates', { id: f.id, effectiveFrom: f.from || null, effectiveTo: f.to || null }), 'Dates saved'))) { setF(null); reload() } }}>Save</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {f && <div className="grid grid-cols-2 gap-3"><Field label="Effective from"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label="Effective to"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>}
      </Modal>
    </Card>
  )
}

function Rules({ rules, manage, reload }: { rules: ComplianceRule[]; manage: boolean; reload: () => void }) {
  const s = useSaver()
  const [f, setF] = useState<{ id?: number; ruleKey: RuleKey; value: string; unit: string; from: string; to: string; note: string } | null>(null)
  return (
    <Card title="Compliance rules" subtitle="Thresholds and limits used by classification, e-invoice and e-way bill checks. Defaults come from public guidance and must be verified; a company rule overrides the default for its dates." actions={manage ? <Button icon={<Plus className="size-4" />} onClick={() => setF({ ruleKey: 'B2CL_INVOICE_THRESHOLD_PAISE', value: '', unit: 'paise', from: new Date().toISOString().slice(0, 10), to: '', note: '' })}>Add company rule</Button> : undefined} bodyClassName="p-0">
      <DataTable rows={rules} rowKey={(r) => r.id} onRowClick={manage ? (r) => (r.companySpecific ? setF({ id: r.id, ruleKey: r.ruleKey, value: String(r.unit === 'paise' ? r.valueNum / 100 : r.valueNum), unit: r.unit, from: r.effectiveFrom, to: r.effectiveTo ?? '', note: r.sourceNote ?? '' }) : setF({ ruleKey: r.ruleKey, value: String(r.unit === 'paise' ? r.valueNum / 100 : r.valueNum), unit: r.unit, from: new Date().toISOString().slice(0, 10), to: '', note: '' })) : undefined} maxHeight="max-h-[calc(100vh-330px)]" columns={[
        { key: 'k', header: 'Rule', render: (r) => <span><span className="font-semibold">{r.description}</span><span className="block font-mono text-[11px] text-ink-3">{r.ruleKey}</span></span>, wrap: true },
        { key: 'v', header: 'Value', align: 'right', render: (r) => <span className="font-semibold">{ruleValue(r)}</span> },
        { key: 'e', header: 'Effective', render: (r) => `${formatDate(r.effectiveFrom)} – ${r.effectiveTo ? formatDate(r.effectiveTo) : 'open'}` },
        { key: 's', header: 'Source', render: (r) => <span className="text-[12px] text-ink-2">{r.sourceNote ?? '—'}</span>, wrap: true },
        { key: 'x', header: '', render: (r) => <span className="flex gap-1">{r.companySpecific ? <Badge tone="violet">Company</Badge> : <Badge tone="gray">Default</Badge>}{r.activeToday && <Badge tone="green">In force</Badge>}</span> }
      ]} />
      <Modal open={!!f} title={f?.id ? 'Edit company rule' : 'Company rule (overrides the default)'} onClose={() => { setF(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => {
        if (!f) return
        const unit = rules.find((r) => r.ruleKey === f.ruleKey)?.unit ?? f.unit
        if (await s.run(() => api('gst:saveRule', { ...(f.id ? { id: f.id } : {}), ruleKey: f.ruleKey, valueNum: unit === 'paise' ? toPaise(f.value) : Math.round(Number(f.value)), effectiveFrom: f.from, effectiveTo: f.to || null, sourceNote: f.note || null }), 'Rule saved')) { setF(null); reload() }
      }}>Save</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {f && <div className="grid grid-cols-2 gap-3">
          <Field label="Rule" className="col-span-2"><Select value={f.ruleKey} disabled={!!f.id} onChange={(e) => setF({ ...f, ruleKey: e.target.value as RuleKey })}>{RULE_KEYS.map((k) => <option key={k} value={k}>{rules.find((r) => r.ruleKey === k)?.description ?? k}</option>)}</Select></Field>
          <Field label={`Value (${(rules.find((r) => r.ruleKey === f.ruleKey)?.unit ?? f.unit) === 'paise' ? '₹' : rules.find((r) => r.ruleKey === f.ruleKey)?.unit})`} required><Input inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <div />
          <Field label="Effective from" required><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Effective to"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Source (notification / advisory)" className="col-span-2"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  )
}

function Integrations() {
  const { can, session } = useSession()
  const q = useQuery<IntegrationOverview>(() => api('integration:overview'), [session?.company?.id])
  const s = useSaver()
  const [edit, setEdit] = useState<{ service: string; mode: string; providerName: string; apiBaseUrl: string; timeoutMs: string; maxRetries: string } | null>(null)
  const [cred, setCred] = useState<{ service: string; environment: string; username: string; password: string; clientId: string; clientSecret: string } | null>(null)
  const manage = can('integration.manage')
  if (!q.data) return q.loading ? <Spinner /> : <ErrorBanner error={q.error} onRetry={q.reload} />
  const ov = q.data
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-[13px] text-ink-2" role="note"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-navy-700" /><p><strong>Government integrations connected: none.</strong> {ov.notice}</p></div>
      <Card title="Providers" bodyClassName="p-0">
        <DataTable rows={ov.settings} rowKey={(x) => x.service} onRowClick={manage ? (x) => setEdit({ service: x.service, mode: x.mode, providerName: x.providerName ?? '', apiBaseUrl: x.apiBaseUrl ?? '', timeoutMs: String(x.timeoutMs), maxRetries: String(x.maxRetries) }) : undefined} columns={[
          { key: 's', header: 'Service', render: (x) => <span className="font-semibold">{({ EINVOICE: 'E-invoice (IRN)', EWAYBILL: 'E-way bill', GST_RETURNS: 'GST returns' } as Record<string, string>)[x.service]}</span> },
          { key: 'm', header: 'Mode', render: (x) => <Badge tone={x.mode === 'DEMO' ? 'amber' : 'violet'}>{x.mode}</Badge> },
          { key: 'p', header: 'Provider', render: (x) => x.providerName ?? (x.mode === 'DEMO' ? 'Built-in mock' : '—') },
          { key: 'c', header: 'Connection', render: (x) => <span className="text-[12.5px]">{x.status}</span>, wrap: true },
          { key: 't', header: 'Timeout / retries', render: (x) => `${x.timeoutMs / 1000}s / ${x.maxRetries}` }
        ]} />
      </Card>
      <Card title="Credentials" subtitle={ov.secureStorageAvailable ? 'Encrypted with Windows Data Protection; never shown, logged or exported.' : 'Secure storage is not available here, so credentials cannot be saved.'} bodyClassName="p-0">
        <DataTable rows={ov.credentials} rowKey={(c) => `${c.service}:${c.environment}`} columns={[
          { key: 's', header: 'Service', render: (c) => titleCase(c.service) },
          { key: 'e', header: 'Environment', render: (c) => titleCase(c.environment) },
          { key: 'st', header: 'Stored', render: (c) => (c.stored ? <Badge tone="green">Stored · {c.usernameHint}</Badge> : <Badge tone="gray">None</Badge>) },
          { key: 'u', header: 'Updated', render: (c) => (c.updatedAt ? formatDateTime(c.updatedAt) : '—') },
          { key: 'a', header: '', render: (c) => manage && <span className="flex gap-1"><Button variant="ghost" icon={<KeyRound className="size-4" />} disabled={!ov.secureStorageAvailable} onClick={() => setCred({ service: c.service, environment: c.environment, username: '', password: '', clientId: '', clientSecret: '' })}>{c.stored ? 'Replace' : 'Add'}</Button>{c.stored && <Button variant="ghost" onClick={async () => { await s.run(() => api('integration:deleteCredentials', { service: c.service as 'EINVOICE', environment: c.environment }), 'Credentials removed'); q.reload() }}>Remove</Button>}</span> }
        ]} />
      </Card>
      <Modal open={!!edit} title="Provider settings" onClose={() => { setEdit(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => {
        if (edit && (await s.run(() => api('integration:save', { service: edit.service as 'EINVOICE', mode: edit.mode as 'DEMO', providerName: edit.providerName || null, apiBaseUrl: edit.apiBaseUrl || null, timeoutMs: Number(edit.timeoutMs), maxRetries: Number(edit.maxRetries) }), 'Provider settings saved'))) { setEdit(null); q.reload() }
      }}>Save</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {edit && <div className="grid grid-cols-2 gap-3">
          <Field label="Mode"><Select value={edit.mode} onChange={(e) => setEdit({ ...edit, mode: e.target.value })}>{INTEGRATION_MODES.map((m) => <option key={m} value={m}>{m === 'DEMO' ? 'Demo (mock)' : m === 'SANDBOX' ? 'Sandbox' : 'Live'}</option>)}</Select></Field>
          <Field label="Authorised provider"><Input value={edit.providerName} onChange={(e) => setEdit({ ...edit, providerName: e.target.value })} placeholder="Name of your GSP / API provider" /></Field>
          <Field label="API base URL" className="col-span-2" hint="From your provider's documentation. Nothing is pre-filled."><Input value={edit.apiBaseUrl} onChange={(e) => setEdit({ ...edit, apiBaseUrl: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Timeout (ms)"><Input inputMode="numeric" value={edit.timeoutMs} onChange={(e) => setEdit({ ...edit, timeoutMs: e.target.value })} /></Field>
          <Field label="Retries (transient errors)"><Input inputMode="numeric" value={edit.maxRetries} onChange={(e) => setEdit({ ...edit, maxRetries: e.target.value })} /></Field>
          {edit.mode !== 'DEMO' && <p className="col-span-2 text-[12px] text-amber-800">No sandbox/live adapter is installed: requests in this mode fail safely with “not configured”. They are recorded as failures and never shown as successful.</p>}
        </div>}
      </Modal>
      <Modal open={!!cred} title={`Credentials — ${cred?.service} (${cred?.environment})`} onClose={() => { setCred(null); s.clear() }} footer={<><Button variant="secondary" onClick={() => setCred(null)}>Cancel</Button><Button loading={s.busy} onClick={async () => {
        if (cred && (await s.run(() => api('integration:saveCredentials', { service: cred.service as 'EINVOICE', environment: cred.environment as 'LIVE', username: cred.username, password: cred.password, ...(cred.clientId ? { clientId: cred.clientId } : {}), ...(cred.clientSecret ? { clientSecret: cred.clientSecret } : {}) }), 'Credentials stored (encrypted)'))) { setCred(null); q.reload() }
      }}>Store encrypted</Button></>}>
        {s.err && <ErrorBanner error={s.err} />}
        {cred && <div className="grid grid-cols-2 gap-3">
          <Field label="API username" required><Input autoComplete="off" value={cred.username} onChange={(e) => setCred({ ...cred, username: e.target.value })} /></Field>
          <Field label="API password" required><Input type="password" autoComplete="new-password" value={cred.password} onChange={(e) => setCred({ ...cred, password: e.target.value })} /></Field>
          <Field label="Client ID"><Input autoComplete="off" value={cred.clientId} onChange={(e) => setCred({ ...cred, clientId: e.target.value })} /></Field>
          <Field label="Client secret"><Input type="password" autoComplete="new-password" value={cred.clientSecret} onChange={(e) => setCred({ ...cred, clientSecret: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  )
}
