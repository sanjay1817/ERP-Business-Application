import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button, cx } from './ui'

export function Modal({ open, title, subtitle, onClose, children, footer, width = 'max-w-lg' }: { open: boolean; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-navy-950/40" onClick={onClose} />
      <div role="dialog" aria-modal="true" className={cx('relative flex max-h-full w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl', width)}>
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[16px] font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-slate-100 hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-slate-50/60 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onClose }: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Back</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm} autoFocus>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
