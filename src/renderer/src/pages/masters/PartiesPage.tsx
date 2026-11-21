import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Power } from 'lucide-react'
import type { Customer, Supplier } from '@shared/types'
import { GST_REG_TYPES } from '@shared/schemas'
import { GST_STATES } from '@shared/india'
import { api } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { integer, paiseToInput, rupees, text, useForm, type FormValues } from '../../lib/form'
import { formatINR, stateName, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, Drawer, ErrorBanner, Field, FormSection, Input, PageHeader, SearchInput, Select, Spinner, type Column } from '../../components/ui'

type Kind = 'customer' | 'supplier'
type Party = Customer | Supplier

const BASE: FormValues = {
  code: '', name: '', gstRegistrationType: 'REGULAR', gstin: '', pan: '', contactPerson: '', phone: '', email: '',
  addressLine1: '', addressLine2: '', city: '', stateCode: '33', pincode: '', openingBalancePaise: ''
}
const CUSTOMER_EXTRA: FormValues = {
  partyType: 'BUSINESS', shippingAddressLine1: '', shippingAddressLine2: '', shippingCity: '', shippingStateCode: '', shippingPincode: '', creditLimitPaise: '', creditDays: '30'
}
const SUPPLIER_EXTRA: FormValues = { paymentTermsDays: '30', bankAccountName: '', bankAccountNo: '', bankIfsc: '' }
const MONEY_FIELDS = new Set(['openingBalancePaise', 'creditLimitPaise'])

function toForm(kind: Kind, p: Party | null): FormValues {
  const empty = { ...BASE, ...(kind === 'customer' ? CUSTOMER_EXTRA : SUPPLIER_EXTRA) }
  if (!p) return empty
  return Object.fromEntries(
    Object.keys(empty).map((k) => {
      const v = (p as unknown as Record<string, unknown>)[k]
      return [k, MONEY_FIELDS.has(k) ? paiseToInput(v as number) : v == null ? '' : String(v)]
    })
  )
}

function PartiesPage({ kind }: { kind: Kind }) {
  const label = kind === 'customer' ? 'Customer' : 'Supplier'
  const { can } = useSession()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const q = useDebounced(search)
  const list = useQuery<Party[]>(
    () => (kind === 'customer' ? api('customer:list', { search: q || undefined, includeInactive: showInactive }) : api('supplier:list', { search: q || undefined, includeInactive: showInactive })),
    [kind, q, showInactive]
  )
  const [editing, setEditing] = useState<Party | 'new' | null>(null)
  const form = useForm(toForm(kind, null))
  const canManage = can(`${kind}.manage`)
  const isNew = editing === 'new'

  const open = (p: Party | 'new') => {
    setEditing(p)
    form.reset(toForm(kind, p === 'new' ? null : p))
  }

  // Deep link from global search: ?open=<id>
  useEffect(() => {
    const id = Number(params.get('open'))
    if (!id) return
    ;(kind === 'customer' ? api('customer:get', { id }) : api('supplier:get', { id }))
      .then((p) => open(p))
      .catch((e: Error) => toast('error', `${label} not found`, e.message))
    params.delete('open')
    setParams(params, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  async function save() {
    const v = form.values
    const build = () => {
      const common = {
        code: text(v, 'code'), name: text(v, 'name'), gstRegistrationType: text(v, 'gstRegistrationType'), gstin: text(v, 'gstin'), pan: text(v, 'pan'),
        contactPerson: text(v, 'contactPerson'), phone: text(v, 'phone'), email: text(v, 'email'), addressLine1: text(v, 'addressLine1'),
        addressLine2: text(v, 'addressLine2'), city: text(v, 'city'), stateCode: text(v, 'stateCode'), pincode: text(v, 'pincode')
      }
      const specific =
        kind === 'customer'
          ? {
              partyType: text(v, 'partyType'), shippingAddressLine1: text(v, 'shippingAddressLine1'), shippingAddressLine2: text(v, 'shippingAddressLine2'),
              shippingCity: text(v, 'shippingCity'), shippingStateCode: text(v, 'shippingStateCode') || null, shippingPincode: text(v, 'shippingPincode'),
              creditLimitPaise: rupees(v, 'creditLimitPaise'), creditDays: integer(v, 'creditDays')
            }
          : { paymentTermsDays: integer(v, 'paymentTermsDays'), bankAccountName: text(v, 'bankAccountName'), bankAccountNo: text(v, 'bankAccountNo'), bankIfsc: text(v, 'bankIfsc') }
      return isNew ? { ...common, ...specific, openingBalancePaise: rupees(v, 'openingBalancePaise', { allowNegative: true }) } : { ...common, ...specific, id: (editing as Party).id }
    }
    const channel = `${kind}:${isNew ? 'create' : 'update'}` as const
    const res = await form.submit(build, (p) => api(channel as 'customer:create', p), (r) => `${label} ${r.code} ${isNew ? 'created' : 'saved'}`)
    if (res) {
      setEditing(null)
      list.reload()
    }
  }

  async function toggleActive(p: Party) {
    try {
      const r = kind === 'customer' ? await api('customer:setActive', { id: p.id, isActive: !p.isActive }) : await api('supplier:setActive', { id: p.id, isActive: !p.isActive })
      toast('success', `${label} ${r.code} ${r.isActive ? 'activated' : 'deactivated'}`)
      setEditing(null)
      list.reload()
    } catch (e) {
      toast('error', 'Could not change status', (e as Error).message)
    }
  }

  const columns: Column<Party>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span>, sortValue: (r) => r.code, width: '90px' },
    { key: 'name', header: 'Name', render: (r) => <span className="font-semibold text-ink">{r.name}</span>, sortValue: (r) => r.name, wrap: true },
    { key: 'gstin', header: 'GSTIN', render: (r) => (r.gstin ? <span className="font-mono text-[12.5px]">{r.gstin}</span> : <Badge>{titleCase(r.gstRegistrationType)}</Badge>) },
    { key: 'place', header: 'Location', render: (r) => <span className="text-ink-2">{[r.city, stateName(r.stateCode)].filter(Boolean).join(', ')}</span>, sortValue: (r) => r.city ?? '' },
    { key: 'phone', header: 'Phone', render: (r) => <span className="text-ink-2">{r.phone ?? '—'}</span> },
    {
      key: 'balance',
      header: kind === 'customer' ? 'Receivable' : 'Payable',
      align: 'right',
      render: (r) => <span className={r.balancePaise < 0 ? 'text-emerald-700' : 'font-semibold'}>{formatINR(r.balancePaise)}</span>,
      sortValue: (r) => r.balancePaise
    },
    { key: 'status', header: 'Status', render: (r) => (r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) }
  ]

  const b = form.bind
  const E = form.errors
  return (
    <div>
      <PageHeader
        title={kind === 'customer' ? 'Customers' : 'Suppliers'}
        description={kind === 'customer' ? 'Balances are read live from the receivables ledger.' : 'Balances are read live from the payables ledger.'}
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => open('new')}>New {label.toLowerCase()}</Button>}
      />
      <ErrorBanner error={list.error} onRetry={list.reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, GSTIN, city, phone…" className="w-96" />
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="size-4 accent-brand-600" />
            Show inactive
          </label>
          <span className="ml-auto text-[12.5px] text-ink-3">{list.data?.length ?? 0} records</span>
        </div>
        {list.loading && !list.data ? <Spinner /> : <DataTable rows={list.data ?? []} columns={columns} rowKey={(r) => r.id} onRowClick={open} />}
      </Card>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={isNew ? `New ${label.toLowerCase()}` : `${(editing as Party | null)?.name ?? ''}`}
        subtitle={!isNew && editing ? `${label} ${(editing as Party).code} · balance ${formatINR((editing as Party).balancePaise)}` : 'Fields marked * are required'}
        footer={
          <>
            {!isNew && canManage && editing && (
              <Button variant="danger" className="mr-auto" icon={<Power className="size-4" />} onClick={() => void toggleActive(editing as Party)}>
                {(editing as Party).isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setEditing(null)}>{canManage ? 'Cancel' : 'Close'}</Button>
            {canManage && <Button loading={form.saving} onClick={() => void save()}>Save {label.toLowerCase()}</Button>}
          </>
        }
      >
        {form.formError && <ErrorBanner error={new Error(form.formError)} />}
        <fieldset disabled={!canManage}>
          <FormSection title="Identity">
            <Field label="Code" required error={E.code}><Input {...b('code')} placeholder={kind === 'customer' ? 'C011' : 'S006'} className="uppercase" /></Field>
            <Field label="Name" required error={E.name}><Input {...b('name')} /></Field>
            {kind === 'customer' && (
              <Field label="Party type" error={E.partyType}>
                <Select {...b('partyType')}><option value="BUSINESS">Business</option><option value="INDIVIDUAL">Individual</option></Select>
              </Field>
            )}
            <Field label="GST registration" required error={E.gstRegistrationType}>
              <Select {...b('gstRegistrationType')}>{GST_REG_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
            </Field>
            <Field label="GSTIN" error={E.gstin} hint="Required for Regular, Composition and SEZ"><Input {...b('gstin')} className="font-mono uppercase" /></Field>
            <Field label="PAN" error={E.pan}><Input {...b('pan')} className="font-mono uppercase" /></Field>
          </FormSection>
          <FormSection title="Contact">
            <Field label="Contact person" error={E.contactPerson}><Input {...b('contactPerson')} /></Field>
            <Field label="Phone" error={E.phone}><Input {...b('phone')} /></Field>
            <Field label="Email" error={E.email} className="col-span-2"><Input {...b('email')} type="email" /></Field>
          </FormSection>
          <FormSection title={kind === 'customer' ? 'Billing address' : 'Address'}>
            <Field label="Address line 1" error={E.addressLine1} className="col-span-2"><Input {...b('addressLine1')} /></Field>
            <Field label="Address line 2" error={E.addressLine2} className="col-span-2"><Input {...b('addressLine2')} /></Field>
            <Field label="City" error={E.city}><Input {...b('city')} /></Field>
            <Field label="PIN code" error={E.pincode}><Input {...b('pincode')} /></Field>
            <Field label="State (place of supply)" required error={E.stateCode} className="col-span-2">
              <Select {...b('stateCode')}>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.code} - {s.name}</option>)}</Select>
            </Field>
          </FormSection>
          {kind === 'customer' && (
            <FormSection title="Shipping address (if different)">
              <Field label="Address line 1" error={E.shippingAddressLine1} className="col-span-2"><Input {...b('shippingAddressLine1')} /></Field>
              <Field label="City" error={E.shippingCity}><Input {...b('shippingCity')} /></Field>
              <Field label="PIN code" error={E.shippingPincode}><Input {...b('shippingPincode')} /></Field>
              <Field label="State" error={E.shippingStateCode} className="col-span-2">
                <Select {...b('shippingStateCode')}><option value="">Same as billing</option>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.code} - {s.name}</option>)}</Select>
              </Field>
            </FormSection>
          )}
          <FormSection title={kind === 'customer' ? 'Credit terms' : 'Payment terms & bank'}>
            {kind === 'customer' ? (
              <>
                <Field label="Credit limit (₹)" error={E.creditLimitPaise} hint="0 = no limit"><Input {...b('creditLimitPaise')} inputMode="decimal" className="tabular" /></Field>
                <Field label="Credit days" error={E.creditDays}><Input {...b('creditDays')} inputMode="numeric" /></Field>
              </>
            ) : (
              <>
                <Field label="Payment terms (days)" error={E.paymentTermsDays}><Input {...b('paymentTermsDays')} inputMode="numeric" /></Field>
                <Field label="Account name" error={E.bankAccountName}><Input {...b('bankAccountName')} /></Field>
                <Field label="Account number" error={E.bankAccountNo}><Input {...b('bankAccountNo')} className="font-mono" /></Field>
                <Field label="IFSC" error={E.bankIfsc}><Input {...b('bankIfsc')} className="font-mono uppercase" /></Field>
              </>
            )}
            <Field
              label="Opening balance (₹)"
              error={E.openingBalancePaise}
              hint={isNew ? `Posted to the ${kind === 'customer' ? 'receivables' : 'payables'} ledger. Use a negative amount for an advance.` : 'Posted at creation; correct with a journal adjustment.'}
              className="col-span-2"
            >
              <Input {...b('openingBalancePaise')} inputMode="decimal" disabled={!isNew} className="tabular" />
            </Field>
          </FormSection>
        </fieldset>
      </Drawer>
    </div>
  )
}

export const CustomersPage = () => <PartiesPage key="customer" kind="customer" />
export const SuppliersPage = () => <PartiesPage key="supplier" kind="supplier" />
