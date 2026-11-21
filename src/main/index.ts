import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { IPC_CHANNELS, IPC_PREFIX } from '@shared/ipc-channels'
import type { AppInfo } from '@shared/types'
import type { DbEnvironment, WorkspaceStatus } from '@shared/backup'
import { closeDatabase, openDatabase, type DB } from './db/connection'
import { initializeDatabase } from './db/bootstrap'
import { currentSchemaVersion, migrate } from './db/migrator'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './db/migrations'
import { createRoutes, type WorkspaceDeps } from './ipc/routes'
import { createRouter, type RouterDeps } from './ipc/router'
import { createFileLogger, type Logger } from './logger'
import { CONTENT_SECURITY_POLICY, createSenderValidator, secureWebPreferences } from './security'
import { SessionStore } from './services/auth'
import { writeAudit } from './services/audit'
import { defaultEwayBillProvider, EwayBillService } from './services/ewaybill/service'
import { EInvoiceService } from './services/einvoice/service'
import type { SecretCipher } from './services/integrations/settings'
import { BackupManager } from './services/backup/manager'
import { finalizeRestore, recoverInterruptedRestore, type RecoveryResult } from './services/backup/restore'
import { classifyDatabaseFile, dbPathFor, isInside, loadWorkspace, saveWorkspace, type WorkspaceConfig } from './services/backup/workspace'
import { quickCheckOrRecover } from './startup-recovery'
import { setupCompanyDatabase } from './services/setup'
import { createPrinting } from './printing'
import type { PrintingDeps } from './ipc/routes'

export const WINDOW_TITLE = 'SA Business ERP - Enterprise Management'
const SMOKE_TEST = process.argv.includes('--smoke-test')
const E2E_TEST = !app.isPackaged && process.argv.includes('--e2e-test')
const E2E_FINANCE = !app.isPackaged && process.argv.includes('--e2e-finance')
const E2E_GST = !app.isPackaged && process.argv.includes('--e2e-gst')
const E2E_BACKUP = !app.isPackaged ? process.argv.find((a) => a.startsWith('--e2e-backup='))?.slice('--e2e-backup='.length) ?? null : null
const E2E_SETUP = !app.isPackaged ? process.argv.find((a) => a.startsWith('--e2e-setup='))?.slice('--e2e-setup='.length) ?? null : null
const EXPORT_SAMPLES = !app.isPackaged ? process.argv.find((a) => a.startsWith('--export-samples='))?.slice('--export-samples='.length) ?? null : null
const PRINT_TO = !app.isPackaged ? process.argv.find((a) => a.startsWith('--print-to='))?.slice('--print-to='.length).replace(/_/g, ' ') ?? null : null
const CAPTURE_ARG = !app.isPackaged ? process.argv.find((a) => a.startsWith('--capture=')) : undefined
/** Self-test and development flows always run on the DEMO database. */
const FORCE_DEMO = SMOKE_TEST || E2E_TEST || E2E_FINANCE || E2E_GST || !!E2E_BACKUP || !!CAPTURE_ARG || !!EXPORT_SAMPLES
const AUTOMATED = SMOKE_TEST || E2E_TEST || E2E_FINANCE || E2E_GST || !!E2E_BACKUP || !!E2E_SETUP || !!EXPORT_SAMPLES
const DEV_SERVER_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

/**
 * Installed builds refuse Chromium/V8 debugging switches: with them, anyone able to start the
 * program could drive the signed-in session from outside. (Node's --inspect and NODE_OPTIONS are
 * disabled by Electron fuses at packaging time.)
 */
export const BLOCKED_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk', 'js-flags']
if (app.isPackaged && BLOCKED_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  console.error('Debugging switches are not allowed in the installed application.')
  app.exit(2)
}

/**
 * Data folder:
 *  - development/tests: SA_ERP_USER_DATA;
 *  - any build: --data-dir=<folder> (e.g. a data drive), never inside the installation folder;
 *  - --smoke-test without either: a temporary folder (the self-test never touches real data);
 *  - otherwise the per-user profile (%APPDATA%\SA Business ERP).
 */
const installDir = dirname(app.getPath('exe'))
let dataDirError: string | null = null
let temporaryDataDir: string | null = null
{
  const arg = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length).replace(/^"|"$/g, '')
  const devDir = !app.isPackaged ? process.env.SA_ERP_USER_DATA : undefined
  if (devDir) app.setPath('userData', devDir)
  else if (arg) {
    const dir = resolve(arg)
    if (app.isPackaged && isInside(dir, installDir)) {
      dataDirError = `The data folder ${dir} is inside the installation folder, which is replaced when the application is upgraded. Choose another folder.`
      // Never fall back to the default profile: point Chromium at a throw-away folder; start() stops before opening anything.
      temporaryDataDir = mkdtempSync(join(tmpdir(), 'sa-erp-refused-'))
      app.setPath('userData', temporaryDataDir)
    } else app.setPath('userData', dir)
  } else if (SMOKE_TEST) {
    temporaryDataDir = mkdtempSync(join(tmpdir(), 'sa-erp-selftest-'))
    app.setPath('userData', temporaryDataDir)
  }
}

let db: DB | null = null
let logger: Logger
let mainWindow: BrowserWindow | null = null
let printingService: PrintingDeps | null = null
let backups: BackupManager | null = null
let activeEnv: DbEnvironment | null = null
let activeDbPath: string | null = null
let workspaceConfig: WorkspaceConfig
let startupNotice: string | null = null
let relaunching = false
const timers: NodeJS.Timeout[] = []
const routerDeps = {} as RouterDeps

if (!SMOKE_TEST && !E2E_TEST && !E2E_BACKUP && !E2E_SETUP && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(start).catch((err) => fatal(err))
}

const rendererIndex = join(__dirname, '../renderer/index.html')
const isTrustedSender = createSenderValidator({ devServerUrl: DEV_SERVER_URL, rendererIndexPath: rendererIndex })

/** Open, recover, back up (before any upgrade), migrate and seed the database for one environment. */
async function openEnvironment(root: string, env: DbEnvironment): Promise<void> {
  const dbPath = dbPathFor(root, workspaceConfig, env)
  const rec: RecoveryResult = recoverInterruptedRestore(dbPath, env, LATEST_SCHEMA_VERSION)
  if (rec.message) {
    startupNotice = rec.message
    logger.warn('Restore journal resolved at startup', { action: rec.action, message: rec.message })
  }
  let conn: DB | null = null
  const manager = new BackupManager({
    root, environment: env, dbPath, appVersion: app.getVersion(), getDb: () => conn,
    closeDb: () => {
      closeDatabase(conn)
      conn = null
      db = null
    },
    forbiddenDirs: app.isPackaged ? [installDir] : [],
    log: (level, message, meta) => logger[level](message, meta)
  })
  manager.housekeeping()
  if (existsSync(dbPath)) {
    const fileEnv = classifyDatabaseFile(dbPath)
    if ((fileEnv === 'DEMO' || fileEnv === 'COMPANY') && fileEnv !== env)
      throw new Error(`${dbPath} holds ${fileEnv === 'DEMO' ? 'DEMO sample data' : 'company books'} but is configured as the ${env === 'DEMO' ? 'demo' : 'company'} database. It was not opened.`)
    // A damaged file is never opened for writing; the user may restore the newest verified backup.
    await quickCheckOrRecover({ dbPath, env, manager, interactive: !AUTOMATED, logger })
  }
  conn = openDatabase({ filePath: dbPath })
  const report = await initializeDatabase(conn, {
    seedDemo: env === 'DEMO',
    environment: env,
    beforeMigrate: async ({ fromVersion, pending }) => {
      // Never upgrade without a verified copy of the previous version.
      const b = await manager.backupNow('PRE_UPGRADE', `Before upgrading schema ${fromVersion} → ${pending[pending.length - 1]}`)
      logger.info('Pre-upgrade backup created', { file: b.fileName, fromVersion, pending })
    }
  })
  if (rec.action === 'COMPLETED' && rec.journal) {
    finalizeRestore(dbPath)
    writeAudit(conn, { companyId: null, userId: null, action: 'RESTORE', entityType: 'database', summary: `Database restored from ${rec.journal.backupFile}${rec.journal.user ? ` by ${rec.journal.user}` : ''}; safety backup ${rec.journal.safetyBackup ?? 'none'}` })
    if (rec.message?.includes('interruption')) manager.appendHistory({ outcome: 'RECOVERED', backupFile: rec.journal.backupFile, safetyBackup: rec.journal.safetyBackup, message: rec.message, user: rec.journal.user })
  } else if (rec.action === 'ROLLED_BACK' && rec.journal) {
    manager.appendHistory({ outcome: 'ROLLED_BACK', backupFile: rec.journal.backupFile, safetyBackup: rec.journal.safetyBackup, message: rec.message ?? '', user: rec.journal.user })
    writeAudit(conn, { companyId: null, userId: null, action: 'RESTORE_ROLLED_BACK', entityType: 'database', summary: rec.message ?? 'Interrupted restore rolled back' })
  }
  db = conn
  routerDeps.db = conn
  backups = manager
  activeEnv = env
  activeDbPath = dbPath
  logger.info('Database ready', { environment: env, path: dbPath, schema: report.migrations.toVersion, applied: report.migrations.applied, demoSeeded: !!report.demo, demoCredentialsFlagged: report.demoCredentialsFlagged })

  if (!AUTOMATED) {
    // Automatic backups: shortly after start, then checked every 30 minutes.
    timers.push(setTimeout(() => void manager.autoTick(), 60_000))
    timers.push(setInterval(() => void manager.autoTick(), 30 * 60_000))
  }
}

function relaunchSoon(): void {
  if (relaunching) return
  relaunching = true
  setTimeout(() => {
    if (E2E_BACKUP || E2E_SETUP) return // the end-to-end checks restart the app themselves to exercise the real startup path
    for (const t of timers) clearTimeout(t)
    closeDatabase(db)
    db = null
    app.relaunch()
    app.exit(0)
  }, 400)
}

function workspaceStatus(root: string): WorkspaceStatus {
  const companyPath = dbPathFor(root, workspaceConfig, 'COMPANY')
  const demoPath = dbPathFor(root, workspaceConfig, 'DEMO')
  return {
    environment: activeEnv, needsSetup: activeEnv === null, companyDatabaseExists: existsSync(companyPath), demoDatabaseExists: existsSync(demoPath),
    databasePath: activeDbPath, dataDirectory: root, startupNotice
  }
}

function createWorkspaceDeps(root: string): WorkspaceDeps {
  return {
    status: () => workspaceStatus(root),
    async setupCompany(input) {
      const companyPath = dbPathFor(root, workspaceConfig, 'COMPANY')
      if (existsSync(companyPath)) {
        const env = classifyDatabaseFile(companyPath)
        if (env !== 'UNSET') throw new Error('A company database already exists. Open it from the sign-in screen.')
        rmSync(companyPath, { force: true }) // an empty file left by an interrupted setup
      }
      const conn = openDatabase({ filePath: companyPath })
      try {
        migrate(conn, MIGRATIONS)
        setupCompanyDatabase(conn, input)
      } catch (err) {
        closeDatabase(conn)
        rmSync(companyPath, { force: true })
        rmSync(`${companyPath}-wal`, { force: true })
        rmSync(`${companyPath}-shm`, { force: true })
        throw err
      }
      closeDatabase(conn)
      workspaceConfig = { ...workspaceConfig, active: 'COMPANY' }
      saveWorkspace(root, workspaceConfig)
      logger.info('Company database created', { path: companyPath })
      relaunchSoon()
      return { relaunching: true }
    },
    switchTo(target) {
      if (target === 'COMPANY' && !existsSync(dbPathFor(root, workspaceConfig, 'COMPANY'))) throw new Error('No company database exists yet. Use "Set up my company" first.')
      if (target === activeEnv) return { relaunching: false }
      workspaceConfig = { ...workspaceConfig, active: target }
      saveWorkspace(root, workspaceConfig)
      logger.info('Switching database', { target })
      relaunchSoon()
      return { relaunching: true }
    },
    backups: () => backups,
    async chooseDirectory() {
      const opts = { title: 'Choose a backup folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    async chooseImportFile() {
      const opts = { title: 'Choose a backup file to import', filters: [{ name: 'SA Business ERP database', extensions: ['db', 'sqlite'] }], properties: ['openFile'] as Array<'openFile'> }
      const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    relaunchSoon
  }
}

async function start(): Promise<void> {
  // A refused --data-dir stops here: nothing is logged or opened in any profile.
  if (dataDirError) throw new Error(dataDirError)
  const userData = app.getPath('userData')
  logger = createFileLogger(join(userData, 'logs'), !app.isPackaged)
  logger.info('Starting SA Business ERP', { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, dataDirectory: userData })
  if (app.isPackaged && isInside(userData, installDir)) throw new Error('The data folder must not be inside the installation folder.')

  const ws = loadWorkspace(userData)
  workspaceConfig = ws.config
  startupNotice = ws.notice
  const target: DbEnvironment | null = FORCE_DEMO ? 'DEMO' : workspaceConfig.active
  if (target) await openEnvironment(userData, target)
  else logger.info('No database chosen yet: first-run setup')

  const sqliteVersion = (() => {
    const probe = openDatabase({ filePath: ':memory:' })
    try {
      return (probe.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
    } finally {
      probe.close()
    }
  })()
  const appInfo = (): AppInfo => ({
    appName: 'SA Business ERP',
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    sqlite: sqliteVersion,
    databasePath: activeDbPath ?? '',
    schemaVersion: db?.open ? currentSchemaVersion(db) : 0,
    logPath: logger.filePath ?? '',
    platform: `${process.platform} ${process.arch}`,
    environment: activeEnv,
    dataDirectory: userData,
    packaged: app.isPackaged
  })

  const sessions = new SessionStore()
  // Provider per company and service: DEMO (mock) by default; sandbox/live use a placeholder that refuses until an authorised adapter exists.
  const ewayBills = new EwayBillService(defaultEwayBillProvider)
  const einvoices = new EInvoiceService()
  // Credentials are encrypted with the OS key store (DPAPI on Windows); never stored in plain text.
  const secrets: SecretCipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob)
  }
  const printing = createPrinting(() => mainWindow)
  printingService = printing
  Object.assign(routerDeps, {
    db, sessions, logger, isTrustedSender,
    routes: createRoutes({ ewayBills, einvoices, secrets, appInfo, printing, workspace: createWorkspaceDeps(userData) })
  } satisfies RouterDeps)
  const dispatch = createRouter(routerDeps)
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(IPC_PREFIX + channel, (event, input) => dispatch(channel, input, event.senderFrame?.url ?? ''))
  }

  hardenSession()
  Menu.setApplicationMenu(null)
  createWindow()
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (!DEV_SERVER_URL) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] } })
    })
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.on('will-navigate', (e, url) => {
    if (!isTrustedSender(url)) {
      e.preventDefault()
      logger?.warn('Blocked navigation', { url: url.slice(0, 200) })
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'), !app.isPackaged)
  })
  mainWindow.on('page-title-updated', (e) => e.preventDefault())
  mainWindow.once('ready-to-show', () => {
    if (AUTOMATED) return
    mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => logger.error('Renderer process gone', details))
  mainWindow.webContents.on('preload-error', (_e, path, error) => logger.error('Preload error', { path, error }))
  mainWindow.on('closed', () => (mainWindow = null))

  if (SMOKE_TEST) mainWindow.webContents.once('did-finish-load', () => void runSmokeTest())
  const runDev = (flag: boolean, tag: string, load: () => Promise<{ pass: boolean; result: Record<string, unknown> }>) => {
    if (!flag) return
    mainWindow!.webContents.once('did-finish-load', () => {
      void load()
        .then(({ pass, result }) => {
          console.log(`${tag} ${JSON.stringify({ pass, ...result })}`)
          shutdown(pass ? 0 : 1)
        })
        .catch((err) => {
          console.log(`${tag} ${JSON.stringify({ pass: false, error: String(err) })}`)
          shutdown(1)
        })
    })
  }
  runDev(E2E_TEST, 'E2E_RESULT', () => import('./dev-e2e').then((m) => m.runE2E(mainWindow!, printingService!, app.getPath('userData'))))
  runDev(E2E_FINANCE, 'E2E_FINANCE_RESULT', () => import('./dev-e2e-finance').then((m) => m.runFinanceE2E(mainWindow!, printingService!, app.getPath('userData'))))
  runDev(E2E_GST, 'E2E_GST_RESULT', () => import('./dev-e2e-gst').then((m) => m.runGstE2E(mainWindow!, printingService!, app.getPath('userData'))))
  runDev(!!EXPORT_SAMPLES, 'EXPORT_SAMPLES_RESULT', () => import('./dev-export-samples').then((m) => m.exportSamples(db!, printingService!, EXPORT_SAMPLES!, PRINT_TO)))
  runDev(!!E2E_SETUP, 'E2E_SETUP_RESULT', () => import('./dev-e2e-backup').then((m) => m.runSetupE2E(mainWindow!, E2E_SETUP!, app.getPath('userData'))))
  runDev(!!E2E_BACKUP, 'E2E_BACKUP_RESULT', () => import('./dev-e2e-backup').then((m) => m.runBackupE2E(mainWindow!, E2E_BACKUP!, app.getPath('userData'))))
  if (CAPTURE_ARG) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow!.setSize(1440, 900)
      mainWindow!.webContents.setBackgroundThrottling(false)
      mainWindow!.show()
      void import('./dev-capture')
        .then((m) => m.captureScreens(mainWindow!, CAPTURE_ARG.slice('--capture='.length)))
        .then(() => shutdown(0))
        .catch((err) => (logger.error('Capture failed', err), shutdown(1)))
    })
  }
  if (DEV_SERVER_URL) void mainWindow.loadURL(DEV_SERVER_URL)
  else void mainWindow.loadFile(rendererIndex)
}

/** --smoke-test: boot the real app, verify renderer isolation and an end-to-end IPC round trip, then exit. */
async function runSmokeTest(): Promise<void> {
  const wc = mainWindow!.webContents
  const result: Record<string, unknown> = {}
  try {
    await new Promise((r) => setTimeout(r, 1500))
    Object.assign(
      result,
      await wc.executeJavaScript(`(async () => {
        const out = {
          title: document.title,
          erpType: typeof window.erp,
          requireType: typeof window.require,
          processType: typeof window.process,
          bufferType: typeof window.Buffer,
          loginScreen: !!document.querySelector('[data-testid="login-form"]'),
        };
        const bad = await window.erp.invoke('dashboard:summary');
        out.unauthenticatedBlocked = bad.ok === false && bad.error.code === 'UNAUTHENTICATED';
        const unknown = await window.erp.invoke('fs:readFile', { path: 'C:/Windows/win.ini' });
        out.unknownChannelBlocked = unknown.ok === false;
        const login = await window.erp.invoke('auth:login', { username: 'admin', password: 'Admin@123' });
        out.loginOk = login.ok;
        const dash = await window.erp.invoke('dashboard:summary');
        out.dashboardOk = dash.ok && dash.data.kpis.salesPaise > 0;
        const ws = await window.erp.invoke('workspace:status');
        out.environment = ws.ok ? ws.data.environment : null;
        await window.erp.invoke('auth:logout');
        return out;
      })()`)
    )
    result.windowTitle = mainWindow!.getTitle()
    result.packaged = app.isPackaged
    result.temporaryDataDir = !!temporaryDataDir
    result.dataDirectory = app.getPath('userData')
    result.sqlite = db ? (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v : null
    const pass =
      result.erpType === 'object' && result.requireType === 'undefined' && result.processType === 'undefined' && result.bufferType === 'undefined' &&
      result.unauthenticatedBlocked === true && result.unknownChannelBlocked === true && result.loginOk === true && result.dashboardOk === true &&
      result.windowTitle === WINDOW_TITLE && result.loginScreen === true && result.environment === 'DEMO'
    result.pass = pass
    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`)
    shutdown(pass ? 0 : 1)
  } catch (err) {
    console.log(`SMOKE_RESULT ${JSON.stringify({ ...result, pass: false, error: String(err) })}`)
    shutdown(1)
  }
}

function shutdown(code: number): void {
  try {
    for (const t of timers) clearTimeout(t)
    closeDatabase(db)
  } finally {
    db = null
    if (temporaryDataDir) {
      try {
        rmSync(temporaryDataDir, { recursive: true, force: true })
      } catch {
        /* Chromium may still hold cache files; the OS temp folder is cleaned eventually. */
      }
    }
    app.exit(code)
  }
}

function fatal(err: unknown): void {
  logger?.error('Fatal startup error', err)
  console.error(err)
  if (SMOKE_TEST) {
    console.log(`SMOKE_RESULT ${JSON.stringify({ pass: false, error: String(err) })}`)
  } else if (!AUTOMATED) {
    dialog.showErrorBox('SA Business ERP failed to start', `${(err as Error)?.message ?? String(err)}\n\nYour data has not been changed. See the application log and the Backup and Restore guide.`)
  }
  shutdown(1)
}

app.on('window-all-closed', () => {
  for (const t of timers) clearTimeout(t)
  closeDatabase(db)
  db = null
  app.quit()
})

app.on('before-quit', () => {
  closeDatabase(db)
  db = null
})

process.on('uncaughtException', (err) => logger?.error('Uncaught exception', err))
process.on('unhandledRejection', (reason) => logger?.error('Unhandled rejection', reason))
