import { useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, ExternalLink, FileDown, FileSpreadsheet, Printer, XCircle } from 'lucide-react'
import type { JournalDetail, PeriodsInfo, ReportParamsT } from '@shared/finance'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR } from '../../lib/format'
import { Badge, Button, Drawer, Spinner, cx } from '../../components/ui'

// ───────── Section navigation ─────────
export function SectionNav({ label, items }: { label: string; items: Array<{ to: string; label: string; end?: boolean; permission?: string }> }) {
  const { can } = useSession()
  return (
    <nav aria-label={label} className="-mx-1 mb-5 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-line px-1">
      {items.filter((i) => !i.permission || can(i.permission)).map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) => cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold whitespace-nowrap transition-colors', isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-2 hover:border-slate-300 hover:text-ink')}
        >
          {i.label}
        </NavLink>
      ))}
    </nav>
  )
}

export const FinanceNav = () => (
  <SectionNav
    label="Finance sections"
    items={[
      { to: '/finance', label: 'Dashboard', end: true },
      { to: '/finance/ledger', label: 'General Ledger' },
      { to: '/finance/trial-balance', label: 'Trial Balance' },
      { to: '/finance/profit-loss', label: 'Profit & Loss' },
      { to: '/finance/balance-sheet', label: 'Balance Sheet' },
      { to: '/finance/day-book', label: 'Day Book' },
      { to: '/finance/vouchers', label: 'Vouchers' },
      { to: '/finance/receivables', label: 'Receivables' },
      { to: '/finance/payables', label: 'Payables' },
      { to: '/finance/accounts', label: 'Chart of Accounts' }
    ]}
  />
)

export const BankingNav = () => (
  <SectionNav
    label="Banking sections"
    items={[
      { to: '/banking', label: 'Overview', end: true },
      { to: '/banking/cash-book', label: 'Cash Book' },
      { to: '/banking/bank-book', label: 'Bank Book' },
      { to: '/banking/reconciliation', label: 'Bank Reconciliation' }
    ]}
  />
)

// ───────── Period (financial year / date range) in the URL ─────────
const todayIso = () => new Date().toISOString().slice(0, 10)

export function usePeriods() {
  const { session } = useSession()
  return useQuery<PeriodsInfo>(() => api('finance:periods'), [session?.company?.id])
}

/** Date range from ?from&to (default: current financial year to date). */
export function usePeriod() {
  const [params, setParams] = useSearchParams()
  const periods = usePeriods()
  const fy = periods.data?.years.find((y) => y.fy === periods.data?.currentFy)
  const from = params.get('from') ?? fy?.from ?? null
  const to = params.get('to') ?? (fy ? (fy.to < todayIso() ? fy.to : todayIso()) : null)
  const set = (next: { from?: string; to?: string; [k: string]: string | undefined }) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k)
    setParams(p, { replace: true })
  }
  return { from, to, ready: !!from && !!to, set, periods: periods.data, params }
}

/** As-of date from ?asOf (default: today). */
export function useAsOf() {
  const [params, setParams] = useSearchParams()
  const asOf = params.get('asOf') ?? todayIso()
  const set = (v: string) => {
    const p = new URLSearchParams(params)
    p.set('asOf', v)
    setParams(p, { replace: true })
  }
  return { asOf, set }
}

const dateInput = 'h-9 rounded-lg border border-line bg-white px-2.5 text-[13px] text-ink focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none'

export function PeriodBar({ period, children }: { period: ReturnType<typeof usePeriod>; children?: ReactNode }) {
  const years = period.periods?.years ?? []
  const match = years.find((y) => y.from === period.from && (y.to === period.to || (y.to > todayIso() && period.to === todayIso())))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="fy">Financial year</label>
      <select
        id="fy"
        value={match?.fy ?? ''}
        onChange={(e) => {
          const y = years.find((x) => x.fy === e.target.value)
          if (y) period.set({ from: y.from, to: y.to < todayIso() ? y.to : todayIso() })
        }}
        className={cx(dateInput, 'pr-8 font-semibold')}
      >
        {!match && <option value="">Custom period</option>}
        {years.map((y) => <option key={y.fy} value={y.fy}>FY {y.fy}{y.hasData ? '' : ' (no entries)'}</option>)}
      </select>
      <input type="date" aria-label="From date" className={dateInput} value={period.from ?? ''} max={period.to ?? undefined} onChange={(e) => e.target.value && period.set({ from: e.target.value })} />
      <span className="text-[12px] text-ink-3">to</span>
      <input type="date" aria-label="To date" className={dateInput} value={period.to ?? ''} min={period.from ?? undefined} onChange={(e) => e.target.value && period.set({ to: e.target.value })} />
      {children}
    </div>
  )
}

export function AsOfBar({ asOf, onChange, children }: { asOf: string; onChange: (v: string) => void; children?: ReactNode }) {
  const periods = usePeriods()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] font-semibold text-ink-2">As of</span>
      <input type="date" aria-label="As of date" className={dateInput} value={asOf} onChange={(e) => e.target.value && onChange(e.target.value)} />
      <select aria-label="Financial year end" value="" onChange={(e) => e.target.value && onChange(e.target.value)} className={cx(dateInput, 'pr-8')}>
        <option value="">Jump to…</option>
        <option value={todayIso()}>Today</option>
        {(periods.data?.years ?? []).filter((y) => y.to < todayIso()).map((y) => <option key={y.fy} value={y.to}>End of FY {y.fy}</option>)}
      </select>
      {children}
    </div>
  )
}

// ───────── Exports ─────────
export function ReportActions({ params, disabled }: { params: ReportParamsT | null; disabled?: boolean }) {
  const { can } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'print' | null>(null)
  if (!can('reports.export')) return null
  const run = async (kind: 'pdf' | 'xlsx' | 'print') => {
    if (!params) return
    setBusy(kind)
    try {
      if (kind === 'print') {
        const r = await api('report:print', params)
        if (r.printed) toast('success', 'Sent to printer')
      } else {
        const r = await api(kind === 'pdf' ? 'report:exportPdf' : 'report:exportExcel', params)
        if (r.path) toast('success', kind === 'pdf' ? 'PDF saved' : 'Excel workbook saved', r.path)
      }
    } catch (e) {
      toast('error', 'Export failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const off = disabled || !params
  return (
    <div className="flex items-center gap-1.5">
      <Button variant="secondary" icon={<Printer className="size-4" />} loading={busy === 'print'} disabled={off} onClick={() => void run('print')}>Print</Button>
      <Button variant="secondary" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} disabled={off} onClick={() => void run('pdf')}>PDF</Button>
      <Button variant="secondary" icon={<FileSpreadsheet className="size-4" />} loading={busy === 'xlsx'} disabled={off} onClick={() => void run('xlsx')}>Excel</Button>
    </div>
  )
}

// ───────── Amounts ─────────
/** Debit-positive amount shown as "₹x Dr / Cr". */
export function DrCr({ paise, className }: { paise: number; className?: string }) {
  if (paise === 0) return <span className={cx('tabular text-ink-3', className)}>{formatINR(0)}</span>
  return (
    <span className={cx('tabular whitespace-nowrap', className)}>
      {formatINR(Math.abs(paise))} <span className="text-[11px] font-semibold text-ink-3">{paise > 0 ? 'Dr' : 'Cr'}</span>
    </span>
  )
}

export const money = (paise: number | null | undefined) => (paise ? formatINR(paise) : '')

export function SummaryStrip({ items }: { items: Array<{ label: string; value: ReactNode; tone?: 'good' | 'bad' | 'muted' }> }) {
  return (
    <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((i) => (
        <div key={i.label} className="rounded-xl border border-line bg-white px-4 py-3">
          <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{i.label}</p>
          <p className={cx('tabular mt-1 text-[18px] font-bold', i.tone === 'good' ? 'text-emerald-700' : i.tone === 'bad' ? 'text-red-700' : 'text-ink')}>{i.value}</p>
        </div>
      ))}
    </div>
  )
}

export function CheckPill({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold', ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')} role="status">
      {ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
      {ok ? okText : badText}
    </span>
  )
}

// ───────── Journal drill-down ─────────
export function JournalDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data, loading, error } = useQuery<JournalDetail | null>(() => (id ? api('finance:journal', { id }) : Promise.resolve(null)), [id])
  const navigate = useNavigate()
  const dr = data?.lines.reduce((s, l) => s + l.debitPaise, 0) ?? 0
  const cr = data?.lines.reduce((s, l) => s + l.creditPaise, 0) ?? 0
  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      title={data ? `Journal ${data.entryNo}` : 'Journal entry'}
      subtitle={data ? `${formatDate(data.entryDate)} · ${data.source.voucherType}${data.source.voucherNo ? ` ${data.source.voucherNo}` : ''}` : undefined}
      width="w-[720px]"
      footer={
        data?.source.route ? (
          <Button icon={<ExternalLink className="size-4" />} onClick={() => { onClose(); navigate(data.source.route!) }}>Open source document</Button>
        ) : undefined
      }
    >
      {loading && !data ? <Spinner /> : error ? <p className="text-red-700">{error.message}</p> : data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.status === 'REVERSED' ? 'red' : 'green'}>{data.status === 'REVERSED' ? 'Reversed' : 'Posted'}</Badge>
            {data.source.isCancellation && <Badge tone="red">Reversal entry</Badge>}
            {data.source.documentStatus === 'CANCELLED' && <Badge tone="amber">Source document cancelled</Badge>}
            {data.source.documentStatus === 'MISSING' && <Badge tone="red">Source document missing</Badge>}
            <span className="text-[12.5px] text-ink-3">FY {data.financialYear} · entered {formatDateTime(data.createdAt)}{data.createdBy ? ` by ${data.createdBy}` : ''}</span>
          </div>
          {data.narration && <p className="rounded-lg bg-slate-50 px-3 py-2 text-[13px] text-ink-2">{data.narration}</p>}
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11.5px] text-ink-3 uppercase"><th className="py-2">Account</th><th className="py-2 text-right">Debit</th><th className="py-2 text-right">Credit</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.lineId} className="border-b border-slate-100">
                  <td className={cx('py-2', l.creditPaise ? 'pl-6' : '')}>
                    <Link to={`/finance/ledger?account=${l.accountId}&from=${data.entryDate}&to=${data.entryDate}`} onClick={onClose} className="hover:text-brand-700 hover:underline">
                      <span className="font-mono text-ink-3">{l.accountCode}</span> {l.accountName}
                    </Link>
                    {l.party && <span className="text-ink-3"> · {l.party}</span>}
                    {l.narration && <span className="block text-[12px] text-ink-3">{l.narration}</span>}
                  </td>
                  <td className="tabular py-2 text-right">{money(l.debitPaise)}</td>
                  <td className="tabular py-2 text-right">{money(l.creditPaise)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold"><td className="py-2 text-right text-ink-2">Total</td><td className="tabular py-2 text-right">{formatINR(dr)}</td><td className="tabular py-2 text-right">{formatINR(cr)}</td></tr>
            </tfoot>
          </table>
          {data.reversalOf && <p className="text-[13px] text-ink-2">Reverses {data.reversalOf.entryNo}</p>}
          {data.reversedBy.length > 0 && <p className="text-[13px] text-ink-2">Reversed by {data.reversedBy.map((r) => `${r.entryNo} (${formatDate(r.entryDate)})`).join(', ')}</p>}
        </div>
      )}
    </Drawer>
  )
}

/** Accounts as select options (non-group). */
export function useAccountOptions(filter?: (a: { isBank: boolean; isCash: boolean; systemKey: string | null; accountType: string }) => boolean) {
  const { session } = useSession()
  const q = useQuery(() => api('finance:accounts'), [session?.company?.id])
  const options = useMemo(
    () => (q.data ?? []).filter((a) => !a.isGroup && a.isActive && (!filter || filter(a))).map((a) => ({ value: a.id, label: `${a.code} ${a.name}`, sublabel: a.accountType.toLowerCase(), keywords: a.systemKey ?? '' })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data]
  )
  return { ...q, options }
}
