import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionInfo } from '@shared/types'
import { api, onUnauthenticated } from './api'

interface SessionCtx {
  session: SessionInfo | null
  ready: boolean
  setSession: (s: SessionInfo | null) => void
  can: (permission: string) => boolean
  logout: () => Promise<void>
  switchCompany: (id: number) => Promise<void>
}

const Ctx = createContext<SessionCtx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    api('auth:session')
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setReady(true))
    return onUnauthenticated(() => setSession(null))
  }, [])

  const can = useCallback((p: string) => !!session?.permissions.includes(p), [session])
  const logout = useCallback(async () => {
    try {
      await api('auth:logout')
    } finally {
      setSession(null)
    }
  }, [])
  const switchCompany = useCallback(async (id: number) => setSession(await api('company:switch', { id })), [])

  const value = useMemo(() => ({ session, ready, setSession, can, logout, switchCompany }), [session, ready, can, logout, switchCompany])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}
