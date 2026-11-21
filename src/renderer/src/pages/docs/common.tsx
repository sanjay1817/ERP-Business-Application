import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { FileDown, Printer } from 'lucide-react'
import { KINDS, SIDE_KINDS, type DocStatus, type DocumentKind, type PaymentStatus, type Side } from '@shared/documents'
import { api } from '../../lib/api'
import { useToast } from '../../lib/toast'
import { Badge, Button, Spinner, cx } from '../../components/ui'
import { Modal } from '../../components/Modal'

export const sideRoot = (side: Side) => (side === 'SALES' ? '/sales' : '/purchase')
export const paymentsSlug = (side: Side) => (side === 'SALES' ? 'receipts' : 'payments')

/** Secondary navigation for the Sales / Purchase modules. */
export function ModuleNav({ side }: { side: Side }) {
  const root = sideRoot(side)
  const items = [
    { to: root, label: 'Dashboard', end: true },
    ...(side === 'SALES' ? [{ to: `${root}/customers`, label: 'Customers', end: false }] : []),
    ...SIDE_KINDS[side].map((k) => ({ to: `${root}/${KINDS[k].slug}`, label: KINDS[k].plural.replace(/^(Sales|Purchase) /, ''), end: false })),
    { to: `${root}/${paymentsSlug(side)}`, label: side === 'SALES' ? 'Receipts' : 'Payments', end: false },
    { to: `${root}/register`, label: 'Register', end: false }
  ]
  return (
    <nav aria-label={`${side === 'SALES' ? 'Sales' : 'Purchase'} sections`} className="-mx-1 mb-5 flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-line px-1">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) =>
            cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold whitespace-nowrap transition-colors', isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-2 hover:border-slate-300 hover:text-ink')
          }
        >
          {i.label}
        </NavLink>
      ))}
    </nav>
  )
}

export function StatusBadge({ status }: { status: DocStatus }) {
  return <Badge tone={status === 'POSTED' ? 'green' : status === 'CANCELLED' ? 'red' : 'gray'}>{status === 'POSTED' ? 'Posted' : status === 'CANCELLED' ? 'Cancelled' : 'Draft'}</Badge>
}

export function PaymentBadge({ status, overdue }: { status: PaymentStatus; overdue?: number }) {
  if (status === 'NA') return null
  if (overdue && overdue > 0 && status !== 'PAID') return <Badge tone="red">Overdue {overdue}d</Badge>
  return <Badge tone={status === 'PAID' ? 'green' : status === 'PARTIAL' ? 'amber' : 'gray'}>{status === 'PAID' ? 'Paid' : status === 'PARTIAL' ? 'Part-paid' : 'Unpaid'}</Badge>
}

/** Print/PDF preview. Rendered inside a Shadow DOM so its stylesheet cannot leak into the app. */
export function DocumentPreview({ kind, id, open, onClose }: { kind: DocumentKind; id: number; open: boolean; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null)
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    setHtml(null)
    setError(null)
    api('doc:printHtml', { kind, id })
      .then((r) => setHtml(r.html))
      .catch((e: Error) => setError(e.message))
  }, [open, kind, id])

  useEffect(() => {
    if (!html || !host.current) return
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' })
    root.innerHTML = `<style>.wm{position:absolute!important}</style>${html}`
  }, [html])

  const exportPdf = async () => {
    setBusy('pdf')
    try {
      const r = await api('doc:exportPdf', { kind, id })
      if (r.path) toast('success', 'PDF saved', r.path)
    } catch (e) {
      toast('error', 'PDF export failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const print = async () => {
    setBusy('print')
    try {
      const r = await api('doc:print', { kind, id })
      if (r.printed) toast('success', 'Sent to printer')
    } catch (e) {
      toast('error', 'Printing failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${KINDS[kind].label} preview`}
      subtitle="Exactly what will be printed or exported to PDF (A4)"
      width="max-w-[900px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="secondary" icon={<Printer className="size-4" />} loading={busy === 'print'} onClick={() => void print()} disabled={!html}>Print…</Button>
          <Button icon={<FileDown className="size-4" />} loading={busy === 'pdf'} onClick={() => void exportPdf()} disabled={!html}>Export PDF…</Button>
        </>
      }
    >
      {error && <p className="py-10 text-center text-red-700">{error}</p>}
      {!html && !error && <Spinner label="Rendering…" />}
      <div className={cx('mx-auto w-[794px] max-w-full rounded border border-line bg-white p-[11mm] shadow-sm', !html && 'hidden')}>
        <div ref={host} className="relative" />
      </div>
    </Modal>
  )
}
