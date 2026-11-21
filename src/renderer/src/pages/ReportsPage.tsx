import { useSearchParams } from 'react-router-dom'
import { BookOpen, FileBarChart2, Landmark, Package, Scale, Users, type LucideIcon } from 'lucide-react'
import { REPORT_KINDS, formatReportCell, type ReportDoc, type ReportKind, type ReportParamsT } from '@shared/finance'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, cx } from '../components/ui'
import { SearchSelect } from '../components/SearchSelect'
import { AsOfBar, PeriodBar, ReportActions, useAccountOptions, usePeriod } from './finance/shared'

const GROUPS: Array<{ label: string; icon: LucideIcon; kinds: ReportKind[] }> = [
  { label: 'Books of account', icon: BookOpen, kinds: ['DAY_BOOK', 'CASH_BOOK', 'BANK_BOOK', 'GENERAL_LEDGER'] },
  { label: 'Financial statements', icon: Scale, kinds: ['TRIAL_BALANCE', 'PROFIT_LOSS', 'BALANCE_SHEET'] },
  { label: 'Receivables & payables', icon: Users, kinds: ['RECEIVABLES', 'PAYABLES'] },
  { label: 'Registers & GST', icon: FileBarChart2, kinds: ['SALES_REGISTER', 'PURCHASE_REGISTER', 'GST_SUMMARY'] },
  { label: 'Inventory', icon: Package, kinds: ['STOCK_VALUATION'] }
]

/** Renders any ReportDoc exactly as it will be exported. */
export function ReportView({ doc }: { doc: ReportDoc }) {
  const numeric = (t: string) => t === 'money' || t === 'qty' || t === 'number'
  return (
    <div>
      {doc.summary.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {doc.summary.map((s) => (
            <div key={s.label} className="rounded-lg border border-line bg-white px-3 py-2">
              <p className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{s.label}</p>
              <p className={cx('tabular text-[14px] font-bold', s.tone === 'good' ? 'text-emerald-700' : s.tone === 'bad' ? 'text-red-700' : 'text-ink')}>{s.value}</p>
            </div>
          ))}
        </div>
      )}
      <div className="max-h-[calc(100vh-360px)] overflow-auto rounded-lg border border-line">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead className="sticky top-0 z-10">
            <tr>{doc.columns.map((c) => <th key={c.key} style={{ minWidth: c.type === 'text' ? Math.min(320, (c.width ?? 16) * 7) : c.type === 'date' ? 96 : 104 }} className={cx('border-b border-line bg-navy-900 px-3 py-2 text-[11px] font-semibold tracking-wide whitespace-nowrap text-white uppercase', numeric(c.type) ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {doc.rows.map((r, i) => (
              <tr key={i} className={cx(r.style === 'group' && 'bg-slate-100', r.style === 'muted' && 'text-ink-3 italic')}>
                {doc.columns.map((c, ci) => {
                  const v = r.cells[c.key] ?? null
                  return (
                    <td
                      key={c.key}
                      style={ci === 0 && r.indent ? { paddingLeft: 12 + r.indent * 16 } : undefined}
                      className={cx(
                        'border-b border-slate-100 px-3 py-1.5',
                        numeric(c.type) ? 'tabular text-right whitespace-nowrap' : '',
                        r.style === 'group' && 'text-[11px] font-bold tracking-wide uppercase',
                        r.style === 'subtotal' && 'font-semibold',
                        r.style === 'total' && 'border-t-2 border-b-2 border-t-navy-900 border-b-navy-900 font-bold',
                        c.type === 'money' && typeof v === 'number' && v < 0 && 'text-red-700'
                      )}
                    >
                      {formatReportCell(c, v)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {doc.notes.length > 0 && <div className="mt-2 space-y-0.5 text-[12px] text-ink-3">{doc.notes.map((n) => <p key={n}>{n}</p>)}</div>}
    </div>
  )
}

export default function ReportsPage() {
  const { can } = useSession()
  const [params, setParams] = useSearchParams()
  const period = usePeriod()
  const report = (params.get('report') as ReportKind | null) ?? 'TRIAL_BALANCE'
  const cfg = REPORT_KINDS[report]
  const asOf = params.get('asOf') ?? new Date().toISOString().slice(0, 10)
  const needsAccount = report === 'GENERAL_LEDGER' || report === 'BANK_BOOK'
  const accounts = useAccountOptions(report === 'BANK_BOOK' ? (a) => a.isBank && !a.isCash : undefined)
  const accountId = Number(params.get('account')) || (report === 'BANK_BOOK' ? accounts.data?.find((a) => a.isBank && !a.isCash)?.id ?? null : null)
  const allowed = (k: ReportKind) => can('reports.view') && can(REPORT_KINDS[k].permission)
  const p: ReportParamsT | null =
    cfg.period === 'range'
      ? period.ready && (!needsAccount || accountId) ? { report, from: period.from!, to: period.to!, ...(needsAccount ? { accountId: accountId! } : {}) } : null
      : { report, asOf }
  const { data, error, loading, reload } = useQuery<ReportDoc | null>(() => (p && allowed(report) ? api('report:run', p) : Promise.resolve(null)), [JSON.stringify(p)])
  const choose = (k: ReportKind) => {
    const next = new URLSearchParams(params)
    next.set('report', k)
    next.delete('account')
    setParams(next, { replace: true })
  }
  const setAsOf = (v: string) => {
    const next = new URLSearchParams(params)
    next.set('asOf', v)
    setParams(next, { replace: true })
  }
  return (
    <div>
      <PageHeader title="Financial Reports" description="Every report is calculated from posted transactions and exports to PDF and Excel exactly as previewed." actions={<ReportActions params={p} disabled={!data} />} />
      <div className="grid grid-cols-[250px_1fr] items-start gap-4">
        <Card bodyClassName="p-2">
          {GROUPS.map((g) => (
            <div key={g.label} className="mb-2">
              <p className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10.5px] font-bold tracking-[0.1em] text-ink-3 uppercase"><g.icon className="size-3.5" />{g.label}</p>
              {g.kinds.filter(allowed).map((k) => (
                <button key={k} onClick={() => choose(k)} className={cx('block w-full rounded-lg px-3 py-1.5 text-left text-[13px] font-medium', k === report ? 'bg-brand-50 text-brand-700' : 'text-ink-2 hover:bg-slate-50 hover:text-ink')}>
                  {REPORT_KINDS[k].label}
                </button>
              ))}
            </div>
          ))}
          <p className="flex items-center gap-1.5 px-3 pt-1 pb-2 text-[11.5px] text-ink-3"><Landmark className="size-3.5" />Bank reconciliation statements are printed from Banking → Reconciliation.</p>
        </Card>
        <div className="min-w-0">
          <Card bodyClassName="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {needsAccount && (
                <SearchSelect
                  className="w-72"
                  options={accounts.options}
                  value={accountId}
                  onChange={(v) => {
                    const next = new URLSearchParams(params)
                    v ? next.set('account', String(v)) : next.delete('account')
                    setParams(next, { replace: true })
                  }}
                  placeholder={report === 'BANK_BOOK' ? 'Bank account…' : 'Ledger account…'}
                  aria-label="Account"
                />
              )}
              {cfg.period === 'range' ? <PeriodBar period={period} /> : <AsOfBar asOf={asOf} onChange={setAsOf} />}
            </div>
            <ErrorBanner error={error} onRetry={reload} />
            {!allowed(report) ? <EmptyState title="Not available" message="You do not have permission for this report." /> : !p ? <EmptyState title="Choose an account" /> : loading && !data ? <Spinner label="Calculating…" /> : data && (
              <>
                <div className="mb-3 flex items-end justify-between border-b border-line pb-2">
                  <div>
                    <h2 className="text-[17px] font-bold text-ink">{data.title}</h2>
                    <p className="text-[12.5px] text-ink-3">{data.companyName} · {data.subtitle}</p>
                  </div>
                  <p className="text-[11.5px] text-ink-3">{data.rows.length} rows</p>
                </div>
                <ReportView doc={data} />
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
