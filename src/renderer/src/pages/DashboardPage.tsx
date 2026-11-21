import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ArrowDownLeft, ArrowUpRight, Banknote, Boxes, ReceiptIndianRupee, RefreshCw, ShoppingCart, Table2, TrendingUp, Wallet, Landmark, AlertTriangle } from 'lucide-react'
import type { DashboardSummary } from '@shared/types'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { formatDate, formatINR, formatINRCompact, milliToString } from '../lib/format'
import { Badge, Button, Card, DemoBadge, ErrorBanner, PageHeader, Spinner, cx } from '../components/ui'

const SERIES = { sales: 'var(--color-series-1)', purchases: 'var(--color-series-2)', receipts: 'var(--color-series-3)' }
const AXIS = { fontSize: 12, fill: 'var(--color-ink-3)' }

function Kpi({ label, value, sub, icon, accent }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; accent: string }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between">
        <p className="text-[12.5px] font-semibold text-ink-2">{label}</p>
        <span className={cx('grid size-8 place-items-center rounded-lg', accent)}>{icon}</span>
      </div>
      <p className="tabular mt-2 text-[24px] leading-none font-bold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-2 text-[12px] text-ink-3">{sub}</p>}
    </div>
  )
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

function TrendCard({ data }: { data: DashboardSummary['monthly'] }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card
      title="Sales, purchases & collections"
      subtitle="Last 6 months · taxable value (sales, purchases) and amount received"
      actions={
        <Button variant="ghost" icon={<Table2 className="size-4" />} onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? 'Chart view' : 'Table view'}
        </Button>
      }
      className="col-span-2"
    >
      {asTable ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] text-ink-3 uppercase">
              <th className="py-2">Month</th>
              <th className="py-2 text-right">Sales</th>
              <th className="py-2 text-right">Purchases</th>
              <th className="py-2 text-right">Receipts</th>
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.month} className="tabular border-t border-slate-100">
                <td className="py-2">{m.label}</td>
                <td className="py-2 text-right">{formatINR(m.salesPaise)}</td>
                <td className="py-2 text-right">{formatINR(m.purchasesPaise)}</td>
                <td className="py-2 text-right">{formatINR(m.receiptsPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="#eef1f6" />
              <XAxis dataKey="label" tick={AXIS} axisLine={{ stroke: '#e3e8f0' }} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} width={72} tickFormatter={(v: number) => formatINRCompact(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(37,99,217,0.05)' }} />
              <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12.5, color: 'var(--color-ink-2)', paddingTop: 8 }} />
              <Bar dataKey="salesPaise" name="Sales" fill={SERIES.sales} radius={[4, 4, 0, 0]} maxBarSize={30} />
              <Bar dataKey="purchasesPaise" name="Purchases" fill={SERIES.purchases} radius={[4, 4, 0, 0]} maxBarSize={30} />
              <Line dataKey="receiptsPaise" name="Receipts" stroke={SERIES.receipts} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: '#fff', fill: SERIES.receipts }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

function TopCustomers({ data }: { data: DashboardSummary['topCustomers'] }) {
  const rows = data.map((d) => ({ ...d, short: d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name }))
  return (
    <Card title="Top customers" subtitle="Financial year to date · taxable sales">
      {rows.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-3">No sales posted yet</p>
      ) : (
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 64, left: 0, bottom: 0 }} barCategoryGap="30%">
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="short" tick={{ ...AXIS, fill: 'var(--color-ink-2)' }} axisLine={false} tickLine={false} width={170} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(37,99,217,0.05)' }} />
              <Bar dataKey="salesPaise" name="Sales" fill={SERIES.sales} radius={[0, 4, 4, 0]} maxBarSize={22}>
                <LabelList dataKey="salesPaise" position="right" formatter={(v: unknown) => formatINRCompact(Number(v))} style={{ fontSize: 12, fill: 'var(--color-ink-2)', fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}

function SalesMix({ data }: { data: DashboardSummary['salesMix'] }) {
  const total = data.reduce((s, d) => s + d.taxablePaise, 0)
  const items = [
    { key: 'GOODS', label: 'Goods', color: SERIES.sales },
    { key: 'SERVICE', label: 'Services', color: SERIES.purchases }
  ].map((i) => ({ ...i, value: data.find((d) => d.itemType === i.key)?.taxablePaise ?? 0 }))
  return (
    <Card title="Revenue mix" subtitle="Goods vs services · FY to date">
      {total === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">No sales posted yet</p>
      ) : (
        <>
          <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={items.map((i) => `${i.label} ${Math.round((i.value / total) * 100)}%`).join(', ')}>
            {items.filter((i) => i.value > 0).map((i) => (
              <div key={i.key} title={`${i.label}: ${formatINR(i.value)}`} style={{ width: `${(i.value / total) * 100}%`, background: i.color }} />
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3">
            {items.map((i) => (
              <div key={i.key}>
                <dt className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                  <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
                  {i.label} · {Math.round((i.value / total) * 100)}%
                </dt>
                <dd className="tabular mt-0.5 text-[16px] font-bold text-ink">{formatINRCompact(i.value)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Card>
  )
}

export default function DashboardPage() {
  const { session } = useSession()
  const { data, error, loading, reload } = useQuery<DashboardSummary>(() => api('dashboard:summary'), [session?.company?.id])

  if (loading && !data) return <Spinner label="Loading dashboard…" />
  if (!data) return <ErrorBanner error={error} onRetry={reload} />
  const k = data.kpis
  const gstNet = k.gstOutputPaise - k.gstInputPaise

  return (
    <div>
      <PageHeader
        title="Dashboard"
        badge={session?.company?.isDemo ? <DemoBadge label="DEMO DATA" /> : undefined}
        description={`${session?.company?.name} · FY ${data.financialYear} · figures computed from posted transactions as of ${formatDate(data.asOf)}`}
        actions={<Button variant="secondary" icon={<RefreshCw className={cx('size-4', loading && 'animate-spin')} />} onClick={reload}>Refresh</Button>}
      />
      <ErrorBanner error={error} onRetry={reload} />

      <div className="grid grid-cols-4 gap-4">
        <Kpi label="Sales (FY)" value={formatINRCompact(k.salesPaise)} sub={`${k.salesCount} invoices · incl. GST`} icon={<TrendingUp className="size-4 text-brand-700" />} accent="bg-brand-50" />
        <Kpi label="Purchases (FY)" value={formatINRCompact(k.purchasesPaise)} sub={`${k.purchasesCount} bills · incl. GST`} icon={<ShoppingCart className="size-4 text-orange-700" />} accent="bg-orange-50" />
        <Kpi label="Receivables" value={formatINRCompact(k.receivablesPaise)} sub={`Collected ${formatINRCompact(k.receiptsPaise)} this FY`} icon={<ArrowDownLeft className="size-4 text-emerald-700" />} accent="bg-emerald-50" />
        <Kpi label="Payables" value={formatINRCompact(k.payablesPaise)} sub={`Paid ${formatINRCompact(k.paymentsPaise)} this FY`} icon={<ArrowUpRight className="size-4 text-red-700" />} accent="bg-red-50" />
        <Kpi label="Cash & bank" value={formatINRCompact(k.cashBankPaise)} sub="Ledger balance" icon={<Wallet className="size-4 text-navy-700" />} accent="bg-slate-100" />
        <Kpi label="Stock value" value={formatINRCompact(k.stockValuePaise)} sub={`${data.counts.products} items · ${data.counts.warehouses} warehouses`} icon={<Boxes className="size-4 text-violet-700" />} accent="bg-violet-50" />
        <Kpi label="GST output" value={formatINRCompact(k.gstOutputPaise)} sub={`Input credit ${formatINRCompact(k.gstInputPaise)}`} icon={<ReceiptIndianRupee className="size-4 text-brand-700" />} accent="bg-brand-50" />
        <Kpi
          label={gstNet >= 0 ? 'Net GST payable' : 'Net GST credit'}
          value={formatINRCompact(Math.abs(gstNet))}
          sub="Output less input (indicative)"
          icon={gstNet >= 0 ? <Landmark className="size-4 text-amber-700" /> : <Banknote className="size-4 text-emerald-700" />}
          accent={gstNet >= 0 ? 'bg-amber-50' : 'bg-emerald-50'}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <TrendCard data={data.monthly} />
        <TopCustomers data={data.topCustomers} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Card title="Recent transactions" subtitle="Latest posted sales and purchase invoices" className="col-span-2" bodyClassName="p-0" actions={<Link to="/sales" className="text-[13px] font-semibold text-brand-600 hover:underline">View all</Link>}>
          <table className="w-full text-[13px]">
            <tbody>
              {data.recentInvoices.map((r) => (
                <tr key={`${r.kind}-${r.id}`} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-2.5">
                    <Badge tone={r.kind === 'SALE' ? 'blue' : 'amber'}>{r.kind === 'SALE' ? 'Sale' : 'Purchase'}</Badge>
                  </td>
                  <td className="px-2 py-2.5 font-mono text-[12.5px] font-semibold text-ink">{r.number}</td>
                  <td className="px-2 py-2.5 text-ink-2">{r.party}</td>
                  <td className="px-2 py-2.5 text-ink-3">{formatDate(r.date)}</td>
                  <td className="tabular px-5 py-2.5 text-right font-semibold">{formatINR(r.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="flex flex-col gap-4">
          <SalesMix data={data.salesMix} />
          <Card title="Low stock" subtitle="At or below reorder level" bodyClassName="p-0" actions={<Link to="/inventory" className="text-[13px] font-semibold text-brand-600 hover:underline">Inventory</Link>}>
            {data.lowStock.length === 0 ? (
              <p className="px-5 py-6 text-center text-[13px] text-ink-3">All items above reorder level</p>
            ) : (
              <ul>
                {data.lowStock.map((i) => (
                  <li key={i.productId} className="flex items-center gap-3 border-b border-slate-100 px-5 py-2.5 last:border-0">
                    <AlertTriangle className={cx('size-4 shrink-0', i.qtyMilli === 0 ? 'text-red-600' : 'text-amber-600')} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{i.name}</span>
                    <span className="tabular text-[12.5px] font-semibold text-ink">{milliToString(i.qtyMilli)}</span>
                    <span className="text-[12px] text-ink-3">/ {milliToString(i.reorderLevelMilli)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
