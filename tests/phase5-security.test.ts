/**
 * Phase 5 security review, as executable checks:
 *  - the permission matrix over EVERY channel (static: route access vs role permissions);
 *  - no channel answers an unauthenticated or malformed request with data or an internal error;
 *  - passwords and credentials are never stored or logged in plain text;
 *  - packaging configuration: Electron fuses on, data outside the install folder, no secrets in config.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../src/main/db/connection'
import { createRouter, NO_DATABASE_CHANNELS, PASSWORD_CHANGE_CHANNELS, type Dispatch } from '../src/main/ipc/router'
import { createRoutes } from '../src/main/ipc/routes'
import { SessionStore } from '../src/main/services/auth'
import { EwayBillService } from '../src/main/services/ewaybill/service'
import { MockEwayBillProvider } from '../src/main/services/ewaybill/mock-provider'
import { sanitize, silentLogger } from '../src/main/logger'
import { createSenderValidator, secureWebPreferences } from '../src/main/security'
import { saveCredentials } from '../src/main/services/integrations/settings'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import { demoDb } from './helpers'

const root = join(__dirname, '..')
const TRUSTED = 'file:///D:/App/out/renderer/index.html'
const routes = createRoutes({ ewayBills: new EwayBillService(new MockEwayBillProvider(), { sleep: async () => {} }), appInfo: () => ({}) as never })
const access = (ch: string) => (routes as Record<string, { access: string }>)[ch].access

/** Channels whose name says they change something (reviewed list of verbs). */
const MUTATING = /:(create|update|save|saveDraft|post|cancel|delete|deleteDraft|convert|generate|retry|send|restore|import|classify|prepare|markExported|review|rematch|match|unmatch|complete|extend|unlock|resetPassword|setActive|setupCompany|changePassword|chooseDirectory|saveSettings|saveCredentials|deleteCredentials|saveRule|saveHsn|saveHsnRate|saveRegistration|saveTaxRateDates|importHsn|updatePartB|updateTransporter|addCharge|reconcile|clear|uncleared|exportPreparation|saveTransporter|saveVehicle|saveDoc|print|exportPdf|exportExcel|exportReport)$/i

/** Session-level (no single permission) channels that change data — each checks permissions inside its handler. Reviewed list. */
const SESSION_MUTATIONS_WITH_INTERNAL_CHECKS = [
  'doc:saveDraft', 'doc:deleteDraft', 'doc:validate', 'doc:post', 'doc:cancel', 'doc:convert', // need(<side>.post)
  'doc:print', 'doc:exportPdf', // need(<side>.view): output only
  'report:print', 'report:exportPdf', 'report:exportExcel', // reportCtx(reports.export + the report's own permission)
  'payment:create', // need(sales.post / purchase.post)
  'company:switch', 'auth:logout', 'auth:changePassword' // the signed-in user's own session
]
/** Output-only channels guarded by a view permission whose handlers check the export permission themselves. */
const VIEW_GUARDED_OUTPUT = /:(print|printHtml|exportPdf|exportExcel|exportReport|exportPreparation)$/

describe('permission matrix over every channel', () => {
  let db: DB
  let rolePerms: Record<string, string[]>
  beforeAll(async () => {
    db = (await demoDb()).db
    rolePerms = {}
    for (const r of db.prepare('SELECT r.code AS role, p.code AS perm FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id').all() as Array<{ role: string; perm: string }>)
      (rolePerms[r.role] ??= []).push(r.perm)
  })

  it('every channel has a route; public channels are exactly the sign-in and first-run set', () => {
    for (const ch of IPC_CHANNELS) expect(['public', 'session'].includes(access(ch)) || /^[a-z]+\.[a-z]+$/.test(access(ch)), ch).toBe(true)
    const pub = IPC_CHANNELS.filter((c) => access(c) === 'public').sort()
    expect(pub).toEqual(['app:loginInfo', 'auth:login', 'auth:session', 'workspace:setupCompany', 'workspace:status', 'workspace:switch'])
    expect([...NO_DATABASE_CHANNELS].every((c) => access(c) === 'public')).toBe(true)
    // Every permission a route needs exists in the database.
    const known = new Set((db.prepare('SELECT code FROM permissions').all() as Array<{ code: string }>).map((r) => r.code))
    for (const ch of IPC_CHANNELS) if (!['public', 'session'].includes(access(ch))) expect(known.has(access(ch)), `${ch} needs unknown permission ${access(ch)}`).toBe(true)
  })

  it('no mutating channel is guarded by a view permission, and the auditor only holds view/export permissions', () => {
    const offenders = IPC_CHANNELS.filter((c) => MUTATING.test(c) && /\.view$/.test(access(c)) && !VIEW_GUARDED_OUTPUT.test(c))
    expect(offenders).toEqual([])
    expect(rolePerms.AUDITOR.filter((p) => !p.endsWith('.view') && p !== 'reports.export')).toEqual([])
    const auditorCanMutate = IPC_CHANNELS.filter((c) => MUTATING.test(c) && rolePerms.AUDITOR.includes(access(c)) && !VIEW_GUARDED_OUTPUT.test(c))
    expect(auditorCanMutate).toEqual([])
  })

  it('session-level channels that change data are the reviewed list (each checks permission itself)', () => {
    const sessionMutations = IPC_CHANNELS.filter((c) => access(c) === 'session' && MUTATING.test(c)).sort()
    expect(sessionMutations).toEqual([...SESSION_MUTATIONS_WITH_INTERNAL_CHECKS].filter((c) => MUTATING.test(c)).sort())
  })

  it('administration permissions belong to the administrator only', () => {
    for (const p of ['user.manage', 'backup.manage', 'integration.manage', 'company.manage']) {
      const holders = Object.entries(rolePerms).filter(([, perms]) => perms.includes(p)).map(([r]) => r)
      expect(holders, p).toEqual(['ADMIN'])
    }
    expect(Object.entries(rolePerms).filter(([, perms]) => perms.includes('backup.view')).map(([r]) => r).sort()).toEqual(['ADMIN', 'AUDITOR'])
  })

  it('prints the role × module matrix used in the administrator guide', () => {
    const modules = [...new Set(IPC_CHANNELS.map((c) => c.split(':')[0]))].sort()
    const roles = ['ADMIN', 'ACCOUNTANT', 'SALES', 'AUDITOR']
    const lines = modules.map((m) => {
      const chans = IPC_CHANNELS.filter((c) => c.startsWith(`${m}:`))
      const cells = roles.map((r) => {
        const n = chans.filter((c) => ['public', 'session'].includes(access(c)) || rolePerms[r]?.includes(access(c))).length
        return n === chans.length ? 'all' : n === 0 ? '—' : `${n}/${chans.length}`
      })
      return `${m.padEnd(13)} ${cells.map((c) => c.padEnd(8)).join(' ')}`
    })
    expect(lines.length).toBeGreaterThan(20)
    console.log(['module        ' + roles.map((r) => r.padEnd(8)).join(' '), ...lines].join('\n'))
  })
})

describe('hostile input on every channel', () => {
  let dispatch: Dispatch
  beforeAll(async () => {
    const { db } = await demoDb()
    dispatch = createRouter({ db, sessions: new SessionStore(), logger: silentLogger, isTrustedSender: createSenderValidator({ rendererIndexPath: 'D:\\App\\out\\renderer\\index.html' }), routes })
  })

  it('unauthenticated or malformed requests never return data or an internal error', async () => {
    const junk: unknown[] = [undefined, null, {}, 'x', 42, [], { id: -1 }, { __proto__: { admin: true } }, { id: 1, extra: 'field' }, 'a'.repeat(100_000)]
    for (const ch of IPC_CHANNELS) {
      if (access(ch) === 'public') continue
      for (const input of junk) {
        const r = await dispatch(ch, input, TRUSTED)
        expect(r.ok, `${ch} accepted ${JSON.stringify(input)?.slice(0, 40)}`).toBe(false)
        if (!r.ok) expect(['UNAUTHENTICATED', 'VALIDATION'], `${ch} → ${r.error.code}`).toContain(r.error.code)
      }
    }
  })

  it('requests from any other origin are refused before validation', async () => {
    for (const origin of ['https://evil.example', 'file:///C:/Users/x/Downloads/page.html', 'devtools://devtools', '', 'about:blank']) {
      const r = await dispatch('auth:login', { username: 'admin', password: 'Admin@123' }, origin)
      expect(r.ok === false && r.error.code).toBe('UNTRUSTED_SENDER')
    }
  })

  it('a user who must change the password can reach only the password-change channels', () => {
    expect([...PASSWORD_CHANGE_CHANNELS].sort()).toEqual(['app:info', 'app:loginInfo', 'auth:changePassword', 'auth:logout', 'auth:session', 'workspace:status', 'workspace:switch'])
  })
})

describe('secrets at rest and in logs', () => {
  it('stores only scrypt hashes and encrypted credential blobs', async () => {
    const { db, ctx } = await demoDb()
    for (const u of db.prepare('SELECT username, password_hash FROM users').all() as Array<{ username: string; password_hash: string }>) {
      expect(u.password_hash, u.username).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]{80,}$/)
      expect(u.password_hash).not.toMatch(/Admin@123|Accounts@123|Auditor@123/)
    }
    // Credentials go through the OS cipher; the stored blob never contains the plain secret.
    const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)), decrypt: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString() }
    saveCredentials({ ...ctx, userId: ctx.userId }, { service: 'EWAYBILL', environment: 'SANDBOX', username: 'gsp-user-77', password: 'Very$ecretPass9' }, cipher)
    const row = db.prepare(`SELECT secret_blob, username_hint FROM integration_credentials WHERE service = 'EWAYBILL'`).get() as { secret_blob: Buffer; username_hint: string }
    expect(row.secret_blob.toString('latin1')).not.toContain('Very$ecretPass9')
    expect(row.username_hint).toBe('gs***7')
    const audit = JSON.stringify(db.prepare(`SELECT summary, details_json FROM audit_logs WHERE action LIKE 'CREDENTIALS%'`).all())
    expect(audit).not.toContain('Very$ecretPass9')
    expect(audit).not.toContain('gsp-user-77')
    expect(() => saveCredentials(ctx, { service: 'EWAYBILL', environment: 'LIVE', username: 'u', password: 'p' }, { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })).toThrow(/never stored in plain text/)
  })

  it('the logger redacts every password-like field, however it is named or nested', () => {
    const out = JSON.stringify(
      sanitize({ password: 'a1', currentPassword: 'a2', newPassword: 'a3', confirmPassword: 'a4', temporaryPassword: 'a5', adminPassword: 'a6', clientSecret: 'a7', token: 'a8', authorization: 'a9', nested: [{ input: { password: 'b1' } }], password_hash: 'b2' })
    )
    for (const v of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1', 'b2']) expect(out).not.toContain(`"${v}"`)
  })

  it('configuration files contain no credentials and the packaged app is hardened', () => {
    const cfg = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const pkg = readFileSync(join(root, 'package.json'), 'utf8')
    for (const text of [cfg, pkg]) expect(text).not.toMatch(/(password|secret|token|apikey|api_key)\s*[:=]\s*\S+/i)
    expect(cfg).toMatch(/runAsNode: false/)
    expect(cfg).toMatch(/enableNodeOptionsEnvironmentVariable: false/)
    expect(cfg).toMatch(/enableNodeCliInspectArguments: false/)
    expect(cfg).toMatch(/onlyLoadAppFromAsar: true/)
    expect(cfg).toMatch(/enableEmbeddedAsarIntegrityValidation: true/)
    expect(cfg).toMatch(/deleteAppDataOnUninstall: false/)
    expect(cfg).toMatch(/'!out\/main\/chunks\/dev-\*\.js'/)
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    expect(main).toMatch(/remote-debugging-port/)
    expect(main).toMatch(/isInside\(dir, installDir\)/)
    // Renderer: isolated, sandboxed, no Node, no devtools in the installed build.
    expect(secureWebPreferences('p', false)).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, webviewTag: false })
  })
})
