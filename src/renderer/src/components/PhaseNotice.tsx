import type { ReactNode } from 'react'
import { Info } from 'lucide-react'

/** Honest, visible note about what a module does today vs. what's planned. */
export function PhaseNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-brand-100 bg-brand-50 px-4 py-3 text-[13px] text-navy-800">
      <Info className="mt-0.5 size-4 shrink-0 text-brand-600" />
      <div>{children}</div>
    </div>
  )
}
