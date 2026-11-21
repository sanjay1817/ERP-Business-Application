import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react'
import type { VoucherDetail, VoucherRow, VoucherType } from '@shared/finance'
import type { Customer, Supplier } from '@shared/types'
import { toPaise } from '@shared/money'
import { api, ApiError } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Field, Input, KeyValue, PageHeader, SearchInput, Spinner, Tabs, cx } from '../../components/ui'
import { SearchSelect } from '../../components/SearchSelect'
import { ConfirmDialog } from '../../components/Modal'
import { FinanceNav, JournalDrawer, money, useAccountOptions } from './shared'

const today = () => new Date().toISOString().slice(0, 10)
const TYPE_LABEL: Record<VoucherType, string> = { JOURNAL: 'Journal', CONTRA: 'Contra' }

export function VoucherListPage() {
  const { can, session } = useSession()
  const [type, setType] = useState<'' | VoucherType>('')
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const { data, error, loading, reload } = useQuery<VoucherRow[]>(() => api('voucher:list', { type: type || undefined, search: q || undefined }), [type, q, session?.company?.id])
  const navigate = useNavigate()
  return (
    <div>
      <PageHeader
        title="Vouchers"
        description="Journal vouchers (expenses, accruals, adjustments) and contra vouchers (cash ↔ bank). Posted vouchers are corrected by cancellation with a reversing entry."
        actions={can('finance.manage') && (
          <>
            <Button variant="secondary" icon={<ArrowLeftRight className="size-4" />} onClick={() => navigate('/finance/vouchers/new?type=CONTRA')}>New contra</Button>
            <Button icon={<Plus className="size-4" />} onClick={() => navigate('/finance/vouchers/new?type=JOURNAL')}>New journal voucher</Button>
          </>
        )}
      />
      <FinanceNav />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Tabs value={type} onChange={setType} tabs={[{ value: '', label: 'All' }, { value: 'JOURNAL', label: 'Journal' }, { value: 'CONTRA', label: 'Contra' }]} />
          <SearchInput value={search} onChange={setSearch} placeholder="Search number, narration, reference…" className="w-80" />
          <span className="ml-auto text-[12.5px] text-ink-3">{data?.length ?? 0} vouchers</span>
        </div>
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/finance/vouchers/${r.id}`)}
            empty={<EmptyState title="No vouchers" message="Journal and contra vouchers you post will appear here." />}
            columns={[
              { key: 'no', header: 'Voucher no.', render: (r) => <span className="font-mono font-semibold">{r.number}</span>, sortValue: (r) => r.number },
              { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date },
              { key: 'type', header: 'Type', render: (r) => <Badge tone={r.type === 'CONTRA' ? 'violet' : 'blue'}>{TYPE_LABEL[r.type]}</Badge> },
              { key: 'narration', header: 'Narration', render: (r) => r.narration, wrap: true },
              { key: 'ref', header: 'Reference', render: (r) => <span className="font-mono text-[12.5px]">{r.referenceNo ?? '—'}</span> },
              { key: 'amt', header: 'Amount', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.amountPaise)}</span>, sortValue: (r) => r.amountPaise },
              { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'POSTED' ? 'green' : 'red'}>{r.status === 'POSTED' ? 'Posted' : 'Cancelled'}</Badge> },
              { key: 'by', header: 'Entered by', render: (r) => <span className="text-ink-3">{r.createdBy ?? 'system'}</span> }
            ]}
          />
        )}
      </Card>
    </div>
  )
}

interface LineState { key: number; accountId: number | null; partyId: number | null; debit: string; credit: string; narration: string }
const parse = (s: string): number | null => {
  if (!s.trim()) return 0
  try {
    const v = toPaise(s)
    return v >= 0 ? v : null
  } catch {
    return null
  }
}

function VoucherEditor({ type }: { type: VoucherType }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { can } = useSession()
  const accounts = useAccountOptions(type === 'CONTRA' ? (a) => a.isBank : (a) => a.systemKey !== 'INVENTORY')
  const customers = useQuery<Customer[]>(() => (can('customer.view') ? api('customer:list', {}) : Promise.resolve([])), [])
  const suppliers = useQuery<Supplier[]>(() => (can('supplier.view') ? api('supplier:list', {}) : Promise.resolve([])), [])
  const [requestKey] = useState(() => crypto.randomUUID())
  const [date, setDate] = useState(today())
  const [referenceNo, setReferenceNo] = useState('')
  const [narration, setNarration] = useState('')
  const [lines, setLines] = useState<LineState[]>([
    { key: 1, accountId: null, partyId: null, debit: '', credit: '', narration: '' },
    { key: 2, accountId: null, partyId: null, debit: '', credit: '', narration: '' }
  ])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyOf = (id: number | null) => accounts.data?.find((a) => a.id === id)?.systemKey ?? null
  const totals = useMemo(() => {
    let dr = 0
    let cr = 0
    let bad = false
    for (const l of lines) {
      const d = parse(l.debit)
      const c = parse(l.credit)
      if (d === null || c === null) bad = true
      dr += d ?? 0
      cr += c ?? 0
    }
    return { dr, cr, bad }
  }, [lines])
  const update = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const complete = lines.every((l) => l.accountId && ((parse(l.debit) ?? 0) > 0) !== ((parse(l.credit) ?? 0) > 0)) && narration.trim().length >= 3
  const balanced = !totals.bad && totals.dr === totals.cr && totals.dr > 0

  const submit = async () => {
    setBusy(true)
    setErrors({})
    setFormError(null)
    try {
      const v = await api('voucher:create', {
        type, date, narration, referenceNo: referenceNo || null, requestKey,
        lines: lines.map((l) => {
          const k = keyOf(l.accountId)
          const partyType: 'CUSTOMER' | 'SUPPLIER' | null = k === 'AR' ? 'CUSTOMER' : k === 'AP' ? 'SUPPLIER' : null
          return { accountId: l.accountId!, debitPaise: parse(l.debit) ?? 0, creditPaise: parse(l.credit) ?? 0, partyType, partyId: partyType ? l.partyId : null, narration: l.narration || null }
        })
      })
      toast('success', `${TYPE_LABEL[type]} voucher ${v.number} posted`, `Journal ${v.entryNo}`)
      navigate(`/finance/vouchers/${v.id}`, { replace: true })
    } catch (e) {
      const err = e as ApiError
      setErrors(err.fieldErrors ?? {})
      setFormError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={type === 'CONTRA' ? 'New contra voucher' : 'New journal voucher'}
        description={type === 'CONTRA' ? 'Transfer between cash and bank accounts (deposit, withdrawal, bank-to-bank).' : 'Record expenses, accruals, provisions and adjustments. Debtors and creditors need a party; Stock in Hand changes only through stock documents.'}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/finance/vouchers')}>Cancel</Button>
            <Button onClick={() => void submit()} loading={busy} disabled={!complete || !balanced}>Post voucher</Button>
          </>
        }
      />
      {formError && <ErrorBanner error={new Error(formError)} />}
      <Card className="mb-4">
        <div className="grid grid-cols-4 gap-4">
          <Field label="Date" required error={errors.date}><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} invalid={!!errors.date} /></Field>
          <Field label="Reference"><Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} className="font-mono" placeholder="Bill / cheque / UTR" /></Field>
          <Field label="Narration" required error={errors.narration} className="col-span-2"><Input value={narration} onChange={(e) => setNarration(e.target.value)} invalid={!!errors.narration} placeholder="What is this entry for?" /></Field>
        </div>
      </Card>
      <Card title="Lines" subtitle="Each line is either a debit or a credit. Total debits must equal total credits." bodyClassName="p-0">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
            <tr><th className="w-8 px-3 py-2.5">#</th><th className="px-3 py-2.5">Account</th><th className="px-3 py-2.5">Party</th><th className="w-40 px-3 py-2.5 text-right">Debit (₹)</th><th className="w-40 px-3 py-2.5 text-right">Credit (₹)</th><th className="px-3 py-2.5">Line narration</th><th className="w-10" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const k = keyOf(l.accountId)
              const parties = k === 'AR' ? customers.data ?? [] : k === 'AP' ? suppliers.data ?? [] : null
              return (
                <tr key={l.key} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-2 pt-4 text-ink-3">{i + 1}</td>
                  <td className="px-3 py-2">
                    <SearchSelect options={accounts.options} value={l.accountId} onChange={(v) => update(l.key, { accountId: v, partyId: null })} invalid={!!errors[`lines.${i}.accountId`]} placeholder="Account…" aria-label={`Line ${i + 1} account`} />
                    {errors[`lines.${i}.accountId`] && <p className="mt-1 text-[12px] text-red-600">{errors[`lines.${i}.accountId`]}</p>}
                  </td>
                  <td className="px-3 py-2">
                    {parties ? (
                      <SearchSelect options={parties.map((p) => ({ value: p.id, label: p.name, sublabel: p.code }))} value={l.partyId} onChange={(v) => update(l.key, { partyId: v })} invalid={!!errors[`lines.${i}.partyId`]} placeholder={k === 'AR' ? 'Customer…' : 'Supplier…'} aria-label={`Line ${i + 1} party`} />
                    ) : <span className="block pt-2 text-ink-3">—</span>}
                    {errors[`lines.${i}.partyId`] && <p className="mt-1 text-[12px] text-red-600">{errors[`lines.${i}.partyId`]}</p>}
                  </td>
                  <td className="px-3 py-2"><Input value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} inputMode="decimal" className="text-right tabular" invalid={parse(l.debit) === null || !!errors[`lines.${i}.debitPaise`]} aria-label={`Line ${i + 1} debit`} /></td>
                  <td className="px-3 py-2"><Input value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} inputMode="decimal" className="text-right tabular" invalid={parse(l.credit) === null} aria-label={`Line ${i + 1} credit`} /></td>
                  <td className="px-3 py-2"><Input value={l.narration} onChange={(e) => update(l.key, { narration: e.target.value })} aria-label={`Line ${i + 1} narration`} /></td>
                  <td className="px-2 py-2 pt-3">
                    {lines.length > 2 && <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" aria-label={`Remove line ${i + 1}`}><Trash2 className="size-4" /></button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={3} className="px-3 py-3">
                <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, accountId: null, partyId: null, debit: '', credit: '', narration: '' }])}>Add line</Button>
              </td>
              <td className="tabular px-3 py-3 text-right">{formatINR(totals.dr)}</td>
              <td className="tabular px-3 py-3 text-right">{formatINR(totals.cr)}</td>
              <td colSpan={2} className="px-3 py-3">
                {totals.bad ? <span className="text-red-700">Check the amounts</span> : totals.dr === totals.cr ? (totals.dr > 0 ? <span className="text-emerald-700">Balanced</span> : null) : <span className="text-red-700">Difference {formatINR(Math.abs(totals.dr - totals.cr))}</span>}
              </td>
            </tr>
          </tfoot>
        </table>
        {errors.lines && <p className="px-4 pb-3 text-[13px] font-medium text-red-600">{errors.lines}</p>}
      </Card>
    </div>
  )
}

function VoucherView({ id }: { id: number }) {
  const { can } = useSession()
  const toast = useToast()
  const { data, error, loading, reload } = useQuery<VoucherDetail>(() => api('voucher:get', { id }), [id])
  const [journal, setJournal] = useState<number | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  if (loading && !data) return <Spinner />
  if (!data) return <ErrorBanner error={error} onRetry={reload} />
  const cancel = async () => {
    setBusy(true)
    try {
      await api('voucher:cancel', { id, reason })
      toast('success', `Voucher ${data.number} cancelled`, 'A reversing journal entry was posted')
      setCancelOpen(false)
      reload()
    } catch (e) {
      toast('error', 'Could not cancel', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <PageHeader
        title={`${TYPE_LABEL[data.type]} voucher ${data.number}`}
        badge={<Badge tone={data.status === 'POSTED' ? 'green' : 'red'}>{data.status === 'POSTED' ? 'Posted' : 'Cancelled'}</Badge>}
        description={data.narration}
        actions={
          <>
            <Link to="/finance/vouchers" className="text-[13px] font-semibold text-brand-700 hover:underline">← All vouchers</Link>
            {can('finance.manage') && data.status === 'POSTED' && <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel by reversal…</Button>}
          </>
        }
      />
      <Card className="mb-4">
        <dl className="grid grid-cols-6 gap-4">
          <KeyValue label="Date" value={formatDate(data.date)} />
          <KeyValue label="Amount" value={<span className="tabular font-semibold">{formatINR(data.amountPaise)}</span>} />
          <KeyValue label="Reference" value={data.referenceNo} />
          <KeyValue label="Journal entry" value={data.journalId ? <button onClick={() => setJournal(data.journalId)} className="font-mono text-brand-700 hover:underline">{data.entryNo}</button> : '—'} />
          <KeyValue label="Entered" value={`${formatDateTime(data.createdAt)}${data.createdBy ? ` · ${data.createdBy}` : ''}`} />
          <KeyValue label="Reversal" value={data.reversalEntryNo ? `${data.reversalEntryNo} · ${data.cancelReason ?? ''}` : '—'} />
        </dl>
      </Card>
      <Card title="Lines" bodyClassName="p-0">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 text-left text-[11.5px] tracking-wide text-ink-3 uppercase"><tr><th className="px-4 py-2.5">Account</th><th className="px-4 py-2.5">Party</th><th className="px-4 py-2.5">Narration</th><th className="px-4 py-2.5 text-right">Debit</th><th className="px-4 py-2.5 text-right">Credit</th></tr></thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className={cx('px-4 py-2.5', l.creditPaise ? 'pl-10' : '')}><Link to={`/finance/ledger?account=${l.accountId}`} className="hover:text-brand-700 hover:underline"><span className="font-mono text-ink-3">{l.accountCode}</span> {l.accountName}</Link></td>
                <td className="px-4 py-2.5">{l.party ?? '—'}</td>
                <td className="px-4 py-2.5 text-ink-3">{l.narration}</td>
                <td className="tabular px-4 py-2.5 text-right">{money(l.debitPaise)}</td>
                <td className="tabular px-4 py-2.5 text-right">{money(l.creditPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
      <ConfirmDialog open={cancelOpen} title={`Cancel ${data.number}?`} confirmLabel="Cancel voucher" danger busy={busy} onConfirm={() => void cancel()} onClose={() => setCancelOpen(false)}>
        <p className="mb-3 text-[13px] text-ink-2">The voucher stays on record. A reversing journal entry dated today is posted and the original is marked reversed.</p>
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      </ConfirmDialog>
    </div>
  )
}

export function VoucherPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const type = params.get('type') === 'CONTRA' ? 'CONTRA' : 'JOURNAL'
  if (id === 'new') return <VoucherEditor key={type} type={type} />
  return <VoucherView id={Number(id)} />
}
