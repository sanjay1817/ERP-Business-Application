import { useEffect, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, Inbox, Loader2, Search, X } from 'lucide-react'
import type { ApiError } from '../lib/api'

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(' ')

// ───────── Buttons ─────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-600/20 disabled:bg-brand-600/60',
  secondary: 'bg-white text-ink border border-line hover:bg-slate-50 hover:border-slate-300',
  ghost: 'text-ink-2 hover:bg-slate-100 hover:text-ink',
  danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50'
}
export function Button({ variant = 'primary', loading, icon, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70', VARIANTS[variant], className)}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

// ───────── Form fields ─────────
export function Field({ label, error, hint, required, children, className }: { label: string; error?: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-[12px] font-medium text-red-600">{error}</span> : hint ? <span className="mt-1 block text-[12px] text-ink-3">{hint}</span> : null}
    </label>
  )
}

const inputBase = 'h-9 w-full rounded-lg border bg-white px-3 text-[13.5px] text-ink placeholder:text-ink-3 transition-colors focus:outline-none focus:ring-3 disabled:bg-slate-50 disabled:text-ink-3'
const inputState = (invalid?: boolean) => (invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : 'border-line focus:border-brand-500 focus:ring-brand-100')

export function Input({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} aria-invalid={invalid || undefined} className={cx(inputBase, inputState(invalid), className)} />
}

export function Select({ invalid, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} aria-invalid={invalid || undefined} className={cx(inputBase, inputState(invalid), 'pr-8', className)}>
      {children}
    </select>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-9" />
    </div>
  )
}

// ───────── Layout primitives ─────────
export function Card({ title, subtitle, actions, children, className, bodyClassName }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div>
            {title && <h2 className="text-[14.5px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName ?? 'p-5'}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, description, actions, badge }: { title: string; description?: string; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-[22px] font-bold tracking-tight text-ink">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1 text-[13.5px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'navy'
const TONES: Record<Tone, string> = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  navy: 'bg-navy-900 text-white ring-navy-900'
}
export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ring-1 ring-inset whitespace-nowrap', TONES[tone], className)}>{children}</span>
}

export const DemoBadge = ({ label = 'DEMO' }: { label?: string }) => <Badge tone="amber" className="tracking-wider">{label}</Badge>

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-3">
      <Loader2 className="size-5 animate-spin" />
      <span className="text-[13px]">{label}</span>
    </div>
  )
}

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-ink-3">
        <Inbox className="size-6" />
      </div>
      <p className="font-semibold text-ink">{title}</p>
      {message && <p className="mt-1 max-w-md text-[13px] text-ink-2">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorBanner({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1 text-[13px] font-medium">{error.message}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-[13px] font-semibold underline">
          Retry
        </button>
      )}
    </div>
  )
}

// ───────── Drawer (side panel form) ─────────
export function Drawer({ open, title, subtitle, onClose, children, footer, width = 'w-[640px]' }: { open: boolean; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-navy-950/35 backdrop-blur-[1px]" onClick={onClose} />
      <div role="dialog" aria-modal="true" className={cx('relative flex h-full max-w-full flex-col bg-white shadow-2xl', width)}>
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-[17px] font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-slate-100 hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-slate-50/60 px-6 py-3.5">{footer}</footer>}
      </div>
    </div>
  )
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mb-6">
      <legend className="mb-3 text-[11.5px] font-bold tracking-wider text-ink-3 uppercase">{title}</legend>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">{children}</div>
    </fieldset>
  )
}

// ───────── Data table ─────────
export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  sortValue?: (row: T) => string | number | null
  align?: 'left' | 'right' | 'center'
  width?: string
  /** Allow text to wrap (names, summaries). Other cells stay on one line. */
  wrap?: boolean
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, empty, maxHeight = 'max-h-[calc(100vh-290px)]', footer }: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string | number
  onRowClick?: (row: T) => void
  empty?: ReactNode
  maxHeight?: string
  footer?: ReactNode
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a)
      const vb = col.sortValue!(b)
      if (va === vb) return 0
      if (va === null) return 1
      if (vb === null) return -1
      return (va > vb ? 1 : -1) * sort.dir
    })
  }, [rows, columns, sort])

  if (rows.length === 0) return <>{empty ?? <EmptyState title="No records" />}</>
  return (
    <div className={cx('overflow-auto', maxHeight)}>
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width }}
                className={cx('border-b border-line bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-wide whitespace-nowrap text-ink-3 uppercase', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left')}
              >
                {c.sortValue ? (
                  <button className="inline-flex items-center gap-1 uppercase hover:text-ink" onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}>
                    {c.header}
                    {sort?.key === c.key ? sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-50" />}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} className={cx('group', onRowClick && 'cursor-pointer')}>
              {columns.map((c) => (
                <td key={c.key} className={cx('border-b border-slate-100 px-4 py-2.5 align-middle group-hover:bg-brand-50/50', c.wrap ? 'min-w-[180px]' : 'whitespace-nowrap', c.align === 'right' ? 'text-right tabular' : c.align === 'center' ? 'text-center' : 'text-left')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">{footer}</tfoot>}
      </table>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-slate-50 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cx('rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors', value === t.value ? 'bg-white text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-ink-3">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] text-ink">{value ?? '—'}</dd>
    </div>
  )
}
