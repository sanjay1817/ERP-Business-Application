import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { KINDS, docRoute, isInvoiceKind, kindBySlug, type DocStatus, type DocumentRow, type Side } from '@shared/documents'
import { api } from '../../lib/api'
import { useDebounced, useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { formatDate, formatINR } from '../../lib/format'
import { Button, Card, DataTable, EmptyState, ErrorBanner, PageHeader, SearchInput, Spinner, Tabs, type Column } from '../../components/ui'
import { ModuleNav, PaymentBadge, StatusBadge, sideRoot } from './common'

export default function DocumentListPage({ side }: { side: Side }) {
  const { slug = '' } = useParams()
  const kind = kindBySlug(side, slug)
  if (!kind) return <Navigate to={sideRoot(side)} replace />
  return <DocumentList key={kind} side={side} kind={kind} />
}

function DocumentList({ side, kind }: { side: Side; kind: NonNullable<ReturnType<typeof kindBySlug>> }) {
  const cfg = KINDS[kind]
  const navigate = useNavigate()
  const { can, session } = useSession()
  const [status, setStatus] = useState<'ALL' | DocStatus>('ALL')
  const [search, setSearch] = useState('')
  const q = useDebounced(search)
  const { data, error, loading, reload } = useQuery<DocumentRow[]>(() => api('doc:list', { kind, search: q || undefined }), [kind, q, session?.company?.id])
  const all = data ?? []
  const rows = all.filter((r) => status === 'ALL' || r.status === status)
  const canCreate = can(`${side === 'SALES' ? 'sales' : 'purchase'}.post`) && !cfg.sourceRequired
  const invoice = isInvoiceKind(kind)

  const columns: Column<DocumentRow>[] = [
    { key: 'no', header: 'Number', render: (r) => <span className="font-mono font-semibold text-ink">{r.status === 'DRAFT' ? <span className="text-ink-3">Draft #{r.id}</span> : r.number}</span>, sortValue: (r) => r.number },
    { key: 'date', header: 'Date', render: (r) => formatDate(r.date), sortValue: (r) => r.date },
    { key: 'party', header: cfg.party === 'CUSTOMER' ? 'Customer' : 'Supplier', render: (r) => r.partyName ?? <span className="text-ink-3">—</span>, sortValue: (r) => r.partyName ?? '', wrap: true },
    cfg.supplierRefLabel
      ? { key: 'ref', header: cfg.supplierRefLabel.replace(/ no\.$/, ''), render: (r) => <span className="font-mono text-[12.5px] text-ink-2">{r.supplierRef ?? '—'}</span> }
      : { key: 'ref', header: 'Reference', render: (r) => <span className="text-ink-2">{r.referenceNo ?? '—'}</span> },
    ...(cfg.sources.length ? [{ key: 'src', header: 'From', render: (r: DocumentRow) => <span className="font-mono text-[12px] text-ink-2">{r.sourceNumber ?? '—'}</span> }] : []),
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => r.lineCount },
    { key: 'taxable', header: 'Taxable', align: 'right', render: (r) => formatINR(r.taxablePaise), sortValue: (r) => r.taxablePaise },
    { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="font-semibold">{formatINR(r.grandTotalPaise)}</span>, sortValue: (r) => r.grandTotalPaise },
    ...(invoice ? [{ key: 'bal', header: 'Balance', align: 'right' as const, render: (r: DocumentRow) => (r.status === 'POSTED' ? formatINR(r.balanceDuePaise) : '—'), sortValue: (r: DocumentRow) => r.balanceDuePaise }] : []),
    { key: 'status', header: 'Status', render: (r) => <span className="flex gap-1"><StatusBadge status={r.status} />{invoice && <PaymentBadge status={r.paymentStatus} />}</span> }
  ]

  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader
        title={cfg.plural}
        description={cfg.description}
        actions={
          canCreate ? (
            <Button icon={<Plus className="size-4" />} onClick={() => navigate(docRoute(kind, 'new'))}>New {cfg.label.toLowerCase()}</Button>
          ) : cfg.sourceRequired ? (
            <span className="text-[12.5px] text-ink-3">Create from a posted {cfg.sources.map((s) => KINDS[s].label.toLowerCase()).join(' / ')} (Convert → {cfg.label})</span>
          ) : undefined
        }
      />
      <ErrorBanner error={error} onRetry={reload} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder={`Search number, ${cfg.party === 'CUSTOMER' ? 'customer' : 'supplier'}, reference…`} className="w-80" />
          <Tabs
            value={status}
            onChange={setStatus}
            tabs={[
              { value: 'ALL', label: 'All', count: all.length },
              { value: 'DRAFT', label: 'Drafts', count: all.filter((r) => r.status === 'DRAFT').length },
              { value: 'POSTED', label: 'Posted', count: all.filter((r) => r.status === 'POSTED').length },
              { value: 'CANCELLED', label: 'Cancelled', count: all.filter((r) => r.status === 'CANCELLED').length }
            ]}
          />
        </div>
        {loading && !data ? (
          <Spinner />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(docRoute(kind, r.id))}
            empty={
              <EmptyState
                title={`No ${cfg.plural.toLowerCase()}${status !== 'ALL' ? ` with status ${status.toLowerCase()}` : ''}`}
                message={cfg.sourceRequired ? `Open a posted ${KINDS[cfg.sources[0]].label.toLowerCase()} and choose “Convert → ${cfg.label}”.` : undefined}
                action={canCreate ? <Button icon={<Plus className="size-4" />} onClick={() => navigate(docRoute(kind, 'new'))}>New {cfg.label.toLowerCase()}</Button> : undefined}
              />
            }
          />
        )}
      </Card>
    </div>
  )
}
