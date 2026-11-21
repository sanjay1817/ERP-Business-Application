import { useState, type ReactNode } from 'react'
import { Building2, Database, FlaskConical, KeyRound, ShieldAlert } from 'lucide-react'
import { GST_STATES } from '@shared/india'
import type { WorkspaceStatus } from '@shared/backup'
import { api, ApiError } from '../lib/api'
import { text, useForm } from '../lib/form'
import { useSession } from '../lib/session'
import { Button, DemoBadge, Field, Input, Select } from '../components/ui'

/** Full-screen frame used by first-run, setup and forced password change. */
function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-[#f5f7fb] p-8">
      <div className={wide ? 'w-full max-w-[760px]' : 'w-full max-w-[460px]'}>
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-[14px] font-black text-white">SA</div>
          <div>
            <p className="text-[16px] font-bold text-ink">SA Business ERP</p>
            <p className="text-[12.5px] text-ink-3">Enterprise Management</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

const Restarting = () => (
  <div role="status" className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-[13px] text-brand-800">The application is restarting with the selected database…</div>
)

/** First run: nothing chosen yet. Company books and the demo are separate database files. */
export function FirstRunPage({ status }: { status: WorkspaceStatus }) {
  const [mode, setMode] = useState<'choose' | 'setup'>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  async function openDemo() {
    setBusy(true)
    setError(null)
    try {
      const r = await api('workspace:switch', { target: 'DEMO' })
      setRestarting(r.relaunching)
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setBusy(false)
    }
  }
  if (mode === 'setup') return <CompanySetupPage onBack={() => setMode('choose')} />
  return (
    <Frame wide>
      <h1 className="text-[24px] font-bold tracking-tight text-ink">Welcome</h1>
      <p className="mt-1 text-[14px] text-ink-2">Choose how to start. Your company books and the demonstration data are kept in separate database files and never mix.</p>
      {error && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-800">{error}</div>}
      <div className="mt-6 grid grid-cols-2 gap-4">
        <button type="button" data-testid="setup-company" onClick={() => setMode('setup')} className="rounded-xl border border-line bg-white p-5 text-left shadow-sm transition hover:border-brand-400 hover:shadow">
          <Building2 className="size-6 text-brand-600" />
          <p className="mt-3 text-[15px] font-semibold text-ink">Set up my company</p>
          <p className="mt-1 text-[13px] text-ink-2">Create the company database with your own administrator account and password. No sample data or demo passwords.</p>
        </button>
        <button type="button" data-testid="open-demo" disabled={busy || restarting} onClick={openDemo} className="rounded-xl border border-amber-200 bg-amber-50/50 p-5 text-left shadow-sm transition hover:border-amber-400 hover:shadow">
          <FlaskConical className="size-6 text-amber-600" />
          <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-ink">Explore the demo <DemoBadge /></p>
          <p className="mt-1 text-[13px] text-ink-2">Open a separate DEMO database with sample company, transactions and published demo sign-ins. Nothing in it is real.</p>
        </button>
      </div>
      {restarting && <Restarting />}
      <p className="mt-6 flex items-center gap-2 text-[12px] text-ink-3"><Database className="size-3.5" /> Data folder: <span className="font-mono">{status.dataDirectory}</span></p>
    </Frame>
  )
}

const SETUP_EMPTY = {
  'company.code': '', 'company.name': '', 'company.legalName': '', 'company.gstin': '', 'company.pan': '', 'company.stateCode': '33', 'company.addressLine1': '',
  'company.city': '', 'company.pincode': '', 'company.phone': '', 'company.email': '', 'company.fyStartMonth': '4',
  adminUsername: '', adminFullName: '', adminPassword: '', confirmPassword: ''
}

export function CompanySetupPage({ onBack }: { onBack: () => void }) {
  const form = useForm(SETUP_EMPTY)
  const [restarting, setRestarting] = useState(false)
  const b = form.bind
  const err = form.errors
  async function save() {
    const v = form.values
    const c = (k: string) => text(v, `company.${k}`)
    const res = await form.submit(
      () => ({
        company: {
          code: c('code'), name: c('name'), legalName: c('legalName'), gstin: c('gstin'), pan: c('pan'), stateCode: c('stateCode'), addressLine1: c('addressLine1'), addressLine2: '',
          city: c('city'), pincode: c('pincode'), phone: c('phone'), email: c('email'), fyStartMonth: Number(v['company.fyStartMonth'])
        },
        adminUsername: text(v, 'adminUsername'), adminFullName: text(v, 'adminFullName'), adminPassword: String(v.adminPassword), confirmPassword: String(v.confirmPassword)
      }),
      (p) => api('workspace:setupCompany', p),
      () => 'Company database created'
    )
    if (res) setRestarting(true)
  }
  return (
    <Frame wide>
      <h1 className="text-[22px] font-bold tracking-tight text-ink">Set up your company</h1>
      <p className="mt-1 text-[13.5px] text-ink-2">This creates a new, empty company database. Opening balances, customers, suppliers and products are entered after sign-in.</p>
      {form.formError && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-800">{form.formError}</div>}
      <div className="mt-5 rounded-xl border border-line bg-white p-5">
        <p className="mb-3 text-[13px] font-semibold text-ink">Company</p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Short code" required error={err['company.code']} hint="e.g. SAE"><Input {...b('company.code')} /></Field>
          <Field label="Trade name" required error={err['company.name']} className="col-span-2"><Input {...b('company.name')} /></Field>
          <Field label="Legal name" error={err['company.legalName']} className="col-span-2"><Input {...b('company.legalName')} /></Field>
          <Field label="State" required error={err['company.stateCode']}>
            <Select {...b('company.stateCode')}>{GST_STATES.filter((s) => s.code !== '96').map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}</Select>
          </Field>
          <Field label="GSTIN" error={err['company.gstin']}><Input {...b('company.gstin')} className="font-mono uppercase" /></Field>
          <Field label="PAN" error={err['company.pan']}><Input {...b('company.pan')} className="font-mono uppercase" /></Field>
          <Field label="Financial year starts" error={err['company.fyStartMonth']}>
            <Select {...b('company.fyStartMonth')}><option value="4">April</option><option value="1">January</option></Select>
          </Field>
          <Field label="Address" error={err['company.addressLine1']} className="col-span-3"><Input {...b('company.addressLine1')} /></Field>
          <Field label="City" error={err['company.city']}><Input {...b('company.city')} /></Field>
          <Field label="PIN code" error={err['company.pincode']}><Input {...b('company.pincode')} /></Field>
          <Field label="Phone" error={err['company.phone']}><Input {...b('company.phone')} /></Field>
        </div>
      </div>
      <div className="mt-4 rounded-xl border border-line bg-white p-5">
        <p className="mb-1 text-[13px] font-semibold text-ink">Administrator account</p>
        <p className="mb-3 text-[12.5px] text-ink-3">At least 10 characters with letters and a number. Keep it safe: there is no password recovery without another administrator.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username" required error={err.adminUsername}><Input {...b('adminUsername')} autoComplete="off" /></Field>
          <Field label="Full name" required error={err.adminFullName}><Input {...b('adminFullName')} /></Field>
          <Field label="Password" required error={err.adminPassword}><Input type="password" {...b('adminPassword')} autoComplete="new-password" /></Field>
          <Field label="Confirm password" required error={err.confirmPassword}><Input type="password" {...b('confirmPassword')} autoComplete="new-password" /></Field>
        </div>
      </div>
      <div className="mt-5 flex justify-between">
        <Button variant="secondary" onClick={onBack} disabled={form.saving || restarting}>Back</Button>
        <Button onClick={save} loading={form.saving} disabled={restarting} data-testid="create-company-db">Create company database</Button>
      </div>
      {restarting && <Restarting />}
    </Frame>
  )
}

/** Change own password. Forced (full screen, no navigation) when the server requires it. */
export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { setSession, logout } = useSession()
  const form = useForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const b = form.bind
  async function save() {
    const v = form.values
    const s = await form.submit(
      () => ({ currentPassword: String(v.currentPassword), newPassword: String(v.newPassword), confirmPassword: String(v.confirmPassword) }),
      (p) => api('auth:changePassword', p),
      () => 'Password changed'
    )
    if (s) {
      setSession(s)
      onDone?.()
    }
  }
  return (
    <div>
      {form.formError && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-800">{form.formError}</div>}
      <div className="space-y-3">
        <Field label={forced ? 'Current (temporary) password' : 'Current password'} required error={form.errors.currentPassword}><Input type="password" {...b('currentPassword')} autoComplete="current-password" autoFocus /></Field>
        <Field label="New password" required error={form.errors.newPassword} hint="At least 10 characters with letters and a number"><Input type="password" {...b('newPassword')} autoComplete="new-password" /></Field>
        <Field label="Confirm new password" required error={form.errors.confirmPassword}><Input type="password" {...b('confirmPassword')} autoComplete="new-password" /></Field>
      </div>
      <div className="mt-5 flex justify-between">
        {forced ? <Button variant="secondary" onClick={() => void logout()}>Sign out</Button> : <span />}
        <Button onClick={save} loading={form.saving} data-testid="change-password">Change password</Button>
      </div>
    </div>
  )
}

export function ForcedPasswordChangePage() {
  const { session } = useSession()
  return (
    <Frame>
      <div className="rounded-xl border border-line bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div>
            <h1 className="text-[18px] font-bold text-ink">Choose a new password</h1>
            <p className="mt-1 text-[13px] text-ink-2">
              {session?.username}, your password was set by an administrator or is a published demo password. You must change it before continuing.
            </p>
          </div>
        </div>
        <ChangePasswordForm forced />
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-3"><KeyRound className="size-3.5" /> Passwords are stored only as salted scrypt hashes.</p>
    </Frame>
  )
}
