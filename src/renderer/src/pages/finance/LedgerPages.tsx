import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AccountRow, DayBookEntry, LedgerReport, TrialBalanceReport } from '@shared/finance'
import { REPORT_GROUP_LABELS } from '@shared/finance'
import type { Customer, Supplier } from '@shared/types'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { formatDate, formatINR, titleCase } from '../../lib/format'
import { Badge, Card, DataTable, EmptyState, ErrorBanner, PageHeader, SearchInput, Spinner, cx } from '../../components/ui'
import { SearchSelect } from '../../components/SearchSelect'
import { CheckPill, DrCr, FinanceNav, JournalDrawer, PeriodBar, ReportActions, SummaryStrip, money, useAccountOptions, usePeriod } from './shared'

// ───────────────────────── General ledger ─────────────────────────

export function GeneralLedgerPage() {
  const period = usePeriod()
  const accountId = Number(period.params.get('account')) || null
  const partyType = (period.params.get('partyType') as 'CUSTOMER' | 'SUPPLIER' | null) ?? undefined
  const partyId = Number(period.params.get('partyId')) || undefined
  const accounts = useAccountOptions()
  const account = accounts.data?.find((a) => a.id === accountId)
  const partySide = account?.systemKey === 'AR' ? 'CUSTOMER' : account?.systemKey === 'AP' ? 'SUPPLIER' : null
  const { can } = useSession()
  const parties = useQuery<Array<Customer | Supplier>>(
    () => (partySide === 'CUSTOMER' && can('customer.view') ? api('customer:list', {}) : partySide === 'SUPPLIER' && can('supplier.view') ? api('supplier:list', {}) : Promise.resolve([])),
    [partySide]
  )
  const { data, error, loading, reload } = useQuery<LedgerReport | null>(
    () => (period.ready && accountId ? api('finance:ledger', { accountId, from: period.from!, to: period.to!, ...(partyType && partyId ? { partyType, partyId } : {}) }) : Promise.resolve(null)),
    [accountId, period.from, period.to, partyType, partyId]
  )
  const [journal, setJournal] = useState<number | null>(null)
  const navigate = useNavigate()
  return (
    <div>
      <PageHeader
        title="General Ledger"
        description="Account-wise ledger with opening balance, every posted entry and a running balance. Click an entry to inspect its journal and open the source document."
        actions={<ReportActions params={accountId && period.ready ? { report: 'GENERAL_LEDGER', accountId, from: period.from!, to: period.to! } : null} />}
      />
      <FinanceNav />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchSelect className="w-80" options={accounts.options} value={accountId} onChange={(v) => period.set({ account: v ? String(v) : undefined, partyType: undefined, partyId: undefined })} placeholder="Select an account…" aria-label="Account" />
        {partySide && (
          <SearchSelect
            className="w-72"
            clearable
            options={(parties.data ?? []).map((p) => ({ value: p.id, label: p.name, sublabel: p.code }))}
            value={partyId ?? null}
            onChange={(v) => period.set({ partyType: v ? partySide : undefined, partyId: v ? String(v) : undefined })}
            placeholder={`All ${partySide === 'CUSTOMER' ? 'customers' : 'suppliers'}`}
            aria-label="Party"
          />
        )}
        <PeriodBar period={period} />
      </div>
      <ErrorBanner error={error ?? accounts.error} onRetry={reload} />
      {!accountId ? (
        <Card><EmptyState title="Choose an account" message="Select a ledger account above to see its entries for the period." /></Card>
      ) : loading && !data ? <Spinner /> : data && (
        <>
          <SummaryStrip
            items={[
              { label: 'Opening balance', value: <DrCr paise={data.openingPaise} /> },
              { label: 'Debits', value: formatINR(data.debitPaise) },
              { label: 'Credits', value: formatINR(data.creditPaise) },
              { label: 'Closing balance', value: <DrCr paise={data.closingPaise} /> }
            ]}
          />
          <Card
            title={`${data.account.code} ${data.account.name}${data.party ? ` — ${data.party.name}` : ''}`}
            subtitle={`${titleCase(data.account.accountType)}${data.account.reportGroup ? ` · ${REPORT_GROUP_LABELS[data.account.reportGroup]}` : ''} · ${data.lines.length} entries${data.account.accountType === 'INCOME' || data.account.accountType === 'EXPENSE' ? ' · income/expense accounts open at zero each financial year' : ''}`}
            bodyClassName="p-0"
          >
            <div className="max-h-[calc(100vh-380px)] overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-[13px]">
                <thead className="sticky top-0 z-10">
                  <tr className="text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
                    {['Date', 'Voucher', 'Particulars / narration', 'Debit', 'Credit', 'Balance'].map((h, i) => (
                      <th key={h} className={cx('border-b border-line bg-slate-50 px-4 py-2.5 font-semibold whitespace-nowrap', i >= 3 && 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-slate-50/60 font-semibold"><td className="border-b border-slate-100 px-4 py-2" colSpan={5}>Opening balance on {formatDate(data.from)}</td><td className="border-b border-slate-100 px-4 py-2 text-right"><DrCr paise={data.openingPaise} /></td></tr>
                  {data.lines.map((l) => (
                    <tr key={l.lineId} onClick={() => setJournal(l.journalId)} className="group cursor-pointer">
                      <td className="border-b border-slate-100 px-4 py-2 whitespace-nowrap group-hover:bg-brand-50/50">{formatDate(l.date)}</td>
                      <td className="border-b border-slate-100 px-4 py-2 whitespace-nowrap group-hover:bg-brand-50/50">
                        <span className="block font-mono">
                          {l.route ? <button onClick={(e) => { e.stopPropagation(); navigate(l.route!) }} className="font-semibold text-brand-700 hover:underline">{l.voucherNo}</button> : l.voucherNo}
                        </span>
                        <span className="block text-[12px]">{l.isCancellation ? <Badge tone="red">{l.voucherType}</Badge> : <span className="text-ink-3">{l.voucherType}</span>}</span>
                      </td>
                      <td className="border-b border-slate-100 px-4 py-2 group-hover:bg-brand-50/50">
                        <div className="max-w-[340px] min-w-[200px]">
                          <span className="block text-ink">{l.particulars}</span>
                          {l.narration && <span className="block truncate text-[12px] text-ink-3" title={l.narration}>{l.narration}</span>}
                        </div>
                      </td>
                      <td className="tabular border-b border-slate-100 px-4 py-2 text-right group-hover:bg-brand-50/50">{money(l.debitPaise)}</td>
                      <td className="tabular border-b border-slate-100 px-4 py-2 text-right group-hover:bg-brand-50/50">{money(l.creditPaise)}</td>
                      <td className="border-b border-slate-100 px-4 py-2 text-right group-hover:bg-brand-50/50"><DrCr paise={l.balancePaise} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                  <tr>
                    <td className="border-t border-line px-4 py-2.5" colSpan={3}>Closing balance on {formatDate(data.to)}</td>
                    <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.debitPaise)}</td>
                    <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.creditPaise)}</td>
                    <td className="border-t border-line px-4 py-2.5 text-right"><DrCr paise={data.closingPaise} /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
    </div>
  )
}

// ───────────────────────── Trial balance ─────────────────────────

export function TrialBalancePage() {
  const period = usePeriod()
  const { data, error, loading, reload } = useQuery<TrialBalanceReport | null>(() => (period.ready ? api('finance:trialBalanceReport', { from: period.from!, to: period.to! }) : Promise.resolve(null)), [period.from, period.to])
  const navigate = useNavigate()
  const th = 'border-b border-line bg-slate-50 px-3 py-2 text-[11px] font-semibold tracking-wide whitespace-nowrap text-ink-3 uppercase'
  const td = 'tabular border-b border-slate-100 px-3 py-2 text-right group-hover:bg-brand-50/50'
  return (
    <div>
      <PageHeader title="Trial Balance" description="Opening, period and closing balances of every account. Only posted entries are included; drafts are excluded." actions={<ReportActions params={period.ready ? { report: 'TRIAL_BALANCE', from: period.from!, to: period.to! } : null} />} />
      <FinanceNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <PeriodBar period={period} />
        {data && <CheckPill ok={data.balanced} okText="Balanced: debits equal credits" badText="NOT balanced — see difference row" />}
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <Card bodyClassName="p-0" subtitle={data.priorYearsProfitPaise ? `Profit of earlier years (${formatINR(data.priorYearsProfitPaise)}) is carried into Retained Earnings; income and expense accounts open at zero for FY ${data.financialYear}.` : `Income and expense accounts open at zero for FY ${data.financialYear}.`} title={`${formatDate(data.from)} – ${formatDate(data.to)}`}>
          <div className="max-h-[calc(100vh-330px)] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className={cx(th, 'text-left')} rowSpan={2}>Code</th>
                  <th className={cx(th, 'text-left')} rowSpan={2}>Account</th>
                  <th className={cx(th, 'text-center')} colSpan={2}>Opening</th>
                  <th className={cx(th, 'text-center')} colSpan={2}>Period</th>
                  <th className={cx(th, 'text-center')} colSpan={2}>Closing</th>
                </tr>
                <tr>{['Debit', 'Credit', 'Debit', 'Credit', 'Debit', 'Credit'].map((h, i) => <th key={i} className={cx(th, 'text-right')}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.accountId ?? r.name} onClick={() => r.accountId && navigate(`/finance/ledger?account=${r.accountId}&from=${data.from}&to=${data.to}`)} className={cx('group', !!r.accountId && 'cursor-pointer')}>
                    <td className="border-b border-slate-100 px-3 py-2 font-mono text-ink-3 group-hover:bg-brand-50/50">{r.code}</td>
                    <td className="border-b border-slate-100 px-3 py-2 group-hover:bg-brand-50/50">
                      <span className="font-semibold text-ink">{r.name}</span> <span className="text-[11.5px] text-ink-3">{titleCase(r.accountType)}</span>
                    </td>
                    <td className={td}>{money(r.openingDebitPaise)}</td>
                    <td className={td}>{money(r.openingCreditPaise)}</td>
                    <td className={td}>{money(r.periodDebitPaise)}</td>
                    <td className={td}>{money(r.periodCreditPaise)}</td>
                    <td className={cx(td, 'font-semibold')}>{money(r.closingDebitPaise)}</td>
                    <td className={cx(td, 'font-semibold')}>{money(r.closingCreditPaise)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-50 font-bold">
                <tr>
                  <td className="border-t border-line px-3 py-2.5" colSpan={2}>Total</td>
                  {[data.totals.openingDebitPaise, data.totals.openingCreditPaise, data.totals.periodDebitPaise, data.totals.periodCreditPaise, data.totals.closingDebitPaise, data.totals.closingCreditPaise].map((v, i) => (
                    <td key={i} className="tabular border-t border-line px-3 py-2.5 text-right">{formatINR(v)}</td>
                  ))}
                </tr>
                {!data.balanced && (
                  <tr className="text-red-700">
                    <td className="px-3 py-2" colSpan={2}>Difference (debit − credit)</td>
                    <td className="tabular px-3 py-2 text-right" colSpan={2}>{formatINR(data.differences.openingPaise)}</td>
                    <td className="tabular px-3 py-2 text-right" colSpan={2}>{formatINR(data.differences.periodPaise)}</td>
                    <td className="tabular px-3 py-2 text-right" colSpan={2}>{formatINR(data.differences.closingPaise)}</td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ───────────────────────── Day book ─────────────────────────

export function DayBookPage() {
  const period = usePeriod()
  const { data, error, loading, reload } = useQuery<DayBookEntry[] | null>(() => (period.ready ? api('finance:dayBook', { from: period.from!, to: period.to! }) : Promise.resolve(null)), [period.from, period.to])
  const [search, setSearch] = useState('')
  const [journal, setJournal] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = [...(data ?? [])].reverse()
    if (!q) return list
    return list.filter((e) => `${e.entryNo} ${e.voucherNo ?? ''} ${e.voucherType} ${e.narration ?? ''} ${e.lines.map((l) => `${l.accountName} ${l.party ?? ''}`).join(' ')}`.toLowerCase().includes(q))
  }, [data, search])
  const total = rows.reduce((s, e) => s + e.amountPaise, 0)
  return (
    <div>
      <PageHeader title="Day Book" description="Every posted journal entry in date order — sales, purchases, receipts, payments, notes, vouchers and reversals." actions={<ReportActions params={period.ready ? { report: 'DAY_BOOK', from: period.from!, to: period.to! } : null} />} />
      <FinanceNav />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PeriodBar period={period} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search voucher, account, party, narration…" className="w-80" />
        <span className="ml-auto text-[12.5px] text-ink-3">{rows.length} entries · {formatINR(total)}</span>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : (
        <Card bodyClassName="p-0">
          {rows.length === 0 ? <EmptyState title="No entries" message="No journal entries match this period and search." /> : (
            <div className="max-h-[calc(100vh-300px)] overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-slate-50 text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
                  <tr><th className="px-4 py-2.5">Date</th><th className="px-4 py-2.5">Voucher</th><th className="px-4 py-2.5">Voucher no.</th><th className="px-4 py-2.5">Entry</th><th className="px-4 py-2.5">Narration</th><th className="px-4 py-2.5 text-right">Amount</th></tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <Fragment key={e.journalId}>
                      <tr onClick={() => setExpanded(expanded === e.journalId ? null : e.journalId)} className="cursor-pointer border-b border-slate-100 hover:bg-brand-50/50">
                        <td className="px-4 py-2.5 whitespace-nowrap">{formatDate(e.date)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap">{e.isCancellation ? <Badge tone="red">{e.voucherType}</Badge> : <Badge tone="blue">{e.voucherType}</Badge>}{e.status === 'REVERSED' && <Badge tone="amber" className="ml-1">Reversed</Badge>}</td>
                        <td className="px-4 py-2.5 font-mono font-semibold whitespace-nowrap">{e.route ? <Link to={e.route} onClick={(ev) => ev.stopPropagation()} className="text-brand-700 hover:underline">{e.voucherNo}</Link> : (e.voucherNo ?? '—')}</td>
                        <td className="px-4 py-2.5 font-mono text-ink-3 whitespace-nowrap"><button onClick={(ev) => { ev.stopPropagation(); setJournal(e.journalId) }} className="hover:text-brand-700 hover:underline">{e.entryNo}</button></td>
                        <td className="px-4 py-2.5 text-ink-2">{e.narration}</td>
                        <td className="tabular px-4 py-2.5 text-right font-semibold">{formatINR(e.amountPaise)}</td>
                      </tr>
                      {expanded === e.journalId && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={6} className="px-10 py-2.5">
                            <table className="w-full text-[12.5px]">
                              <tbody>
                                {e.lines.map((l, i) => (
                                  <tr key={i}>
                                    <td className={cx('py-1', l.creditPaise ? 'pl-8' : '')}><span className="font-mono text-ink-3">{l.accountCode}</span> {l.accountName}{l.party && <span className="text-ink-3"> · {l.party}</span>}</td>
                                    <td className="tabular w-36 py-1 text-right">{money(l.debitPaise)}</td>
                                    <td className="tabular w-36 py-1 text-right">{money(l.creditPaise)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
    </div>
  )
}

// ───────────────────────── Chart of accounts ─────────────────────────

const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const
const TYPE_LABEL: Record<(typeof TYPE_ORDER)[number], string> = { ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity', INCOME: 'Income', EXPENSE: 'Expenses' }

export function ChartOfAccountsPage() {
  const { session } = useSession()
  const { data, error, loading, reload } = useQuery<AccountRow[]>(() => api('finance:accounts'), [session?.company?.id])
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const rows = (data ?? []).filter((a) => !search || `${a.code} ${a.name} ${a.reportGroup ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <div>
      <PageHeader title="Chart of Accounts" description="Ledger accounts and how each is classified in the profit & loss and balance sheet." />
      <FinanceNav />
      <div className="mb-4"><SearchInput value={search} onChange={setSearch} placeholder="Search code, name or classification…" className="w-80" /></div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : (
        <div className="space-y-4">
          {TYPE_ORDER.map((t) => {
            const list = rows.filter((a) => a.accountType === t && !a.isGroup)
            if (!list.length) return null
            return (
              <Card key={t} title={TYPE_LABEL[t]} bodyClassName="p-0">
                <DataTable
                  rows={list}
                  rowKey={(a) => a.id}
                  maxHeight=""
                  onRowClick={(a) => navigate(`/finance/ledger?account=${a.id}`)}
                  columns={[
                    { key: 'code', header: 'Code', render: (a) => <span className="font-mono">{a.code}</span>, width: '90px', sortValue: (a) => a.code },
                    { key: 'name', header: 'Account', render: (a) => <span className="font-semibold text-ink">{a.name}</span>, sortValue: (a) => a.name },
                    { key: 'group', header: 'Statement classification', render: (a) => (a.reportGroup ? REPORT_GROUP_LABELS[a.reportGroup] : '—') },
                    { key: 'flags', header: '', render: (a) => <span className="flex gap-1">{a.isCash ? <Badge tone="amber">Cash</Badge> : a.isBank ? <Badge tone="blue">Bank</Badge> : null}{a.systemKey && <Badge>System</Badge>}{!a.isActive && <Badge tone="red">Inactive</Badge>}</span> },
                    { key: 'n', header: 'Entries', align: 'right', render: (a) => a.lineCount, sortValue: (a) => a.lineCount },
                    { key: 'bal', header: 'Balance', align: 'right', render: (a) => <DrCr paise={a.balancePaise} />, sortValue: (a) => a.balancePaise }
                  ]}
                />
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
