import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, CalendarClock, FileText, IndianRupee, PencilLine, Receipt, ShoppingCart, TrendingUp, Wallet } from 'lucide-react'
import { KINDS, docRoute, type DocumentKind, type ModuleSummary, type RegisterRow, type Side } from '@shared/documents'
import type { Customer } from '@shared/types'
import { api } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { formatDate, formatINR, formatINRCompact, stateName } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Input, PageHeader, SearchInput, Select, Spinner, cx, type Column } from '../../components/ui'
import { StatTile } from '../../components/StatTile'
import { ModuleNav, PaymentBadge, StatusBadge, paymentsSlug, sideRoot } from './common'

// ───────────────────────── Module dashboard ─────────────────────────
export function ModuleDashboard({ side }: { side: Side }) {
  const navigate = useNavigate()
  const { can, session } = useSession()
  const { data, error, loading, reload } = useQuery<ModuleSummary>(() => api('doc:summary', { side }), [side, session?.company?.id])
  const sales = side === 'SALES'
  const canPost = can(sales ? 'sales.post' : 'purchase.post')
  const quick: DocumentKind[] = sales ? ['SALES_QUOTATION', 'SALES_ORDER', 'SALES_INVOICE'] : ['PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_INVOICE']
  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader
        title={sales ? 'Sales' : 'Purchase'}
        description={`All figures are computed from posted documents${data ? ` · FY ${data.financialYear} · as of ${formatDate(data.asOf)}` : ''}`}
        actions={
          canPost && (
            <div className="flex gap-2">
              {quick.map((k) => <Button key={k} variant={k.endsWith('INVOICE') ? 'primary' : 'secondary'} onClick={() => navigate(docRoute(k, 'new'))}>New {KINDS[k].label.replace(/^(Sales|Purchase) /, '').toLowerCase()}</Button>)}
              <Button variant="secondary" icon={<IndianRupee className="size-4" />} onClick={() => navigate(`${sideRoot(side)}/${paymentsSlug(side)}/new`)}>{sales ? 'Receive payment' : 'Pay supplier'}</Button>
            </div>
          )
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : data ? (
        <>
          <div className="grid grid-cols-3 gap-4 xl:grid-cols-6">
            <StatTile label={sales ? 'Invoiced this month' : 'Billed this month'} value={formatINRCompact(data.monthTotalPaise)} sub={`${data.monthCount} invoice${data.monthCount === 1 ? '' : 's'} · incl. GST`} icon={sales ? <TrendingUp className="size-4 text-brand-700" /> : <ShoppingCart className="size-4 text-orange-700" />} accent={sales ? 'bg-brand-50' : 'bg-orange-50'} />
            <StatTile label="Financial year to date" value={formatINRCompact(data.fyTotalPaise)} sub="Posted invoices" icon={<FileText className="size-4 text-navy-700" />} accent="bg-slate-100" />
            <StatTile label={sales ? 'Receivables' : 'Payables'} value={formatINRCompact(data.outstandingPaise)} sub="Ledger balance incl. opening & advances" icon={<Wallet className="size-4 text-violet-700" />} accent="bg-violet-50" />
            <StatTile label="Overdue" value={formatINRCompact(data.overduePaise)} sub={`${data.overdueCount} invoice${data.overdueCount === 1 ? '' : 's'} past due date`} icon={<AlertTriangle className="size-4 text-red-700" />} accent="bg-red-50" onClick={() => navigate(`${sideRoot(side)}/register?status=OVERDUE`)} />
            <StatTile label={sales ? 'Received this month' : 'Paid this month'} value={formatINRCompact(data.settledThisMonthPaise)} sub={sales ? 'Customer receipts' : 'Supplier payments'} icon={<Receipt className="size-4 text-emerald-700" />} accent="bg-emerald-50" />
            <StatTile label="Drafts" value={String(data.draftCount)} sub="Not posted — no effect yet" icon={<PencilLine className="size-4 text-amber-700" />} accent="bg-amber-50" />
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4">
            <Card title="Pipeline" subtitle="Posted documents not yet taken further">
              <ul className="space-y-2">
                {data.pending.map((p) => (
                  <li key={p.kind}>
                    <button onClick={() => navigate(`${sideRoot(side)}/${KINDS[p.kind].slug}`)} className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left hover:border-brand-500/40 hover:bg-brand-50/40">
                      <CalendarClock className="size-4 text-ink-3" />
                      <span className="flex-1 text-[13px] font-medium text-ink">{p.label}</span>
                      <span className="tabular text-[12.5px] text-ink-3">{formatINRCompact(p.valuePaise)}</span>
                      <Badge tone={p.count ? 'blue' : 'gray'}>{p.count}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={sales ? 'Overdue invoices' : 'Overdue bills'} subtitle="Oldest first" className="col-span-2" bodyClassName="p-0">
              {data.overdue.length === 0 ? (
                <p className="px-5 py-8 text-center text-[13px] text-ink-3">Nothing overdue 🎉</p>
              ) : (
                <table className="w-full text-[13px]">
                  <tbody>
                    {data.overdue.map((r) => (
                      <tr key={r.id} onClick={() => navigate(docRoute(r.kind, r.id))} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-brand-50/40">
                        <td className="px-5 py-2.5 font-mono font-semibold">{r.number}</td>
                        <td className="px-2 py-2.5">{r.partyName}</td>
                        <td className="px-2 py-2.5 text-ink-3">due {formatDate(r.dueDate)}</td>
                        <td className="px-2 py-2.5"><Badge tone="red">{r.overdueDays} days</Badge></td>
                        <td className="tabular px-5 py-2.5 text-right font-semibold">{formatINR(r.balanceDuePaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title="Recent documents" className="mt-4" bodyClassName="p-0">
            {data.recent.length === 0 ? (
              <EmptyState title="No posted documents yet" />
            ) : (
              <table className="w-full text-[13px]">
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={`${r.kind}-${r.id}`} onClick={() => navigate(docRoute(r.kind, r.id))} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-brand-50/40">
                      <td className="px-5 py-2.5"><Badge tone="blue">{KINDS[r.kind].label}</Badge></td>
                      <td className="px-2 py-2.5 font-mono font-semibold">{r.number}</td>
                      <td className="px-2 py-2.5">{r.partyName ?? '—'}</td>
                      <td className="px-2 py-2.5 text-ink-3">{formatDate(r.date)}</td>
                      <td className="px-2 py-2.5"><StatusBadge status={r.status} /></td>
                      <td className="tabular px-5 py-2.5 text-right font-semibold">{formatINR(r.grandTotalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      ) : null}
    </div>
  )
}

// ───────────────────────── Customer selection ─────────────────────────
export function CustomerSelectionPage() {
  const navigate = useNavigate()
  const { can, session } = useSession()
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const { data, error, loading, reload } = useQuery<Customer[]>(() => api('customer:list', { search: q || undefined }), [q, session?.company?.id])
  const canPost = can('sales.post')
  const go = (path: string) => (e: React.MouseEvent) => (e.stopPropagation(), navigate(path))
  const columns: Column<Customer>[] = [
    { key: 'name', header: 'Customer', wrap: true, render: (c) => <span><span className="font-semibold text-ink">{c.name}</span><span className="block font-mono text-[11.5px] text-ink-3">{c.code} · {c.gstin ?? c.gstRegistrationType.toLowerCase()}</span></span>, sortValue: (c) => c.name },
    { key: 'place', header: 'Place of supply', render: (c) => <span className="text-ink-2">{stateName(c.shippingStateCode ?? c.stateCode)}</span> },
    { key: 'terms', header: 'Terms', render: (c) => `${c.creditDays} days` },
    { key: 'bal', header: 'Outstanding', align: 'right', render: (c) => <span className={cx('font-semibold', c.balancePaise < 0 && 'text-emerald-700')}>{formatINR(c.balancePaise)}</span>, sortValue: (c) => c.balancePaise },
    {
      key: 'limit', header: 'Credit used', render: (c) => {
        if (!c.creditLimitPaise) return <span className="text-ink-3">No limit</span>
        const pct = Math.max(0, Math.round((c.balancePaise / c.creditLimitPaise) * 100))
        return (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100"><span className={cx('block h-full rounded-full', pct > 100 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${Math.min(100, pct)}%` }} /></span>
            <span className="tabular text-[12px] text-ink-2">{pct}%</span>
          </span>
        )
      }
    },
    {
      key: 'act', header: '', render: (c) => canPost && (
        <span className="flex justify-end gap-1">
          <Button variant="ghost" className="h-8" onClick={go(`/sales/quotations/new?party=${c.id}`)}>Quote</Button>
          <Button variant="ghost" className="h-8" onClick={go(`/sales/invoices/new?party=${c.id}`)}>Invoice</Button>
          <Button variant="ghost" className="h-8" onClick={go(`/sales/receipts/new?party=${c.id}`)}>Receive</Button>
        </span>
      )
    }
  ]
  return (
    <div>
      <ModuleNav side="SALES" />
      <PageHeader title="Select a customer" description="Pick a customer to start a quotation, invoice or receipt. Outstanding balances are read from the receivables ledger." />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="border-b border-line px-4 py-3"><SearchInput value={search} onChange={setSearch} placeholder="Search name, code, GSTIN, city…" className="w-96" /></div>
        {loading && !data ? <Spinner /> : <DataTable rows={data ?? []} columns={columns} rowKey={(c) => c.id} onRowClick={(c) => navigate(`/masters/customers?open=${c.id}`)} />}
      </Card>
    </div>
  )
}

// ───────────────────────── Register ─────────────────────────
export function RegisterPage({ side }: { side: Side }) {
  const navigate = useNavigate()
  const { session } = useSession()
  const [params] = useSearchParams()
  const initial = params.get('status')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState<string>(initial ?? '')
  const [cancelled, setCancelled] = useState(false)
  const q = useDebounced(search)
  const { data, error, loading, reload } = useQuery<RegisterRow[]>(
    () => api('doc:register', { side, search: q || undefined, from: from || undefined, to: to || undefined, paymentStatus: (status || undefined) as never, includeCancelled: cancelled }),
    [side, q, from, to, status, cancelled, session?.company?.id]
  )
  const rows = data ?? []
  const posted = rows.filter((r) => r.status === 'POSTED')
  const sum = (k: keyof RegisterRow) => posted.reduce((s, r) => s + (r[k] as number), 0)
  const sales = side === 'SALES'
  const columns: Column<RegisterRow>[] = [
    { key: 'no', header: 'Number', render: (r) => <span className="font-mono font-semibold">{r.number}</span>, sortValue: (r) => r.number },
    { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date },
    { key: 'party', header: sales ? 'Customer' : 'Supplier', render: (r) => r.partyName, wrap: true, sortValue: (r) => r.partyName },
    { key: 'ref', header: sales ? 'GSTIN' : 'Supplier bill', render: (r) => <span className="font-mono text-[12px] text-ink-2">{(sales ? r.partyGstin : r.partyRef) ?? '—'}</span> },
    { key: 'taxable', header: 'Taxable', align: 'right', render: (r) => formatINR(r.taxablePaise), sortValue: (r) => r.taxablePaise },
    { key: 'cgst', header: 'CGST', align: 'right', render: (r) => formatINR(r.cgstPaise) },
    { key: 'sgst', header: 'SGST', align: 'right', render: (r) => formatINR(r.sgstPaise) },
    { key: 'igst', header: 'IGST', align: 'right', render: (r) => formatINR(r.igstPaise) },
    { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.grandTotalPaise)}</span>, sortValue: (r) => r.grandTotalPaise },
    { key: 'settled', header: sales ? 'Received' : 'Paid', align: 'right', render: (r) => formatINR(r.settledPaise) },
    { key: 'bal', header: 'Balance', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.balanceDuePaise)}</span>, sortValue: (r) => r.balanceDuePaise },
    { key: 'due', header: 'Due', render: (r) => formatDate(r.dueDate), sortValue: (r) => r.dueDate ?? '' },
    { key: 'st', header: 'Status', render: (r) => (r.status === 'CANCELLED' ? <StatusBadge status="CANCELLED" /> : <PaymentBadge status={r.paymentStatus} overdue={r.overdueDays} />) }
  ]
  const td = 'tabular border-t border-line px-4 py-2.5 text-right'
  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader title={sales ? 'Sales register' : 'Purchase register'} description="Posted invoices with GST break-up, settlements and balances. Totals exclude cancelled invoices." />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search number, party, GSTIN, bill no.…" className="w-72" />
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-38" /></label>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-38" /></label>
          <div className="w-44"><Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All payment states</option>
            <option value="UNPAID">Unpaid</option>
            <option value="PARTIAL">Part-paid</option>
            <option value="PAID">Paid</option>
            <option value="OVERDUE">Overdue</option>
          </Select></div>
          <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} className="size-4 accent-brand-600" /> Include cancelled</label>
          <span className="ml-auto text-[12.5px] text-ink-3">{rows.length} invoices</span>
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(docRoute(r.kind, r.id))}
            empty={<EmptyState title="No invoices match these filters" />}
            footer={
              rows.length > 0 && (
                <tr>
                  <td colSpan={4} className="border-t border-line px-4 py-2.5 text-right text-ink-2">Total (posted)</td>
                  <td className={td}>{formatINR(sum('taxablePaise'))}</td>
                  <td className={td}>{formatINR(sum('cgstPaise'))}</td>
                  <td className={td}>{formatINR(sum('sgstPaise'))}</td>
                  <td className={td}>{formatINR(sum('igstPaise'))}</td>
                  <td className={td}>{formatINR(sum('grandTotalPaise'))}</td>
                  <td className={td}>{formatINR(sum('settledPaise'))}</td>
                  <td className={td}>{formatINR(sum('balanceDuePaise'))}</td>
                  <td colSpan={2} className="border-t border-line" />
                </tr>
              )
            }
          />
        )}
      </Card>
    </div>
  )
}
