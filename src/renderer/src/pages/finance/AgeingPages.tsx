import { Link, useNavigate, useParams } from 'react-router-dom'
import { AGEING_BUCKETS, AGEING_LABELS, type AgeingBucket, type AgeingReport, type PartyStatement } from '@shared/finance'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { formatDate, formatINR, titleCase } from '../../lib/format'
import { Badge, Card, DataTable, EmptyState, ErrorBanner, PageHeader, Spinner, cx } from '../../components/ui'
import { AsOfBar, CheckPill, FinanceNav, ReportActions, SummaryStrip, money, useAsOf } from './shared'

type Side = 'CUSTOMER' | 'SUPPLIER'
const ROOT: Record<Side, string> = { CUSTOMER: '/finance/receivables', SUPPLIER: '/finance/payables' }

/** Ordered buckets on one sequential hue (lightest = current, darkest = oldest). */
const BUCKET_COLOR: Record<AgeingBucket, string> = { CURRENT: '#c7dbf7', D1_30: '#8db7ee', D31_60: '#4f8fe0', D61_90: '#2463c4', D90_PLUS: '#173f80' }

function BucketBar({ buckets, total }: { buckets: Record<AgeingBucket, number>; total: number }) {
  const parts = AGEING_BUCKETS.map((b) => ({ b, v: Math.max(0, buckets[b]) }))
  const sum = parts.reduce((s, p) => s + p.v, 0)
  return (
    <div>
      {sum > 0 && (
        <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${AGEING_LABELS[p.b]} ${formatINR(p.v)}`).join(', ')}>
          {parts.filter((p) => p.v > 0).map((p) => <div key={p.b} title={`${AGEING_LABELS[p.b]}: ${formatINR(p.v)}`} style={{ width: `${(p.v / sum) * 100}%`, background: BUCKET_COLOR[p.b] }} />)}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-5 gap-3">
        {parts.map((p) => (
          <div key={p.b}>
            <dt className="flex items-center gap-1.5 text-[12px] text-ink-2"><span className="size-2.5 rounded-sm" style={{ background: BUCKET_COLOR[p.b] }} />{AGEING_LABELS[p.b]}</dt>
            <dd className="tabular mt-0.5 text-[15px] font-bold text-ink">{formatINR(buckets[p.b])}</dd>
            <dd className="text-[11.5px] text-ink-3">{total > 0 ? `${((buckets[p.b] / total) * 100).toFixed(0)}%` : '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function AgeingPage({ side }: { side: Side }) {
  const { asOf, set } = useAsOf()
  const { data, error, loading, reload } = useQuery<AgeingReport>(() => api('finance:ageing', { side, asOf }), [side, asOf])
  const navigate = useNavigate()
  const cust = side === 'CUSTOMER'
  return (
    <div>
      <PageHeader
        title={cust ? 'Accounts Receivable' : 'Accounts Payable'}
        description={cust ? 'Customer-wise outstanding, ageing by days past due, advances and credit notes — reconciled to Sundry Debtors.' : 'Supplier-wise outstanding, ageing by days past due, advances paid and debit notes — reconciled to Sundry Creditors.'}
        actions={<ReportActions params={{ report: cust ? 'RECEIVABLES' : 'PAYABLES', asOf }} />}
      />
      <FinanceNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <AsOfBar asOf={asOf} onChange={set} />
        {data && <CheckPill ok={data.agrees} okText={`Agrees with ${cust ? 'Sundry Debtors' : 'Sundry Creditors'}`} badText={`Differs from the ledger by ${formatINR(data.differencePaise)}`} />}
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : data && (
        <>
          <SummaryStrip
            items={[
              { label: 'Net outstanding', value: formatINR(data.totals.netPaise) },
              { label: 'Overdue', value: formatINR(data.totals.overduePaise), tone: data.totals.overduePaise > 0 ? 'bad' : undefined },
              { label: cust ? 'Advances / on account' : 'Advances paid', value: formatINR(data.totals.onAccountPaise) },
              { label: `${cust ? 'Sundry Debtors' : 'Sundry Creditors'} ledger`, value: formatINR(data.controlAccountPaise), tone: data.agrees ? 'good' : 'bad' }
            ]}
          />
          <Card title="Ageing" subtitle={`Open items by days past due date, as of ${formatDate(asOf)}`} className="mb-4">
            <BucketBar buckets={data.totals} total={data.totals.grossPaise} />
          </Card>
          <Card title={cust ? 'Customer-wise outstanding' : 'Supplier-wise outstanding'} bodyClassName="p-0">
            <DataTable
              rows={data.rows}
              rowKey={(r) => r.partyId}
              onRowClick={(r) => navigate(`${ROOT[side]}/${r.partyId}?asOf=${asOf}`)}
              maxHeight="max-h-[calc(100vh-520px)] min-h-[200px]"
              empty={<EmptyState title="Nothing outstanding" />}
              columns={[
                { key: 'name', header: cust ? 'Customer' : 'Supplier', render: (r) => <span><span className="font-semibold text-ink">{r.name}</span> <span className="text-[12px] text-ink-3">{r.code}</span></span>, sortValue: (r) => r.name, wrap: true },
                ...AGEING_BUCKETS.map((b) => ({ key: b, header: AGEING_LABELS[b], align: 'right' as const, render: (r: (typeof data.rows)[number]) => <span className={cx(b !== 'CURRENT' && r.buckets[b] > 0 && 'text-red-700')}>{money(r.buckets[b])}</span>, sortValue: (r: (typeof data.rows)[number]) => r.buckets[b] })),
                { key: 'onacc', header: 'On account', align: 'right', render: (r) => (r.onAccountPaise ? <span className="text-emerald-700">−{formatINR(r.onAccountPaise)}</span> : ''), sortValue: (r) => r.onAccountPaise },
                { key: 'net', header: 'Net outstanding', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.netPaise)}</span>, sortValue: (r) => r.netPaise },
                { key: 'chk', header: '', render: (r) => (r.differencePaise === 0 ? null : <Badge tone="red">Ledger differs</Badge>) }
              ]}
              footer={
                <tr>
                  <td className="border-t border-line px-4 py-2.5">Total</td>
                  {AGEING_BUCKETS.map((b) => <td key={b} className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.totals[b])}</td>)}
                  <td className="tabular border-t border-line px-4 py-2.5 text-right">−{formatINR(data.totals.onAccountPaise)}</td>
                  <td className="tabular border-t border-line px-4 py-2.5 text-right">{formatINR(data.totals.netPaise)}</td>
                  <td className="border-t border-line" />
                </tr>
              }
            />
          </Card>
        </>
      )}
    </div>
  )
}

export function PartyStatementPage({ side }: { side: Side }) {
  const { partyId } = useParams()
  const { asOf, set } = useAsOf()
  const { data, error, loading, reload } = useQuery<PartyStatement>(() => api('finance:partyStatement', { side, partyId: Number(partyId), asOf }), [side, partyId, asOf])
  const cust = side === 'CUSTOMER'
  if (loading && !data) return <Spinner />
  if (!data) return <ErrorBanner error={error} onRetry={reload} />
  const s = data.summary
  const ledgerAccountQuery = `partyType=${side}&partyId=${data.party.id}&to=${asOf}`
  return (
    <div>
      <PageHeader
        title={data.party.name}
        description={`${cust ? 'Customer' : 'Supplier'} ${data.party.code}${data.party.gstin ? ` · GSTIN ${data.party.gstin}` : ''} · ${cust ? 'credit' : 'payment'} terms ${data.party.creditDays} days${data.party.creditLimitPaise ? ` · credit limit ${formatINR(data.party.creditLimitPaise)}` : ''}`}
        actions={
          <>
            <Link to={`${ROOT[side]}?asOf=${asOf}`} className="text-[13px] font-semibold text-brand-700 hover:underline">← {cust ? 'All receivables' : 'All payables'}</Link>
            <PartyLedgerLink side={side} query={ledgerAccountQuery} />
          </>
        }
      />
      <FinanceNav />
      <div className="mb-4 flex items-center justify-between"><AsOfBar asOf={asOf} onChange={set} />{s.differencePaise === 0 ? <CheckPill ok okText="Agrees with the party ledger" badText="" /> : <CheckPill ok={false} okText="" badText={`Differs from the ledger by ${formatINR(s.differencePaise)}`} />}</div>
      <SummaryStrip
        items={[
          { label: 'Net outstanding', value: formatINR(s.netPaise) },
          { label: 'Open items', value: formatINR(s.grossPaise) },
          { label: 'Overdue', value: formatINR(s.overduePaise), tone: s.overduePaise > 0 ? 'bad' : undefined },
          { label: cust ? 'Advances / on account' : 'Advances paid', value: formatINR(s.onAccountPaise) },
          { label: 'Oldest overdue', value: s.oldestOverdueDays ? `${s.oldestOverdueDays} days` : '—' }
        ]}
      />
      <Card title="Ageing" className="mb-4"><BucketBar buckets={s.buckets} total={s.grossPaise} /></Card>
      <div className="grid grid-cols-2 items-start gap-4">
        <Card title={cust ? 'Outstanding invoices' : 'Outstanding bills'} subtitle="Invoice-wise balance, due date and days overdue" bodyClassName="p-0" className="col-span-2">
          <DataTable
            rows={data.items}
            rowKey={(i) => `${i.kind}-${i.id}`}
            maxHeight=""
            empty={<EmptyState title="No open items" />}
            columns={[
              { key: 'no', header: 'Document', render: (i) => (i.route ? <Link to={i.route} className="font-mono font-semibold text-brand-700 hover:underline">{i.number}</Link> : <span className="font-mono">{i.number}</span>) },
              { key: 'kind', header: 'Type', render: (i) => titleCase(i.kind) },
              { key: 'date', header: 'Date', render: (i) => formatDate(i.date) },
              { key: 'due', header: 'Due date', render: (i) => formatDate(i.dueDate) },
              { key: 'days', header: 'Days overdue', align: 'right', render: (i) => (i.daysOverdue > 0 ? <span className="font-semibold text-red-700">{i.daysOverdue}</span> : <span className="text-ink-3">—</span>) },
              { key: 'bucket', header: 'Bucket', render: (i) => <Badge tone={i.bucket === 'CURRENT' ? 'green' : i.bucket === 'D90_PLUS' ? 'red' : 'amber'}>{AGEING_LABELS[i.bucket]}</Badge> },
              { key: 'amt', header: 'Amount', align: 'right', render: (i) => formatINR(i.amountPaise) },
              { key: 'set', header: cust ? 'Received / adjusted' : 'Paid / adjusted', align: 'right', render: (i) => money(i.settledPaise) },
              { key: 'bal', header: 'Balance', align: 'right', render: (i) => <span className="font-semibold">{formatINR(i.balancePaise)}</span> }
            ]}
          />
        </Card>
        <Card title={cust ? 'Advances & unallocated credits' : 'Advances & unallocated debits'} subtitle="Not yet set against an invoice" bodyClassName="p-0">
          <DataTable
            rows={data.onAccount}
            rowKey={(o) => `${o.kind}-${o.id}`}
            maxHeight=""
            empty={<EmptyState title="None" />}
            columns={[
              { key: 'no', header: 'Document', render: (o) => (o.route ? <Link to={o.route} className="font-mono text-brand-700 hover:underline">{o.number}</Link> : o.number) },
              { key: 'kind', header: 'Type', render: (o) => titleCase(o.kind) },
              { key: 'date', header: 'Date', render: (o) => formatDate(o.date) },
              { key: 'u', header: 'Unallocated', align: 'right', render: (o) => <span className="font-semibold">{formatINR(o.unallocatedPaise)}</span> }
            ]}
          />
        </Card>
        <Card title={cust ? 'Credit notes & sales returns' : 'Debit notes & purchase returns'} bodyClassName="p-0">
          <DataTable
            rows={data.notes}
            rowKey={(n) => `${n.kind}-${n.id}`}
            maxHeight=""
            empty={<EmptyState title="None" />}
            columns={[
              { key: 'no', header: 'Number', render: (n) => <Link to={n.route} className="font-mono text-brand-700 hover:underline">{n.number}</Link> },
              { key: 'kind', header: 'Type', render: (n) => n.label },
              { key: 'date', header: 'Date', render: (n) => formatDate(n.date) },
              { key: 'ag', header: 'Against', render: (n) => <span className="font-mono text-[12.5px]">{n.against ?? '—'}</span> },
              { key: 'st', header: 'Status', render: (n) => <Badge tone={n.status === 'POSTED' ? 'green' : 'red'}>{titleCase(n.status)}</Badge> },
              { key: 'amt', header: 'Amount', align: 'right', render: (n) => formatINR(n.amountPaise) }
            ]}
          />
        </Card>
        <Card title={cust ? 'Payment history (receipts)' : 'Payment history'} bodyClassName="p-0" className="col-span-2">
          <DataTable
            rows={data.payments}
            rowKey={(p) => p.id}
            maxHeight=""
            empty={<EmptyState title={cust ? 'No receipts' : 'No payments'} />}
            columns={[
              { key: 'no', header: 'Number', render: (p) => <Link to={p.route} className="font-mono font-semibold text-brand-700 hover:underline">{p.number}</Link> },
              { key: 'date', header: 'Date', render: (p) => formatDate(p.date) },
              { key: 'mode', header: 'Mode', render: (p) => titleCase(p.mode) },
              { key: 'alloc', header: 'Settled', render: (p) => (p.allocations.length ? p.allocations.map((a) => `${a.number} (${formatINR(a.amountPaise)})`).join(', ') : <span className="text-ink-3">On account</span>), wrap: true },
              { key: 'amt', header: 'Amount', align: 'right', render: (p) => <span className="font-semibold">{formatINR(p.amountPaise)}</span> },
              { key: 'un', header: 'Unallocated', align: 'right', render: (p) => money(p.amountPaise - p.allocatedPaise) }
            ]}
          />
        </Card>
      </div>
    </div>
  )
}

function PartyLedgerLink({ side, query }: { side: Side; query: string }) {
  const accounts = useQuery(() => api('finance:accounts'), [])
  const control = accounts.data?.find((a) => a.systemKey === (side === 'CUSTOMER' ? 'AR' : 'AP'))
  if (!control) return null
  return <Link to={`/finance/ledger?account=${control.id}&${query}`} className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-brand-700 hover:bg-brand-50">Party ledger →</Link>
}
