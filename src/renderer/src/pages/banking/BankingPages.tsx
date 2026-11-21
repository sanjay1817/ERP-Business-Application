import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CheckCheck, ClipboardPaste, Landmark, Link2, Lock, Plus, Trash2, Unlink, Wallet, Wand2 } from 'lucide-react'
import type { BankingOverview } from '@shared/types'
import type { BankRecDetail, BankRecRow, BookItem, CashBookReport } from '@shared/finance'
import { toPaise } from '@shared/money'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatINR, titleCase } from '../../lib/format'
import { Badge, Button, Card, DataTable, EmptyState, ErrorBanner, Field, Input, PageHeader, Spinner, cx } from '../../components/ui'
import { Modal } from '../../components/Modal'
import { SearchSelect } from '../../components/SearchSelect'
import { BankingNav, CheckPill, JournalDrawer, PeriodBar, ReportActions, SummaryStrip, money, useAccountOptions, usePeriod } from '../finance/shared'

const today = () => new Date().toISOString().slice(0, 10)

// ───────────────────────── Overview ─────────────────────────

export function BankingOverviewPage() {
  const { session } = useSession()
  const { data, error, loading, reload } = useQuery<BankingOverview>(() => api('banking:overview'), [session?.company?.id])
  const recs = useQuery<BankRecRow[]>(() => api('bankrec:list'), [session?.company?.id])
  if (loading && !data) return <Spinner />
  return (
    <div>
      <PageHeader title="Banking" description="Cash and bank balances from the ledger, cash and bank books, and bank reconciliation." />
      <BankingNav />
      <ErrorBanner error={error} onRetry={reload} />
      <div className="mb-4 grid grid-cols-3 gap-4">
        {(data?.accounts ?? []).map((a) => {
          const last = recs.data?.find((r) => r.accountId === a.id && r.status === 'COMPLETED')
          const cash = a.code === '1100'
          return (
            <Link key={a.id} to={cash ? '/banking/cash-book' : `/banking/bank-book?account=${a.id}`} className="rounded-xl border border-line bg-white p-4 transition hover:border-brand-500/40 hover:shadow-md">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">{cash ? <Wallet className="size-4" /> : <Landmark className="size-4" />}{a.name}</div>
              <p className="tabular mt-2 text-[22px] font-bold text-ink">{formatINR(a.balancePaise)}</p>
              <p className="mt-1 text-[12px] text-ink-3">{cash ? 'Cash book' : last ? `Reconciled to ${formatDate(last.statementDate)}` : 'Not reconciled yet'}</p>
            </Link>
          )
        })}
      </div>
      <Card title="Receipts & payments" bodyClassName="p-0">
        <DataTable
          rows={data?.transactions ?? []}
          rowKey={(r) => `${r.kind}-${r.id}`}
          maxHeight="max-h-[calc(100vh-430px)]"
          columns={[
            { key: 'no', header: 'Number', render: (r) => <Link to={r.kind === 'RECEIPT' ? `/sales/receipts/${r.id}` : `/purchase/payments/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.number}</Link>, sortValue: (r) => r.number },
            { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date },
            { key: 'kind', header: 'Type', render: (r) => (r.kind === 'RECEIPT' ? <Badge tone="green">Receipt</Badge> : <Badge tone="amber">Payment</Badge>) },
            { key: 'party', header: 'Party', render: (r) => r.party },
            { key: 'mode', header: 'Mode', render: (r) => titleCase(r.mode) },
            { key: 'acc', header: 'Account', render: (r) => <span className="text-ink-2">{r.account}</span> },
            { key: 'ref', header: 'Reference', render: (r) => <span className="font-mono text-[12.5px]">{r.reference ?? '—'}</span> },
            { key: 'amt', header: 'Amount', align: 'right', render: (r) => <span className={r.kind === 'RECEIPT' ? 'font-semibold text-emerald-700' : 'font-semibold'}>{r.kind === 'RECEIPT' ? '+' : '−'}{formatINR(r.amountPaise)}</span>, sortValue: (r) => r.amountPaise }
          ]}
        />
      </Card>
    </div>
  )
}

// ───────────────────────── Cash book / bank book ─────────────────────────

export function CashBankBookPage({ kind }: { kind: 'CASH' | 'BANK' }) {
  const period = usePeriod()
  const accounts = useAccountOptions((a) => a.isBank && (kind === 'CASH' ? a.isCash : !a.isCash))
  const paramId = Number(period.params.get('account')) || null
  const accountId = paramId ?? accounts.data?.find((a) => (kind === 'CASH' ? a.isCash : a.isBank && !a.isCash))?.id ?? null
  const { data, error, loading, reload } = useQuery<CashBookReport | null>(
    () => (period.ready && accountId ? api('finance:cashBook', { accountId, from: period.from!, to: period.to! }) : Promise.resolve(null)),
    [accountId, period.from, period.to]
  )
  const [journal, setJournal] = useState<number | null>(null)
  const navigate = useNavigate()
  const cash = kind === 'CASH'
  return (
    <div>
      <PageHeader
        title={cash ? 'Cash Book' : 'Bank Book'}
        description={cash ? 'Cash receipts and payments with contra entries (cash deposited / withdrawn), opening and closing balance.' : 'Bank deposits and withdrawals with contra entries and clearing status from bank reconciliation.'}
        actions={<ReportActions params={period.ready && accountId ? (cash ? { report: 'CASH_BOOK', from: period.from!, to: period.to! } : { report: 'BANK_BOOK', accountId, from: period.from!, to: period.to! }) : null} />}
      />
      <BankingNav />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!cash && <SearchSelect className="w-72" options={accounts.options} value={accountId} onChange={(v) => v && period.set({ account: String(v) })} aria-label="Bank account" />}
        <PeriodBar period={period} />
      </div>
      <ErrorBanner error={error ?? accounts.error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <SummaryStrip
            items={[
              { label: 'Opening balance', value: formatINR(data.openingPaise) },
              { label: cash ? 'Receipts' : 'Deposits', value: formatINR(data.receiptsPaise) },
              { label: cash ? 'Payments' : 'Withdrawals', value: formatINR(data.paymentsPaise) },
              { label: 'Contra in / out', value: `${formatINR(data.contraInPaise)} / ${formatINR(data.contraOutPaise)}` },
              { label: 'Closing balance', value: formatINR(data.closingPaise), tone: data.closingPaise < 0 ? 'bad' : undefined }
            ]}
          />
          <Card title={data.account.name} subtitle={`${data.rows.length} entries · ${formatDate(data.from)} – ${formatDate(data.to)}`} bodyClassName="p-0">
            <div className="max-h-[calc(100vh-400px)] overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-[13px]">
                <thead className="sticky top-0 z-10">
                  <tr className="text-left text-[11.5px] tracking-wide text-ink-3 uppercase">
                    {['Date', 'Voucher', 'Voucher no.', 'Particulars', cash ? 'Receipts' : 'Deposits', cash ? 'Payments' : 'Withdrawals', 'Balance', cash ? '' : 'Bank'].map((h, i) => (
                      <th key={i} className={cx('border-b border-line bg-slate-50 px-4 py-2.5 font-semibold whitespace-nowrap', i >= 4 && i <= 6 && 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-slate-50/60 font-semibold"><td colSpan={6} className="border-b border-slate-100 px-4 py-2">Opening balance</td><td className="tabular border-b border-slate-100 px-4 py-2 text-right">{formatINR(data.openingPaise)}</td><td className="border-b border-slate-100" /></tr>
                  {data.rows.map((r) => (
                    <tr key={r.lineId} onClick={() => setJournal(r.journalId)} className="group cursor-pointer">
                      <td className="border-b border-slate-100 px-4 py-2 whitespace-nowrap group-hover:bg-brand-50/50">{formatDate(r.date)}</td>
                      <td className="border-b border-slate-100 px-4 py-2 whitespace-nowrap group-hover:bg-brand-50/50">{r.isContra ? <Badge tone="violet">{r.voucherType}</Badge> : r.voucherType}</td>
                      <td className="border-b border-slate-100 px-4 py-2 font-mono whitespace-nowrap group-hover:bg-brand-50/50">{r.route ? <button onClick={(e) => { e.stopPropagation(); navigate(r.route!) }} className="font-semibold text-brand-700 hover:underline">{r.voucherNo}</button> : r.voucherNo}</td>
                      <td className="border-b border-slate-100 px-4 py-2 group-hover:bg-brand-50/50">{r.particulars}</td>
                      <td className="tabular border-b border-slate-100 px-4 py-2 text-right text-emerald-700 group-hover:bg-brand-50/50">{money(r.receiptPaise)}</td>
                      <td className="tabular border-b border-slate-100 px-4 py-2 text-right group-hover:bg-brand-50/50">{money(r.paymentPaise)}</td>
                      <td className="tabular border-b border-slate-100 px-4 py-2 text-right font-semibold group-hover:bg-brand-50/50">{formatINR(r.balancePaise)}</td>
                      <td className="border-b border-slate-100 px-4 py-2 group-hover:bg-brand-50/50">{!cash && (r.cleared ? <Badge tone="green">Cleared</Badge> : <Badge>Uncleared</Badge>)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                  <tr>
                    <td colSpan={4} className="border-t border-line px-4 py-2.5">Closing balance</td>
                    <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.receiptsPaise)}</td>
                    <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.paymentsPaise)}</td>
                    <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.closingPaise)}</td>
                    <td className="border-t border-line" />
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

// ───────────────────────── Bank reconciliation ─────────────────────────

export function ReconciliationListPage() {
  const { can, session } = useSession()
  const { data, error, loading, reload } = useQuery<BankRecRow[]>(() => api('bankrec:list'), [session?.company?.id])
  const banks = useAccountOptions((a) => a.isBank && !a.isCash)
  const navigate = useNavigate()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ accountId: null as number | null, statementDate: today(), balance: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    setErrors({})
    try {
      let bal: number
      try {
        bal = toPaise(form.balance || 'x')
      } catch {
        setErrors({ statementBalancePaise: 'Enter the closing balance shown on the statement' })
        return
      }
      const r = await api('bankrec:create', { accountId: form.accountId ?? 0, statementDate: form.statementDate, statementBalancePaise: bal })
      toast('success', 'Reconciliation started')
      navigate(`/banking/reconciliation/${r.id}`)
    } catch (e) {
      const err = e as { message: string; fieldErrors?: Record<string, string> }
      setErrors(err.fieldErrors ?? { _: err.message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <PageHeader title="Bank Reconciliation" description="Match the bank statement with the books. Reconciliation records which entries the bank has cleared; it never changes posted transactions." actions={can('finance.manage') && <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Start reconciliation</Button>} />
      <BankingNav />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/banking/reconciliation/${r.id}`)}
            empty={<EmptyState title="No reconciliations yet" message="Start one with the closing balance from your bank statement." />}
            columns={[
              { key: 'acc', header: 'Bank account', render: (r) => <span className="font-semibold text-ink">{r.accountName}</span> },
              { key: 'date', header: 'Statement date', render: (r) => formatDate(r.statementDate), sortValue: (r) => r.statementDate },
              { key: 'sb', header: 'Statement balance', align: 'right', render: (r) => formatINR(r.statementBalancePaise) },
              { key: 'bb', header: 'Book balance', align: 'right', render: (r) => (r.bookBalancePaise === null ? '—' : formatINR(r.bookBalancePaise)) },
              { key: 'st', header: 'Status', render: (r) => (r.status === 'COMPLETED' ? <Badge tone="green"><Lock className="size-3" /> Completed</Badge> : <Badge tone="amber">In progress</Badge>) },
              { key: 'at', header: 'Completed', render: (r) => <span className="text-ink-3">{r.completedAt ? formatDateTime(r.completedAt) : '—'}</span> }
            ]}
          />
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Start bank reconciliation" subtitle="Use the closing balance printed on the bank statement" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} onClick={() => void start()}>Start</Button></>}>
        {errors._ && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{errors._}</p>}
        <div className="space-y-3">
          <Field label="Bank account" required error={errors.accountId}><SearchSelect options={banks.options} value={form.accountId} onChange={(v) => setForm({ ...form, accountId: v })} invalid={!!errors.accountId} aria-label="Bank account" /></Field>
          <Field label="Statement date" required error={errors.statementDate}><Input type="date" max={today()} value={form.statementDate} onChange={(e) => setForm({ ...form, statementDate: e.target.value })} invalid={!!errors.statementDate} /></Field>
          <Field label="Closing balance as per statement (₹)" required error={errors.statementBalancePaise} hint="Use a minus sign for an overdrawn account"><Input inputMode="decimal" className="text-right tabular" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} invalid={!!errors.statementBalancePaise} /></Field>
        </div>
      </Modal>
    </div>
  )
}

function BookList({ title, items, onPick, picked, onTick, canEdit }: { title: string; items: BookItem[]; onPick: (b: BookItem) => void; picked: number | null; onTick: (b: BookItem) => void; canEdit: boolean }) {
  return (
    <Card title={title} subtitle={`${items.length} · ${formatINR(items.reduce((s, b) => s + b.amountPaise, 0))}`} bodyClassName="p-0">
      {items.length === 0 ? <p className="py-8 text-center text-[13px] text-ink-3">All cleared</p> : (
        <ul className="max-h-[300px] divide-y divide-slate-100 overflow-auto">
          {items.map((b) => (
            <li key={b.journalLineId} className={cx('flex items-center gap-3 px-4 py-2', picked === b.journalLineId && 'bg-brand-50')}>
              <button disabled={!canEdit} onClick={() => onPick(b)} className="min-w-0 flex-1 text-left disabled:cursor-default">
                <span className="block text-[13px] font-semibold text-ink">{b.voucherNo ?? b.entryNo} <span className="font-normal text-ink-3">· {formatDate(b.date)} · {b.voucherType}</span></span>
                <span className="block truncate text-[12px] text-ink-3">{b.particulars}</span>
              </button>
              <span className="tabular text-[13px] font-semibold">{formatINR(b.amountPaise)}</span>
              {canEdit && <button onClick={() => onTick(b)} title="Mark as cleared on the statement date" className="rounded p-1 text-ink-3 hover:bg-emerald-50 hover:text-emerald-700" aria-label={`Mark ${b.voucherNo} cleared`}><CheckCheck className="size-4" /></button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function ReconciliationPage() {
  const { id } = useParams()
  const recId = Number(id)
  const { can } = useSession()
  const toast = useToast()
  const { data, error, loading, reload } = useQuery<BankRecDetail>(() => api('bankrec:get', { id: recId }), [recId])
  const [detail, setDetail] = useState<BankRecDetail | null>(null)
  const d = detail && detail.id === recId ? detail : data
  const [picked, setPicked] = useState<number | null>(null)
  const [csvOpen, setCsvOpen] = useState(false)
  const [csv, setCsv] = useState('')
  const [record, setRecord] = useState<{ lineId: number; contra: number | null; narration: string; key: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [journal, setJournal] = useState<number | null>(null)
  const contraAccounts = useAccountOptions((a) => !a.isBank && !['AR', 'AP', 'INVENTORY'].includes(a.systemKey ?? ''))
  const canEdit = can('finance.manage') && d?.status === 'IN_PROGRESS'

  const act = async (fn: () => Promise<BankRecDetail | { matched: number; detail: BankRecDetail }>, success?: string) => {
    setBusy(true)
    try {
      const r = await fn()
      const next = 'detail' in r ? r.detail : r
      setDetail(next)
      if ('matched' in r) toast('success', `${r.matched} line(s) matched automatically`)
      else if (success) toast('success', success)
      return true
    } catch (e) {
      toast('error', 'Could not update the reconciliation', (e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  if (loading && !d) return <Spinner />
  if (!d) return <ErrorBanner error={error} onRetry={reload} />
  const s = d.summary
  return (
    <div>
      <PageHeader
        title={`Reconciliation · ${d.accountName}`}
        badge={d.status === 'COMPLETED' ? <Badge tone="green"><Lock className="size-3" /> Completed</Badge> : <Badge tone="amber">In progress</Badge>}
        description={`Statement as of ${formatDate(d.statementDate)}. Matching never changes posted transactions.`}
        actions={
          <>
            <ReportActions params={{ report: 'BANK_RECONCILIATION', reconciliationId: d.id }} />
            {canEdit && (
              <>
                <Button variant="secondary" icon={<ClipboardPaste className="size-4" />} onClick={() => setCsvOpen(true)}>Add statement lines</Button>
                <Button variant="secondary" icon={<Wand2 className="size-4" />} loading={busy} onClick={() => void act(() => api('bankrec:autoMatch', { id: d.id }))}>Auto-match</Button>
                <Button icon={<Lock className="size-4" />} disabled={s.status !== 'RECONCILED'} loading={busy} onClick={() => void act(() => api('bankrec:complete', { id: d.id }), 'Reconciliation completed and locked')}>Complete</Button>
              </>
            )}
          </>
        }
      />
      <BankingNav />
      <div className="mb-3 flex items-center gap-3">
        <CheckPill ok={s.status === 'RECONCILED'} okText="Statement agrees with the books" badText={s.unmatchedStatementLines ? `${s.unmatchedStatementLines} statement line(s) not in the books` : `Difference ${formatINR(s.differencePaise)}`} />
        <Link to="/banking/reconciliation" className="ml-auto text-[13px] font-semibold text-brand-700 hover:underline">← All reconciliations</Link>
      </div>
      <SummaryStrip
        items={[
          { label: 'Balance as per books', value: formatINR(s.bookBalancePaise) },
          { label: '− Deposits not credited', value: formatINR(s.unclearedDepositsPaise) },
          { label: '+ Payments not debited', value: formatINR(s.unclearedWithdrawalsPaise) },
          { label: 'Adjusted book balance', value: formatINR(s.adjustedBookBalancePaise) },
          { label: 'Statement balance', value: formatINR(s.statementBalancePaise) },
          { label: 'Difference', value: formatINR(s.differencePaise), tone: s.differencePaise === 0 ? 'good' : 'bad' }
        ]}
      />
      <div className="space-y-4">
        <Card title="Bank statement lines" subtitle={picked ? 'Now choose the statement line to match with the selected book entry' : 'Select a book entry on the right, then a statement line to match it'} bodyClassName="p-0">
          {d.statementLines.length === 0 ? <EmptyState title="No statement lines" message="Paste rows from your bank statement (CSV) to start matching." /> : (
            <table className="w-full text-[13px]">
              <thead className="bg-slate-50 text-left text-[11.5px] tracking-wide text-ink-3 uppercase"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Deposit</th><th className="px-3 py-2 text-right">Withdrawal</th><th className="px-3 py-2">Matched with</th><th className="w-24" /></tr></thead>
              <tbody>
                {d.statementLines.map((l) => (
                  <tr key={l.id} className={cx('border-b border-slate-100', !l.matched && 'bg-amber-50/40')}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(l.date)}</td>
                    <td className="px-3 py-2">{l.description}{l.reference && <span className="ml-1 font-mono text-[12px] text-ink-3">{l.reference}</span>}{l.source === 'BOOK_TICK' && <Badge className="ml-1">Ticked</Badge>}</td>
                    <td className="tabular px-3 py-2 text-right text-emerald-700">{money(l.depositPaise)}</td>
                    <td className="tabular px-3 py-2 text-right">{money(l.withdrawalPaise)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{l.matched ? <button onClick={() => setJournal(l.matched!.journalId)} className="font-mono text-[12.5px] text-brand-700 hover:underline">{l.matched.voucherNo ?? l.matched.entryNo}</button> : <Badge tone="amber">Not in books</Badge>}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {canEdit && (l.matched ? (
                        <button onClick={() => void act(() => api('bankrec:unmatch', { id: d.id, statementLineId: l.id }))} className="rounded p-1 text-ink-3 hover:bg-slate-100 hover:text-ink" title="Unmatch" aria-label="Unmatch"><Unlink className="size-4" /></button>
                      ) : (
                        <>
                          {picked && <button onClick={() => void act(() => api('bankrec:match', { id: d.id, statementLineId: l.id, journalLineId: picked })).then((ok) => ok && setPicked(null))} className="rounded p-1 text-brand-700 hover:bg-brand-50" title="Match with selected book entry" aria-label="Match"><Link2 className="size-4" /></button>}
                          <button onClick={() => setRecord({ lineId: l.id, contra: null, narration: l.description, key: crypto.randomUUID() })} className="rounded px-1.5 py-0.5 text-[12px] font-semibold text-brand-700 hover:bg-brand-50" title="Record this bank-only item in the books">Record</button>
                          <button onClick={() => void act(() => api('bankrec:deleteLine', { id: d.id, statementLineId: l.id }))} className="rounded p-1 text-ink-3 hover:bg-red-50 hover:text-red-600" title="Delete line" aria-label="Delete line"><Trash2 className="size-4" /></button>
                        </>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <div className="grid grid-cols-2 items-start gap-4">
          <BookList title="Deposits in books, not on statement" items={d.unclearedDeposits} picked={picked} canEdit={!!canEdit} onPick={(b) => setPicked(picked === b.journalLineId ? null : b.journalLineId)} onTick={(b) => void act(() => api('bankrec:tick', { id: d.id, journalLineId: b.journalLineId, clearedDate: d.statementDate }))} />
          <BookList title="Payments in books, not on statement" items={d.unclearedWithdrawals} picked={picked} canEdit={!!canEdit} onPick={(b) => setPicked(picked === b.journalLineId ? null : b.journalLineId)} onTick={(b) => void act(() => api('bankrec:tick', { id: d.id, journalLineId: b.journalLineId, clearedDate: d.statementDate }))} />
        </div>
      </div>
      <Modal open={csvOpen} onClose={() => setCsvOpen(false)} title="Add bank statement lines" subtitle="Paste CSV rows: date, description, reference, deposit, withdrawal" width="max-w-2xl" footer={<><Button variant="secondary" onClick={() => setCsvOpen(false)}>Cancel</Button><Button loading={busy} disabled={!csv.trim()} onClick={() => void act(() => api('bankrec:addLines', { id: d.id, csv }), 'Statement lines added').then((ok) => ok && (setCsvOpen(false), setCsv('')))}>Add lines</Button></>}>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={10} className="w-full rounded-lg border border-line p-3 font-mono text-[12.5px] focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none" placeholder={'Date,Description,Reference,Deposit,Withdrawal\n02/11/2026,NEFT from Vertex Software,UTR123456,25000.00,\n03/11/2026,Cheque 000418,,,15000.00'} aria-label="Statement CSV" />
        <p className="mt-2 text-[12px] text-ink-3">Dates as YYYY-MM-DD or DD/MM/YYYY. Each row has either a deposit or a withdrawal. Lines must be on or before {formatDate(d.statementDate)}.</p>
      </Modal>
      <Modal open={!!record} onClose={() => setRecord(null)} title="Record bank-only item in the books" subtitle="Posts a new voucher dated as on the statement line and matches it. Existing entries are not changed." footer={<><Button variant="secondary" onClick={() => setRecord(null)}>Cancel</Button><Button loading={busy} disabled={!record?.contra || (record?.narration.trim().length ?? 0) < 3} onClick={() => record && void act(() => api('bankrec:record', { id: d.id, statementLineId: record.lineId, contraAccountId: record.contra!, narration: record.narration, requestKey: record.key }), 'Recorded in the books and matched').then((ok) => ok && setRecord(null))}>Post and match</Button></>}>
        {record && (
          <div className="space-y-3">
            <Field label="Account (e.g. Bank Charges, Interest Income)" required><SearchSelect options={contraAccounts.options} value={record.contra} onChange={(v) => setRecord({ ...record, contra: v })} aria-label="Contra account" /></Field>
            <Field label="Narration" required><Input value={record.narration} onChange={(e) => setRecord({ ...record, narration: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
    </div>
  )
}

