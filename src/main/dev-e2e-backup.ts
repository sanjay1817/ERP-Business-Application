/**
 * Dev-only end-to-end check of backup and restore in the real Electron app.
 * Run twice on the same scratch profile:
 *   --e2e-backup=run     back up, change data, check refusals, restore (the app stops instead of restarting)
 *   --e2e-backup=verify  normal start-up resolves the restore journal; the data equals the backup
 */
import type { BrowserWindow } from 'electron'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RUN = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const inv = async (ch, input) => {
    const r = await call(ch, input)
    if (!r.ok) throw new Error(ch + ': ' + r.error.code + ' ' + r.error.message + ' ' + JSON.stringify(r.error.fieldErrors || {}))
    return r.data
  }
  const out = {}
  const ws = await inv('workspace:status')
  out.environment = ws.environment

  // Auditor may look but not touch.
  await inv('auth:login', { username: 'auditor', password: 'Auditor@123' })
  out.auditorCanView = (await call('backup:overview')).ok
  const ac = await call('backup:create', { label: 'x' })
  const ar = await call('backup:restore', { fileName: 'sa-erp-demo-x.db', confirmText: 'RESTORE', password: 'Auditor@123' })
  out.auditorForbidden = ac.ok === false && ac.error.code === 'FORBIDDEN' && ar.ok === false && ar.error.code === 'FORBIDDEN'
  await inv('auth:logout')

  await inv('auth:login', { username: 'admin', password: 'Admin@123' })
  const b = await inv('backup:create', { label: 'e2e known good' })
  out.backupFile = b.fileName
  out.backupVerified = (await inv('backup:verify', { fileName: b.fileName })).ok
  out.usersAtBackup = (await inv('user:adminList')).length
  // Work after the backup — must disappear when the backup is restored.
  await inv('user:create', { username: 'e2e.after', fullName: 'Created After Backup', roleCode: 'SALES', temporaryPassword: 'Temp0rary2026' })
  out.usersBeforeRestore = (await inv('user:adminList')).length

  const wrongPhrase = await call('backup:restore', { fileName: b.fileName, confirmText: 'restore', password: 'Admin@123' })
  const wrongPassword = await call('backup:restore', { fileName: b.fileName, confirmText: 'RESTORE', password: 'nope' })
  const badName = await call('backup:restore', { fileName: '../../evil.db', confirmText: 'RESTORE', password: 'Admin@123' })
  out.wrongPhraseRefused = !wrongPhrase.ok && wrongPhrase.error.code === 'VALIDATION'
  out.wrongPasswordRefused = !wrongPassword.ok && wrongPassword.error.code === 'VALIDATION'
  out.pathTraversalRefused = !badName.ok && badName.error.code === 'VALIDATION'
  out.stillUsable = (await call('dashboard:summary')).ok

  const r = await inv('backup:restore', { fileName: b.fileName, confirmText: 'RESTORE', password: 'Admin@123' })
  out.restoreOutcome = r.outcome
  out.safetyBackup = r.safetyBackup
  out.relaunching = r.relaunching
  const after = await call('dashboard:summary')
  out.closedAfterRestore = after.ok === false
  return out
})()`

const VERIFY = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const inv = async (ch, input) => {
    const r = await call(ch, input)
    if (!r.ok) throw new Error(ch + ': ' + r.error.code + ' ' + r.error.message)
    return r.data
  }
  const out = {}
  out.notice = (await inv('workspace:status')).startupNotice
  await inv('auth:login', { username: 'admin', password: 'Admin@123' })
  const users = await inv('user:adminList')
  out.users = users.length
  out.afterBackupUserGone = !users.some((u) => u.username === 'e2e.after')
  const ov = await inv('backup:overview')
  out.history = ov.restoreHistory.map((h) => h.outcome)
  out.backups = ov.backups.map((b) => b.reason)
  const audit = await inv('audit:list', { limit: 50 })
  out.restoreAudited = audit.some((a) => a.action === 'RESTORE')
  const integrity = await inv('audit:integrity')
  out.integrityFailures = integrity.checks.filter((c) => !c.ok).map((c) => c.name || c.label || c.key)
  return out
})()`

export async function runBackupE2E(win: BrowserWindow, phase: string, userData: string): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  await new Promise((r) => setTimeout(r, 1200))
  const state = join(userData, 'e2e-backup-state.json')
  if (phase === 'run') {
    const r = (await win.webContents.executeJavaScript(RUN)) as Record<string, unknown>
    writeFileSync(state, JSON.stringify(r))
    const journal = readdirSync(join(userData, 'data')).filter((f) => f.endsWith('.restore-journal.json'))
    r.journalLeftForStartup = journal.length === 1
    const pass =
      r.environment === 'DEMO' && r.auditorCanView === true && r.auditorForbidden === true && r.backupVerified === true && r.wrongPhraseRefused === true &&
      r.wrongPasswordRefused === true && r.pathTraversalRefused === true && r.stillUsable === true && r.restoreOutcome === 'RESTORED' && r.relaunching === true &&
      r.closedAfterRestore === true && r.journalLeftForStartup === true && (r.usersBeforeRestore as number) === (r.usersAtBackup as number) + 1
    return { pass, result: r }
  }
  const before = JSON.parse(readFileSync(state, 'utf8')) as Record<string, unknown>
  const r = (await win.webContents.executeJavaScript(VERIFY)) as Record<string, unknown>
  const dataFiles = readdirSync(join(userData, 'data'))
  r.leftovers = dataFiles.filter((f) => /journal\.json|replaced|restore-new/.test(f))
  r.historyFile = existsSync(join(userData, 'restore-history.jsonl'))
  const pass =
    r.users === before.usersAtBackup && r.afterBackupUserGone === true && (r.history as string[])[0] === 'RESTORED' && (r.backups as string[]).includes('PRE_RESTORE') &&
    (r.backups as string[]).includes('MANUAL') && r.restoreAudited === true && (r.leftovers as string[]).length === 0 && (r.integrityFailures as string[]).length === 0 &&
    typeof r.notice === 'string' && /restored from/.test(r.notice as string)
  return { pass, result: r }
}

const SETUP_RUN = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const out = {}
  const ws = await call('workspace:status')
  out.firstRun = ws.ok && ws.data.needsSetup === true && ws.data.environment === null
  out.firstRunScreen = !!document.querySelector('[data-testid="setup-company"]') && !!document.querySelector('[data-testid="open-demo"]')
  out.loginBlocked = (await call('auth:login', { username: 'admin', password: 'Admin@123' })).error?.code === 'SETUP_REQUIRED'
  const weak = await call('workspace:setupCompany', { company: { code: 'RT', name: 'Real Traders', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: 'Chennai', pincode: null, phone: null, email: null, fyStartMonth: 4 }, adminUsername: 'owner', adminFullName: 'Business Owner', adminPassword: 'Admin@123', confirmPassword: 'Admin@123' })
  out.publishedPasswordRefused = weak.ok === false && weak.error.code === 'VALIDATION'
  const r = await call('workspace:setupCompany', { company: { code: 'RT', name: 'Real Traders', legalName: 'Real Traders Pvt Ltd', gstin: null, pan: null, stateCode: '33', addressLine1: '1 Main Road', addressLine2: null, city: 'Chennai', pincode: '600001', phone: null, email: null, fyStartMonth: 4 }, adminUsername: 'owner', adminFullName: 'Business Owner', adminPassword: 'OwnerPass2026', confirmPassword: 'OwnerPass2026' })
  out.setupOk = r.ok && r.data.relaunching === true
  const again = await call('workspace:setupCompany', { company: { code: 'RT', name: 'Real Traders', legalName: null, gstin: null, pan: null, stateCode: '33', addressLine1: null, addressLine2: null, city: null, pincode: null, phone: null, email: null, fyStartMonth: 4 }, adminUsername: 'owner2', adminFullName: 'Second', adminPassword: 'OwnerPass2026', confirmPassword: 'OwnerPass2026' })
  out.secondSetupRefused = again.ok === false && /already exists/.test(again.error.message)
  return out
})()`

const SETUP_VERIFY = `(async () => {
  const call = (ch, input) => window.erp.invoke(ch, input)
  const out = {}
  const ws = (await call('workspace:status')).data
  out.environment = ws.environment
  out.demoExists = ws.demoDatabaseExists
  const info = (await call('app:loginInfo')).data
  out.noDemoCredentials = info.demoMode === false && info.demoUsers.length === 0
  out.noDemoBox = !document.body.innerText.includes('Admin@123')
  out.demoLoginFails = (await call('auth:login', { username: 'admin', password: 'Admin@123' })).ok === false
  const s = await call('auth:login', { username: 'owner', password: 'OwnerPass2026' })
  out.ownerLogin = s.ok && s.data.roleCode === 'ADMIN' && s.data.company && s.data.company.isDemo === false && s.data.environment === 'COMPANY'
  out.companies = (await call('company:list')).data.map((c) => c.name)
  const dash = await call('dashboard:summary')
  out.emptyBooks = dash.ok && dash.data.kpis.salesPaise === 0
  out.integrity = (await call('audit:integrity')).data.checks.filter((c) => !c.ok).length
  const b = await call('backup:overview')
  out.backupFolder = b.ok ? b.data.directory : null
  await call('auth:logout')
  out.switchToDemo = (await call('workspace:switch', { target: 'DEMO' })).data
  return out
})()`

export async function runSetupE2E(win: BrowserWindow, phase: string, userData: string): Promise<{ pass: boolean; result: Record<string, unknown> }> {
  await new Promise((r) => setTimeout(r, 1200))
  if (phase === 'run') {
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 1500))
    writeFileSync(join(userData, 'first-run.png'), (await win.webContents.capturePage()).toPNG())
    const r = (await win.webContents.executeJavaScript(SETUP_RUN)) as Record<string, unknown>
    const ws = JSON.parse(readFileSync(join(userData, 'workspace.json'), 'utf8')) as { active: string; companyDb: string }
    r.workspaceActive = ws.active
    r.companyDbCreated = existsSync(join(userData, ws.companyDb))
    r.noDemoDbCreated = !existsSync(join(userData, 'data', 'sa-business-erp.db'))
    const pass = Object.entries(r).every(([k, v]) => (k === 'workspaceActive' ? v === 'COMPANY' : v === true))
    return { pass, result: r }
  }
  const r = (await win.webContents.executeJavaScript(SETUP_VERIFY)) as Record<string, unknown>
  r.workspaceAfterSwitch = (JSON.parse(readFileSync(join(userData, 'workspace.json'), 'utf8')) as { active: string }).active
  const pass =
    r.environment === 'COMPANY' && r.demoExists === false && r.noDemoCredentials === true && r.noDemoBox === true && r.demoLoginFails === true && r.ownerLogin === true &&
    JSON.stringify(r.companies) === JSON.stringify(['Real Traders']) && r.emptyBooks === true && r.integrity === 0 && typeof r.backupFolder === 'string' &&
    /company$/.test(r.backupFolder as string) && r.workspaceAfterSwitch === 'DEMO'
  return { pass, result: r }
}
