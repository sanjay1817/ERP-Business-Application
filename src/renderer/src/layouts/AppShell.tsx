import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bell, Building2, Check, ChevronDown, ChevronRight, LogOut, Search, AlertTriangle, Info, OctagonAlert } from 'lucide-react'
import type { Company, NotificationItem, SearchResult } from '@shared/types'
import { api } from '../lib/api'
import { useDebounced, useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { useToast } from '../lib/toast'
import { cx, DemoBadge } from '../components/ui'
import { NAV, breadcrumbsFor } from './nav'

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside()
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onOutside])
  return ref
}

function Sidebar() {
  const { can, session } = useSession()
  const groups = [...new Set(NAV.map((n) => n.group))]
  return (
    <aside className="flex w-[248px] shrink-0 flex-col bg-navy-900 text-navy-200">
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
        <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-[13px] font-black tracking-tight text-white shadow-lg shadow-black/20">SA</div>
        <div className="leading-tight">
          <p className="text-[15px] font-bold text-white">SA Business ERP</p>
          <p className="text-[11px] text-navy-300">Enterprise Management</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <p className="mb-1.5 px-3 text-[10.5px] font-bold tracking-[0.12em] text-navy-300/70 uppercase">{g}</p>
            {NAV.filter((n) => n.group === g).map((n) => {
              const allowed = !n.permission || can(n.permission)
              if (!allowed) return null
              return (
                <NavLink
                  key={n.path}
                  to={n.path}
                  className={({ isActive }) =>
                    cx(
                      'group mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors',
                      isActive ? 'bg-white/[0.09] text-white shadow-[inset_3px_0_0_var(--color-brand-500)]' : 'text-navy-200 hover:bg-white/[0.05] hover:text-white'
                    )
                  }
                >
                  <n.icon className="size-[18px] shrink-0 opacity-90" />
                  {n.label}
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/10 px-5 py-3 text-[11px] text-navy-300">
        {session?.environment === 'DEMO' ? 'DEMO database · sample data only' : session?.environment === 'COMPANY' ? 'Company database' : session?.company?.isDemo ? 'Demo mode · sample data' : 'Workspace'}
      </div>
    </aside>
  )
}

function GlobalSearch() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [active, setActive] = useState(0)
  const debounced = useDebounced(q.trim(), 200)
  const navigate = useNavigate()
  const ref = useClickOutside(() => setOpen(false))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!debounced) return setResults([])
    let cancelled = false
    api('search:global', { query: debounced })
      .then((r) => !cancelled && (setResults(r), setActive(0)))
      .catch(() => !cancelled && setResults([]))
    return () => {
      cancelled = true
    }
  }, [debounced])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const go = (r: SearchResult) => {
    navigate(r.route)
    setOpen(false)
    setQ('')
  }

  return (
    <div ref={ref} className="relative w-full max-w-[460px] min-w-[220px]">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1))
          if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
          if (e.key === 'Enter' && results[active]) go(results[active])
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Search parties, items, invoices…"
        className="h-9 w-full rounded-lg border border-line bg-slate-50 pr-14 pl-9 text-[13.5px] placeholder:text-ink-3 focus:border-brand-500 focus:bg-white focus:ring-3 focus:ring-brand-100 focus:outline-none"
        aria-label="Global search"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-line bg-white px-1.5 text-[10.5px] font-semibold text-ink-3">Ctrl K</kbd>
      {open && debounced && (
        <div className="absolute top-11 right-0 left-0 z-40 overflow-hidden rounded-xl border border-line bg-white shadow-xl shadow-slate-900/10">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-ink-3">No matches for “{debounced}”</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto py-1">
              {results.map((r, i) => (
                <li key={`${r.type}-${r.id}`}>
                  <button onMouseEnter={() => setActive(i)} onClick={() => go(r)} className={cx('flex w-full flex-col px-4 py-2 text-left', i === active && 'bg-brand-50')}>
                    <span className="text-[13.5px] font-semibold text-ink">{r.title}</span>
                    <span className="text-[12px] text-ink-3">{r.subtitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Notifications() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const { session } = useSession()
  const { data } = useQuery<NotificationItem[]>(() => api('notifications:list'), [location.pathname, session?.company?.id])
  const ref = useClickOutside(() => setOpen(false))
  const items = data ?? []
  const alerts = items.filter((n) => n.severity !== 'info').length
  const icon = (s: NotificationItem['severity']) =>
    s === 'critical' ? <OctagonAlert className="size-4 text-red-600" /> : s === 'warning' ? <AlertTriangle className="size-4 text-amber-600" /> : <Info className="size-4 text-brand-600" />
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-slate-100 hover:text-ink" aria-label={`Notifications (${alerts} alerts)`}>
        <Bell className="size-[18px]" />
        {alerts > 0 && <span className="absolute -top-0.5 -right-0.5 grid min-w-[18px] place-items-center rounded-full bg-red-600 px-1 text-[10.5px] font-bold text-white ring-2 ring-white">{alerts}</span>}
      </button>
      {open && (
        <div className="absolute top-11 right-0 z-40 w-[380px] overflow-hidden rounded-xl border border-line bg-white shadow-xl shadow-slate-900/10">
          <div className="border-b border-line px-4 py-3">
            <p className="font-semibold text-ink">Notifications</p>
            <p className="text-[12px] text-ink-3">Generated from live stock and receivable data</p>
          </div>
          <ul className="max-h-[420px] overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-8 text-center text-[13px] text-ink-3">You're all caught up</li>}
            {items.map((n) => (
              <li key={n.id}>
                <Link to={n.route ?? '#'} onClick={() => setOpen(false)} className="flex gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-50">
                  <span className="mt-0.5">{icon(n.severity)}</span>
                  <span>
                    <span className="block text-[13px] font-semibold text-ink">{n.title}</span>
                    <span className="block text-[12.5px] text-ink-2">{n.message}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function CompanySwitcher() {
  const { session, switchCompany } = useSession()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const { data } = useQuery<Company[]>(() => (open ? api('company:list') : Promise.resolve([])), [open])
  const company = session?.company
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-[13px] hover:bg-slate-50">
        <Building2 className="size-4 text-ink-3" />
        <span className="max-w-[200px] truncate font-semibold text-ink">{company?.name ?? 'No company'}</span>
        {company && <span className="text-[11.5px] whitespace-nowrap text-ink-3">FY {company.financialYear}</span>}
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>
      {open && (
        <div className="absolute top-11 right-0 z-40 w-80 rounded-xl border border-line bg-white py-1 shadow-xl shadow-slate-900/10">
          <p className="px-4 pt-2 pb-1 text-[11px] font-bold tracking-wider text-ink-3 uppercase">Switch company</p>
          {(data ?? []).filter((c) => c.isActive).map((c) => (
            <button
              key={c.id}
              onClick={async () => {
                setOpen(false)
                if (c.id === company?.id) return
                try {
                  await switchCompany(c.id)
                  toast('success', `Switched to ${c.name}`)
                } catch (e) {
                  toast('error', 'Could not switch company', (e as Error).message)
                }
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-50"
            >
              <span className="flex-1">
                <span className="block text-[13px] font-semibold text-ink">{c.name}</span>
                <span className="block text-[12px] text-ink-3">{c.code}{c.gstin ? ` · ${c.gstin}` : ''}</span>
              </span>
              {c.isDemo && <DemoBadge />}
              {c.id === company?.id && <Check className="size-4 text-brand-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { session, logout } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useClickOutside(() => setOpen(false))
  const initials = (session?.fullName ?? '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 hover:bg-slate-100">
        <span className="grid size-8 place-items-center rounded-full bg-navy-800 text-[12px] font-bold text-white">{initials}</span>
        <span className="max-w-[150px] text-left leading-tight">
          <span className="block truncate text-[13px] font-semibold whitespace-nowrap text-ink">{session?.fullName}</span>
          <span className="block text-[11.5px] text-ink-3">{session?.roleName}</span>
        </span>
        <ChevronDown className="size-3.5 text-ink-3" />
      </button>
      {open && (
        <div className="absolute top-12 right-0 z-40 w-60 rounded-xl border border-line bg-white py-1 shadow-xl shadow-slate-900/10">
          <div className="border-b border-line px-4 py-2.5">
            <p className="text-[13px] font-semibold text-ink">{session?.username}</p>
            <p className="text-[12px] text-ink-3">{session?.permissions.length} permissions</p>
          </div>
          <button onClick={() => void logout()} className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-red-700 hover:bg-red-50">
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function Breadcrumbs() {
  const { pathname } = useLocation()
  const crumbs = breadcrumbsFor(pathname)
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12.5px] text-ink-3">
      {crumbs.map((c, i) => (
        <span key={c.path + i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5" />}
          {i === crumbs.length - 1 ? <span className="font-semibold text-ink-2">{c.label}</span> : <Link to={c.path} className="hover:text-ink">{c.label}</Link>}
        </span>
      ))}
    </nav>
  )
}

export default function AppShell() {
  const { session } = useSession()
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {session?.environment === 'DEMO' && (
          <div role="status" data-testid="demo-database-banner" className="shrink-0 bg-amber-400 px-6 py-1.5 text-center text-[12.5px] font-semibold text-amber-950">
            DEMO DATABASE — sample data for training only. Your company books are kept in a separate database. E-invoices and e-way bills here are DEMO records, never government records.
          </div>
        )}
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-white px-6">
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            {session?.roleCode === 'AUDITOR' && (
              <Link to="/auditor" className="rounded-md bg-navy-900 px-2 py-1 text-[11.5px] font-bold tracking-wide whitespace-nowrap text-white" title="Read-only auditor session">AUDITOR · READ-ONLY</Link>
            )}
            {session?.company?.isDemo && <DemoBadge label="DEMO COMPANY" />}
            <CompanySwitcher />
            <Notifications />
            <div className="mx-1 h-7 w-px bg-line" />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1600px] px-7 pt-4 pb-10">
            <Breadcrumbs />
            <div className="mt-3">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
