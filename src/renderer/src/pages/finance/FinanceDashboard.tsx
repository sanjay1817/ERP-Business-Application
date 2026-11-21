import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Banknote, Landmark, ReceiptIndianRupee, Scale, ShoppingCart, Table2, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import type { FinanceDashboard as Dash } from '@shared/finance'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { formatDate, formatINR, formatINRCompact } from '../../lib/format'
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, cx } from '../../components/ui'
import { CheckPill, FinanceNav, JournalDrawer, PeriodBar, usePeriod } from './shared'

const SERIES = { income: 'var(--color-series-1)', expenses: 'var(--color-series-2)', net: 'var(--color-series-3)' }
const AXIS = { fontSize: 12, fill: 'var(--color-ink-3)' }

function Tile({ label, value, sub, icon, accent, to, tone }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; accent: string; to?: string; tone?: 'bad' | 'good' }) {
  const body = (
    <>
      <div className="flex items-start justify-between">
        <p className="text-[12.5px] font-semibold text-ink-2">{label}</p>
        <span className={cx('grid size-8 place-items-center rounded-lg', accent)}>{icon}</span>
      </div>
      <p className={cx('tabular mt-2 text-[21px] leading-none font-bold tracking-tight', tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-ink')}>{value}</p>
      {sub && <p className="mt-2 text-[12px] text-ink-3">{sub}</p>}
    </>
  )
  const cls = 'block rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]'
  return to ? <Link to={to} className={cx(cls, 'transition hover:border-brand-500/40 hover:shadow-md')}>{body}</Link> : <div className={cls}>{body}</div>
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 shadow-lg shadow-slate-900/10">
      <p className="mb-1 text-[12px] font-semibold text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-[12px] text-ink-2">
          <span className="size-2.5 rounded-sm" style={{ background: p.color }} />
          {p.name}
          <span className="tabular ml-auto pl-4 font-semibold text-ink">{formatINR(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

function MonthlyCard({ data }: { data: Dash['monthly'] }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card
      title="Income, expenses and net profit"
      subtitle="Monthly, from posted journals (excludes GST)"
      className="col-span-2"
      actions={<Button variant="ghost" icon={<Table2 className="size-4" />} onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>{asTable ? 'Chart view' : 'Table view'}</Button>}
    >
      {data.length === 0 ? <p className="py-16 text-center text-[13px] text-ink-3">No postings in this period</p> : asTable ? (
        <table className="w-full text-[13px]">
          <thead><tr className="text-left text-[11.5px] text-ink-3 uppercase"><th className="py-1.5">Month</th><th className="py-1.5 text-right">Income</th><th className="py-1.5 text-right">Expenses</th><th className="py-1.5 text-right">Net profit</th></tr></thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.month} className="border-t border-slate-100">
                <td className="py-1.5">{m.label}</td>
                <td className="tabular py-1.5 text-right">{formatINR(m.incomePaise)}</td>
                <td className="tabular py-1.5 text-right">{formatINR(m.expensesPaise)}</td>
                <td className={cx('tabular py-1.5 text-right font-semibold', m.netPaise < 0 && 'text-red-700')}>{formatINR(m.netPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="h-[290px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="#eef1f6" />
              <XAxis dataKey="label" tick={AXIS} axisLine={{ stroke: '#e3e8f0' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={72} tickFormatter={(v: number) => formatINRCompact(v)} />
              <ReferenceLine y={0} stroke="#cbd5e1" />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(37,99,217,0.05)' }} />
              <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12.5, color: 'var(--color-ink-2)', paddingTop: 8 }} />
              <Bar dataKey="incomePaise" name="Income" fill={SERIES.income} radius={[4, 4, 0, 0]} maxBarSize={30} />
              <Bar dataKey="expensesPaise" name="Expenses" fill={SERIES.expenses} radius={[4, 4, 0, 0]} maxBarSize={30} />
              <Line dataKey="netPaise" name="Net profit" stroke={SERIES.net} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: SERIES.net }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

export default function FinanceDashboard() {
  const period = usePeriod()
  const { data, error, loading, reload } = useQuery<Dash | null>(() => (period.ready ? api('finance:dashboard', { from: period.from!, to: period.to! }) : Promise.resolve(null)), [period.from, period.to])
  const [journal, setJournal] = useState<number | null>(null)
  const k = data?.kpis
  const q = period.ready ? `?from=${period.from}&to=${period.to}` : ''
  return (
    <div>
      <PageHeader title="Finance & Accounts" description="Every figure is calculated from posted journal entries. Drafts never post." actions={<PeriodBar period={period} />} />
      <FinanceNav />
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && k && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <CheckPill ok={data.checks.trialBalanceBalanced} okText="Trial balance balanced" badText="Trial balance NOT balanced" />
            <CheckPill ok={data.checks.balanceSheetBalanced} okText="Assets = Liabilities + Equity" badText="Balance sheet does not balance" />
            <span className="text-[12.5px] text-ink-3">FY {data.financialYear} · {formatDate(data.from)} – {formatDate(data.to)}</span>
          </div>
          <div className="grid grid-cols-4 gap-4">
            <Tile label="Total sales" value={formatINR(k.salesPaise)} sub={`${k.salesCount} invoices · net of returns, excl. GST`} icon={<TrendingUp className="size-4" />} accent="bg-brand-50 text-brand-700" to={`/finance/profit-loss${q}`} />
            <Tile label="Total purchases" value={formatINR(k.purchasesPaise)} sub={`${k.purchasesCount} bills · net of returns, excl. GST`} icon={<ShoppingCart className="size-4" />} accent="bg-orange-50 text-orange-700" to="/purchase/register" />
            <Tile label="Receivables" value={formatINR(k.receivablesPaise)} sub={`As of ${formatDate(data.to)}`} icon={<ArrowDownLeft className="size-4" />} accent="bg-emerald-50 text-emerald-700" to={`/finance/receivables?asOf=${data.to}`} />
            <Tile label="Payables" value={formatINR(k.payablesPaise)} sub={`As of ${formatDate(data.to)}`} icon={<ArrowUpRight className="size-4" />} accent="bg-violet-50 text-violet-700" to={`/finance/payables?asOf=${data.to}`} />
            <Tile label="Cash balance" value={formatINR(k.cashPaise)} sub="Cash in hand" icon={<Wallet className="size-4" />} accent="bg-amber-50 text-amber-700" to={`/banking/cash-book${q}`} />
            <Tile label="Bank balance" value={formatINR(k.bankPaise)} sub="All bank accounts" icon={<Landmark className="size-4" />} accent="bg-sky-50 text-sky-700" to={`/banking/bank-book${q}`} />
            <Tile label="Income" value={formatINR(k.incomePaise)} sub="Sales and other income" icon={<ReceiptIndianRupee className="size-4" />} accent="bg-brand-50 text-brand-700" to={`/finance/profit-loss${q}`} />
            <Tile label="Expenses" value={formatINR(k.expensesPaise)} sub="Cost of sales and operating" icon={<Banknote className="size-4" />} accent="bg-orange-50 text-orange-700" to={`/finance/profit-loss${q}`} />
            <Tile label="Net profit" value={formatINR(k.netProfitPaise)} sub={k.incomePaise ? `${((k.netProfitPaise / k.incomePaise) * 100).toFixed(1)}% of income` : '—'} icon={k.netProfitPaise >= 0 ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />} accent={k.netProfitPaise >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'} tone={k.netProfitPaise >= 0 ? 'good' : 'bad'} to={`/finance/profit-loss${q}`} />
            <Tile label="Overdue receivables" value={formatINR(k.overdueReceivablesPaise)} sub={`${k.overdueReceivablesCount} open item${k.overdueReceivablesCount === 1 ? '' : 's'} past due date`} icon={<AlertTriangle className="size-4" />} accent="bg-red-50 text-red-700" tone={k.overdueReceivablesPaise > 0 ? 'bad' : undefined} to={`/finance/receivables?asOf=${data.to}`} />
            <Tile label="Overdue payables" value={formatINR(k.overduePayablesPaise)} sub={`${k.overduePayablesCount} open item${k.overduePayablesCount === 1 ? '' : 's'} past due date`} icon={<AlertTriangle className="size-4" />} accent="bg-amber-50 text-amber-700" to={`/finance/payables?asOf=${data.to}`} />
            <Tile label="Books" value={data.checks.trialBalanceBalanced && data.checks.balanceSheetBalanced ? 'Balanced' : 'Check needed'} sub="Trial balance and balance sheet" icon={<Scale className="size-4" />} accent="bg-slate-100 text-slate-700" tone={data.checks.trialBalanceBalanced && data.checks.balanceSheetBalanced ? 'good' : 'bad'} to={`/finance/trial-balance${q}`} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <MonthlyCard data={data.monthly} />
            <Card title="Recent financial transactions" subtitle="Latest journal entries in the period" bodyClassName="p-0" actions={<Link to={`/finance/day-book${q}`} className="text-[13px] font-semibold text-brand-700 hover:underline">Day book →</Link>}>
              {data.recent.length === 0 ? <p className="py-12 text-center text-[13px] text-ink-3">No entries</p> : (
                <ul className="divide-y divide-slate-100">
                  {data.recent.map((e) => (
                    <li key={e.journalId}>
                      <button onClick={() => setJournal(e.journalId)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-brand-50/50">
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                            {e.voucherNo ?? e.entryNo}
                            {e.isCancellation && <Badge tone="red">Reversal</Badge>}
                          </span>
                          <span className="block truncate text-[12px] text-ink-3">{formatDate(e.date)} · {e.voucherType}{e.narration ? ` · ${e.narration}` : ''}</span>
                        </span>
                        <span className="tabular text-[13px] font-semibold text-ink">{formatINR(e.amountPaise)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
    </div>
  )
}
