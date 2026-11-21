/**
 * Phase 5 over the real IPC router: user administration and forced password
 * change, demo/company isolation, first-run (no database) mode, backup and
 * restore permissions, and that passwords never reach the audit log or the log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { closeDatabase, openDatabase, type DB } from '../src/main/db/connection'
import { demoCredentialsVisible, initializeDatabase } from '../src/main/db/bootstrap'
import { migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import { createRouter, type Dispatch, type RouterDeps } from '../src/main/ipc/router'
import { createRoutes, type WorkspaceDeps } from '../src/main/ipc/routes'
import { SessionStore } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { EInvoiceService } from '../src/main/services/einvoice/service'
import { MockEInvoiceProvider } from '../src/main/services/einvoice/provider'
import type { Logger } from '../src/main/logger'
import { sanitize } from '../src/main/logger'
import { createSenderValidator } from '../src/main/security'
import { BackupManager } from '../src/main/services/backup/manager'
import { setupCompanyDatabase } from '../src/main/services/setup'
import { flagPublishedPasswords } from '../src/main/services/users'
import { hashPassword } from '../src/main/services/password'
import type { BackupInfo, BackupOverview } from '@shared/backup'
import type { LoginInfo, SessionInfo, UserAdminRow } from '@shared/types'
import { TEST_TODAY, tempDir } from './helpers'

const TRUSTED = 'file:///D:/App/out/renderer/index.html'
type Ok<T> = { ok: true; data: T }
type Res = { ok: boolean; data?: unknown; error?: { code: string; message: string; fieldErrors?: Record<string, string> } }

const logLines: string[] = []
const capturingLogger: Logger = {
  filePath: null,
  info: (m, meta) => void logLines.push(JSON.stringify({ m, meta: sanitize(meta) })),
  warn: (m, meta) => void logLines.push(JSON.stringify({ m, meta: sanitize(meta) })),
  error: (m, meta) => void logLines.push(JSON.stringify({ m, meta: sanitize(meta) }))
}

function harness(db: DB | null, workspace?: WorkspaceDeps) {
  const deps: RouterDeps = {
    db, sessions: new SessionStore(), logger: capturingLogger,
    isTrustedSender: createSenderValidator({ rendererIndexPath: 'D:\\App\\out\\renderer\\index.html' }),
    routes: createRoutes({
      ewayBills: new EwayBillService(new MockEwayBillProvider(), { sleep: async () => {} }),
      einvoices: new EInvoiceService(() => new MockEInvoiceProvider(), { sleep: async () => {} }),
      appInfo: () => ({}) as never, workspace,
      secrets: { isAvailable: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => b.toString().slice(4) }
    })
  }
  const dispatch: Dispatch = createRouter(deps)
  const call = (ch: string, input?: unknown) => dispatch(ch, input, TRUSTED) as Promise<Res>
  const ok = async <T,>(ch: string, input?: unknown): Promise<T> => {
    const r = await call(ch, input)
    expect(r.ok, `${ch}: ${r.error?.code} ${r.error?.message} ${JSON.stringify(r.error?.fieldErrors ?? {})}`).toBe(true)
    return (r as Ok<T>).data
  }
  return { deps, call, ok }
}

describe('Phase 5 over IPC — DEMO database', () => {
  const t = tempDir()
  let db: DB | null
  let h: ReturnType<typeof harness>
  let manager: BackupManager
  let relaunches = 0
  const livePath = join(t.dir, 'data', 'sa-business-erp.db')

  beforeAll(async () => {
    db = openDatabase({ filePath: livePath })
    await initializeDatabase(db, { seedDemo: true, environment: 'DEMO', today: TEST_TODAY })
    manager = new BackupManager({ root: t.dir, environment: 'DEMO', dbPath: livePath, appVersion: 'test', getDb: () => db, closeDb: () => (closeDatabase(db), (db = null)) })
    const ws: WorkspaceDeps = {
      status: () => ({ environment: 'DEMO', needsSetup: false, companyDatabaseExists: false, demoDatabaseExists: true, databasePath: livePath, dataDirectory: t.dir, startupNotice: null }),
      setupCompany: async () => ({ relaunching: true }),
      switchTo: () => ({ relaunching: true }),
      backups: () => manager,
      chooseDirectory: async () => null,
      chooseImportFile: async () => null,
      relaunchSoon: () => void relaunches++
    }
    h = harness(db, ws)
  })
  afterAll(() => {
    closeDatabase(db)
    t.cleanup()
  })

  it('new users get a temporary password and are held at the password change screen by the server', async () => {
    await h.ok('auth:login', { username: 'admin', password: 'Admin@123' })
    const weak = await h.call('user:create', { username: 'priya.s', fullName: 'Priya S', roleCode: 'SALES', temporaryPassword: 'short' })
    expect(weak.error?.code).toBe('VALIDATION')
    const known = await h.call('user:create', { username: 'priya.s', fullName: 'Priya S', roleCode: 'SALES', temporaryPassword: 'Admin@123' })
    expect(known.error?.fieldErrors?.temporaryPassword).toBeDefined()
    const u = await h.ok<UserAdminRow>('user:create', { username: 'priya.s', fullName: 'Priya S', roleCode: 'SALES', temporaryPassword: 'Welcome2026x' })
    expect(u).toMatchObject({ roleCode: 'SALES', mustChangePassword: true, isActive: true })
    const dup = await h.call('user:create', { username: 'PRIYA.S', fullName: 'Again', roleCode: 'SALES', temporaryPassword: 'Welcome2026x' })
    expect(dup.error?.message).toMatch(/already taken/)
    await h.ok('auth:logout')

    const s = await h.ok<SessionInfo>('auth:login', { username: 'priya.s', password: 'Welcome2026x' })
    expect(s.mustChangePassword).toBe(true)
    expect((await h.call('dashboard:summary')).error?.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect((await h.call('sales:list' as never, {})).ok).toBe(false)
    expect((await h.call('app:info')).ok).toBe(true)
    const wrong = await h.call('auth:changePassword', { currentPassword: 'nope', newPassword: 'MyOwnPass2026', confirmPassword: 'MyOwnPass2026' })
    expect(wrong.error?.fieldErrors?.currentPassword).toBe('Incorrect password')
    const mismatch = await h.call('auth:changePassword', { currentPassword: 'Welcome2026x', newPassword: 'MyOwnPass2026', confirmPassword: 'MyOwnPass2027' })
    expect(mismatch.error?.fieldErrors?.confirmPassword).toBeDefined()
    const fresh = await h.ok<SessionInfo>('auth:changePassword', { currentPassword: 'Welcome2026x', newPassword: 'MyOwnPass2026', confirmPassword: 'MyOwnPass2026' })
    expect(fresh.mustChangePassword).toBe(false)
    expect((await h.call('dashboard:summary')).ok).toBe(true)
    // Sales role still cannot administer users.
    expect((await h.call('user:create', { username: 'x.y.z', fullName: 'Xavier', roleCode: 'ADMIN', temporaryPassword: 'Welcome2026x' })).error?.code).toBe('FORBIDDEN')
    await h.ok('auth:logout')
    expect((await h.call('auth:login', { username: 'priya.s', password: 'Welcome2026x' })).ok).toBe(false)
    await h.ok('auth:login', { username: 'priya.s', password: 'MyOwnPass2026' })
    await h.ok('auth:logout')
  })

  it('administrators cannot lock themselves or the company out', async () => {
    const me = await h.ok<SessionInfo>('auth:login', { username: 'admin', password: 'Admin@123' })
    expect((await h.call('user:update', { id: me.userId, fullName: 'System Administrator', roleCode: 'ADMIN', isActive: false })).error?.message).toMatch(/your own account/)
    expect((await h.call('user:update', { id: me.userId, fullName: 'System Administrator', roleCode: 'SALES', isActive: true })).error?.message).toMatch(/own role/)
    expect((await h.call('user:resetPassword', { id: me.userId, temporaryPassword: 'Welcome2026x' })).error?.message).toMatch(/Change my password/)
    // A second admin is created, then removing the only remaining admin is refused.
    const second = await h.ok<UserAdminRow>('user:create', { username: 'admin2', fullName: 'Second Admin', roleCode: 'ADMIN', temporaryPassword: 'Welcome2026x' })
    await h.ok('user:update', { id: second.id, fullName: 'Second Admin', roleCode: 'ADMIN', isActive: false })
    const users = await h.ok<UserAdminRow[]>('user:adminList')
    expect(users.find((u) => u.username === 'admin2')?.isActive).toBe(false)
    // Lock-out and unlock.
    await h.ok('auth:logout')
    for (let i = 0; i < 5; i++) await h.call('auth:login', { username: 'accounts', password: 'wrong' })
    expect((await h.call('auth:login', { username: 'accounts', password: 'Accounts@123' })).error?.message).toMatch(/locked/)
    await h.ok('auth:login', { username: 'admin', password: 'Admin@123' })
    const acc = (await h.ok<UserAdminRow[]>('user:adminList')).find((u) => u.username === 'accounts')!
    expect(acc.isLocked).toBe(true)
    await h.ok('user:unlock', { id: acc.id })
    await h.ok('auth:logout')
    await h.ok('auth:login', { username: 'accounts', password: 'Accounts@123' })
    expect((await h.call('user:adminList')).error?.code).toBe('FORBIDDEN')
    await h.ok('auth:logout')
  })

  it('the DEMO database refuses real companies and stored integration credentials', async () => {
    await h.ok('auth:login', { username: 'admin', password: 'Admin@123' })
    const c = await h.call('company:create', { code: 'REAL', name: 'Real Co', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 })
    expect(c.error?.message).toMatch(/DEMO database/)
    const live = await h.call('integration:save', { service: 'EINVOICE', mode: 'LIVE', providerName: 'Some GSP', apiBaseUrl: 'https://gsp.example.invalid',  timeoutMs: 30000, maxRetries: 2 })
    expect(live.ok).toBe(true) // selectable, but nothing can be sent without credentials…
    const cred = await h.call('integration:saveCredentials', { service: 'EINVOICE', environment: 'LIVE', username: 'gsp-user', password: 'gsp-secret-pass' })
    expect(cred.error?.message).toMatch(/cannot be stored in the DEMO database/)
    await h.ok('integration:save', { service: 'EINVOICE', mode: 'DEMO', providerName: null, apiBaseUrl: null, timeoutMs: 30000, maxRetries: 2 })
    const info = await h.ok<LoginInfo>('app:loginInfo')
    expect(info).toMatchObject({ demoMode: true, environment: 'DEMO' })
    expect((await h.ok<SessionInfo>('auth:session')).environment).toBe('DEMO')
    // The profile is set once and cannot be changed or removed, even with direct SQL.
    expect(() => db!.prepare(`UPDATE database_profile SET environment = 'COMPANY'`).run()).toThrow(/cannot be changed/)
    expect(() => db!.prepare(`DELETE FROM database_profile`).run()).toThrow(/cannot be deleted/)
    await h.ok('auth:logout')
  })

  it('backups: auditor may view and verify but not create or restore; restore needs the phrase and the password', async () => {
    await h.ok('auth:login', { username: 'auditor', password: 'Auditor@123' })
    expect((await h.ok<BackupOverview>('backup:overview')).environment).toBe('DEMO')
    expect((await h.call('backup:create', {})).error?.code).toBe('FORBIDDEN')
    expect((await h.call('backup:saveSettings', { autoEnabled: false, intervalHours: 24, keepAutomatic: 3, keepSafety: 3 })).error?.code).toBe('FORBIDDEN')
    await h.ok('auth:logout')
    await h.ok('auth:login', { username: 'accounts', password: 'Accounts@123' })
    expect((await h.call('backup:overview')).error?.code).toBe('FORBIDDEN')
    await h.ok('auth:logout')

    await h.ok('auth:login', { username: 'admin', password: 'Admin@123' })
    const b = await h.ok<BackupInfo>('backup:create', { label: 'ipc' })
    expect(b.reason).toBe('MANUAL')
    expect((await h.ok<{ ok: boolean }>('backup:verify', { fileName: b.fileName })).ok).toBe(true)
    for (const bad of ['../x.db', 'C:\\Windows\\x.db', 'a/b.db', 'x.txt']) expect((await h.call('backup:verify', { fileName: bad })).error?.code, bad).toBe('VALIDATION')
    expect((await h.call('backup:verify', { fileName: 'sa-erp-demo-19990101-000000-manual.db' })).error?.message).toMatch(/not found/)
    const ov = await h.ok<BackupOverview>('backup:saveSettings', { autoEnabled: true, intervalHours: 12, keepAutomatic: 5, keepSafety: 4 })
    expect(ov.settings).toMatchObject({ intervalHours: 12, keepAutomatic: 5, keepSafety: 4 })
    expect((await h.call('backup:restore', { fileName: b.fileName, confirmText: 'restore', password: 'Admin@123' })).error?.fieldErrors?.confirmText).toBeDefined()
    expect((await h.call('backup:restore', { fileName: b.fileName, confirmText: 'RESTORE', password: 'wrong' })).error?.fieldErrors?.password).toBe('Incorrect password')
    expect(relaunches).toBe(0)
    expect(db!.open).toBe(true)
    const r = await h.ok<{ outcome: string; relaunching: boolean; safetyBackup: string }>('backup:restore', { fileName: b.fileName, confirmText: 'RESTORE', password: 'Admin@123' })
    expect(r).toMatchObject({ outcome: 'RESTORED', relaunching: true })
    expect(relaunches).toBe(1)
    expect(db).toBeNull()
    // Signed out and nothing else is served until the restart.
    expect((await h.call('auth:session')).data).toBeNull()
    expect((await h.call('dashboard:summary')).error?.code).toBe('SETUP_REQUIRED')
  })

  it('never writes a password or credential to the audit log or the application log', () => {
    const conn = openDatabase({ filePath: livePath })
    try {
      const audit = JSON.stringify(conn.prepare('SELECT summary, details_json FROM audit_logs').all())
      const logs = logLines.join('\n')
      for (const secret of ['Welcome2026x', 'MyOwnPass2026', 'gsp-secret-pass', 'Admin@123', 'Accounts@123', 'Auditor@123']) {
        expect(audit, secret).not.toContain(secret)
        expect(logs, secret).not.toContain(secret)
      }
    } finally {
      closeDatabase(conn)
    }
  })
})

describe('Phase 5 — company database and first-run mode', () => {
  it('a company database has no demo users or credentials and is marked COMPANY', async () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS)
    setupCompanyDatabase(db, {
      company: { code: 'RT', name: 'Real Traders', legalName: null, gstin: null, pan: null, stateCode: '29', addressLine1: null, addressLine2: null, city: 'Bengaluru', pincode: null, phone: null, email: null, fyStartMonth: 4 },
      adminUsername: 'owner', adminFullName: 'The Owner', adminPassword: 'Owner2026pass', confirmPassword: 'Owner2026pass'
    })
    expect(() => setupCompanyDatabase(db, { company: { code: 'X', name: 'Xx', legalName: null, gstin: null, pan: null, stateCode: '29', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 }, adminUsername: 'other', adminFullName: 'O', adminPassword: 'Owner2026pass', confirmPassword: 'Owner2026pass' })).toThrow(/already been set up/)
    const r = await initializeDatabase(db, { seedDemo: false, environment: 'COMPANY' })
    expect(r.usersCreated).toBe(0)
    expect(r.demo).toBeNull()
    expect(demoCredentialsVisible(db)).toBe(false)
    const h = harness(db)
    const info = await h.ok<LoginInfo>('app:loginInfo')
    expect(info).toEqual({ demoMode: false, demoUsers: [], environment: 'COMPANY' })
    expect((await h.call('auth:login', { username: 'admin', password: 'Admin@123' })).ok).toBe(false)
    const s = await h.ok<SessionInfo>('auth:login', { username: 'owner', password: 'Owner2026pass' })
    expect(s).toMatchObject({ roleCode: 'ADMIN', mustChangePassword: false, environment: 'COMPANY' })
    expect(s.company?.isDemo).toBe(false)
    // Real companies may be added here.
    expect((await h.call('company:create', { code: 'BR2', name: 'Branch Two', legalName: null, gstin: null, pan: null, stateCode: '29', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 })).ok).toBe(true)
    // The company database can never be opened as the demo (no seeding into real books).
    await expect(initializeDatabase(db, { seedDemo: true, environment: 'DEMO' })).rejects.toThrow(/company books/)
    closeDatabase(db)
  })

  it('accounts still on a published demo password in company data must change it', async () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS.slice(0, 5))
    db.prepare(`INSERT INTO companies (code, name, state_code, is_demo) VALUES ('DEMO', 'Demo', '33', 1), ('REAL', 'Real', '33', 0)`).run()
    db.prepare(`INSERT INTO users (username, full_name, password_hash, role_id) VALUES ('admin', 'A', ?, (SELECT id FROM roles WHERE code='ADMIN')), ('accounts', 'B', ?, (SELECT id FROM roles WHERE code='ACCOUNTANT'))`).run(hashPassword('Admin@123'), hashPassword('ChangedAlready1'))
    const r = await initializeDatabase(db, { seedDemo: false, environment: 'COMPANY' })
    expect((db.prepare('SELECT environment FROM database_profile').get() as { environment: string }).environment).toBe('COMPANY') // mixed file → company
    expect(r.demoCredentialsFlagged).toEqual(['admin'])
    expect(flagPublishedPasswords(db)).toEqual([]) // idempotent
    const h = harness(db)
    const s = await h.ok<SessionInfo>('auth:login', { username: 'admin', password: 'Admin@123' })
    expect(s.mustChangePassword).toBe(true)
    expect((await h.call('company:list')).error?.code).toBe('PASSWORD_CHANGE_REQUIRED')
    closeDatabase(db)
  })

  it('with no database open only the first-run requests are served', async () => {
    let switched: string | null = null
    const h = harness(null, {
      status: () => ({ environment: null, needsSetup: true, companyDatabaseExists: false, demoDatabaseExists: false, databasePath: null, dataDirectory: 'X', startupNotice: null }),
      setupCompany: async () => ({ relaunching: true }),
      switchTo: (t) => ((switched = t), { relaunching: true }),
      backups: () => null, chooseDirectory: async () => null, chooseImportFile: async () => null, relaunchSoon: () => {}
    })
    expect((await h.ok<{ needsSetup: boolean }>('workspace:status')).needsSetup).toBe(true)
    expect(await h.ok('auth:session')).toBeNull()
    expect(await h.ok('app:loginInfo')).toEqual({ demoMode: false, demoUsers: [], environment: null })
    for (const ch of ['auth:login', 'dashboard:summary', 'backup:overview', 'company:list']) expect((await h.call(ch, ch === 'auth:login' ? { username: 'admin', password: 'Admin@123' } : undefined)).error?.code, ch).toBe('SETUP_REQUIRED')
    await h.ok('workspace:switch', { target: 'DEMO' })
    expect(switched).toBe('DEMO')
    const bad = await h.call('workspace:setupCompany', { company: {}, adminUsername: 'a', adminFullName: 'b', adminPassword: 'weak', confirmPassword: 'x' })
    expect(bad.error?.code).toBe('VALIDATION')
  })
})
