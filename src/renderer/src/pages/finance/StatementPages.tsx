import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BalanceSheetReport, ProfitLossReport, StatementSection } from '@shared/finance'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { formatDate, formatINR } from '../../lib/format'
import { Card, ErrorBanner, PageHeader, Spinner, cx } from '../../components/ui'
import { AsOfBar, CheckPill, FinanceNav, PeriodBar, ReportActions, SummaryStrip, useAsOf, usePeriod } from './shared'

function SectionRows({ s, onAccount, indentItems = true }: { s: StatementSection; onAccount: (id: number) => void; indentItems?: boolean }) {
  return (
    <>
      <tr><td colSpan={2} className="bg-slate-50 px-4 pt-3 pb-1.5 text-[11.5px] font-bold tracking-wider text-ink-3 uppercase">{s.label}</td></tr>
      {s.items.length === 0 && <tr><td className="px-4 py-1.5 pl-8 text-[12.5px] text-ink-3 italic" colSpan={2}>None</td></tr>}
      {s.items.map((i) => (
        <tr key={`${i.code}-${i.label}`} onClick={() => i.accountId && onAccount(i.accountId)} className={cx('group', !!i.accountId && 'cursor-pointer')}>
          <td className={cx('py-1.5 pr-4 group-hover:bg-brand-50/50', indentItems ? 'pl-8' : 'pl-4')}>
            {i.code && <span className="mr-2 font-mono text-[12px] text-ink-3">{i.code}</span>}
            {i.label}
            {i.note && <span className="ml-2 text-[12px] text-ink-3">({i.note})</span>}
          </td>
          <td className={cx('tabular px-4 py-1.5 text-right group-hover:bg-brand-50/50', i.amountPaise < 0 && 'text-red-700')}>{formatINR(i.amountPaise)}</td>
        </tr>
      ))}
      <tr className="font-semibold"><td className="border-t border-slate-200 px-4 py-1.5 pl-8 text-ink-2">Total {s.label.toLowerCase()}</td><td className="tabular border-t border-slate-200 px-4 py-1.5 text-right">{formatINR(s.totalPaise)}</td></tr>
    </>
  )
}

function ResultRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <tr className={cx(strong ? 'text-[15px]' : 'text-[14px]')}>
      <td className="border-y-2 border-navy-900/80 bg-brand-50/60 px-4 py-2.5 font-bold tracking-wide text-navy-900 uppercase">{label}</td>
      <td className={cx('tabular border-y-2 border-navy-900/80 bg-brand-50/60 px-4 py-2.5 text-right font-bold', value < 0 ? 'text-red-700' : 'text-navy-900')}>{formatINR(value)}</td>
    </tr>
  )
}

export function ProfitLossPage() {
  const period = usePeriod()
  const { data, error, loading, reload } = useQuery<ProfitLossReport | null>(() => (period.ready ? api('finance:profitLoss', { from: period.from!, to: period.to! }) : Promise.resolve(null)), [period.from, period.to])
  const navigate = useNavigate()
  const goLedger = (id: number) => navigate(`/finance/ledger?account=${id}&from=${period.from}&to=${period.to}`)
  const get = (k: string) => [...(data?.income ?? []), ...(data?.expenses ?? [])].find((s) => s.key === k)!
  const pct = (v: number) => (data?.salesRevenuePaise ? `${((v / data.salesRevenuePaise) * 100).toFixed(1)}% of sales` : '')
  return (
    <div>
      <PageHeader title="Profit & Loss" description="Income and expenses by statement classification, excluding GST. Click an account to open its ledger." actions={<ReportActions params={period.ready ? { report: 'PROFIT_LOSS', from: period.from!, to: period.to! } : null} />} />
      <FinanceNav />
      <div className="mb-4"><PeriodBar period={period} /></div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <SummaryStrip
            items={[
              { label: 'Sales revenue', value: formatINR(data.salesRevenuePaise) },
              { label: `Gross profit ${pct(data.grossProfitPaise) && `· ${pct(data.grossProfitPaise)}`}`, value: formatINR(data.grossProfitPaise), tone: data.grossProfitPaise < 0 ? 'bad' : undefined },
              { label: 'Operating profit', value: formatINR(data.operatingProfitPaise), tone: data.operatingProfitPaise < 0 ? 'bad' : undefined },
              { label: data.netProfitPaise >= 0 ? 'Net profit' : 'Net loss', value: formatINR(data.netProfitPaise), tone: data.netProfitPaise >= 0 ? 'good' : 'bad' }
            ]}
          />
          <Card title={`Statement of profit and loss · ${formatDate(data.from)} – ${formatDate(data.to)}`} bodyClassName="p-0" className="max-w-[900px]">
            <table className="w-full text-[13.5px]">
              <tbody>
                <SectionRows s={get('SALES')} onAccount={goLedger} />
                <SectionRows s={get('COGS')} onAccount={goLedger} />
                <SectionRows s={get('DIRECT_EXPENSE')} onAccount={goLedger} />
                <ResultRow label="Gross profit" value={data.grossProfitPaise} />
                <SectionRows s={get('INDIRECT_EXPENSE')} onAccount={goLedger} />
                <SectionRows s={get('ADMIN_EXPENSE')} onAccount={goLedger} />
                <ResultRow label="Operating profit" value={data.operatingProfitPaise} />
                <SectionRows s={get('OTHER_INCOME')} onAccount={goLedger} />
                <SectionRows s={get('FINANCE_EXPENSE')} onAccount={goLedger} />
                <ResultRow label={data.netProfitPaise >= 0 ? 'Net profit' : 'Net loss'} value={data.netProfitPaise} strong />
              </tbody>
            </table>
            <p className="px-4 py-3 text-[12px] text-ink-3">
              Sales revenue is net of returns and credit notes. Stocked purchases are capitalised to inventory and expensed as cost of goods sold when sold. Total income {formatINR(data.totalIncomePaise)} − total expenses {formatINR(data.totalExpensesPaise)} = {formatINR(data.netProfitPaise)}.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

export function BalanceSheetPage() {
  const { asOf, set } = useAsOf()
  const { data, error, loading, reload } = useQuery<BalanceSheetReport>(() => api('finance:balanceSheet', { asOf }), [asOf])
  const navigate = useNavigate()
  const goLedger = (id: number) => navigate(`/finance/ledger?account=${id}&from=${data?.fyFrom ?? asOf}&to=${asOf}`)
  const Column = ({ title, groups, total }: { title: string; groups: Array<{ heading?: string; sections: StatementSection[]; total?: number }>; total: number }) => (
    <Card title={title} bodyClassName="p-0">
      <table className="w-full text-[13.5px]">
        <tbody>
          {groups.map((g, gi) => (
            <Fragment key={gi}>
              {g.heading && <tr><td colSpan={2} className="border-b border-line px-4 pt-4 pb-2 text-[13px] font-bold text-ink">{g.heading}</td></tr>}
              {g.sections.map((s) => <SectionRows key={s.key} s={s} onAccount={goLedger} />)}
              {g.total !== undefined && (
                <tr className="font-bold"><td className="border-t-2 border-slate-300 px-4 py-2">Total {g.heading?.toLowerCase()}</td><td className="tabular border-t-2 border-slate-300 px-4 py-2 text-right">{formatINR(g.total)}</td></tr>
              )}
            </Fragment>
          ))}
          <ResultRow label={`Total ${title.toLowerCase()}`} value={total} strong />
        </tbody>
      </table>
    </Card>
  )
  return (
    <div>
      <PageHeader title="Balance Sheet" description="Assets, liabilities and equity as of a date. Current-year profit and earlier years' retained earnings are derived from the ledger." actions={<ReportActions params={{ report: 'BALANCE_SHEET', asOf }} />} />
      <FinanceNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <AsOfBar asOf={asOf} onChange={set} />
        {data && <CheckPill ok={data.balanced} okText={`Assets = Liabilities + Equity (${formatINR(data.totalAssetsPaise)})`} badText={`Out of balance by ${formatINR(data.differencePaise)}`} />}
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <p className="mb-3 text-[12.5px] text-ink-3">FY {data.financialYear} · as of {formatDate(data.asOf)} · current-year profit counted from {formatDate(data.fyFrom)}</p>
          <div className="grid grid-cols-2 items-start gap-4">
            <Column title="Assets" groups={[{ sections: data.assets }]} total={data.totalAssetsPaise} />
            <Column title="Liabilities & Equity" groups={[{ heading: 'Liabilities', sections: data.liabilities, total: data.totalLiabilitiesPaise }, { heading: 'Equity', sections: data.equity, total: data.totalEquityPaise }]} total={data.totalLiabilitiesPaise + data.totalEquityPaise} />
          </div>
          {!data.balanced && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] font-semibold text-red-800">The balance sheet does not balance: Assets − (Liabilities + Equity) = {formatINR(data.differencePaise)}. Run the auditor's integrity checks.</p>}
        </>
      )}
    </div>
  )
}
