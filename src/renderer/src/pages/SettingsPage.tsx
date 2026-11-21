import { ShieldCheck } from 'lucide-react'
import type { AppInfo } from '@shared/types'
import { api } from '../lib/api'
import { useQuery } from '../lib/hooks'
import { useSession } from '../lib/session'
import { Card, ErrorBanner, KeyValue, PageHeader, Spinner } from '../components/ui'

const SECURITY = [
  'Context isolation on; Node.js integration off; renderer sandboxed',
  'Preload exposes one allow-listed invoke() — no filesystem, shell or Node APIs',
  'Every request: sender origin check → Zod validation → authentication → permission check',
  'Content Security Policy blocks remote scripts; navigation, pop-ups, webviews and device permissions are denied',
  'Passwords hashed with scrypt; account lock after 5 failed attempts',
  'Database stored in the per-user profile (never the installation folder); logs redact secrets',
  'Company books and DEMO data in separate database files; demo passwords never work in company data',
  'Verified automatic backups, a backup before every upgrade, and journaled restore with roll-back'
]

export default function SettingsPage() {
  const { session } = useSession()
  const { data, error, loading, reload } = useQuery<AppInfo>(() => api('app:info'))
  if (loading && !data) return <Spinner />
  return (
    <div>
      <PageHeader title="Settings" description="Application and environment information." />
      <ErrorBanner error={error} onRetry={reload} />
      <div className="grid grid-cols-2 gap-4">
        <Card title="Application">
          <dl className="grid grid-cols-2 gap-4">
            <KeyValue label="Product" value={data?.appName} />
            <KeyValue label="Version" value={data?.version} />
            <KeyValue label="Electron" value={data?.electron} />
            <KeyValue label="Node.js" value={data?.node} />
            <KeyValue label="SQLite" value={data?.sqlite} />
            <KeyValue label="Schema version" value={data?.schemaVersion} />
            <KeyValue label="Platform" value={data?.platform} />
            <KeyValue label="Signed in as" value={`${session?.username} (${session?.roleName})`} />
            <KeyValue label="Database" value={data?.environment === 'DEMO' ? 'DEMO sample data' : data?.environment === 'COMPANY' ? 'Company books' : '—'} />
            <KeyValue label="Build" value={data?.packaged ? 'Installed application' : 'Development build'} />
            <div className="col-span-2"><KeyValue label="Data folder" value={<span className="font-mono text-[12px] break-all">{data?.dataDirectory}</span>} /></div>
            <div className="col-span-2"><KeyValue label="Database file" value={<span className="font-mono text-[12px] break-all">{data?.databasePath}</span>} /></div>
            <div className="col-span-2"><KeyValue label="Log file" value={<span className="font-mono text-[12px] break-all">{data?.logPath}</span>} /></div>
          </dl>
        </Card>
        <Card title="Desktop security">
          <ul className="space-y-2.5">
            {SECURITY.map((s) => (
              <li key={s} className="flex gap-2.5 text-[13px] text-ink-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />{s}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
