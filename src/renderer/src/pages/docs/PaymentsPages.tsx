import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Plus, Wand2 } from 'lucide-react'
import { PAYMENT_MODES, docRoute, type OpenInvoice, type PaymentDetail, type PaymentRow, type Side } from '@shared/documents'
import { allocateFifo } from '@shared/tax'
import { paiseToRupeesString, toPaise } from '@shared/money'
import type { Customer, Lookups, Supplier } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatINR, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, KeyValue, PageHeader, SearchInput, Select, Spinner, EmptyState } from '../../components/ui'
import { SearchSelect } from '../../components/SearchSelect'
import { ConfirmDialog } from '../../components/Modal'
import { ModuleNav, paymentsSlug, sideRoot } from './common'

type PayType = 'RECEIPT' | 'PAYMENT'
const sideOf = (t: PayType): Side => (t === 'RECEIPT' ? 'SALES' : 'PURCHASE')
const label = (t: PayType) => (t === 'RECEIPT' ? 'Receipt' : 'Payment')
const today = () => new Date().toISOString().slice(0, 10)
const tryPaise = (v: string): number | null => {
  try {
    return toPaise(v || '0')
  } catch {
    return null
  }
}

export function PaymentListPage({ type }: { type: PayType }) {
  const side = sideOf(type)
  const navigate = useNavigate()
  const { can, session } = useSession()
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const { data, error, loading, reload } = useQuery<PaymentRow[]>(() => api('payment:list', { type, search: q || undefined }), [type, q, session?.company?.id])
  const base = `${sideRoot(side)}/${paymentsSlug(side)}`
  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader
        title={type === 'RECEIPT' ? 'Customer receipts' : 'Supplier payments'}
        description={`Money ${type === 'RECEIPT' ? 'received from customers' : 'paid to suppliers'}, posted to the selected cash/bank account and allocated to invoices. Unallocated amounts stay on account as advances.`}
        actions={can(type === 'RECEIPT' ? 'sales.post' : 'purchase.post') && <Button icon={<Plus className="size-4" />} onClick={() => navigate(`${base}/new`)}>New {label(type).toLowerCase()}</Button>}
      />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search number, party, reference…" className="w-80" />
          <span className="ml-auto text-[12.5px] text-ink-3">{data?.length ?? 0} {label(type).toLowerCase()}s</span>
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`${base}/${r.id}`)}
            empty={<EmptyState title={`No ${label(type).toLowerCase()}s yet`} />}
            columns={[
              { key: 'no', header: 'Number', render: (r) => <span className="font-mono font-semibold">{r.number}</span>, sortValue: (r) => r.number },
              { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date },
              { key: 'party', header: type === 'RECEIPT' ? 'Customer' : 'Supplier', render: (r) => r.partyName, wrap: true, sortValue: (r) => r.partyName },
              { key: 'mode', header: 'Mode', render: (r) => titleCase(r.mode) },
              { key: 'acc', header: 'Account', render: (r) => <span className="text-ink-2">{r.accountName}</span> },
              { key: 'ref', header: 'Reference', render: (r) => <span className="font-mono text-[12.5px]">{r.referenceNo ?? '—'}</span> },
              { key: 'amt', header: 'Amount', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.amountPaise)}</span>, sortValue: (r) => r.amountPaise },
              { key: 'alloc', header: 'Allocated', align: 'right', render: (r) => formatINR(r.allocatedPaise) },
              { key: 'un', header: 'On account', align: 'right', render: (r) => (r.unallocatedPaise ? <Badge tone="amber">{formatINR(r.unallocatedPaise)}</Badge> : '—') }
            ]}
          />
        )}
      </Card>
    </div>
  )
}

export function PaymentEditorPage({ type }: { type: PayType }) {
  const { id = 'new' } = useParams()
  return id === 'new' ? <NewPayment key="new" type={type} /> : <PaymentView key={id} type={type} id={Number(id)} />
}

function NewPayment({ type }: { type: PayType }) {
  const side = sideOf(type)
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  const lookups = useQuery<Lookups>(() => api('lookup:all'))
  const parties = useQuery<Array<Customer | Supplier>>(() => (type === 'RECEIPT' ? api('customer:list', {}) : api('supplier:list', {})))
  const [partyId, setPartyId] = useState<number | null>(Number(params.get('party')) || null)
  const [date, setDate] = useState(today())
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<(typeof PAYMENT_MODES)[number]>('BANK_TRANSFER')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [referenceNo, setReferenceNo] = useState('')
  const [notes, setNotes] = useState('')
  const [open, setOpen] = useState<OpenInvoice[] | null>(null)
  const [alloc, setAlloc] = useState<Record<number, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  // One key per form: a double-click or a retry after a lost response returns the same posting.
  const [requestKey] = useState(() => crypto.randomUUID())

  // Default account follows the mode: CASH → Cash in Hand, otherwise the main bank account.
  useEffect(() => {
    const accs = lookups.data?.cashBankAccounts ?? []
    const want = mode === 'CASH' ? 'CASH' : 'BANK'
    const acc = accs.find((a) => a.systemKey === want) ?? accs[0]
    if (acc) setAccountId(acc.id)
  }, [mode, lookups.data])

  useEffect(() => {
    if (!partyId) return setOpen(null)
    let cancelled = false
    api('payment:openInvoices', { type, partyId }).then((inv) => {
      if (cancelled) return
      setOpen(inv)
      const target = Number(params.get('invoice'))
      const t = inv.find((x) => x.invoiceId === target)
      if (t) {
        setAlloc({ [t.invoiceId]: paiseToRupeesString(t.balancePaise) })
        setAmount((a) => a || paiseToRupeesString(t.balancePaise))
      } else setAlloc({})
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyId, type])

  const amountPaise = tryPaise(amount)
  const allocated = useMemo(() => Object.values(alloc).reduce((s, v) => s + (tryPaise(v) ?? 0), 0), [alloc])
  const autoAllocate = () => {
    if (!open || !amountPaise) return
    const fifo = allocateFifo(amountPaise, open.map((o) => ({ invoiceId: o.invoiceId, balancePaise: o.balancePaise })))
    setAlloc(Object.fromEntries(fifo.map((a) => [a.invoiceId, paiseToRupeesString(a.amountPaise)])))
  }

  function build() {
    const errs: Record<string, string> = {}
    if (!partyId) errs.partyId = `Select a ${type === 'RECEIPT' ? 'customer' : 'supplier'}`
    if (!amountPaise || amountPaise <= 0) errs.amountPaise = 'Enter the amount'
    if (!accountId) errs.accountId = 'Select an account'
    const allocations = Object.entries(alloc)
      .map(([invoiceId, v]) => ({ invoiceId: Number(invoiceId), amountPaise: tryPaise(v) }))
      .filter((a) => a.amountPaise !== 0)
    allocations.forEach((a) => {
      const inv = open?.find((o) => o.invoiceId === a.invoiceId)
      if (a.amountPaise == null || a.amountPaise < 0) errs[`alloc.${a.invoiceId}`] = 'Invalid amount'
      else if (inv && a.amountPaise > inv.balancePaise) errs[`alloc.${a.invoiceId}`] = 'Exceeds balance'
    })
    if (amountPaise && allocated > amountPaise) errs.allocations = 'Allocated total exceeds the amount'
    setErrors(errs)
    if (Object.keys(errs).length) return null
    return { type, partyId: partyId!, date, amountPaise: amountPaise!, mode, accountId: accountId!, referenceNo, notes, requestKey, allocations: allocations as Array<{ invoiceId: number; amountPaise: number }> }
  }

  async function submit() {
    const payload = build()
    if (!payload) return setConfirm(false)
    setBusy(true)
    try {
      const p = await api('payment:create', payload)
      toast('success', `${label(type)} ${p.number} posted`, `${formatINR(p.allocatedPaise)} allocated${p.unallocatedPaise ? `, ${formatINR(p.unallocatedPaise)} on account` : ''}`)
      navigate(`${sideRoot(side)}/${paymentsSlug(side)}/${p.id}`, { replace: true })
    } catch (e) {
      const err = e as ApiError
      setErrors(err.fieldErrors ?? {})
      setFormError(err.message)
      setConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  if (!lookups.data || !parties.data) return (<div><ModuleNav side={side} /><Spinner /></div>)
  const party = parties.data.find((p) => p.id === partyId)
  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader
        title={`New ${type === 'RECEIPT' ? 'customer receipt' : 'supplier payment'}`}
        description={type === 'RECEIPT' ? 'Dr cash/bank, Cr customer. Allocate the amount to open invoices; any remainder is an advance.' : 'Dr supplier, Cr cash/bank. Allocate the amount to open bills; any remainder is an advance.'}
        actions={<Button onClick={() => build() && setConfirm(true)}>Review & post…</Button>}
      />
      {formError && <ErrorBanner error={new Error(formError)} />}
      <Card className="mb-4">
        <div className="grid grid-cols-4 gap-x-4 gap-y-3.5">
          <Field label={type === 'RECEIPT' ? 'Customer' : 'Supplier'} required error={errors.partyId} className="col-span-2">
            <SearchSelect
              options={parties.data.map((p) => ({ value: p.id, label: p.name, sublabel: `${p.code} · outstanding ${formatINR(p.balancePaise)}`, keywords: `${p.code} ${p.gstin ?? ''}` }))}
              value={partyId}
              onChange={setPartyId}
              invalid={!!errors.partyId}
              autoFocus={!partyId}
              aria-label="Party"
            />
          </Field>
          <Field label="Date" required error={errors.date}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} /></Field>
          <Field label="Amount (₹)" required error={errors.amountPaise}><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="text-right tabular" invalid={!!errors.amountPaise} /></Field>
          <Field label="Mode" required>
            <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>{PAYMENT_MODES.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}</Select>
          </Field>
          <Field label={type === 'RECEIPT' ? 'Deposit to' : 'Paid from'} required error={errors.accountId}>
            <Select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>{lookups.data.cashBankAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}</Select>
          </Field>
          <Field label={mode === 'CHEQUE' ? 'Cheque no.' : 'Reference (UTR / txn id)'} required={mode === 'CHEQUE'} error={errors.referenceNo}><Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} className="font-mono" /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </Card>

      <Card
        title="Allocate to open invoices"
        subtitle={party ? `${party.name} · outstanding ${formatINR(party.balancePaise)} (ledger)` : 'Select a party to see open invoices'}
        bodyClassName="p-0"
        actions={open && open.length > 0 ? (<><Button variant="secondary" icon={<Wand2 className="size-4" />} onClick={autoAllocate} disabled={!amountPaise}>Auto-allocate (oldest first)</Button><Button variant="ghost" onClick={() => setAlloc({})}>Clear</Button></>) : undefined}
      >
        {!partyId ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-3">Choose a {type === 'RECEIPT' ? 'customer' : 'supplier'} first.</p>
        ) : !open ? (
          <Spinner />
        ) : open.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-3">No open invoices. The full amount will be recorded as an advance on account.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr className="bg-slate-50 text-left text-[11px] tracking-wide text-ink-3 uppercase">
              <th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Date</th><th className="px-4 py-2">Due</th><th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2 text-right">Balance</th><th className="w-44 px-4 py-2 text-right">Allocate (₹)</th>
            </tr></thead>
            <tbody>
              {open.map((o) => (
                <tr key={o.invoiceId} className="border-t border-slate-100">
                  <td className="px-4 py-2"><span className="font-mono font-semibold">{o.number}</span>{o.partyRef && type === 'PAYMENT' && <span className="ml-2 text-ink-3">bill {o.partyRef}</span>}</td>
                  <td className="px-4 py-2">{formatDate(o.date)}</td>
                  <td className="px-4 py-2">{formatDate(o.dueDate)} {o.overdueDays > 0 && <Badge tone="red">{o.overdueDays}d overdue</Badge>}</td>
                  <td className="tabular px-4 py-2 text-right">{formatINR(o.grandTotalPaise)}</td>
                  <td className="tabular px-4 py-2 text-right font-semibold">{formatINR(o.balancePaise)}</td>
                  <td className="px-4 py-1.5">
                    <Input value={alloc[o.invoiceId] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [o.invoiceId]: e.target.value }))} inputMode="decimal" className="h-8 text-right tabular" invalid={!!errors[`alloc.${o.invoiceId}`]} aria-label={`Allocate to ${o.number}`} />
                    {errors[`alloc.${o.invoiceId}`] && <p className="text-right text-[11.5px] text-red-600">{errors[`alloc.${o.invoiceId}`]}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex justify-end gap-8 border-t border-line bg-slate-50 px-5 py-3 text-[13px]">
          <span>Amount <strong className="tabular">{formatINR(amountPaise ?? 0)}</strong></span>
          <span>Allocated <strong className="tabular">{formatINR(allocated)}</strong></span>
          <span className={amountPaise && allocated > amountPaise ? 'text-red-700' : ''}>On account <strong className="tabular">{formatINR(Math.max(0, (amountPaise ?? 0) - allocated))}</strong></span>
        </div>
        {errors.allocations && <p className="px-5 pb-3 text-right text-[12.5px] font-medium text-red-600">{errors.allocations}</p>}
      </Card>

      <ConfirmDialog open={confirm} title={`Post ${label(type).toLowerCase()}?`} confirmLabel={`Post ${label(type).toLowerCase()}`} busy={busy} onConfirm={() => void submit()} onClose={() => setConfirm(false)}>
        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
          <KeyValue label={type === 'RECEIPT' ? 'Customer' : 'Supplier'} value={party?.name} />
          <KeyValue label="Amount" value={<strong>{formatINR(amountPaise ?? 0)}</strong>} />
          <KeyValue label={type === 'RECEIPT' ? 'Deposit to' : 'Paid from'} value={lookups.data.cashBankAccounts.find((a) => a.id === accountId)?.name} />
          <KeyValue label="Allocated / on account" value={`${formatINR(allocated)} / ${formatINR(Math.max(0, (amountPaise ?? 0) - allocated))}`} />
        </dl>
        <p className="mt-3 text-[13px] text-ink-2">{type === 'RECEIPT' ? 'Dr cash/bank, Cr customer' : 'Dr supplier, Cr cash/bank'}. Posted payments cannot be edited.</p>
      </ConfirmDialog>
    </div>
  )
}

function PaymentView({ type, id }: { type: PayType; id: number }) {
  const side = sideOf(type)
  const { data, error, loading } = useQuery<PaymentDetail>(() => api('payment:get', { type, id }), [type, id])
  if (loading && !data) return (<div><ModuleNav side={side} /><Spinner /></div>)
  if (!data) return (<div><ModuleNav side={side} /><ErrorBanner error={error} /></div>)
  const invKind = type === 'RECEIPT' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE'
  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader title={`${label(type)} ${data.number}`} badge={<Badge tone="green">Posted</Badge>} description={`${data.partyName} · ${formatDate(data.date)}`} />
      <div className="grid grid-cols-3 gap-4">
        <Card title="Details">
          <dl className="space-y-3">
            <KeyValue label="Amount" value={<span className="text-[18px] font-bold">{formatINR(data.amountPaise)}</span>} />
            <KeyValue label="Mode" value={titleCase(data.mode)} />
            <KeyValue label={type === 'RECEIPT' ? 'Deposited to' : 'Paid from'} value={data.accountName} />
            <KeyValue label="Reference" value={data.referenceNo ?? '—'} />
            <KeyValue label="Journal entry" value={<span className="font-mono">{data.journalEntryNo}</span>} />
            {data.notes && <KeyValue label="Notes" value={data.notes} />}
          </dl>
        </Card>
        <Card title="Allocation" className="col-span-2" bodyClassName="p-0">
          <table className="w-full text-[13px]">
            <thead><tr className="bg-slate-50 text-left text-[11px] tracking-wide text-ink-3 uppercase"><th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Date</th><th className="px-4 py-2 text-right">Allocated</th></tr></thead>
            <tbody>
              {data.allocations.map((a) => (
                <tr key={a.invoiceId} className="border-t border-slate-100">
                  <td className="px-4 py-2"><Link to={docRoute(invKind, a.invoiceId)} className="font-mono font-semibold text-brand-700 hover:underline">{a.number}</Link></td>
                  <td className="px-4 py-2">{formatDate(a.date)}</td>
                  <td className="tabular px-4 py-2 text-right font-semibold">{formatINR(a.amountPaise)}</td>
                </tr>
              ))}
              {data.allocations.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-ink-3">Not allocated to any invoice</td></tr>}
            </tbody>
          </table>
          <div className="flex justify-end gap-8 border-t border-line bg-slate-50 px-5 py-3 text-[13px]">
            <span>Allocated <strong className="tabular">{formatINR(data.allocatedPaise)}</strong></span>
            <span>On account <strong className="tabular">{formatINR(data.unallocatedPaise)}</strong></span>
          </div>
        </Card>
      </div>
    </div>
  )
}
