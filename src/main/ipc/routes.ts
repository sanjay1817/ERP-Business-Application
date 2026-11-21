import type { AppInfo } from '@shared/types'
import { DEMO_USERS, demoCredentialsVisible } from '../db/bootstrap'
import { buildSession, login } from '../services/auth'
import { writeAudit } from '../services/audit'
import { createCompany, getCompany, listCompanies, updateCompany } from '../services/company'
import { AppError, notFound } from '../services/errors'
import type { EwayBillService } from '../services/ewaybill/service'
import {
  createCustomer, createSupplier, getCustomer, getSupplier, listCustomers, listSuppliers,
  setCustomerActive, setSupplierActive, updateCustomer, updateSupplier
} from '../services/parties'
import { createProduct, getLookups, getProduct, listProducts, setProductActive, updateProduct } from '../services/products'
import * as R from '../services/reports'
import type { HandlerContext, Routes } from './router'
import { KINDS, type DocumentKind } from '@shared/documents'
import type { ServiceContext } from '../services/context'
import { cancelDocument, convertDocument, deleteDraft, postDocument, saveDraft, validateDocument } from '../services/documents/engine'
import { listDocuments, loadDocument } from '../services/documents/store'
import { buildDocumentHtml } from '../services/documents/print'
import { moduleSummary, register } from '../services/documents/summary'
import { createPayment, getPayment, listPayments, openInvoices } from '../services/documents/payments'
import { REPORT_KINDS, type ReportParamsT } from '@shared/finance'
import { periods, todayIso } from '../services/finance/periods'
import * as FS from '../services/finance/statements'
import { ageing, partyStatement } from '../services/finance/ageing'
import { cancelVoucher, createVoucher, getVoucher, listVouchers } from '../services/finance/vouchers'
import * as BR from '../services/finance/bankrec'
import { auditExceptions, integrityReport } from '../services/finance/audit-checks'
import { buildReport } from '../services/reports/report-docs'
import { reportHtml } from '../services/reports/report-html'
import { reportToXlsx } from '../services/reports/xlsx'
import * as GC from '../services/gst/config'
import { purchaseRegister, salesRegister } from '../services/gst/registers'
import * as GR from '../services/gst/returns'
import { classifyItc } from '../services/gst/itc'
import * as RC from '../services/gst/recon'
import * as IS from '../services/integrations/settings'
import { EInvoiceService } from '../services/einvoice/service'
import * as TR from '../services/transport'
import type { z } from 'zod'
import { RESTORE_CONFIRM_PHRASE, type DbEnvironment, type WorkspaceSetupInput, type WorkspaceStatus } from '@shared/backup'
import type { BackupManager } from '../services/backup/manager'
import { databaseEnvironment } from '../services/auth'
import * as U from '../services/users'
import { currentSchemaVersion } from '../db/migrator'
import { businessRule } from '../services/errors'

/** Phase 5: which database is open, first-run setup, switching between company and demo data, and backups. */
export interface WorkspaceDeps {
  status(): WorkspaceStatus
  /** Creates the company database and restarts into it. Refused if a company database already exists. */
  setupCompany(input: z.infer<typeof WorkspaceSetupInput>): Promise<{ relaunching: boolean }>
  switchTo(target: DbEnvironment): { relaunching: boolean }
  backups(): BackupManager | null
  chooseDirectory(): Promise<string | null>
  chooseImportFile(): Promise<string | null>
  /** Restart shortly after the response has been sent (after a restore). */
  relaunchSoon(): void
}

/** Electron-backed printing (absent in unit tests). */
export interface PrintingDeps {
  toPdf(html: string): Promise<Buffer>
  print(html: string): Promise<boolean>
  /** Shows a save dialog; returns the chosen path or null if cancelled. */
  savePdf(defaultFileName: string, data: Buffer): Promise<string | null>
  /** Save dialog for other exports (e.g. Excel). */
  saveFile(defaultFileName: string, data: Buffer, filter: { name: string; extensions: string[] }): Promise<string | null>
}

export interface RouteDeps {
  ewayBills: EwayBillService
  appInfo: () => AppInfo
  printing?: PrintingDeps
  /** Phase 4: e-invoice workflow (defaults to the company's configured provider). */
  einvoices?: EInvoiceService
  /** OS-backed encryption for integration credentials (Electron safeStorage). */
  secrets?: IS.SecretCipher
  /** Phase 5 workspace, backup and restart services (absent in older unit tests). */
  workspace?: WorkspaceDeps
}

const sideOf = (kind: DocumentKind) => (KINDS[kind].side === 'SALES' ? 'sales' : 'purchase')
/** Document routes are 'session'-level; the side-specific permission is checked per kind here. */
function need(c: HandlerContext, permission: string): ServiceContext {
  if (!c.sessions.has(permission)) throw new AppError('FORBIDDEN', 'You do not have permission for this action')
  return c.svc()
}
/** A report needs reports.view/export plus the permission of the data it shows (e.g. stock valuation needs inventory.view). */
function reportCtx(c: HandlerContext, p: ReportParamsT, action: 'reports.view' | 'reports.export'): ServiceContext {
  need(c, action)
  return need(c, REPORT_KINDS[p.report].permission)
}
const reportFileName = (title: string, ext: string) => `${title} ${todayIso()}`.replace(/[\\/:*?"<>|\u2014]+/g, '-').replace(/\s+/g, ' ') + `.${ext}`
const docFileName = (kind: DocumentKind, number: string) => `${KINDS[kind].label} ${number}`.replace(/[\/:*?"<>|]+/g, '-') + '.pdf'

/** Channel → access rule + handler. Inputs arrive already validated by the router. */
/** Passes when the user holds any of the permissions. */
function needAny(c: HandlerContext, ...permissions: string[]): ServiceContext {
  if (!permissions.some((p) => c.sessions.has(p))) throw new AppError('FORBIDDEN', 'You do not have permission for this action')
  return c.svc()
}

export function createRoutes({ ewayBills, appInfo, printing, einvoices = new EInvoiceService(), secrets, workspace }: RouteDeps): Routes {
  const ws = (): WorkspaceDeps => {
    if (!workspace) throw businessRule('Workspace services are not available in this environment')
    return workspace
  }
  const backups = (): BackupManager => {
    const m = ws().backups()
    if (!m) throw businessRule('No database is open')
    return m
  }
  /** Backup/restore errors are explained to the administrator rather than hidden as internal errors. */
  const explain = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof AppError) throw err
      throw businessRule((err as Error).message)
    }
  }
  const audit = (c: HandlerContext, action: string, summary: string, details?: Record<string, unknown>) => {
    const s = c.sessions.get()
    writeAudit(c.db, { companyId: s?.company?.id ?? null, userId: s?.userId ?? null, action, entityType: 'backup', summary, details })
  }
  const needPrinting = (): PrintingDeps => {
    if (!printing) throw new AppError('BUSINESS_RULE', 'Printing is not available in this environment')
    return printing
  }
  return {
    'auth:login': {
      access: 'public',
      handler: ({ db, sessions }, input) => {
        const session = login(db, input.username, input.password)
        sessions.set(session)
        return session
      }
    },
    'auth:logout': {
      access: 'session',
      handler: ({ db, sessions }) => {
        const s = sessions.get()!
        writeAudit(db, { companyId: s.company?.id ?? null, userId: s.userId, action: 'LOGOUT', entityType: 'user', entityId: s.userId, summary: `${s.username} signed out` })
        sessions.set(null)
        return null
      }
    },
    'auth:session': {
      access: 'public',
      handler: ({ db, sessions }) => {
        const s = sessions.get()
        if (!s) return null
        // Refresh from the database so permission/company changes apply immediately.
        const fresh = buildSession(db, s.userId, s.company?.id)
        sessions.set(fresh)
        return fresh
      }
    },
    'app:info': { access: 'session', handler: () => appInfo() },
    'app:loginInfo': {
      access: 'public',
      handler: ({ db }) => {
        if (!db || !db.open) return { demoMode: false, demoUsers: [], environment: null }
        const demoMode = demoCredentialsVisible(db)
        return { demoMode, demoUsers: demoMode ? DEMO_USERS.map((u) => ({ username: u.username, password: u.password, role: u.role })) : [], environment: databaseEnvironment(db) }
      }
    },
    'dashboard:summary': { access: 'dashboard.view', handler: (c) => R.dashboardSummary(c.svc()) },
    'search:global': { access: 'session', handler: (c, i) => R.globalSearch(c.svc(), i.query) },
    'notifications:list': { access: 'session', handler: (c) => R.notifications(c.svc()) },
    'lookup:all': { access: 'session', handler: (c) => getLookups(c.svc()) },

    'company:list': { access: 'session', handler: ({ db }) => listCompanies(db) },
    'company:get': { access: 'company.view', handler: ({ db }, i) => getCompany(db, i.id) },
    'company:create': {
      access: 'company.manage',
      handler: ({ db, sessions }, i) => {
        // Keep sample data and real books apart: real companies go in the company database.
        if (databaseEnvironment(db) === 'DEMO') throw businessRule('This is the DEMO database. Set up your company database from the sign-in screen ("Set up my company") instead of adding a company here.')
        return createCompany(db, sessions.get()!.userId, i)
      }
    },
    'company:update': {
      access: 'company.manage',
      handler: ({ db, sessions }, i) => {
        const updated = updateCompany(db, sessions.get()!.userId, i)
        const s = sessions.get()!
        if (s.company?.id === updated.id) sessions.set(buildSession(db, s.userId, updated.id))
        return updated
      }
    },
    'company:switch': {
      access: 'session',
      handler: ({ db, sessions }, i) => {
        const s = sessions.get()!
        const company = db.prepare('SELECT id, name, is_active FROM companies WHERE id = ?').get(i.id) as { id: number; name: string; is_active: number } | undefined
        if (!company) throw notFound('Company')
        if (!company.is_active) throw new AppError('BUSINESS_RULE', 'This company is inactive')
        const next = buildSession(db, s.userId, company.id)
        sessions.set(next)
        writeAudit(db, { companyId: company.id, userId: s.userId, action: 'SWITCH_COMPANY', entityType: 'company', entityId: company.id, summary: `${s.username} switched to ${company.name}` })
        return next
      }
    },

    'customer:list': { access: 'customer.view', handler: (c, i) => listCustomers(c.svc(), i) },
    'customer:get': { access: 'customer.view', handler: (c, i) => getCustomer(c.svc(), i.id) },
    'customer:create': { access: 'customer.manage', handler: (c, i) => createCustomer(c.svc(), i) },
    'customer:update': { access: 'customer.manage', handler: (c, i) => updateCustomer(c.svc(), i) },
    'customer:setActive': { access: 'customer.manage', handler: (c, i) => setCustomerActive(c.svc(), i.id, i.isActive) },

    'supplier:list': { access: 'supplier.view', handler: (c, i) => listSuppliers(c.svc(), i) },
    'supplier:get': { access: 'supplier.view', handler: (c, i) => getSupplier(c.svc(), i.id) },
    'supplier:create': { access: 'supplier.manage', handler: (c, i) => createSupplier(c.svc(), i) },
    'supplier:update': { access: 'supplier.manage', handler: (c, i) => updateSupplier(c.svc(), i) },
    'supplier:setActive': { access: 'supplier.manage', handler: (c, i) => setSupplierActive(c.svc(), i.id, i.isActive) },

    'product:list': { access: 'product.view', handler: (c, i) => listProducts(c.svc(), i) },
    'product:get': { access: 'product.view', handler: (c, i) => getProduct(c.svc(), i.id) },
    'product:create': { access: 'product.manage', handler: (c, i) => createProduct(c.svc(), i) },
    'product:update': { access: 'product.manage', handler: (c, i) => updateProduct(c.svc(), i) },
    'product:setActive': { access: 'product.manage', handler: (c, i) => setProductActive(c.svc(), i.id, i.isActive) },

    'sales:list': { access: 'sales.view', handler: (c, i) => R.salesList(c.svc(), i) },
    'purchase:list': { access: 'purchase.view', handler: (c, i) => R.purchaseList(c.svc(), i) },
    'inventory:stock': { access: 'inventory.view', handler: (c) => R.stockSummary(c.svc()) },
    'inventory:movements': { access: 'inventory.view', handler: (c, i) => R.stockMovements(c.svc(), i) },
    'finance:trialBalance': { access: 'finance.view', handler: (c) => R.trialBalance(c.svc()) },
    'finance:journals': { access: 'finance.view', handler: (c, i) => R.journals(c.svc(), i) },
    'gst:summary': { access: 'gst.view', handler: (c) => R.gstSummary(c.svc()) },
    'banking:overview': { access: 'banking.view', handler: (c) => R.bankingOverview(c.svc()) },
    'audit:list': { access: 'audit.view', handler: (c, i) => R.auditList(c.svc(), i) },
    'user:list': { access: 'user.view', handler: (c) => R.userList(c.svc()) },
    'user:roles': { access: 'user.view', handler: (c) => R.roleList(c.svc()) },

    'ewaybill:list': { access: 'ewaybill.view', handler: (c, i) => ewayBills.list(c.svc(), i ?? {}) },
    'ewaybill:get': { access: 'ewaybill.view', handler: (c, i) => ewayBills.get(c.svc(), i.id) },
    'ewaybill:eligibleInvoices': { access: 'ewaybill.manage', handler: (c) => ewayBills.eligibleInvoices(c.svc()) },
    'ewaybill:generate': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.generate(c.svc(), i) },
    'ewaybill:updatePartB': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.updatePartB(c.svc(), i) },
    'ewaybill:cancel': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.cancel(c.svc(), i) },

    'doc:list': { access: 'session', handler: (c, i) => listDocuments(need(c, `${sideOf(i.kind)}.view`), i) },
    'doc:get': { access: 'session', handler: (c, i) => loadDocument(need(c, `${sideOf(i.kind)}.view`), i.kind, i.id) },
    'doc:saveDraft': { access: 'session', handler: (c, i) => saveDraft(need(c, `${sideOf(i.kind)}.post`), i) },
    'doc:deleteDraft': {
      access: 'session',
      handler: (c, i) => {
        deleteDraft(need(c, `${sideOf(i.kind)}.post`), i.kind, i.id)
        return null
      }
    },
    'doc:validate': { access: 'session', handler: (c, i) => validateDocument(need(c, `${sideOf(i.kind)}.view`), i.kind, i.id) },
    'doc:post': { access: 'session', handler: (c, i) => postDocument(need(c, `${sideOf(i.kind)}.post`), i.kind, i.id) },
    'doc:cancel': { access: 'session', handler: (c, i) => cancelDocument(need(c, `${sideOf(i.kind)}.cancel`), i.kind, i.id, i.reason) },
    'doc:convert': {
      access: 'session',
      handler: (c, i) => {
        need(c, `${sideOf(i.kind)}.view`)
        return convertDocument(need(c, `${sideOf(i.target)}.post`), i.kind, i.id, i.target)
      }
    },
    'doc:printHtml': {
      access: 'session',
      handler: (c, i) => {
        const ctx = need(c, `${sideOf(i.kind)}.view`)
        const doc = loadDocument(ctx, i.kind, i.id)
        return { html: buildDocumentHtml(ctx, i.kind, i.id), fileName: docFileName(i.kind, doc.number) }
      }
    },
    'doc:exportPdf': {
      access: 'session',
      handler: async (c, i) => {
        const ctx = need(c, `${sideOf(i.kind)}.view`)
        const p = needPrinting()
        const doc = loadDocument(ctx, i.kind, i.id)
        const pdf = await p.toPdf(buildDocumentHtml(ctx, i.kind, i.id))
        const path = await p.savePdf(docFileName(i.kind, doc.number), pdf)
        if (path) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_PDF', entityType: i.kind.toLowerCase(), entityId: i.id, summary: `${KINDS[i.kind].label} ${doc.number} exported to PDF` })
        return { path, bytes: pdf.length }
      }
    },
    'doc:print': {
      access: 'session',
      handler: async (c, i) => {
        const ctx = need(c, `${sideOf(i.kind)}.view`)
        const printed = await needPrinting().print(buildDocumentHtml(ctx, i.kind, i.id))
        if (printed) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'PRINT', entityType: i.kind.toLowerCase(), entityId: i.id, summary: `${KINDS[i.kind].label} #${i.id} sent to printer` })
        return { printed }
      }
    },
    'doc:register': { access: 'session', handler: (c, i) => register(need(c, `${i.side === 'SALES' ? 'sales' : 'purchase'}.view`), i) },
    'doc:summary': { access: 'session', handler: (c, i) => moduleSummary(need(c, `${i.side === 'SALES' ? 'sales' : 'purchase'}.view`), i.side) },
    'payment:list': { access: 'session', handler: (c, i) => listPayments(need(c, i.type === 'RECEIPT' ? 'sales.view' : 'purchase.view'), i) },
    'payment:get': { access: 'session', handler: (c, i) => getPayment(need(c, i.type === 'RECEIPT' ? 'sales.view' : 'purchase.view'), i.type, i.id) },
    'payment:create': { access: 'session', handler: (c, i) => createPayment(need(c, i.type === 'RECEIPT' ? 'sales.post' : 'purchase.post'), i) },
    'payment:openInvoices': { access: 'session', handler: (c, i) => openInvoices(need(c, i.type === 'RECEIPT' ? 'sales.view' : 'purchase.view'), i.type, i.partyId) },

    // Phase 3: finance & accounting (read-only reports)
    'finance:periods': { access: 'session', handler: (c) => periods(c.svc()) },
    'finance:dashboard': { access: 'finance.view', handler: (c, i) => FS.financeDashboard(c.svc(), i.from, i.to) },
    'finance:accounts': { access: 'finance.view', handler: (c) => FS.chartOfAccounts(c.svc()) },
    'finance:journal': { access: 'finance.view', handler: (c, i) => FS.journalDetail(c.svc(), i.id) },
    'finance:ledger': { access: 'finance.view', handler: (c, i) => FS.generalLedger(c.svc(), i) },
    'finance:trialBalanceReport': { access: 'finance.view', handler: (c, i) => FS.trialBalanceReport(c.svc(), i.from, i.to) },
    'finance:profitLoss': { access: 'finance.view', handler: (c, i) => FS.profitAndLoss(c.svc(), i.from, i.to) },
    'finance:balanceSheet': { access: 'finance.view', handler: (c, i) => FS.balanceSheet(c.svc(), i.asOf) },
    'finance:dayBook': { access: 'finance.view', handler: (c, i) => FS.dayBook(c.svc(), i.from, i.to) },
    'finance:cashBook': { access: 'banking.view', handler: (c, i) => FS.cashBook(c.svc(), i.accountId, i.from, i.to) },
    'finance:ageing': { access: 'finance.view', handler: (c, i) => ageing(c.svc(), i.side, i.asOf) },
    'finance:partyStatement': { access: 'finance.view', handler: (c, i) => partyStatement(c.svc(), i.side, i.partyId, i.asOf) },

    // Vouchers: viewing needs finance.view; posting/cancelling needs finance.manage (auditors never have it).
    'voucher:list': { access: 'finance.view', handler: (c, i) => listVouchers(c.svc(), i ?? {}) },
    'voucher:get': { access: 'finance.view', handler: (c, i) => getVoucher(c.svc(), i.id) },
    'voucher:create': { access: 'finance.manage', handler: (c, i) => createVoucher(c.svc(), i) },
    'voucher:cancel': { access: 'finance.manage', handler: (c, i) => cancelVoucher(c.svc(), i.id, i.reason) },

    // Bank reconciliation: never changes posted transactions.
    'bankrec:list': { access: 'banking.view', handler: (c, i) => BR.listReconciliations(c.svc(), i ?? {}) },
    'bankrec:get': { access: 'banking.view', handler: (c, i) => BR.getReconciliation(c.svc(), i.id) },
    'bankrec:create': { access: 'finance.manage', handler: (c, i) => BR.createReconciliation(c.svc(), i) },
    'bankrec:update': { access: 'finance.manage', handler: (c, i) => BR.updateReconciliation(c.svc(), i) },
    'bankrec:addLines': { access: 'finance.manage', handler: (c, i) => BR.addStatementLines(c.svc(), i) },
    'bankrec:match': { access: 'finance.manage', handler: (c, i) => BR.matchLine(c.svc(), i) },
    'bankrec:unmatch': { access: 'finance.manage', handler: (c, i) => BR.unmatchLine(c.svc(), i) },
    'bankrec:deleteLine': { access: 'finance.manage', handler: (c, i) => BR.deleteStatementLine(c.svc(), i) },
    'bankrec:tick': { access: 'finance.manage', handler: (c, i) => BR.tickBookLine(c.svc(), i) },
    'bankrec:autoMatch': { access: 'finance.manage', handler: (c, i) => BR.autoMatch(c.svc(), i.id) },
    'bankrec:record': { access: 'finance.manage', handler: (c, i) => BR.recordInBooks(c.svc(), i) },
    'bankrec:complete': { access: 'finance.manage', handler: (c, i) => BR.completeReconciliation(c.svc(), i.id) },

    // Auditor workspace (read-only).
    'audit:exceptions': { access: 'audit.view', handler: (c, i) => auditExceptions(c.svc(), i ?? {}) },
    'audit:integrity': { access: 'audit.view', handler: (c, i) => integrityReport(c.svc(), i?.asOf) },

    // Reports: preview, PDF, Excel and print all come from the same ReportDoc.
    'report:run': { access: 'session', handler: (c, i) => buildReport(reportCtx(c, i, 'reports.view'), i) },
    'report:exportPdf': {
      access: 'session',
      handler: async (c, i) => {
        const ctx = reportCtx(c, i, 'reports.export')
        const p = needPrinting()
        const doc = buildReport(ctx, i)
        const pdf = await p.toPdf(reportHtml(doc))
        const path = await p.savePdf(reportFileName(doc.title, 'pdf'), pdf)
        if (path) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_PDF', entityType: 'report', summary: `${doc.title} (${doc.subtitle}) exported to PDF`, details: { params: i } })
        return { path, bytes: pdf.length }
      }
    },
    'report:exportExcel': {
      access: 'session',
      handler: async (c, i) => {
        const ctx = reportCtx(c, i, 'reports.export')
        const doc = buildReport(ctx, i)
        const xlsx = reportToXlsx(doc)
        const path = await needPrinting().saveFile(reportFileName(doc.title, 'xlsx'), xlsx, { name: 'Excel workbook', extensions: ['xlsx'] })
        if (path) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_EXCEL', entityType: 'report', summary: `${doc.title} (${doc.subtitle}) exported to Excel`, details: { params: i } })
        return { path, bytes: xlsx.length }
      }
    },
    'report:print': {
      access: 'session',
      handler: async (c, i) => {
        const ctx = reportCtx(c, i, 'reports.export')
        const doc = buildReport(ctx, i)
        const printed = await needPrinting().print(reportHtml(doc))
        if (printed) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'PRINT', entityType: 'report', summary: `${doc.title} (${doc.subtitle}) sent to printer` })
        return { printed }
      }
    },

    // ───────── Phase 4: GST configuration, registers, returns (preparation only), reconciliation ─────────
    'gst:overview': { access: 'gst.view', handler: (c, i) => GR.gstOverview(c.svc(), i.period, i.gstin) },
    'gst:config': { access: 'gst.view', handler: (c) => GC.gstConfig(c.svc()) },
    'gst:saveRegistration': { access: 'gst.manage', handler: (c, i) => GC.saveRegistration(c.svc(), i) },
    'gst:saveSettings': { access: 'gst.manage', handler: (c, i) => GC.saveSettings(c.svc(), i) },
    'gst:saveRule': { access: 'gst.manage', handler: (c, i) => GC.saveRule(c.svc(), i) },
    'gst:hsnList': { access: 'gst.view', handler: (c) => GC.listHsn(c.svc()) },
    'gst:hsnRates': { access: 'gst.view', handler: (c, i) => GC.listHsnRates(c.svc(), i?.hsnCode) },
    'gst:saveHsn': { access: 'gst.manage', handler: (c, i) => GC.saveHsn(c.svc(), i) },
    'gst:saveHsnRate': { access: 'gst.manage', handler: (c, i) => GC.saveHsnRate(c.svc(), i) },
    'gst:importHsn': { access: 'gst.manage', handler: (c) => GC.importHsnFromProducts(c.svc()) },
    'gst:saveTaxRateDates': { access: 'gst.manage', handler: (c, i) => GC.saveTaxRateDates(c.svc(), i) },
    'gst:salesRegister': { access: 'gst.view', handler: (c, i) => salesRegister(c.svc(), i) },
    'gst:purchaseRegister': { access: 'gst.view', handler: (c, i) => purchaseRegister(c.svc(), i) },
    'gst:classifyItc': { access: 'gst.manage', handler: (c, i) => classifyItc(c.svc(), i) },
    'gst:validate': { access: 'gst.view', handler: (c, i) => GR.validateGst(c.svc(), i.from, i.to, i.gstin) },
    'gst:gstr1': { access: 'gst.view', handler: (c, i) => GR.gstr1(c.svc(), i.period, i.gstin) },
    'gst:gstr3b': { access: 'gst.view', handler: (c, i) => GR.gstr3b(c.svc(), i.period, i.gstin) },
    'gst:prepare': { access: 'gst.manage', handler: (c, i) => GR.prepareReturn(c.svc(), i.returnType, i.period, i.gstin) },
    'gst:preparations': { access: 'gst.view', handler: (c, i) => GR.listPreparations(c.svc(), i?.returnType) },
    'gst:preparation': { access: 'gst.view', handler: (c, i) => GR.getPreparation(c.svc(), i.id) },
    'gst:previewPreparation': {
      access: 'gst.view',
      handler: (c, i) => {
        const ctx = c.svc()
        const co = ctx.db.prepare('SELECT name, is_demo FROM companies WHERE id = ?').get(ctx.companyId) as { name: string; is_demo: number }
        return GR.preparationReport(co.name, GR.getPreparation(ctx, i.id), co.is_demo === 1)
      }
    },
    'gst:exportPreparation': {
      access: 'gst.view',
      handler: async (c, i) => {
        const ctx = need(c, 'reports.export')
        const prep = GR.getPreparation(ctx, i.id)
        const co = ctx.db.prepare('SELECT name, is_demo FROM companies WHERE id = ?').get(ctx.companyId) as { name: string; is_demo: number }
        const base = `${prep.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} ${prep.period} ${prep.gstin} (prepared, not filed)`.replace(/[\\/:*?"<>|]+/g, '-')
        const data = i.format === 'JSON' ? GR.preparationJson(prep) : reportToXlsx(GR.preparationReport(co.name, prep, co.is_demo === 1))
        const path = await needPrinting().saveFile(`${base}.${i.format === 'JSON' ? 'json' : 'xlsx'}`, data, i.format === 'JSON' ? { name: 'JSON', extensions: ['json'] } : { name: 'Excel workbook', extensions: ['xlsx'] })
        if (path) {
          // Only users who prepare returns change the preparation status; auditors' exports are just logged.
          if (c.sessions.has('gst.manage')) GR.markExported(ctx, prep.id, i.format)
          else writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_EXCEL', entityType: 'gst_return', entityId: prep.id, summary: `${base} exported (${i.format}) for review` })
        }
        return { path, bytes: data.length }
      }
    },
    'gst:reconList': { access: 'gst.view', handler: (c) => RC.listRecon(c.svc()) },
    'gst:reconGet': { access: 'gst.view', handler: (c, i) => RC.reconDetail(c.svc(), i.id) },
    'gst:reconImport': { access: 'gst.manage', handler: (c, i) => RC.importRecon(c.svc(), i) },
    'gst:reconRematch': { access: 'gst.manage', handler: (c, i) => RC.rematch(c.svc(), i.id) },
    'gst:reconReview': { access: 'gst.manage', handler: (c, i) => RC.reviewRecon(c.svc(), i.lineIds, i.reviewStatus, i.note) },

    // ───────── Integrations (mode, encrypted credentials, API history) ─────────
    'integration:overview': { access: 'session', handler: (c) => IS.integrationOverview(needAny(c, 'gst.view', 'einvoice.view', 'ewaybill.view', 'integration.manage'), secrets) },
    // Live/sandbox mode may be selected in the DEMO database (every such request fails safely: no adapter),
    // but credentials are refused there, so demo documents can never reach a government system.
    'integration:save': { access: 'integration.manage', handler: (c, i) => IS.saveIntegration(c.svc(), i, secrets) },
    'integration:saveCredentials': {
      access: 'integration.manage',
      handler: (c, i) => {
        if (databaseEnvironment(c.db) === 'DEMO') throw businessRule('Credentials cannot be stored in the DEMO database')
        return IS.saveCredentials(c.svc(), i, secrets)
      }
    },
    'integration:deleteCredentials': { access: 'integration.manage', handler: (c, i) => IS.deleteCredentials(c.svc(), i.service, i.environment, secrets) },
    'integration:apiLog': { access: 'session', handler: (c, i) => IS.apiLog(needAny(c, 'gst.view', 'einvoice.view', 'ewaybill.view', 'audit.view'), i ?? {}) },

    // ───────── E-invoice ─────────
    'einvoice:workspace': { access: 'einvoice.view', handler: (c, i) => einvoices.workspace(c.svc(), i.from, i.to) },
    'einvoice:list': { access: 'einvoice.view', handler: (c, i) => einvoices.list(c.svc(), i ?? {}) },
    'einvoice:get': { access: 'einvoice.view', handler: (c, i) => einvoices.get(c.svc(), i.id) },
    'einvoice:eligibility': { access: 'einvoice.view', handler: (c, i) => einvoices.eligibility(c.svc(), i.documentKind, i.documentId) },
    'einvoice:generate': { access: 'einvoice.manage', handler: (c, i) => einvoices.generate(c.svc(), i) },
    'einvoice:retry': { access: 'einvoice.manage', handler: (c, i) => einvoices.retry(c.svc(), i.id) },
    'einvoice:cancel': { access: 'einvoice.manage', handler: (c, i) => einvoices.cancel(c.svc(), i) },
    'einvoice:status': { access: 'einvoice.manage', handler: (c, i) => einvoices.status(c.svc(), i.id) },
    'einvoice:printHtml': { access: 'einvoice.view', handler: (c, i) => einvoices.printHtml(c.svc(), i.id) },
    'einvoice:exportPdf': {
      access: 'einvoice.view',
      handler: async (c, i) => {
        const ctx = c.svc()
        const p = needPrinting()
        const { html, fileName } = einvoices.printHtml(ctx, i.id)
        const pdf = await p.toPdf(html)
        const path = await p.savePdf(fileName, pdf)
        if (path) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_PDF', entityType: 'einvoice', entityId: i.id, summary: `${fileName} exported` })
        return { path, bytes: pdf.length }
      }
    },
    'einvoice:print': {
      access: 'einvoice.view',
      handler: async (c, i) => {
        const ctx = c.svc()
        const { html, fileName } = einvoices.printHtml(ctx, i.id)
        const printed = await needPrinting().print(html)
        if (printed) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'PRINT', entityType: 'einvoice', entityId: i.id, summary: `${fileName.replace(/\.pdf$/, '')} sent to printer` })
        return { printed }
      }
    },

    // ───────── E-way bill (Phase 4 operations) ─────────
    'ewaybill:sources': { access: 'ewaybill.view', handler: (c, i) => ewayBills.sources(c.svc(), i.from, i.to) },
    'ewaybill:preview': { access: 'ewaybill.view', handler: (c, i) => ewayBills.preview(c.svc(), i.kind, i.id) },
    'ewaybill:updateTransporter': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.updateTransporter(c.svc(), i) },
    'ewaybill:extend': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.extend(c.svc(), i) },
    'ewaybill:status': { access: 'ewaybill.manage', handler: (c, i) => ewayBills.status(c.svc(), i.id) },
    'ewaybill:printHtml': { access: 'ewaybill.view', handler: (c, i) => ewayBills.printHtml(c.svc(), i.id) },
    'ewaybill:exportPdf': {
      access: 'ewaybill.view',
      handler: async (c, i) => {
        const ctx = c.svc()
        const p = needPrinting()
        const { html, fileName } = ewayBills.printHtml(ctx, i.id)
        const pdf = await p.toPdf(html)
        const path = await p.savePdf(fileName, pdf)
        if (path) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'EXPORT_PDF', entityType: 'ewaybill', entityId: i.id, summary: `${fileName} exported` })
        return { path, bytes: pdf.length }
      }
    },
    'ewaybill:print': {
      access: 'ewaybill.view',
      handler: async (c, i) => {
        const ctx = c.svc()
        const { html, fileName } = ewayBills.printHtml(ctx, i.id)
        const printed = await needPrinting().print(html)
        if (printed) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'PRINT', entityType: 'ewaybill', entityId: i.id, summary: `${fileName.replace(/\.pdf$/, '')} sent to printer` })
        return { printed }
      }
    },

    // ───────── Transport masters ─────────
    'transport:masters': { access: 'ewaybill.view', handler: (c) => TR.transportMasters(c.svc()) },
    'transport:saveTransporter': { access: 'ewaybill.manage', handler: (c, i) => TR.saveTransporter(c.svc(), i) },
    'transport:saveVehicle': { access: 'ewaybill.manage', handler: (c, i) => TR.saveVehicle(c.svc(), i) },
    'transport:saveDoc': { access: 'ewaybill.manage', handler: (c, i) => TR.saveTransportDoc(c.svc(), i) },
    'transport:docs': { access: 'ewaybill.view', handler: (c, i) => TR.listTransportDocs(c.svc(), i ?? {}) },

    // ───────── Phase 5: workspace, users, backup & restore ─────────
    'workspace:status': { access: 'public', handler: () => ws().status() },
    'workspace:setupCompany': { access: 'public', handler: (_c, i) => explain(() => ws().setupCompany(i)) },
    'workspace:switch': {
      access: 'public',
      handler: (c, i) => {
        const s = c.sessions.get()
        if (s && c.db?.open) writeAudit(c.db, { companyId: s.company?.id ?? null, userId: s.userId, action: 'LOGOUT', entityType: 'user', entityId: s.userId, summary: `${s.username} signed out to open the ${i.target === 'DEMO' ? 'demo' : 'company'} database` })
        c.sessions.set(null)
        return ws().switchTo(i.target)
      }
    },
    'auth:changePassword': {
      access: 'session',
      handler: ({ db, sessions }, i) => {
        const s = sessions.get()!
        U.changeOwnPassword(db, s.userId, i)
        const fresh = buildSession(db, s.userId, s.company?.id)
        sessions.set(fresh)
        return fresh
      }
    },
    'user:adminList': { access: 'user.view', handler: ({ db }) => U.listUserAdmin(db) },
    'user:create': { access: 'user.manage', handler: ({ db, sessions }, i) => U.createUser(db, sessions.get()!.userId, i) },
    'user:update': { access: 'user.manage', handler: ({ db, sessions }, i) => U.updateUser(db, sessions.get()!.userId, i) },
    'user:resetPassword': { access: 'user.manage', handler: ({ db, sessions }, i) => U.resetPassword(db, sessions.get()!.userId, i) },
    'user:unlock': { access: 'user.manage', handler: ({ db, sessions }, i) => U.unlockUser(db, sessions.get()!.userId, i.id) },

    'backup:overview': { access: 'backup.view', handler: ({ db }) => explain(() => backups().overview(currentSchemaVersion(db))) },
    'backup:create': {
      access: 'backup.manage',
      handler: (c, i) =>
        explain(async () => {
          const b = await backups().backupNow('MANUAL', i.label ?? null)
          audit(c, 'BACKUP_CREATE', `Manual backup ${b.fileName} created (${b.sizeBytes} bytes)`, { fileName: b.fileName, sha256: b.sha256 })
          return b
        })
    },
    'backup:verify': { access: 'backup.view', handler: (_c, i) => explain(() => backups().verify(i.fileName)) },
    'backup:saveSettings': {
      access: 'backup.manage',
      handler: (c, i) =>
        explain(() => {
          const m = backups()
          const { useDefaultDirectory, ...rest } = i
          m.saveSettings({ ...rest, ...(useDefaultDirectory ? { directory: null } : {}) })
          audit(c, 'BACKUP_SETTINGS', `Backup settings changed: automatic ${i.autoEnabled ? `every ${i.intervalHours} h, keep ${i.keepAutomatic}` : 'off'}${useDefaultDirectory ? '; default folder' : ''}`)
          return m.overview(currentSchemaVersion(c.db))
        })
    },
    'backup:chooseDirectory': {
      access: 'backup.manage',
      handler: (c) =>
        explain(async () => {
          const dir = await ws().chooseDirectory()
          if (!dir) return null
          const m = backups()
          m.saveSettings({ directory: dir })
          audit(c, 'BACKUP_SETTINGS', `Backup folder changed to ${dir}`)
          return m.overview(currentSchemaVersion(c.db))
        })
    },
    'backup:import': {
      access: 'backup.manage',
      handler: (c) =>
        explain(async () => {
          const file = await ws().chooseImportFile()
          if (!file) return null
          const b = backups().importFile(file)
          audit(c, 'BACKUP_IMPORT', `Backup file imported as ${b.fileName} (${b.environment})`, { fileName: b.fileName, sha256: b.sha256 })
          return b
        })
    },
    'backup:restore': {
      access: 'backup.manage',
      handler: (c, i) =>
        explain(async () => {
          const s = c.sessions.get()!
          if (i.confirmText !== RESTORE_CONFIRM_PHRASE) throw new AppError('VALIDATION', `Type ${RESTORE_CONFIRM_PHRASE} to confirm`, { confirmText: `Type ${RESTORE_CONFIRM_PHRASE}` })
          if (!U.confirmPassword(c.db, s.userId, i.password)) {
            audit(c, 'RESTORE_REFUSED', `Restore of ${i.fileName} refused: password not confirmed`)
            throw new AppError('VALIDATION', 'Password not confirmed', { password: 'Incorrect password' })
          }
          const m = backups()
          const check = m.verify(i.fileName)
          if (!check.ok) throw businessRule(`The backup cannot be restored: ${check.errors.join('; ')}`)
          audit(c, 'RESTORE_START', `Restore of ${i.fileName} started by ${s.username}`, { fileName: i.fileName })
          const db = c.db
          try {
            const res = await m.restore(i.fileName, s.username)
            return { ...res, relaunching: true }
          } finally {
            // Whatever happened, if the connection was closed: sign out and restart cleanly.
            if (!db.open) {
              c.sessions.set(null)
              ws().relaunchSoon()
            }
          }
        })
    }
  }
}
