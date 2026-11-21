import { useState } from 'react'
import { KeyRound, Lock, Plus, Unlock } from 'lucide-react'
import { ROLE_CODES } from '@shared/backup'
import type { RoleRow, UserAdminRow } from '@shared/types'
import { api, ApiError } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { useToast } from '../lib/toast'
import { text, useForm } from '../lib/form'
import { formatDateTime } from '../lib/format'
import { Badge, Button, Card, DataTable, ErrorBanner, Field, Input, PageHeader, Select, Spinner } from '../components/ui'
import { Modal } from '../components/Modal'
import { ChangePasswordForm } from './WorkspacePages'

type Editing = { mode: 'new' } | { mode: 'edit'; user: UserAdminRow } | { mode: 'reset'; user: UserAdminRow } | { mode: 'self' } | null

export default function UsersPage() {
  const { can, session } = useSession()
  const toast = useToast()
  const users = useQuery<UserAdminRow[]>(() => api('user:adminList'))
  const roles = useQuery<RoleRow[]>(() => api('user:roles'))
  const [editing, setEditing] = useState<Editing>(null)
  const manage = can('user.manage')

  async function unlock(u: UserAdminRow) {
    try {
      await api('user:unlock', { id: u.id })
      toast('success', `${u.username} unlocked`)
      users.reload()
    } catch (e) {
      toast('error', 'Not unlocked', (e as ApiError).message)
    }
  }

  return (
    <div>
      <PageHeader
        title="User Management"
        description="Each person signs in with their own account. Permissions are enforced by the main process on every request."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setEditing({ mode: 'self' })}>Change my password</Button>
            {manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ mode: 'new' })} data-testid="new-user">New user</Button>}
          </div>
        }
      />
      <ErrorBanner error={users.error ?? roles.error} onRetry={users.reload} />
      <div className="space-y-4">
        <Card title="Users" bodyClassName="p-0">
          {users.loading && !users.data ? <Spinner /> : (
            <DataTable
              rows={users.data ?? []}
              rowKey={(r) => r.id}
              maxHeight=""
              columns={[
                { key: 'u', header: 'User', render: (r) => <div><p className="font-mono font-semibold">{r.username}{r.id === session?.userId && <span className="ml-1.5 font-sans text-[11px] font-normal text-ink-3">(you)</span>}</p><p className="text-[12px] text-ink-2">{r.fullName}</p></div> },
                { key: 'r', header: 'Role', render: (r) => <Badge tone="blue">{r.roleName}</Badge> },
                { key: 'l', header: 'Last sign-in', render: (r) => <span className="text-[12.5px] text-ink-2">{formatDateTime(r.lastLoginAt)}</span> },
                {
                  key: 's', header: 'Status', render: (r) => (
                    <div className="flex flex-wrap gap-1">
                      {r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>}
                      {r.isLocked && <Badge tone="red">Locked</Badge>}
                      {r.mustChangePassword && <Badge tone="amber">Must change password</Badge>}
                    </div>
                  )
                },
                {
                  key: 'a', header: '', render: (r) => manage && (
                    <div className="flex justify-end gap-1.5">
                      {r.isLocked && <Button variant="secondary" icon={<Unlock className="size-3.5" />} onClick={() => void unlock(r)}>Unlock</Button>}
                      <Button variant="secondary" onClick={() => setEditing({ mode: 'edit', user: r })}>Edit</Button>
                      {r.id !== session?.userId && <Button variant="secondary" icon={<Lock className="size-3.5" />} onClick={() => setEditing({ mode: 'reset', user: r })}>Reset password</Button>}
                    </div>
                  )
                }
              ]}
            />
          )}
        </Card>
        <Card title="Roles & permissions">
          <div className="grid grid-cols-2 gap-x-8 gap-y-4">
            {(roles.data ?? []).map((r) => (
              <div key={r.id}>
                <p className="text-[13.5px] font-semibold text-ink">{r.name} <span className="font-normal text-ink-3">· {r.permissions.length} permissions</span></p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {r.permissions.map((p) => <span key={p} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{p}</span>)}
                </div>
              </div>
            ))}
            <p className="col-span-2 text-[12px] text-ink-3">Roles are fixed system roles; custom roles are not supported in this version.</p>
          </div>
        </Card>
      </div>
      {editing?.mode === 'self' && (
        <Modal open title="Change my password" onClose={() => setEditing(null)}>
          <ChangePasswordForm onDone={() => setEditing(null)} />
        </Modal>
      )}
      {(editing?.mode === 'new' || editing?.mode === 'edit') && <UserForm editing={editing} roles={roles.data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), users.reload())} />}
      {editing?.mode === 'reset' && <ResetForm user={editing.user} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), users.reload())} />}
    </div>
  )
}

function UserForm({ editing, roles, onClose, onSaved }: { editing: { mode: 'new' } | { mode: 'edit'; user: UserAdminRow }; roles: RoleRow[]; onClose: () => void; onSaved: () => void }) {
  const u = editing.mode === 'edit' ? editing.user : null
  const form = useForm({ username: u?.username ?? '', fullName: u?.fullName ?? '', email: u?.email ?? '', roleCode: u?.roleCode ?? 'SALES', isActive: u ? (u.isActive ? 'yes' : 'no') : 'yes', temporaryPassword: '' })
  const b = form.bind
  async function save() {
    const v = form.values
    const r = u
      ? await form.submit(() => ({ id: u.id, fullName: text(v, 'fullName'), email: text(v, 'email') || null, roleCode: v.roleCode as never, isActive: v.isActive === 'yes' }), (p) => api('user:update', p), (x) => `${x.username} saved`)
      : await form.submit(() => ({ username: text(v, 'username'), fullName: text(v, 'fullName'), email: text(v, 'email') || null, roleCode: v.roleCode as never, temporaryPassword: String(v.temporaryPassword) }), (p) => api('user:create', p), (x) => `${x.username} created`)
    if (r) onSaved()
  }
  return (
    <Modal open title={u ? `Edit ${u.username}` : 'New user'} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.saving} onClick={() => void save()}>Save</Button></>}>
      {form.formError && <p role="alert" className="mb-3 text-[13px] text-red-700">{form.formError}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Username" required error={form.errors.username}><Input {...b('username')} disabled={!!u} autoComplete="off" /></Field>
        <Field label="Full name" required error={form.errors.fullName}><Input {...b('fullName')} /></Field>
        <Field label="Email" error={form.errors.email}><Input {...b('email')} /></Field>
        <Field label="Role" required error={form.errors.roleCode}>
          <Select {...b('roleCode')}>{ROLE_CODES.map((c) => <option key={c} value={c}>{roles.find((r) => r.code === c)?.name ?? c}</option>)}</Select>
        </Field>
        {u ? (
          <Field label="Status" error={form.errors.isActive}><Select {...b('isActive')}><option value="yes">Active</option><option value="no">Disabled</option></Select></Field>
        ) : (
          <Field label="Temporary password" required error={form.errors.temporaryPassword} hint="The user must change it at first sign-in" className="col-span-2"><Input type="password" {...b('temporaryPassword')} autoComplete="new-password" /></Field>
        )}
      </div>
    </Modal>
  )
}

function ResetForm({ user, onClose, onSaved }: { user: UserAdminRow; onClose: () => void; onSaved: () => void }) {
  const form = useForm({ temporaryPassword: '' })
  async function save() {
    const r = await form.submit(() => ({ id: user.id, temporaryPassword: String(form.values.temporaryPassword) }), (p) => api('user:resetPassword', p), () => `Password reset for ${user.username}`)
    if (r) onSaved()
  }
  return (
    <Modal open title={`Reset password · ${user.username}`} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={form.saving} onClick={() => void save()}>Reset password</Button></>}>
      {form.formError && <p role="alert" className="mb-3 text-[13px] text-red-700">{form.formError}</p>}
      <p className="mb-3 text-[13px] text-ink-2">Give the temporary password to {user.fullName} in person. They must choose a new password at their next sign-in. The account is also unlocked.</p>
      <Field label="Temporary password" required error={form.errors.temporaryPassword}><Input type="password" {...form.bind('temporaryPassword')} autoComplete="new-password" autoFocus /></Field>
    </Modal>
  )
}
