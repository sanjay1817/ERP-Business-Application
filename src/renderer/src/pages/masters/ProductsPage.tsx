import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Power } from 'lucide-react'
import type { Lookups, Product } from '@shared/types'
import { api } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { milliToInput, paiseToInput, quantity, rupees, text, useForm, type FormValues } from '../../lib/form'
import { formatINR, formatPercentBps, milliToString } from '../../lib/format'
import { Badge, Button, Card, DataTable, Drawer, ErrorBanner, Field, FormSection, Input, PageHeader, SearchInput, Select, Spinner, Tabs, type Column } from '../../components/ui'

const EMPTY: FormValues = {
  code: '', name: '', description: '', itemType: 'GOODS', categoryId: '', unitId: '', hsnSac: '', taxRateId: '',
  salePricePaise: '', purchasePricePaise: '', mrpPaise: '', reorderLevelMilli: '', trackInventory: true
}

export default function ProductsPage() {
  const { can } = useSession()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [type, setType] = useState<'ALL' | 'GOODS' | 'SERVICE'>('ALL')
  const [showInactive, setShowInactive] = useState(false)
  const q = useDebounced(search)
  const list = useQuery<Product[]>(() => api('product:list', { search: q || undefined, includeInactive: showInactive }), [q, showInactive])
  const lookups = useQuery<Lookups>(() => api('lookup:all'))
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const form = useForm(EMPTY)
  const canManage = can('product.manage')
  const isNew = editing === 'new'
  const rows = useMemo(() => (list.data ?? []).filter((p) => type === 'ALL' || p.itemType === type), [list.data, type])

  const open = (p: Product | 'new') => {
    setEditing(p)
    const L = lookups.data
    form.reset(
      p === 'new'
        ? { ...EMPTY, unitId: String(L?.units.find((u) => u.code === 'NOS')?.id ?? ''), taxRateId: String(L?.taxRates.find((t) => t.rateBps === 1800)?.id ?? '') }
        : {
            code: p.code, name: p.name, description: p.description ?? '', itemType: p.itemType, categoryId: p.categoryId ? String(p.categoryId) : '', unitId: String(p.unitId),
            hsnSac: p.hsnSac, taxRateId: String(p.taxRateId), salePricePaise: paiseToInput(p.salePricePaise), purchasePricePaise: paiseToInput(p.purchasePricePaise),
            mrpPaise: paiseToInput(p.mrpPaise), reorderLevelMilli: milliToInput(p.reorderLevelMilli), trackInventory: p.trackInventory
          }
    )
  }

  useEffect(() => {
    const id = Number(params.get('open'))
    if (!id) return
    api('product:get', { id }).then(open).catch((e: Error) => toast('error', 'Product not found', e.message))
    params.delete('open')
    setParams(params, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const v = form.values
  const isService = v.itemType === 'SERVICE'
  const setItemType = (t: string) => {
    form.set('itemType', t)
    if (t === 'SERVICE') {
      form.set('trackInventory', false)
      form.set('reorderLevelMilli', '')
      const oth = lookups.data?.units.find((u) => u.code === 'OTH')
      if (oth) form.set('unitId', String(oth.id))
    } else form.set('trackInventory', true)
  }

  async function save() {
    const build = () => {
      const payload = {
        code: text(v, 'code'), name: text(v, 'name'), description: text(v, 'description'), itemType: text(v, 'itemType'),
        categoryId: v.categoryId ? Number(v.categoryId) : null, unitId: Number(v.unitId) || 0, hsnSac: text(v, 'hsnSac'), taxRateId: Number(v.taxRateId) || 0,
        salePricePaise: rupees(v, 'salePricePaise'), purchasePricePaise: rupees(v, 'purchasePricePaise'), mrpPaise: rupees(v, 'mrpPaise', { nullable: true }),
        reorderLevelMilli: quantity(v, 'reorderLevelMilli'), trackInventory: v.trackInventory === true
      }
      return isNew ? payload : { ...payload, id: (editing as Product).id }
    }
    const res = isNew
      ? await form.submit(build, (p) => api('product:create', p), (r) => `${r.itemType === 'SERVICE' ? 'Service' : 'Product'} ${r.code} created`)
      : await form.submit(build, (p) => api('product:update', p), (r) => `${r.code} saved`)
    if (res) {
      setEditing(null)
      list.reload()
    }
  }

  async function toggleActive(p: Product) {
    try {
      const r = await api('product:setActive', { id: p.id, isActive: !p.isActive })
      toast('success', `${r.code} ${r.isActive ? 'activated' : 'deactivated'}`)
      setEditing(null)
      list.reload()
    } catch (e) {
      toast('error', 'Could not change status', (e as Error).message)
    }
  }

  const columns: Column<Product>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span>, sortValue: (r) => r.code, width: '110px' },
    { key: 'name', header: 'Name', render: (r) => <span className="font-semibold text-ink">{r.name}</span>, sortValue: (r) => r.name, wrap: true },
    { key: 'type', header: 'Type', render: (r) => (r.itemType === 'SERVICE' ? <Badge tone="violet">Service</Badge> : <Badge tone="blue">Goods</Badge>) },
    { key: 'cat', header: 'Category', render: (r) => <span className="text-ink-2">{r.categoryName ?? '—'}</span>, sortValue: (r) => r.categoryName ?? '' },
    { key: 'hsn', header: 'HSN/SAC', render: (r) => <span className="font-mono text-[12.5px]">{r.hsnSac}</span> },
    { key: 'gst', header: 'GST', align: 'right', render: (r) => formatPercentBps(r.taxRateBps) },
    { key: 'price', header: 'Sale price', align: 'right', render: (r) => formatINR(r.salePricePaise), sortValue: (r) => r.salePricePaise },
    {
      key: 'stock',
      header: 'In stock',
      align: 'right',
      render: (r) =>
        !r.trackInventory ? (
          <span className="text-ink-3">n/a</span>
        ) : (
          <span className={r.reorderLevelMilli > 0 && r.stockQtyMilli <= r.reorderLevelMilli ? 'font-semibold text-red-700' : 'font-semibold'}>
            {milliToString(r.stockQtyMilli)} {r.unitCode}
          </span>
        ),
      sortValue: (r) => (r.trackInventory ? r.stockQtyMilli : -1)
    },
    { key: 'status', header: 'Status', render: (r) => (r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) }
  ]

  const b = form.bind
  const E = form.errors
  const L = lookups.data
  const all = list.data ?? []
  return (
    <div>
      <PageHeader
        title="Products & Services"
        description="Goods track stock by warehouse; services are billed without stock movements."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => open('new')} disabled={!L}>New item</Button>}
      />
      <ErrorBanner error={list.error ?? lookups.error} onRetry={list.reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, HSN/SAC, category…" className="w-96" />
          <Tabs
            value={type}
            onChange={setType}
            tabs={[
              { value: 'ALL', label: 'All', count: all.length },
              { value: 'GOODS', label: 'Goods', count: all.filter((p) => p.itemType === 'GOODS').length },
              { value: 'SERVICE', label: 'Services', count: all.filter((p) => p.itemType === 'SERVICE').length }
            ]}
          />
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="size-4 accent-brand-600" />
            Show inactive
          </label>
        </div>
        {list.loading && !list.data ? <Spinner /> : <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={open} />}
      </Card>

      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={isNew ? 'New product or service' : (editing as Product | null)?.name ?? ''}
        subtitle={!isNew && editing && (editing as Product).trackInventory ? `Stock on hand ${milliToString((editing as Product).stockQtyMilli)} ${(editing as Product).unitCode} · value ${formatINR((editing as Product).stockValuePaise)}` : undefined}
        footer={
          <>
            {!isNew && canManage && editing && (
              <Button variant="danger" className="mr-auto" icon={<Power className="size-4" />} onClick={() => void toggleActive(editing as Product)}>
                {(editing as Product).isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setEditing(null)}>{canManage ? 'Cancel' : 'Close'}</Button>
            {canManage && <Button loading={form.saving} onClick={() => void save()}>Save item</Button>}
          </>
        }
      >
        {form.formError && <ErrorBanner error={new Error(form.formError)} />}
        <fieldset disabled={!canManage}>
          <FormSection title="Item">
            <Field label="Item type" required error={E.itemType} className="col-span-2">
              <Tabs value={String(v.itemType) as 'GOODS' | 'SERVICE'} onChange={setItemType} tabs={[{ value: 'GOODS', label: 'Goods (stocked)' }, { value: 'SERVICE', label: 'Service (non-stock)' }]} />
            </Field>
            <Field label="Code / SKU" required error={E.code}><Input {...b('code')} className="uppercase" /></Field>
            <Field label="Name" required error={E.name}><Input {...b('name')} /></Field>
            <Field label="Description" error={E.description} className="col-span-2"><Input {...b('description')} /></Field>
            <Field label="Category" error={E.categoryId}>
              <Select {...b('categoryId')}><option value="">— None —</option>{L?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </Field>
            <Field label="Unit (UQC)" required error={E.unitId}>
              <Select {...b('unitId')}><option value="">Select…</option>{L?.units.map((u) => <option key={u.id} value={u.id}>{u.code} - {u.name}</option>)}</Select>
            </Field>
          </FormSection>
          <FormSection title="Tax">
            <Field label={isService ? 'SAC code' : 'HSN code'} required error={E.hsnSac} hint={isService ? 'Services: 6-digit SAC starting with 99' : '4–8 digit HSN'}><Input {...b('hsnSac')} className="font-mono" inputMode="numeric" /></Field>
            <Field label="GST rate" required error={E.taxRateId}>
              <Select {...b('taxRateId')}><option value="">Select…</option>{L?.taxRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
            </Field>
          </FormSection>
          <FormSection title="Pricing (₹, excluding GST)">
            <Field label="Sale price" error={E.salePricePaise}><Input {...b('salePricePaise')} inputMode="decimal" className="tabular" /></Field>
            <Field label="Purchase price" error={E.purchasePricePaise}><Input {...b('purchasePricePaise')} inputMode="decimal" className="tabular" /></Field>
            {!isService && <Field label="MRP (optional)" error={E.mrpPaise}><Input {...b('mrpPaise')} inputMode="decimal" className="tabular" /></Field>}
          </FormSection>
          {!isService && (
            <FormSection title="Inventory">
              <Field label="Reorder level" error={E.reorderLevelMilli} hint="Alerts appear at or below this quantity"><Input {...b('reorderLevelMilli')} inputMode="decimal" className="tabular" /></Field>
              <Field label="Track inventory" error={E.trackInventory}>
                <label className="flex h-9 items-center gap-2 text-[13.5px] text-ink">
                  <input type="checkbox" checked={v.trackInventory === true} onChange={(e) => form.set('trackInventory', e.target.checked)} className="size-4 accent-brand-600" />
                  Maintain stock and valuation
                </label>
              </Field>
            </FormSection>
          )}
        </fieldset>
      </Drawer>
    </div>
  )
}
