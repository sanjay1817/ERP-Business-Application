import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { ipcInputSchemas } from '@shared/ipc-contract'
import { createRouter, type Dispatch } from '../src/main/ipc/router'
import { createRoutes } from '../src/main/ipc/routes'
import { SessionStore, MAX_FAILED_ATTEMPTS } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { silentLogger } from '../src/main/logger'
import { CONTENT_SECURITY_POLICY, createSenderValidator, secureWebPreferences } from '../src/main/security'
import { openDatabase } from '../src/main/db/connection'
import { initializeDatabase } from '../src/main/db/bootstrap'
import { TEST_TODAY } from './helpers'

const RENDERER_INDEX = 'D:\\Apps\\SA Business ERP\\resources\\app.asar\\out\\renderer\\index.html'
const TRUSTED = 'file:///D:/Apps/SA%20Business%20ERP/resources/app.asar/out/renderer/index.html#/dashboard'
let dispatch: Dispatch
let sessions: SessionStore

beforeAll(async () => {
  const db = openDatabase({ filePath: ':memory:' })
  await initializeDatabase(db, { seedDemo: true, today: TEST_TODAY })
  sessions = new SessionStore()
  dispatch = createRouter({
    db,
    sessions,
    logger: silentLogger,
    isTrustedSender: createSenderValidator({ rendererIndexPath: RENDERER_INDEX }),
    routes: createRoutes({ ewayBills: new EwayBillService(new MockEwayBillProvider()), appInfo: () => ({}) as never })
  })
})

const call = (channel: string, input?: unknown, url = TRUSTED) => dispatch(channel, input, url)
const login = (username: string, password: string) => call('auth:login', { username, password })

describe('window hardening', () => {
  it('uses context isolation, sandbox and no Node integration', () => {
    const wp = secureWebPreferences('/app/preload.js', false)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.nodeIntegrationInWorker).toBe(false)
    expect(wp.nodeIntegrationInSubFrames).toBe(false)
    expect(wp.sandbox).toBe(true)
    expect(wp.webSecurity).toBe(true)
    expect(wp.webviewTag).toBe(false)
    expect(wp.allowRunningInsecureContent).toBe(false)
    expect(wp.devTools).toBe(false)
  })

  it('applies a strict CSP with no remote or inline scripts', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe/)
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    const html = readFileSync(join(__dirname, '../src/renderer/index.html'), 'utf8')
    expect(html).toContain("script-src 'self'")
  })

  it('preload exposes only invoke() over the allow-list (no ipcRenderer, fs or process)', () => {
    const src = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8')
    expect(src).toMatch(/exposeInMainWorld\('erp'/)
    expect(src).not.toMatch(/from 'node:|require\(|exposeInMainWorld\('(ipcRenderer|process|fs)'/)
    expect(src).toContain('allowed.has(channel)')
  })
})

describe('IPC contract', () => {
  it('every allow-listed channel has a Zod input schema', () => {
    for (const c of IPC_CHANNELS) expect(ipcInputSchemas[c], c).toBeDefined()
    expect(Object.keys(ipcInputSchemas).sort()).toEqual([...IPC_CHANNELS].sort())
  })
})

describe('IPC router security', () => {
  it('rejects unknown channels', async () => {
    const r = await call('fs:readFile', { path: 'C:/Windows/win.ini' })
    expect(r).toEqual({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } })
  })

  it('rejects untrusted senders (remote pages, other files)', async () => {
    for (const url of ['https://evil.example.com/', 'file:///C:/Users/x/Downloads/evil.html', '', 'devtools://devtools/bundled/inspector.html']) {
      const r = await call('auth:login', { username: 'admin', password: 'Admin@123' }, url)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('UNTRUSTED_SENDER')
    }
  })

  it('accepts the dev server origin only when configured', () => {
    const dev = createSenderValidator({ devServerUrl: 'http://localhost:5173', rendererIndexPath: RENDERER_INDEX })
    expect(dev('http://localhost:5173/#/sales')).toBe(true)
    expect(dev('http://localhost:5174/')).toBe(false)
    expect(createSenderValidator({ rendererIndexPath: RENDERER_INDEX })('http://localhost:5173/')).toBe(false)
  })

  it('requires authentication for protected channels', async () => {
    sessions.set(null)
    for (const ch of ['dashboard:summary', 'customer:list', 'customer:create', 'audit:list', 'ewaybill:list']) {
      const r = await call(ch, ch === 'customer:list' ? {} : undefined)
      expect(r.ok, ch).toBe(false)
      if (!r.ok) expect(['UNAUTHENTICATED', 'VALIDATION']).toContain(r.error.code)
    }
    const dash = await call('dashboard:summary')
    expect(!dash.ok && dash.error.code).toBe('UNAUTHENTICATED')
  })

  it('validates input shape before running handlers (and rejects extra keys)', async () => {
    const r1 = await call('auth:login', { username: 'admin' })
    expect(!r1.ok && r1.error.code).toBe('VALIDATION')
    expect(!r1.ok && r1.error.fieldErrors?.password).toBeTruthy()
    const r2 = await call('auth:login', { username: 'admin', password: 'x', isAdmin: true })
    expect(!r2.ok && r2.error.code).toBe('VALIDATION')
    const r3 = await call('auth:login', 'DROP TABLE users')
    expect(!r3.ok && r3.error.code).toBe('VALIDATION')
  })

  it('rejects wrong passwords without revealing whether the user exists', async () => {
    const a = await login('admin', 'wrong-password')
    const b = await login('no-such-user', 'whatever')
    expect(!a.ok && a.error).toEqual(!b.ok && b.error)
  })

  it('enforces role permissions server-side', async () => {
    const r = await login('auditor', 'Auditor@123')
    expect(r.ok).toBe(true)
    expect((await call('customer:list', {})).ok).toBe(true)
    const create = await call('customer:create', {
      code: 'HACK1', name: 'Should Fail', partyType: 'BUSINESS', gstRegistrationType: 'UNREGISTERED', stateCode: '33', creditLimitPaise: 0, creditDays: 0
    })
    expect(!create.ok && create.error.code).toBe('FORBIDDEN')
    expect((await call('audit:list')).ok).toBe(true)
    await call('auth:logout')

    await login('accounts', 'Accounts@123')
    const audit = await call('audit:list')
    expect(!audit.ok && audit.error.code).toBe('FORBIDDEN')
    await call('auth:logout')
  })

  it('does not leak SQL or stack traces for constraint violations', async () => {
    await login('admin', 'Admin@123')
    const dup = await call('customer:create', {
      code: 'C001', name: 'Duplicate Code', partyType: 'BUSINESS', gstRegistrationType: 'UNREGISTERED', stateCode: '33', creditLimitPaise: 0, creditDays: 0
    })
    expect(!dup.ok && dup.error.code).toBe('CONFLICT')
    expect(!dup.ok && dup.error.message).not.toMatch(/SQLITE|constraint|INSERT/i)
    expect(!dup.ok && dup.error.fieldErrors?.code).toBeTruthy()
    await call('auth:logout')
  })

  it('locks an account after repeated failed sign-ins', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await login('accounts', 'bad')
    const r = await login('accounts', 'Accounts@123')
    expect(!r.ok && r.error.message).toMatch(/locked/i)
  })
})
