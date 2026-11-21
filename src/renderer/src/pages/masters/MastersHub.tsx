import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { DashboardSummary } from '@shared/types'
import { api } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { MASTERS } from '../../layouts/nav'
import { PageHeader } from '../../components/ui'

export default function MastersHub() {
  const { can, session } = useSession()
  const { data } = useQuery<DashboardSummary | null>(() => (can('dashboard.view') ? api('dashboard:summary') : Promise.resolve(null)), [session?.company?.id])
  const counts: Record<string, string> = data
    ? {
        '/masters/customers': `${data.counts.customers} active`,
        '/masters/suppliers': `${data.counts.suppliers} active`,
        '/masters/products': `${data.counts.products} goods · ${data.counts.services} services`
      }
    : {}
  const desc: Record<string, string> = {
    '/masters/companies': 'Legal entities, GSTIN, address and financial year',
    '/masters/customers': 'Billing parties, GST registration, credit terms',
    '/masters/suppliers': 'Vendors, GST registration, payment terms, bank details',
    '/masters/products': 'Stocked goods and non-stock services with HSN/SAC and GST'
  }
  return (
    <div>
      <PageHeader title="Masters" description="Reference data used by every transaction. Changes are validated and recorded in the audit log." />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {MASTERS.filter((m) => can(m.permission)).map((m) => (
          <Link key={m.path} to={m.path} className="group rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-brand-500/40 hover:shadow-md">
            <div className="flex items-center justify-between">
              <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-700">
                <m.icon className="size-5" />
              </span>
              <ChevronRight className="size-4 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-brand-600" />
            </div>
            <p className="mt-4 text-[15px] font-semibold text-ink">{m.label}</p>
            <p className="mt-1 text-[13px] text-ink-2">{desc[m.path]}</p>
            {counts[m.path] && <p className="mt-3 text-[12px] font-semibold text-brand-700">{counts[m.path]}</p>}
          </Link>
        ))}
      </div>
    </div>
  )
}
