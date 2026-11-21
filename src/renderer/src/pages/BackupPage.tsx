import { useState } from 'react'
import { ArchiveRestore, CheckCircle2, FolderOpen, HardDriveDownload, Import, ShieldCheck, XCircle } from 'lucide-react'
import { BACKUP_REASON_LABELS, RESTORE_CONFIRM_PHRASE, type BackupInfo, type BackupOverview, type BackupVerifyResult } from '@shared/backup'
import { api, ApiError } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { useToast } from '../lib/toast'
import { formatDateTime } from '../lib/format'
import { Badge, Button, Card, DataTable, DemoBadge, ErrorBanner, Field, Input, KeyValue, PageHeader, Select, Spinner } from '../components/ui'
import { Modal } from '../components/Modal'

const size = (b: number) => (b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

export default function BackupPage() {
  const { can } = useSession()
  const toast = useToast()
  const q = useQuery<BackupOverview>(() => api('backup:overview'))
  const [busy, setBusy] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [verify, setVerify] = useState<BackupVerifyResult | null>(null)
  const [restore, setRestore] = useState<BackupInfo | null>(null)
  const manage = can('backup.manage')
  const ov = q.data

  async function run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => string | null): Promise<T | null> {
    setBusy(key)
    try {
      const r = await fn()
      const m = ok?.(r)
      if (m) toast('success', m)
      return r
    } catch (e) {
      toast('error', 'Not completed', (e as ApiError).message)
      return null
    } finally {
      setBusy(null)
    }
  }

  if (q.loading && !ov) return <Spinner />
  return (
    <div>
      <PageHeader
        title="Backup & Restore"
        description="Verified copies of the open database. Backups of company books and of the demo are kept in separate folders and cannot be restored into each other."
        badge={ov?.environment === 'DEMO' ? <DemoBadge label="DEMO DATABASE" /> : <Badge tone="blue">Company database</Badge>}
        actions={
          manage && (
            <div className="flex items-center gap-2">
              <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} className="w-52" />
              <Button
                icon={<HardDriveDownload className="size-4" />}
                loading={busy === 'create'}
                data-testid="backup-now"
                onClick={() =>
                  void run('create', () => api('backup:create', { label: label.trim() || null }), (b) => `Backup ${b.fileName} created and verified`).then((r) => {
                    if (r) (setLabel(''), q.reload())
                  })
                }
              >
                <span className="whitespace-nowrap">Back up now</span>
              </Button>
            </div>
          )
        }
      />
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {ov && (
        <div className="space-y-4">
          <Card title="Backups" subtitle={`${ov.backups.length} verified backup(s) in ${ov.directory}`} bodyClassName="p-0">
            <DataTable
              rows={ov.backups}
              rowKey={(b) => b.fileName}
              maxHeight="max-h-[calc(100vh-330px)]"
              empty="No backups yet."
              columns={[
                { key: 'd', header: 'Created', render: (b) => <span className="whitespace-nowrap">{formatDateTime(b.createdAt)}</span> },
                { key: 'r', header: 'Type', render: (b) => <Badge tone={b.reason === 'MANUAL' ? 'blue' : b.reason === 'AUTO' ? 'gray' : 'amber'}>{BACKUP_REASON_LABELS[b.reason]}</Badge> },
                { key: 'f', header: 'File', render: (b) => <div><p className="font-mono text-[11.5px]">{b.fileName}</p>{b.label && <p className="text-[12px] text-ink-3">{b.label}</p>}</div> },
                { key: 's', header: 'Contents', render: (b) => <span className="text-[12px] whitespace-nowrap text-ink-2">v{b.schemaVersion} · {size(b.sizeBytes)} · {b.counts.documents} docs · {b.counts.journalLines} journal lines</span> },
                {
                  key: 'a', header: '', render: (b) => (
                    <div className="flex justify-end gap-1.5">
                      <Button variant="secondary" loading={busy === `v-${b.fileName}`} onClick={() => void run(`v-${b.fileName}`, () => api('backup:verify', { fileName: b.fileName })).then((r) => r && setVerify(r))}>Verify</Button>
                      {manage && <Button variant="danger" data-testid={`restore-${b.fileName}`} onClick={() => setRestore(b)}>Restore…</Button>}
                    </div>
                  )
                }
              ]}
            />
          </Card>
          <div className="grid grid-cols-3 items-start gap-4">
            <Card title="Automatic backups">
              <BackupSettingsForm ov={ov} manage={manage} onSaved={q.reload} />
            </Card>
            <Card title="Database">
              <dl className="space-y-3">
                <KeyValue label="Open database" value={<span className="font-mono text-[11.5px] break-all">{ov.databasePath}</span>} />
                <KeyValue label="Schema version" value={ov.schemaVersion} />
                <KeyValue label="Backup folder" value={<span className="font-mono text-[11.5px] break-all">{ov.directory}</span>} />
              </dl>
              {manage && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" icon={<FolderOpen className="size-4" />} loading={busy === 'dir'} onClick={() => void run('dir', () => api('backup:chooseDirectory'), (r) => (r ? 'Backup folder changed' : null)).then((r) => r && q.reload())}>Change folder…</Button>
                  <Button variant="secondary" icon={<Import className="size-4" />} loading={busy === 'imp'} onClick={() => void run('imp', () => api('backup:import'), (r) => (r ? `Imported as ${r.fileName}` : null)).then((r) => r && q.reload())}>Import file…</Button>
                </div>
              )}
            </Card>
            <Card title="Restore history">
              {ov.restoreHistory.length === 0 ? <p className="text-[13px] text-ink-3">No restores.</p> : (
                <ul className="space-y-2.5">
                  {ov.restoreHistory.map((h, i) => (
                    <li key={i} className="text-[12.5px]">
                      <p className="flex items-center gap-1.5 font-semibold text-ink">
                        {h.outcome === 'RESTORED' || h.outcome === 'RECOVERED' ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-red-600" />}
                        {h.outcome.replace('_', ' ').toLowerCase()} · {formatDateTime(h.at)}
                      </p>
                      <p className="text-ink-2">{h.message}</p>
                      {h.safetyBackup && <p className="font-mono text-[11px] text-ink-3">safety backup: {h.safetyBackup}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
      <Modal open={!!verify} title="Backup verification" onClose={() => setVerify(null)} footer={<Button onClick={() => setVerify(null)}>Close</Button>}>
        {verify && (
          <div className="space-y-2 text-[13px]">
            <p className="flex items-center gap-2 font-semibold">{verify.ok ? <><ShieldCheck className="size-4 text-emerald-600" /> Verified — integrity, checksum, schema and environment all pass</> : <><XCircle className="size-4 text-red-600" /> Not restorable</>}</p>
            <p className="font-mono text-[11.5px] text-ink-3">{verify.fileName}</p>
            {verify.errors.map((e) => <p key={e} className="text-red-700">{e}</p>)}
            {verify.warnings.map((w) => <p key={w} className="text-amber-700">{w}</p>)}
            {verify.counts && <p className="text-ink-2">{verify.counts.companies} companies · {verify.counts.users} users · {verify.counts.documents} documents · {verify.counts.journalLines} journal lines · {verify.counts.auditLogs} audit entries</p>}
            {verify.sha256 && <p className="font-mono text-[10.5px] break-all text-ink-3">SHA-256 {verify.sha256}</p>}
          </div>
        )}
      </Modal>
      {restore && <RestoreDialog backup={restore} onClose={() => setRestore(null)} />}
    </div>
  )
}

function BackupSettingsForm({ ov, manage, onSaved }: { ov: BackupOverview; manage: boolean; onSaved: () => void }) {
  const toast = useToast()
  const [s, setS] = useState({ autoEnabled: ov.settings.autoEnabled, intervalHours: String(ov.settings.intervalHours), keepAutomatic: String(ov.settings.keepAutomatic), keepSafety: String(ov.settings.keepSafety) })
  const [saving, setSaving] = useState(false)
  async function save(useDefaultDirectory = false) {
    setSaving(true)
    try {
      await api('backup:saveSettings', { autoEnabled: s.autoEnabled, intervalHours: Number(s.intervalHours), keepAutomatic: Number(s.keepAutomatic), keepSafety: Number(s.keepSafety), useDefaultDirectory })
      toast('success', 'Backup settings saved')
      onSaved()
    } catch (e) {
      toast('error', 'Not saved', (e as ApiError).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-3 text-[13px]">
      <label className="flex items-center gap-2"><input type="checkbox" checked={s.autoEnabled} disabled={!manage} onChange={(e) => setS({ ...s, autoEnabled: e.target.checked })} /> Back up automatically</label>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Every">
          <Select value={s.intervalHours} disabled={!manage} onChange={(e) => setS({ ...s, intervalHours: e.target.value })}>
            {[4, 8, 12, 24, 48, 168].map((h) => <option key={h} value={h}>{h < 24 ? `${h} h` : h === 168 ? 'week' : `${h / 24} day${h > 24 ? 's' : ''}`}</option>)}
          </Select>
        </Field>
        <Field label="Keep auto"><Input type="number" min={1} value={s.keepAutomatic} disabled={!manage} onChange={(e) => setS({ ...s, keepAutomatic: e.target.value })} /></Field>
        <Field label="Keep safety"><Input type="number" min={1} value={s.keepSafety} disabled={!manage} onChange={(e) => setS({ ...s, keepSafety: e.target.value })} /></Field>
      </div>
      <p className="text-[12px] text-ink-3">
        Last automatic: {ov.lastAutomaticAt ? formatDateTime(ov.lastAutomaticAt) : 'none yet'} · next due: {!ov.settings.autoEnabled ? 'off' : !ov.lastAutomaticAt ? 'within 30 minutes of start' : formatDateTime(ov.nextAutomaticDue)}. Backups are also made before every upgrade and every restore. Manual backups are never deleted automatically.
      </p>
      {manage && (
        <div className="flex gap-2">
          <Button loading={saving} onClick={() => void save()}>Save</Button>
          {ov.directory !== ov.defaultDirectory && <Button variant="secondary" disabled={saving} onClick={() => void save(true)}>Use default folder</Button>}
        </div>
      )}
    </div>
  )
}

function RestoreDialog({ backup, onClose }: { backup: BackupInfo; onClose: () => void }) {
  const [confirmText, setConfirmText] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  async function go() {
    setBusy(true)
    setError(null)
    setErrors({})
    try {
      const r = await api('backup:restore', { fileName: backup.fileName, confirmText, password })
      setDone(`${r.message}. A safety backup of the replaced database was saved as ${r.safetyBackup}. The application is restarting…`)
    } catch (e) {
      const err = e as ApiError
      setError(err.message)
      setErrors(err.fieldErrors)
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={<span className="flex items-center gap-2"><ArchiveRestore className="size-5 text-red-600" /> Restore backup</span>}
      subtitle={backup.fileName}
      onClose={busy ? () => undefined : onClose}
      footer={
        !done && (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="danger" loading={busy} disabled={confirmText !== RESTORE_CONFIRM_PHRASE || !password} onClick={() => void go()} data-testid="confirm-restore">Restore and restart</Button>
          </>
        )
      }
    >
      {done ? <p role="status" className="text-[13px] text-ink">{done}</p> : (
        <div className="space-y-3 text-[13px]">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
            <p className="font-semibold">This replaces the whole {backup.environment === 'DEMO' ? 'DEMO' : 'company'} database with the backup from {formatDateTime(backup.createdAt)}.</p>
            <p className="mt-1">Everything entered after that time — documents, payments, vouchers, users and settings stored in the database — will no longer be in the books. A verified safety backup of the current database is made first, so this can be undone by restoring it.</p>
          </div>
          <p className="text-ink-2">Backup: schema v{backup.schemaVersion}, {backup.counts.documents} documents, {backup.counts.journalLines} journal lines, made by version {backup.appVersion}.</p>
          {error && <p role="alert" className="text-red-700">{error}</p>}
          <Field label={`Type ${RESTORE_CONFIRM_PHRASE} to confirm`} error={errors.confirmText}><Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus /></Field>
          <Field label="Your password" error={errors.password}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        </div>
      )}
    </Modal>
  )
}
