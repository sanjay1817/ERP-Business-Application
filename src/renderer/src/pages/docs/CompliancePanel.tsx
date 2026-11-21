import { Link } from 'react-router-dom'
import type { EwayBill } from '@shared/types'
import type { EInvoiceEligibility, EInvoiceRow, TransportDoc } from '@shared/gst'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { formatDate, titleCase } from '../../lib/format'
import { Badge, Card, DemoBadge } from '../../components/ui'

/** E-invoice, e-way bill and transport status of a posted sales document, with links. */
export function CompliancePanel({ kind, id }: { kind: 'SALES_INVOICE' | 'DELIVERY_CHALLAN' | 'CREDIT_NOTE' | 'SALES_RETURN'; id: number }) {
  const { can } = useSession()
  const einvoiceKind = kind !== 'DELIVERY_CHALLAN'
  const ewbKind = kind === 'SALES_INVOICE' || kind === 'DELIVERY_CHALLAN'
  const elig = useQuery<EInvoiceEligibility | null>(() => (einvoiceKind && can('einvoice.view') ? api('einvoice:eligibility', { documentKind: kind as 'SALES_INVOICE', documentId: id }) : Promise.resolve(null)), [kind, id])
  const einv = useQuery<EInvoiceRow[]>(() => (einvoiceKind && can('einvoice.view') ? api('einvoice:list') : Promise.resolve([])), [kind, id])
  const ewbs = useQuery<EwayBill[]>(() => (ewbKind && can('ewaybill.view') ? api('ewaybill:list') : Promise.resolve([])), [kind, id])
  const tdocs = useQuery<TransportDoc[]>(() => (ewbKind && can('ewaybill.view') ? api('transport:docs', { sourceKind: kind as 'SALES_INVOICE', sourceId: id }) : Promise.resolve([])), [kind, id])
  const mine = (einv.data ?? []).filter((e) => e.documentKind === kind && e.documentId === id)
  const myEwbs = (ewbs.data ?? []).filter((e) => e.sourceKind === kind && e.sourceId === id)
  return (
    <Card title="GST compliance">
      <ul className="space-y-2.5 text-[13px]">
        {einvoiceKind && (
          <li>
            <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">E-invoice</p>
            {mine.length ? mine.map((e) => <Link key={e.id} to={`/einvoice/${e.id}`} className="flex items-center gap-1.5 text-brand-700 hover:underline"><Badge tone={e.status === 'GENERATED' ? 'green' : e.status === 'FAILED' ? 'red' : 'amber'}>{titleCase(e.status)}</Badge>{e.isDemo && <DemoBadge />}<span className="truncate font-mono text-[11.5px]">{e.irn?.slice(0, 18) ?? e.errorMessage}</span></Link>)
              : elig.data ? (elig.data.applicable ? <Link to="/einvoice" className="text-brand-700 hover:underline">Eligible — generate from the E-Invoice workspace</Link> : <span className="text-ink-2">Not required / not eligible: {elig.data.blockers[0]}</span>) : <span className="text-ink-3">—</span>}
          </li>
        )}
        {ewbKind && (
          <li>
            <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">E-way bill</p>
            {myEwbs.length ? myEwbs.map((e) => <span key={e.id} className="flex items-center gap-1.5"><span className="font-mono">{e.ewbNo}</span><Badge tone={e.status === 'ACTIVE' ? 'green' : e.status === 'PART_A_ONLY' ? 'amber' : 'gray'}>{titleCase(e.status)}</Badge>{e.isDemo && <DemoBadge />}</span>)
              : can('ewaybill.manage') ? <Link to={`/ewaybill/new?kind=${kind}&id=${id}`} className="text-brand-700 hover:underline">Prepare an e-way bill →</Link> : <span className="text-ink-3">None</span>}
          </li>
        )}
        {ewbKind && (
          <li>
            <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">Transport documents</p>
            {(tdocs.data ?? []).length ? tdocs.data!.map((d) => <span key={d.id} className="block">{d.docNo} · {formatDate(d.docDate)} · {d.transporterName ?? d.vehicleNo ?? titleCase(d.transportMode)}</span>) : <Link to="/masters/transport" className="text-brand-700 hover:underline">Add in Transport masters</Link>}
          </li>
        )}
      </ul>
    </Card>
  )
}
