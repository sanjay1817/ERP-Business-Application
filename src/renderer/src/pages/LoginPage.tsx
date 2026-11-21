import { useState, type FormEvent } from 'react'
import type { WorkspaceStatus } from '@shared/backup'
import { CompanySetupPage } from './WorkspacePages'
import { BarChart3, Lock, ShieldCheck, Truck, User } from 'lucide-react'
import type { LoginInfo } from '@shared/types'
import { api, ApiError } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { Button, DemoBadge, Field, Input } from '../components/ui'

function WorkspaceChoice({ workspace, onSetup }: { workspace: WorkspaceStatus | null; onSetup: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  if (!workspace?.environment) return null
  const go = async (target: 'DEMO' | 'COMPANY') => {
    setBusy(true)
    try {
      const r = await api('workspace:switch', { target })
      setMsg(r.relaunching ? 'Restarting with the selected database…' : null)
    } catch (e) {
      setMsg((e as ApiError).message)
      setBusy(false)
    }
  }
  const link = 'font-semibold text-brand-700 hover:underline disabled:opacity-50'
  return (
    <div className="mt-6 border-t border-line pt-4 text-[12.5px] text-ink-2" data-testid="workspace-choice">
      {workspace.environment === 'DEMO' ? (
        <p>
          You are opening the <b>DEMO database</b>.{' '}
          {workspace.companyDatabaseExists ? (
            <button type="button" className={link} disabled={busy} onClick={() => void go('COMPANY')}>Open company data</button>
          ) : (
            <button type="button" className={link} disabled={busy} onClick={onSetup} data-testid="login-setup-company">Set up my company</button>
          )}
        </p>
      ) : (
        <p>
          You are opening your <b>company database</b>.{' '}
          <button type="button" className={link} disabled={busy} onClick={() => void go('DEMO')}>Open the demo instead</button> (separate sample data)
        </p>
      )}
      {msg && <p role="status" className="mt-2 text-ink">{msg}</p>}
    </div>
  )
}

export default function LoginPage({ workspace = null }: { workspace?: WorkspaceStatus | null }) {
  const { setSession } = useSession()
  const [setup, setSetup] = useState(false)
  const { data: info } = useQuery<LoginInfo>(() => api('app:loginInfo'))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    setBusy(true)
    try {
      const session = await api('auth:login', { username, password })
      // Auditors land in their own read-only workspace.
      if (session.roleCode === 'AUDITOR') location.hash = '#/auditor'
      setSession(session)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.message)
      setFieldErrors(apiErr.fieldErrors ?? {})
    } finally {
      setBusy(false)
    }
  }

  if (setup) return <CompanySetupPage onBack={() => setSetup(false)} />
  return (
    <div className="flex h-full">
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-navy-900 p-12 text-white lg:flex">
        <div className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full bg-brand-600/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-48 -left-32 size-[480px] rounded-full bg-brand-500/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-[15px] font-black shadow-lg shadow-black/30">SA</div>
          <div>
            <p className="text-lg font-bold">SA Business ERP</p>
            <p className="text-[13px] text-navy-300">Enterprise Management</p>
          </div>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-[34px] leading-tight font-bold tracking-tight">Run sales, purchases, stock and accounts from one place.</h1>
          <p className="mt-4 text-[15px] text-navy-200">Every posted document updates stock, receivables, payables and a balanced ledger — with a complete audit trail.</p>
          <ul className="mt-8 space-y-3 text-[14px] text-navy-200">
            <li className="flex items-center gap-3"><BarChart3 className="size-5 text-brand-500" /> Live dashboard from posted transactions</li>
            <li className="flex items-center gap-3"><ShieldCheck className="size-5 text-brand-500" /> Immutable postings, reversals and audit log</li>
            <li className="flex items-center gap-3"><Truck className="size-5 text-brand-500" /> GST, E-Invoice and E-Way Bill ready architecture</li>
          </ul>
        </div>
        <p className="relative text-[12px] text-navy-300">© 2026 SA Business ERP · Windows desktop edition</p>
      </div>

      <div className="flex flex-1 items-center justify-center bg-white p-8">
        <form data-testid="login-form" onSubmit={submit} className="w-full max-w-[380px]" noValidate>
          <h2 className="flex items-center gap-2 text-[24px] font-bold tracking-tight text-ink">Sign in {workspace?.environment === 'DEMO' && <DemoBadge label="DEMO DATABASE" />}</h2>
          {workspace?.startupNotice && <div role="status" className="mt-3 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-2.5 text-[12.5px] text-brand-900">{workspace.startupNotice}</div>}
          <p className="mt-1 text-[14px] text-ink-2">Use your SA Business ERP account to continue.</p>

          {error && <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] font-medium text-red-800">{error}</div>}

          <div className="mt-6 space-y-4">
            <Field label="Username" error={fieldErrors.username}>
              <div className="relative">
                <User className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="h-10 pl-9" invalid={!!fieldErrors.username} />
              </div>
            </Field>
            <Field label="Password" error={fieldErrors.password}>
              <div className="relative">
                <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 pl-9" invalid={!!fieldErrors.password} />
              </div>
            </Field>
          </div>
          <Button type="submit" loading={busy} className="mt-6 h-10 w-full text-[14px]">
            Sign in
          </Button>

          {info?.demoMode && (
            <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
              <div className="mb-2 flex items-center gap-2">
                <DemoBadge />
                <p className="text-[12.5px] font-semibold text-amber-900">Demonstration accounts</p>
              </div>
              <div className="space-y-1">
                {info.demoUsers.map((u) => (
                  <button
                    key={u.username}
                    type="button"
                    onClick={() => (setUsername(u.username), setPassword(u.password))}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-amber-100/70"
                  >
                    <span className="font-mono font-semibold text-ink">{u.username} / {u.password}</span>
                    <span className="text-ink-2">{u.role.toLowerCase()}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-amber-900/80">Shown only for the DEMO database. They never work in your company database.</p>
            </div>
          )}
          <WorkspaceChoice workspace={workspace} onSetup={() => setSetup(true)} />
        </form>
      </div>
    </div>
  )
}
