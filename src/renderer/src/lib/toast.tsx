import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'

type Kind = 'success' | 'error' | 'info'
interface Toast {
  id: number
  kind: Kind
  title: string
  message?: string
}

const Ctx = createContext<(kind: Kind, title: string, message?: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  const push = useCallback((kind: Kind, title: string, message?: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, kind, title, message }])
    setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000)
  }, [])

  const icon = { success: <CheckCircle2 className="size-5 text-emerald-600" />, error: <XCircle className="size-5 text-red-600" />, info: <Info className="size-5 text-brand-600" /> }
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-[100] flex w-96 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-white p-3.5 shadow-lg shadow-slate-900/10">
            {icon[t.kind]}
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">{t.title}</p>
              {t.message && <p className="mt-0.5 text-[13px] text-ink-2">{t.message}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-ink-3 hover:text-ink" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
