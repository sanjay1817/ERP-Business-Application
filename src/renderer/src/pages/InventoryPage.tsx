import { useMemo, useState } from 'react'
import type { MovementRow, StockRow } from '@shared/types'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { formatDate, formatINR, milliToString, titleCase } from '../lib/format'
import { Badge, Card, DataTable, ErrorBanner, PageHeader, Spinner, Tabs } from '../components/ui'
import { PhaseNotice } from '../components/PhaseNotice'

export default function InventoryPage() {
  const { session } = useSession()
  const [tab, setTab] = useState<'stock' | 'moves'>('stock')
  const [warehouse, setWarehouse] = useState('ALL')
  const stock = useQuery<StockRow[]>(() => api('inventory:stock'), [session?.company?.id])
  const moves = useQuery<MovementRow[]>(() => (tab === 'moves' ? api('inventory:movements', { limit: 500 }) : Promise.resolve([])), [tab, session?.company?.id])
  const warehouses = useMemo(() => [...new Set((stock.data ?? []).map((s) => s.warehouseName))], [stock.data])
  const rows = (stock.data ?? []).filter((s) => warehouse === 'ALL' || s.warehouseName === warehouse)
  const totalValue = rows.reduce((s, r) => s + r.valuePaise, 0)

  return (
    <div>
      <PageHeader title="Inventory" description="Moving-average valuation per warehouse. Balances are maintained by immutable stock movements." />
      <PhaseNotice>Stock transfers, adjustments and physical-count reconciliation are planned for Phase 2. Figures below come from posted opening stock, purchases and sales.</PhaseNotice>
      <ErrorBanner error={stock.error ?? moves.error} onRetry={stock.reload} />
      <Card bodyClassName="p-0">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'stock', label: 'Stock summary' }, { value: 'moves', label: 'Stock movements' }]} />
          {tab === 'stock' && (
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)} className="h-9 rounded-lg border border-line bg-white px-3 text-[13px]">
              <option value="ALL">All warehouses</option>
              {warehouses.map((w) => <option key={w}>{w}</option>)}
            </select>
          )}
          {tab === 'stock' && <span className="ml-auto text-[13px] text-ink-2">Stock value <strong className="tabular text-ink">{formatINR(totalValue)}</strong></span>}
        </div>
        {tab === 'stock' ? (
          stock.loading && !stock.data ? <Spinner /> : (
            <DataTable
              rows={rows}
              rowKey={(r) => `${r.productId}-${r.warehouseId}`}
              columns={[
                { key: 'code', header: 'Code', render: (r) => <span className="font-mono font-semibold">{r.code}</span>, sortValue: (r) => r.code },
                { key: 'name', header: 'Item', render: (r) => r.name, sortValue: (r) => r.name, wrap: true },
                { key: 'cat', header: 'Category', render: (r) => <span className="text-ink-2">{r.categoryName ?? '—'}</span> },
                { key: 'wh', header: 'Warehouse', render: (r) => r.warehouseName, sortValue: (r) => r.warehouseName },
                {
                  key: 'qty', header: 'Quantity', align: 'right', sortValue: (r) => r.qtyMilli,
                  render: (r) => <span className="font-semibold">{milliToString(r.qtyMilli)} {r.unitCode}</span>
                },
                { key: 'avg', header: 'Avg cost', align: 'right', render: (r) => (r.qtyMilli > 0 ? formatINR(Math.round((r.valuePaise * 1000) / r.qtyMilli)) : '—') },
                { key: 'value', header: 'Value', align: 'right', render: (r) => formatINR(r.valuePaise), sortValue: (r) => r.valuePaise },
                {
                  key: 'status', header: 'Status',
                  render: (r) => (r.qtyMilli === 0 ? <Badge tone="red">Out of stock</Badge> : r.reorderLevelMilli > 0 && r.qtyMilli <= r.reorderLevelMilli ? <Badge tone="amber">Low</Badge> : <Badge tone="green">OK</Badge>)
                }
              ]}
            />
          )
        ) : moves.loading && !moves.data?.length ? (
          <Spinner />
        ) : (
          <DataTable
            rows={moves.data ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'date', header: 'Date', render: (r) => formatDate(r.movementDate), sortValue: (r) => r.movementDate },
              { key: 'type', header: 'Type', render: (r) => <Badge tone={r.qtyInMilli > 0 ? 'green' : 'amber'}>{titleCase(r.movementType)}</Badge> },
              { key: 'item', header: 'Item', render: (r) => <span><span className="font-mono text-[12px] text-ink-3">{r.productCode}</span> {r.productName}</span>, wrap: true },
              { key: 'wh', header: 'Warehouse', render: (r) => r.warehouseName },
              { key: 'ref', header: 'Reference', render: (r) => <span className="font-mono text-[12.5px]">{r.referenceNo ?? '—'}</span> },
              { key: 'in', header: 'In', align: 'right', render: (r) => (r.qtyInMilli ? milliToString(r.qtyInMilli) : '') },
              { key: 'out', header: 'Out', align: 'right', render: (r) => (r.qtyOutMilli ? milliToString(r.qtyOutMilli) : '') },
              { key: 'bal', header: 'Balance', align: 'right', render: (r) => <strong>{milliToString(r.balanceQtyMilli)}</strong> },
              { key: 'value', header: 'Value', align: 'right', render: (r) => formatINR(r.valuePaise) }
            ]}
          />
        )}
      </Card>
    </div>
  )
}
