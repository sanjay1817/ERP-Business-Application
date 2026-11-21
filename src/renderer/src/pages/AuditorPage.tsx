import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Eye, Info, ShieldCheck, XCircle } from 'lucide-react'
import type { AuditRow, MovementRow } from '@shared/types'
import { EXCEPTION_CATEGORIES, type AuditExceptionReport, type DayBookEntry, type ExceptionCategory, type IntegrityReport } from '@shared/finance'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { formatDate, formatDateTime, formatINR, milliToString, titleCase } from '../lib/format'
import { Badge, Card, DataTable, Drawer, EmptyState, ErrorBanner, PageHeader, SearchInput, Spinner, cx } from '../components/ui'
import { JournalDrawer, PeriodBar, SectionNav, usePeriod } from './finance/shared'

function AuditorFrame({ children, title, description, actions }: { children: React.ReactNode; title: string; description: string; actions?: React.ReactNode }) {
  const { session } = useSession()
  const auditor = session?.roleCode === 'AUDITOR'
  return (
    <div>
      <PageHeader title={title} description={description} badge={<Badge tone="navy"><ShieldCheck className="size-3" /> Auditor workspace</Badge>} actions={actions} />
      {auditor && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-navy-200 bg-navy-900/[0.03] px-4 py-2.5 text-[13px] text-ink-2">
          <Eye className="size-4 text-navy-700" />
          <span><strong className="text-ink">Read-only access.</strong> You can inspect financial records, source documents, journals, stock movements and audit logs, and export reports. Posting, editing, cancelling and deleting are disabled for your role.</span>
        </div>
      )}
      <SectionNav
        label="Auditor sections"
        items={[
          { to: '/auditor', label: 'Overview', end: true },
          { to: '/auditor/exceptions', label: 'Exception report' },
          { to: '/auditor/journals', label: 'Journal inspector' },
          { to: '/auditor/stock', label: 'Stock movements', permission: 'inventory.view' },
          { to: '/auditor/trail', label: 'Audit trail' },
          { to: '/reports', label: 'Reports & exports ↗', permission: 'reports.view' }
        ]}
      />
      {children}
    </div>
  )
}

// ───────────────────────── Overview ─────────────────────────

export function AuditorOverview() {
  const { session } = useSession()
  const integrity = useQuery<IntegrityReport>(() => api('audit:integrity'), [session?.company?.id])
  const exceptions = useQuery<AuditExceptionReport>(() => api('audit:exceptions'), [session?.company?.id])
  return (
    <AuditorFrame title="Auditor" description="Independent checks on the books, with every figure traceable to its source document.">
      <ErrorBanner error={integrity.error ?? exceptions.error} onRetry={integrity.reload} />
      <div className="grid grid-cols-5 items-start gap-4">
        <Card className="col-span-3" title="Financial report reconciliation" subtitle={integrity.data ? `Checked as of ${formatDate(integrity.data.asOf)} from independent sources` : undefined} actions={integrity.data && (integrity.data.allOk ? <Badge tone="green">All checks passed</Badge> : <Badge tone="red">Attention needed</Badge>)} bodyClassName="p-0">
          {integrity.loading && !integrity.data ? <Spinner label="Running checks…" /> : (
            <ul className="divide-y divide-slate-100">
              {integrity.data?.checks.map((c) => (
                <li key={c.key} className="flex gap-3 px-5 py-3">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" />}
                  <div>
                    <p className="text-[13.5px] font-semibold text-ink">{c.label}</p>
                    <p className="text-[12.5px] text-ink-3">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="col-span-2" title="Exceptions for review" subtitle="Unusual items — not findings" bodyClassName="p-0">
          {exceptions.loading && !exceptions.data ? <Spinner /> : (
            <ul className="divide-y divide-slate-100">
              {(Object.keys(EXCEPTION_CATEGORIES) as ExceptionCategory[]).map((k) => (
                <li key={k}>
                  <Link to={`/auditor/exceptions?category=${k}`} className="flex items-center justify-between px-5 py-2.5 text-[13px] hover:bg-brand-50/50">
                    <span className="text-ink-2">{EXCEPTION_CATEGORIES[k]}</span>
                    <Badge tone={(exceptions.data?.counts[k] ?? 0) === 0 ? 'gray' : k === 'REVERSED' || k === 'CANCELLED' ? 'blue' : 'amber'}>{exceptions.data?.counts[k] ?? 0}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="flex gap-2 border-t border-line px-5 py-3 text-[12px] text-ink-3"><Info className="mt-0.5 size-3.5 shrink-0" />{exceptions.data?.disclaimer}</p>
        </Card>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3">
        {[
          { to: '/finance/trial-balance', label: 'Trial balance', sub: 'Opening, period, closing' },
          { to: '/finance/ledger', label: 'General ledger', sub: 'Drill down to documents' },
          { to: '/finance/balance-sheet', label: 'Balance sheet', sub: 'Assets = Liabilities + Equity' },
          { to: '/finance/receivables', label: 'Receivables ageing', sub: 'Agreed to Sundry Debtors' }
        ].map((l) => (
          <Link key={l.to} to={l.to} className="rounded-xl border border-line bg-white px-4 py-3 transition hover:border-brand-500/40 hover:shadow-md">
            <p className="text-[13.5px] font-semibold text-ink">{l.label} →</p>
            <p className="text-[12px] text-ink-3">{l.sub}</p>
          </Link>
        ))}
      </div>
    </AuditorFrame>
  )
}

// ───────────────────────── Exceptions ─────────────────────────

export function AuditorExceptions() {
  const { session } = useSession()
  const [params] = useSearchParams()
  const [category, setCategory] = useState<'' | ExceptionCategory>((params.get('category') as ExceptionCategory) ?? '')
  const [severity, setSeverity] = useState<'' | 'review' | 'info'>('')
  const [search, setSearch] = useState('')
  const { data, error, loading, reload } = useQuery<AuditExceptionReport>(() => api('audit:exceptions'), [session?.company?.id])
  const navigate = useNavigate()
  const rows = useMemo(
    () => (data?.items ?? []).filter((i) => (!category || i.category === category) && (!severity || i.severity === severity) && (!search || `${i.reference} ${i.title} ${i.detail} ${i.user ?? ''}`.toLowerCase().includes(search.toLowerCase()))),
    [data, category, severity, search]
  )
  return (
    <AuditorFrame title="Exception report" description="Items that differ from the normal pattern or lack expected evidence, for the auditor's review.">
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>{data?.disclaimer ?? 'Items are listed for review only.'}</span>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <select value={category} onChange={(e) => setCategory(e.target.value as ExceptionCategory | '')} className="h-9 rounded-lg border border-line bg-white px-3 text-[13px]" aria-label="Category">
            <option value="">All categories</option>
            {(Object.keys(EXCEPTION_CATEGORIES) as ExceptionCategory[]).map((k) => <option key={k} value={k}>{EXCEPTION_CATEGORIES[k]} ({data?.counts[k] ?? 0})</option>)}
          </select>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as '' | 'review' | 'info')} className="h-9 rounded-lg border border-line bg-white px-3 text-[13px]" aria-label="Severity">
            <option value="">Review and information</option>
            <option value="review">Needs review</option>
            <option value="info">Information</option>
          </select>
          <SearchInput value={search} onChange={setSearch} placeholder="Search reference, detail, user…" className="w-72" />
          <span className="ml-auto text-[12.5px] text-ink-3">{rows.length} items</span>
        </div>
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => r.route && navigate(r.route)}
            maxHeight="max-h-[calc(100vh-380px)]"
            empty={<EmptyState title="No exceptions" message="Nothing in this category needs review." />}
            columns={[
              { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date, width: '110px' },
              { key: 'cat', header: 'Category', render: (r) => <Badge tone={r.category === 'REVERSED' || r.category === 'CANCELLED' ? 'blue' : r.category === 'UNBALANCED_ATTEMPT' ? 'red' : 'amber'}>{EXCEPTION_CATEGORIES[r.category]}</Badge> },
              { key: 'sev', header: 'Severity', render: (r) => (r.severity === 'review' ? <Badge tone="amber">Review</Badge> : <Badge>Info</Badge>) },
              { key: 'ref', header: 'Reference', render: (r) => <span className={cx('font-mono text-[12.5px]', r.route && 'text-brand-700')}>{r.reference}</span> },
              { key: 'what', header: 'Observation', render: (r) => <span><span className="font-semibold text-ink">{r.title}</span><span className="block text-[12.5px] text-ink-3">{r.detail}</span></span>, wrap: true },
              { key: 'amt', header: 'Amount', align: 'right', render: (r) => (r.amountPaise === null ? '' : formatINR(r.amountPaise)), sortValue: (r) => r.amountPaise ?? 0 },
              { key: 'user', header: 'User', render: (r) => <span className="text-ink-3">{r.user ?? '—'}</span> }
            ]}
          />
        )}
      </Card>
    </AuditorFrame>
  )
}

// ───────────────────────── Journal inspector ─────────────────────────

export function AuditorJournals() {
  const period = usePeriod()
  const { data, error, loading, reload } = useQuery<DayBookEntry[] | null>(() => (period.ready ? api('finance:dayBook', { from: period.from!, to: period.to! }) : Promise.resolve(null)), [period.from, period.to])
  const [search, setSearch] = useState('')
  const [onlyReversals, setOnlyReversals] = useState(false)
  const [journal, setJournal] = useState<number | null>(null)
  const rows = useMemo(
    () => [...(data ?? [])].reverse().filter((e) => (!onlyReversals || e.isCancellation || e.status === 'REVERSED') && (!search || `${e.entryNo} ${e.voucherNo ?? ''} ${e.voucherType} ${e.narration ?? ''} ${e.lines.map((l) => `${l.accountName} ${l.party ?? ''}`).join(' ')}`.toLowerCase().includes(search.toLowerCase()))),
    [data, search, onlyReversals]
  )
  return (
    <AuditorFrame title="Journal inspector" description="Every journal entry with its lines, status and source document. Click a row for the full entry.">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PeriodBar period={period} />
        <SearchInput value={search} onChange={setSearch} placeholder="Search entry, voucher, account, party…" className="w-80" />
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={onlyReversals} onChange={(e) => setOnlyReversals(e.target.checked)} /> Reversed / reversal entries only</label>
      </div>
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={rows}
            rowKey={(e) => e.journalId}
            onRowClick={(e) => setJournal(e.journalId)}
            maxHeight="max-h-[calc(100vh-330px)]"
            columns={[
              { key: 'entry', header: 'Entry', render: (e) => <span className="font-mono font-semibold">{e.entryNo}</span>, sortValue: (e) => e.entryNo },
              { key: 'date', header: 'Date', render: (e) => formatDate(e.date), sortValue: (e) => e.date },
              { key: 'type', header: 'Voucher', render: (e) => (e.isCancellation ? <Badge tone="red">{e.voucherType}</Badge> : <Badge tone="blue">{e.voucherType}</Badge>) },
              { key: 'no', header: 'Source', render: (e) => <span className="font-mono text-[12.5px]">{e.voucherNo ?? '—'}</span> },
              { key: 'status', header: 'Status', render: (e) => (e.status === 'REVERSED' ? <Badge tone="amber">Reversed</Badge> : <Badge tone="green">Posted</Badge>) },
              { key: 'n', header: 'Narration', render: (e) => <span className="text-ink-2">{e.narration}</span>, wrap: true },
              { key: 'lines', header: 'Lines', align: 'right', render: (e) => e.lines.length },
              { key: 'amt', header: 'Amount', align: 'right', render: (e) => <span className="font-semibold">{formatINR(e.amountPaise)}</span>, sortValue: (e) => e.amountPaise }
            ]}
          />
        )}
      </Card>
      <JournalDrawer id={journal} onClose={() => setJournal(null)} />
    </AuditorFrame>
  )
}

// ───────────────────────── Stock movements ─────────────────────────

const MOVE_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'violet'> = { OPENING: 'gray', PURCHASE: 'green', SALE: 'blue', SALE_REVERSAL: 'amber', PURCHASE_REVERSAL: 'amber', ADJUSTMENT_IN: 'violet', ADJUSTMENT_OUT: 'violet' }

export function AuditorStock() {
  const { session } = useSession()
  const { data, error, loading, reload } = useQuery<MovementRow[]>(() => api('inventory:movements', { limit: 1000 }), [session?.company?.id])
  const [type, setType] = useState('')
  const [search, setSearch] = useState('')
  const rows = (data ?? []).filter((m) => (!type || m.movementType === type) && (!search || `${m.productCode} ${m.productName} ${m.referenceNo ?? ''}`.toLowerCase().includes(search.toLowerCase())))
  return (
    <AuditorFrame title="Stock movements" description="Every stock movement with quantity, cost and source reference. Movements are immutable; corrections are new movements.">
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <select value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-lg border border-line bg-white px-3 text-[13px]" aria-label="Movement type">
            <option value="">All movement types</option>
            {Object.keys(MOVE_TONE).map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
          </select>
          <SearchInput value={search} onChange={setSearch} placeholder="Search item or reference…" className="w-72" />
          <span className="ml-auto text-[12.5px] text-ink-3">{rows.length} movements (latest 1,000)</span>
        </div>
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={rows}
            rowKey={(m) => m.id}
            maxHeight="max-h-[calc(100vh-330px)]"
            columns={[
              { key: 'date', header: 'Date', render: (m) => formatDate(m.movementDate), sortValue: (m) => m.movementDate },
              { key: 'type', header: 'Type', render: (m) => <Badge tone={MOVE_TONE[m.movementType] ?? 'gray'}>{titleCase(m.movementType)}</Badge> },
              { key: 'item', header: 'Item', render: (m) => <span><span className="font-mono text-ink-3">{m.productCode}</span> {m.productName}</span>, wrap: true },
              { key: 'wh', header: 'Warehouse', render: (m) => m.warehouseName },
              { key: 'in', header: 'In', align: 'right', render: (m) => (m.qtyInMilli ? milliToString(m.qtyInMilli) : '') },
              { key: 'out', header: 'Out', align: 'right', render: (m) => (m.qtyOutMilli ? milliToString(m.qtyOutMilli) : '') },
              { key: 'cost', header: 'Unit cost', align: 'right', render: (m) => formatINR(m.unitCostPaise) },
              { key: 'val', header: 'Value', align: 'right', render: (m) => formatINR(m.valuePaise), sortValue: (m) => m.valuePaise },
              { key: 'ref', header: 'Reference', render: (m) => <span className="font-mono text-[12.5px]">{m.referenceNo ?? '—'}</span> },
              { key: 'bal', header: 'Balance qty', align: 'right', render: (m) => milliToString(m.balanceQtyMilli) }
            ]}
          />
        )}
      </Card>
    </AuditorFrame>
  )
}

// ───────────────────────── Audit trail ─────────────────────────

const ENTITY_TYPES = ['', 'company', 'customer', 'supplier', 'product', 'sales_invoice', 'purchase_invoice', 'payment_receipt', 'payment_voucher', 'voucher', 'journal', 'bank_reconciliation', 'report', 'credit_note', 'debit_note', 'sales_return', 'purchase_return', 'ewaybill', 'user']
const tone = (a: string) => (a.includes('FAILED') || a.includes('REJECTED') ? 'red' : a === 'CREATE' || a === 'POST' ? 'green' : a === 'UPDATE' ? 'blue' : a === 'CANCEL' ? 'amber' : a.startsWith('EXPORT') || a === 'PRINT' ? 'violet' : 'gray')

export function AuditTrail() {
  const { session } = useSession()
  const [entity, setEntity] = useState('')
  const [search, setSearch] = useState('')
  const { data, error, loading, reload } = useQuery<AuditRow[]>(() => api('audit:list', { entityType: entity || undefined, limit: 1000 }), [entity, session?.company?.id])
  const [detail, setDetail] = useState<AuditRow | null>(null)
  const rows = (data ?? []).filter((r) => !search || `${r.summary} ${r.username ?? ''} ${r.action}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <AuditorFrame title="Audit trail" description="Append-only log of every action. Entries cannot be edited or deleted — enforced by the database.">
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <select value={entity} onChange={(e) => setEntity(e.target.value)} className="h-9 rounded-lg border border-line bg-white px-3 text-[13px]" aria-label="Record type">
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t ? titleCase(t) : 'All record types'}</option>)}
          </select>
          <SearchInput value={search} onChange={setSearch} placeholder="Search summary, user, action…" className="w-72" />
          <span className="ml-auto text-[12.5px] text-ink-3">{rows.length} entries (latest first)</span>
        </div>
        {loading && !data ? <Spinner /> : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => r.details && setDetail(r)}
            maxHeight="max-h-[calc(100vh-330px)]"
            columns={[
              { key: 'at', header: 'When', render: (r) => <span className="whitespace-nowrap text-ink-2">{formatDateTime(r.createdAt)}</span>, width: '170px' },
              { key: 'user', header: 'User', render: (r) => r.username ?? <span className="text-ink-3">system</span>, width: '110px' },
              { key: 'action', header: 'Action', render: (r) => <Badge tone={tone(r.action)}>{r.action}</Badge>, width: '150px' },
              { key: 'entity', header: 'Record', render: (r) => <span className="text-ink-2">{titleCase(r.entityType)}{r.entityId ? ` #${r.entityId}` : ''}</span>, width: '170px' },
              { key: 'summary', header: 'Summary', render: (r) => r.summary, wrap: true }
            ]}
          />
        )}
      </Card>
      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Audit entry" subtitle={detail ? `${detail.action} · ${formatDateTime(detail.createdAt)}` : ''}>
        {detail && (
          <>
            <p className="mb-3 text-[13.5px]">{detail.summary}</p>
            <pre className="overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-[12px] leading-relaxed text-slate-100">{JSON.stringify(JSON.parse(detail.details ?? 'null'), null, 2)}</pre>
          </>
        )}
      </Drawer>
    </AuditorFrame>
  )
}

export default AuditorOverview
