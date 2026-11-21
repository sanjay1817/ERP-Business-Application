import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { Company } from '@shared/types'
import { GST_STATES } from '@shared/india'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useForm, text, type FormValues } from '../../lib/form'
import { formatDate, stateName } from '../../lib/format'
import { Badge, Button, Card, DataTable, DemoBadge, Drawer, ErrorBanner, Field, FormSection, Input, PageHeader, Select, Spinner } from '../../components/ui'

const EMPTY: FormValues = { code: '', name: '', legalName: '', gstin: '', pan: '', stateCode: '33', addressLine1: '', addressLine2: '', city: '', pincode: '', phone: '', email: '', fyStartMonth: '4', bankName: '', bankAccountNo: '', bankIfsc: '', bankBranch: '', upiId: '', invoiceTerms: '' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function CompaniesPage() {
  const { can, session, setSession } = useSession()
  const { data, error, loading, reload } = useQuery<Company[]>(() => api('company:list'))
  const [editing, setEditing] = useState<Company | 'new' | null>(null)
  const form = useForm(EMPTY)
  const canManage = can('company.manage')

  const open = (c: Company | 'new') => {
    setEditing(c)
    form.reset(c === 'new' ? EMPTY : Object.fromEntries(Object.entries(EMPTY).map(([k]) => [k, String((c as unknown as Record<string, unknown>)[k] ?? '')])))
  }

  async function save() {
    const v = form.values
    const payload = {
      code: text(v, 'code'), name: text(v, 'name'), legalName: text(v, 'legalName'), gstin: text(v, 'gstin'), pan: text(v, 'pan'), stateCode: text(v, 'stateCode'),
      addressLine1: text(v, 'addressLine1'), addressLine2: text(v, 'addressLine2'), city: text(v, 'city'), pincode: text(v, 'pincode'), phone: text(v, 'phone'),
      email: text(v, 'email'), fyStartMonth: Number(v.fyStartMonth), bankName: text(v, 'bankName'), bankAccountNo: text(v, 'bankAccountNo'),
      bankIfsc: text(v, 'bankIfsc'), bankBranch: text(v, 'bankBranch'), upiId: text(v, 'upiId'), invoiceTerms: text(v, 'invoiceTerms')
    }
    const res =
      editing === 'new'
        ? await form.submit(() => payload, (p) => api('company:create', p), (c) => `Company ${c.code} created`)
        : await form.submit(() => ({ ...payload, id: (editing as Company).id }), (p) => api('company:update', p), (c) => `Company ${c.code} saved`)
    if (res) {
      setEditing(null)
      reload()
      if (session?.company?.id === res.id) setSession(await api('auth:session'))
    }
  }

  const b = form.bind
  return (
    <div>
      <PageHeader
        title="Companies"
        description="Each company has its own customers, stock, ledgers and document numbering."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => open('new')}>New company</Button>}
      />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={data ?? []}
            rowKey={(r) => r.id}
            onRowClick={canManage ? open : undefined}
            columns={[
              { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span>, sortValue: (r) => r.code },
              { key: 'name', header: 'Company', render: (r) => <span className="flex items-center gap-2 font-semibold text-ink">{r.name}{r.isDemo && <DemoBadge />}</span>, sortValue: (r) => r.name },
              { key: 'gstin', header: 'GSTIN', render: (r) => <span className="font-mono text-[12.5px]">{r.gstin ?? '—'}</span> },
              { key: 'state', header: 'State', render: (r) => stateName(r.stateCode) },
              { key: 'fy', header: 'FY starts', render: (r) => MONTHS[r.fyStartMonth - 1] },
              { key: 'active', header: 'Status', render: (r) => (session?.company?.id === r.id ? <Badge tone="blue">Current</Badge> : r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
              { key: 'created', header: 'Created', render: (r) => formatDate(r.createdAt) }
            ]}
          />
        )}
      </Card>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New company' : `Edit ${(editing as Company | null)?.name ?? ''}`}
        subtitle={editing === 'new' ? 'A head office branch, main warehouse and chart of accounts are created automatically.' : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button loading={form.saving} onClick={() => void save()}>Save company</Button>
          </>
        }
      >
        {form.formError && <ErrorBanner error={new Error(form.formError)} />}
        <FormSection title="Identity">
          <Field label="Code" required error={form.errors.code}><Input {...b('code')} placeholder="e.g. SAHO" /></Field>
          <Field label="Display name" required error={form.errors.name}><Input {...b('name')} /></Field>
          <Field label="Legal name" error={form.errors.legalName} className="col-span-2"><Input {...b('legalName')} /></Field>
          <Field label="GSTIN" error={form.errors.gstin} hint="15 characters; validated with check digit"><Input {...b('gstin')} className="font-mono uppercase" /></Field>
          <Field label="PAN" error={form.errors.pan}><Input {...b('pan')} className="font-mono uppercase" /></Field>
          <Field label="State" required error={form.errors.stateCode}>
            <Select {...b('stateCode')}>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.code} - {s.name}</option>)}</Select>
          </Field>
          <Field label="Financial year starts" error={form.errors.fyStartMonth}>
            <Select {...b('fyStartMonth')}>{MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}</Select>
          </Field>
        </FormSection>
        <FormSection title="Address & contact">
          <Field label="Address line 1" error={form.errors.addressLine1} className="col-span-2"><Input {...b('addressLine1')} /></Field>
          <Field label="Address line 2" error={form.errors.addressLine2} className="col-span-2"><Input {...b('addressLine2')} /></Field>
          <Field label="City" error={form.errors.city}><Input {...b('city')} /></Field>
          <Field label="PIN code" error={form.errors.pincode}><Input {...b('pincode')} /></Field>
          <Field label="Phone" error={form.errors.phone}><Input {...b('phone')} /></Field>
          <Field label="Email" error={form.errors.email}><Input {...b('email')} type="email" /></Field>
        </FormSection>
        <FormSection title="Printed on invoices">
          <Field label="Bank name" error={form.errors.bankName}><Input {...b('bankName')} /></Field>
          <Field label="Branch" error={form.errors.bankBranch}><Input {...b('bankBranch')} /></Field>
          <Field label="Account number" error={form.errors.bankAccountNo}><Input {...b('bankAccountNo')} className="font-mono" /></Field>
          <Field label="IFSC" error={form.errors.bankIfsc}><Input {...b('bankIfsc')} className="font-mono uppercase" /></Field>
          <Field label="UPI ID" error={form.errors.upiId} className="col-span-2"><Input {...b('upiId')} placeholder="name@bank" /></Field>
          <Field label="Default terms & conditions" error={form.errors.invoiceTerms} className="col-span-2" hint="Printed on sales documents unless a document has its own terms">
            <textarea value={String(form.values.invoiceTerms ?? '')} onChange={(e) => form.set('invoiceTerms', e.target.value)} rows={4} className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none" />
          </Field>
        </FormSection>
      </Drawer>
    </div>
  )
}
