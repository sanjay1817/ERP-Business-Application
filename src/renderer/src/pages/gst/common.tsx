import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { ITC_LABELS, OUTWARD_CLASS_LABELS, type ItcEligibility } from '@shared/gst'
import { formatINR } from '../../lib/format'
import { Badge, cx } from '../../components/ui'
import { SectionNav } from '../finance/shared'

export const GstNav = () => (
  <SectionNav
    label="GST sections"
    items={[
      { to: '/gst', label: 'Overview', end: true },
      { to: '/gst/sales', label: 'Sales register' },
      { to: '/gst/purchases', label: 'Purchase register & ITC' },
      { to: '/gst/gstr1', label: 'GSTR-1' },
      { to: '/gst/gstr3b', label: 'GSTR-3B' },
      { to: '/gst/validation', label: 'Validation' },
      { to: '/gst/reconciliation', label: 'Reconciliation' },
      { to: '/gst/config', label: 'Configuration' }
    ]}
  />
)

const thisMonth = () => new Date().toISOString().slice(0, 7)
export const monthRange = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const to = `${period}-${String(last).padStart(2, '0')}`
  const today = new Date().toISOString().slice(0, 10)
  return { from: `${period}-01`, to: to > today ? today : to, fullTo: to }
}
export const monthLabel = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** Return period (?period=YYYY-MM), default current month. */
export function usePeriodMonth() {
  const [params, setParams] = useSearchParams()
  const period = params.get('period') ?? thisMonth()
  const set = (p: string) => {
    const n = new URLSearchParams(params)
    n.set('period', p)
    setParams(n, { replace: true })
  }
  return { period, set }
}

const input = 'h-9 rounded-lg border border-line bg-white px-2.5 text-[13px] text-ink focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none'
export function MonthBar({ period, onChange, children }: { period: string; onChange: (p: string) => void; children?: ReactNode }) {
  const step = (n: number) => {
    const [y, m] = period.split('-').map(Number)
    onChange(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7))
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] font-semibold text-ink-2">Return period</span>
      <button type="button" aria-label="Previous month" className={cx(input, 'px-2')} onClick={() => step(-1)}>‹</button>
      <input type="month" aria-label="Return period" className={input} value={period} max={thisMonth()} onChange={(e) => e.target.value && onChange(e.target.value)} />
      <button type="button" aria-label="Next month" className={cx(input, 'px-2')} disabled={period >= thisMonth()} onClick={() => step(1)}>›</button>
      {children}
    </div>
  )
}

/** Shown on every return screen: this is preparation, not filing. */
export function NotFiledBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900" role="note">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <p>
        <strong>Preparation only — not filed.</strong> Figures are prepared from posted transactions for review and export. Returns are filed on the GST portal by the taxpayer; this application does not
        connect to the GST portal. {children}
      </p>
    </div>
  )
}

export function DemoProviderBanner({ what }: { what: string }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-900" role="note">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p>
        <strong>DEMO MODE — mock provider.</strong> {what} shown here are generated locally, start with “DEMO” and are <strong>not registered with, or issued by, any government system</strong>. They have no legal
        validity. Live integration needs an authorised provider, credentials and an adapter built from the current official specification.
      </p>
    </div>
  )
}

export const Money = ({ p, className }: { p: number; className?: string }) => (
  <span className={cx('tabular', p < 0 && 'text-red-700', className)}>{p === 0 ? '—' : formatINR(p)}</span>
)

const SECTION_TONE: Record<string, 'blue' | 'violet' | 'green' | 'amber' | 'gray' | 'red'> = { B2B: 'blue', B2CL: 'violet', B2CS: 'gray', EXPWP: 'green', EXPWOP: 'green', SEZWP: 'amber', SEZWOP: 'amber', CDNR: 'red', CDNUR: 'red', B2CS_ADJ: 'red' }
export const SectionBadge = ({ s }: { s: string }) => (
  <Badge tone={SECTION_TONE[s] ?? 'gray'}>{s === 'B2CS_ADJ' ? 'B2CS credit' : s}</Badge>
)
export const sectionLabel = (s: string) => (OUTWARD_CLASS_LABELS as Record<string, string>)[s] ?? ({ CDNR: 'Credit notes — registered', CDNUR: 'Credit notes — unregistered', B2CS_ADJ: 'Credit notes — adjust B2C Small' } as Record<string, string>)[s] ?? s

const ITC_TONE: Record<ItcEligibility, 'green' | 'amber' | 'red' | 'gray'> = { ELIGIBLE: 'green', PENDING: 'amber', INELIGIBLE: 'red', BLOCKED: 'red', NOT_AVAILABLE: 'gray' }
export const ItcBadge = ({ e }: { e: ItcEligibility }) => <Badge tone={ITC_TONE[e]}>{ITC_LABELS[e]}</Badge>

/** Plain table for return sections (values in paise). */
export function TaxTable<T>({ rows, cols, total }: { rows: T[]; cols: Array<{ h: string; v: (r: T) => ReactNode; right?: boolean; w?: string }>; total?: ReactNode }) {
  return (
    <div className="overflow-auto rounded-lg border border-line">
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead>
          <tr>{cols.map((c) => <th key={c.h} style={{ width: c.w }} className={cx('border-b border-line bg-slate-50 px-3 py-2 text-[11px] font-semibold tracking-wide whitespace-nowrap text-ink-3 uppercase', c.right ? 'text-right' : 'text-left')}>{c.h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-3 py-4 text-center text-ink-3">Nothing to report for this period</td></tr>
          ) : (
            rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.h} className={cx('border-b border-slate-100 px-3 py-1.5', c.right ? 'tabular text-right whitespace-nowrap' : '')}>{c.v(r)}</td>)}</tr>)
          )}
        </tbody>
        {total && <tfoot className="bg-slate-50 font-semibold">{total}</tfoot>}
      </table>
    </div>
  )
}
