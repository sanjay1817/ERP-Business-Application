import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useSession } from '../lib/session'

export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useSession()
  if (can(permission)) return <>{children}</>
  return (
    <div className="grid place-items-center py-24 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3 text-ink-3">
        <Lock className="size-6" />
      </div>
      <p className="text-[15px] font-semibold text-ink">Access restricted</p>
      <p className="mt-1 text-[13px] text-ink-2">Your role does not include the “{permission}” permission. Contact your administrator.</p>
    </div>
  )
}
