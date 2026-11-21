import { z } from 'zod'
import * as S from './schemas'
import * as D from './documents'
import * as F from './finance'
import * as G from './gst'
import * as B from './backup'
import type { IpcChannel } from './ipc-channels'
import type * as T from './types'

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date')
const GstRangeInput = z.object({ from: isoDay, to: isoDay }).strict()
const GstHsnRatesInput = z.object({ hsnCode: z.string().max(8).optional() }).strict().optional()

/** Input schema per channel: validated in the main process before any handler runs. */
export const ipcInputSchemas = {
  'auth:login': S.LoginInput,
  'auth:logout': S.NoInput,
  'auth:session': S.NoInput,
  'app:info': S.NoInput,
  'app:loginInfo': S.NoInput,
  'dashboard:summary': S.NoInput,
  'search:global': S.SearchInput,
  'notifications:list': S.NoInput,
  'lookup:all': S.NoInput,
  'company:list': S.NoInput,
  'company:get': S.IdInput,
  'company:create': S.CompanyInput,
  'company:update': S.CompanyUpdateInput,
  'company:switch': S.IdInput,
  'customer:list': S.ListQuery,
  'customer:get': S.IdInput,
  'customer:create': S.CustomerInput,
  'customer:update': S.CustomerUpdateInput,
  'customer:setActive': S.SetActiveInput,
  'supplier:list': S.ListQuery,
  'supplier:get': S.IdInput,
  'supplier:create': S.SupplierInput,
  'supplier:update': S.SupplierUpdateInput,
  'supplier:setActive': S.SetActiveInput,
  'product:list': S.ListQuery,
  'product:get': S.IdInput,
  'product:create': S.ProductInput,
  'product:update': S.ProductUpdateInput,
  'product:setActive': S.SetActiveInput,
  'sales:list': S.ListQuery,
  'purchase:list': S.ListQuery,
  'inventory:stock': S.NoInput,
  'inventory:movements': S.MovementListInput,
  'finance:trialBalance': S.NoInput,
  'finance:journals': S.ListQuery,
  'gst:summary': S.NoInput,
  'banking:overview': S.NoInput,
  'audit:list': S.AuditListInput,
  'user:list': S.NoInput,
  'user:roles': S.NoInput,
  'ewaybill:list': G.EwbListInput,
  'ewaybill:get': S.IdInput,
  'ewaybill:eligibleInvoices': S.NoInput,
  'ewaybill:generate': S.EwbGenerateInput,
  'ewaybill:updatePartB': S.EwbPartBInput,
  'ewaybill:cancel': S.EwbCancelInput,
  'doc:list': D.DocumentListInput,
  'doc:get': D.DocumentRef,
  'doc:saveDraft': D.DocumentSaveInput,
  'doc:deleteDraft': D.DocumentRef,
  'doc:validate': D.DocumentRef,
  'doc:post': D.DocumentRef,
  'doc:cancel': D.DocumentCancelInput,
  'doc:convert': D.DocumentConvertInput,
  'doc:printHtml': D.DocumentRef,
  'doc:exportPdf': D.DocumentRef,
  'doc:print': D.DocumentRef,
  'doc:register': D.RegisterInput,
  'doc:summary': D.SideInput,
  'payment:list': D.PaymentListInput,
  'payment:get': D.PaymentRef,
  'payment:create': D.PaymentCreateInput,
  'payment:openInvoices': D.OpenInvoicesInput,
  'finance:periods': S.NoInput,
  'finance:dashboard': F.PeriodInput,
  'finance:accounts': S.NoInput,
  'finance:journal': F.JournalGetInput,
  'finance:ledger': F.LedgerInput,
  'finance:trialBalanceReport': F.PeriodInput,
  'finance:profitLoss': F.PeriodInput,
  'finance:balanceSheet': F.AsOfInput,
  'finance:dayBook': F.PeriodInput,
  'finance:cashBook': F.CashBookInput,
  'finance:ageing': F.AgeingInput,
  'finance:partyStatement': F.PartyStatementInput,
  'voucher:list': F.VoucherListInput,
  'voucher:get': S.IdInput,
  'voucher:create': F.VoucherCreateInput,
  'voucher:cancel': F.VoucherCancelInput,
  'bankrec:list': F.BankRecListInput,
  'bankrec:get': F.BankRecIdInput,
  'bankrec:create': F.BankRecCreateInput,
  'bankrec:update': F.BankRecUpdateInput,
  'bankrec:addLines': F.BankRecAddLinesInput,
  'bankrec:match': F.BankRecMatchInput,
  'bankrec:unmatch': F.BankRecLineRef,
  'bankrec:deleteLine': F.BankRecLineRef,
  'bankrec:tick': F.BankRecTickInput,
  'bankrec:autoMatch': F.BankRecIdInput,
  'bankrec:record': F.BankRecRecordInput,
  'bankrec:complete': F.BankRecIdInput,
  'audit:exceptions': F.ExceptionsInput,
  'audit:integrity': F.AsOfInput.optional(),
  'report:run': F.ReportParams,
  'report:exportPdf': F.ReportParams,
  'report:exportExcel': F.ReportParams,
  'report:print': F.ReportParams,
  'gst:overview': G.ReturnPeriodInput,
  'gst:config': S.NoInput,
  'gst:saveRegistration': G.RegistrationSaveInput,
  'gst:saveSettings': G.GstSettingsInput,
  'gst:saveRule': G.RuleSaveInput,
  'gst:hsnList': S.NoInput,
  'gst:hsnRates': GstHsnRatesInput,
  'gst:saveHsn': G.HsnSaveInput,
  'gst:saveHsnRate': G.HsnRateSaveInput,
  'gst:importHsn': S.NoInput,
  'gst:saveTaxRateDates': G.TaxRateDatesInput,
  'gst:salesRegister': G.GstPeriodInput,
  'gst:purchaseRegister': G.GstPeriodInput,
  'gst:classifyItc': G.ItcClassifyInput,
  'gst:validate': G.GstPeriodInput,
  'gst:gstr1': G.ReturnPeriodInput,
  'gst:gstr3b': G.ReturnPeriodInput,
  'gst:prepare': G.ReturnPrepareInput,
  'gst:preparations': G.ReturnListInput,
  'gst:preparation': S.IdInput,
  'gst:previewPreparation': S.IdInput,
  'gst:exportPreparation': G.ReturnExportInput,
  'gst:reconList': S.NoInput,
  'gst:reconGet': S.IdInput,
  'gst:reconImport': G.ReconImportInput,
  'gst:reconRematch': S.IdInput,
  'gst:reconReview': G.ReconReviewInput,
  'integration:overview': S.NoInput,
  'integration:save': G.IntegrationSaveInput,
  'integration:saveCredentials': G.CredentialSaveInput,
  'integration:deleteCredentials': G.CredentialRef,
  'integration:apiLog': G.ApiLogInput,
  'einvoice:workspace': GstRangeInput,
  'einvoice:list': G.EInvoiceListInput,
  'einvoice:get': S.IdInput,
  'einvoice:eligibility': G.EInvoiceDocRef,
  'einvoice:generate': G.EInvoiceGenerateInput,
  'einvoice:retry': S.IdInput,
  'einvoice:cancel': G.EInvoiceCancelInput,
  'einvoice:status': S.IdInput,
  'einvoice:printHtml': S.IdInput,
  'einvoice:exportPdf': S.IdInput,
  'einvoice:print': S.IdInput,
  'ewaybill:sources': GstRangeInput,
  'ewaybill:preview': G.EwbSourceRef,
  'ewaybill:updateTransporter': G.EwbTransporterInput,
  'ewaybill:extend': G.EwbExtendInput,
  'ewaybill:status': S.IdInput,
  'ewaybill:printHtml': S.IdInput,
  'ewaybill:exportPdf': S.IdInput,
  'ewaybill:print': S.IdInput,
  'transport:masters': S.NoInput,
  'transport:saveTransporter': G.TransporterSaveInput,
  'transport:saveVehicle': G.VehicleSaveInput,
  'transport:saveDoc': G.TransportDocSaveInput,
  'transport:docs': G.TransportDocListInput,
  'workspace:status': S.NoInput,
  'workspace:setupCompany': B.WorkspaceSetupInput,
  'workspace:switch': B.WorkspaceSwitchInput,
  'auth:changePassword': B.ChangePasswordInput,
  'user:adminList': S.NoInput,
  'user:create': B.UserCreateInput,
  'user:update': B.UserUpdateInput,
  'user:resetPassword': B.UserResetPasswordInput,
  'user:unlock': B.UserUnlockInput,
  'backup:overview': S.NoInput,
  'backup:create': B.BackupCreateInput,
  'backup:verify': B.BackupFileInput,
  'backup:saveSettings': B.BackupSettingsInput,
  'backup:chooseDirectory': S.NoInput,
  'backup:import': S.NoInput,
  'backup:restore': B.BackupRestoreInput
} satisfies Record<IpcChannel, z.ZodType>

export interface IpcOutputs {
  'auth:login': T.SessionInfo
  'auth:logout': null
  'auth:session': T.SessionInfo | null
  'app:info': T.AppInfo
  'app:loginInfo': T.LoginInfo
  'dashboard:summary': T.DashboardSummary
  'search:global': T.SearchResult[]
  'notifications:list': T.NotificationItem[]
  'lookup:all': T.Lookups
  'company:list': T.Company[]
  'company:get': T.Company
  'company:create': T.Company
  'company:update': T.Company
  'company:switch': T.SessionInfo
  'customer:list': T.Customer[]
  'customer:get': T.Customer
  'customer:create': T.Customer
  'customer:update': T.Customer
  'customer:setActive': T.Customer
  'supplier:list': T.Supplier[]
  'supplier:get': T.Supplier
  'supplier:create': T.Supplier
  'supplier:update': T.Supplier
  'supplier:setActive': T.Supplier
  'product:list': T.Product[]
  'product:get': T.Product
  'product:create': T.Product
  'product:update': T.Product
  'product:setActive': T.Product
  'sales:list': T.InvoiceRow[]
  'purchase:list': T.InvoiceRow[]
  'inventory:stock': T.StockRow[]
  'inventory:movements': T.MovementRow[]
  'finance:trialBalance': T.TrialBalanceRow[]
  'finance:journals': T.JournalRow[]
  'gst:summary': T.GstSummaryRow[]
  'banking:overview': T.BankingOverview
  'audit:list': T.AuditRow[]
  'user:list': T.UserRow[]
  'user:roles': T.RoleRow[]
  'ewaybill:list': T.EwayBill[]
  'ewaybill:get': T.EwayBill
  'ewaybill:eligibleInvoices': T.EwbEligibleInvoice[]
  'ewaybill:generate': T.EwayBill
  'ewaybill:updatePartB': T.EwayBill
  'ewaybill:cancel': T.EwayBill
  'doc:list': D.DocumentRow[]
  'doc:get': D.DocumentDetail
  'doc:saveDraft': D.DocumentDetail
  'doc:deleteDraft': null
  'doc:validate': D.ValidationResult
  'doc:post': D.DocumentDetail
  'doc:cancel': D.DocumentDetail
  'doc:convert': D.DocumentDetail
  'doc:printHtml': { html: string; fileName: string }
  'doc:exportPdf': { path: string | null; bytes: number }
  'doc:print': { printed: boolean }
  'doc:register': D.RegisterRow[]
  'doc:summary': D.ModuleSummary
  'payment:list': D.PaymentRow[]
  'payment:get': D.PaymentDetail
  'payment:create': D.PaymentDetail
  'payment:openInvoices': D.OpenInvoice[]
  'finance:periods': F.PeriodsInfo
  'finance:dashboard': F.FinanceDashboard
  'finance:accounts': F.AccountRow[]
  'finance:journal': F.JournalDetail
  'finance:ledger': F.LedgerReport
  'finance:trialBalanceReport': F.TrialBalanceReport
  'finance:profitLoss': F.ProfitLossReport
  'finance:balanceSheet': F.BalanceSheetReport
  'finance:dayBook': F.DayBookEntry[]
  'finance:cashBook': F.CashBookReport
  'finance:ageing': F.AgeingReport
  'finance:partyStatement': F.PartyStatement
  'voucher:list': F.VoucherRow[]
  'voucher:get': F.VoucherDetail
  'voucher:create': F.VoucherDetail
  'voucher:cancel': F.VoucherDetail
  'bankrec:list': F.BankRecRow[]
  'bankrec:get': F.BankRecDetail
  'bankrec:create': F.BankRecDetail
  'bankrec:update': F.BankRecDetail
  'bankrec:addLines': F.BankRecDetail
  'bankrec:match': F.BankRecDetail
  'bankrec:unmatch': F.BankRecDetail
  'bankrec:deleteLine': F.BankRecDetail
  'bankrec:tick': F.BankRecDetail
  'bankrec:autoMatch': { matched: number; detail: F.BankRecDetail }
  'bankrec:record': F.BankRecDetail
  'bankrec:complete': F.BankRecDetail
  'audit:exceptions': F.AuditExceptionReport
  'audit:integrity': F.IntegrityReport
  'report:run': F.ReportDoc
  'report:exportPdf': { path: string | null; bytes: number }
  'report:exportExcel': { path: string | null; bytes: number }
  'report:print': { printed: boolean }
  'gst:overview': G.GstOverview
  'gst:config': G.GstConfig
  'gst:saveRegistration': G.GstRegistration[]
  'gst:saveSettings': G.GstSettings
  'gst:saveRule': G.ComplianceRule[]
  'gst:hsnList': G.HsnCode[]
  'gst:hsnRates': G.HsnRateRule[]
  'gst:saveHsn': G.HsnCode[]
  'gst:saveHsnRate': G.HsnRateRule[]
  'gst:importHsn': { added: number }
  'gst:saveTaxRateDates': G.TaxRateRow[]
  'gst:salesRegister': G.GstSalesRegister
  'gst:purchaseRegister': G.GstPurchaseRegister
  'gst:classifyItc': { updated: number }
  'gst:validate': G.GstValidationReport
  'gst:gstr1': G.Gstr1Data
  'gst:gstr3b': G.Gstr3bData
  'gst:prepare': G.ReturnPreparation
  'gst:preparations': G.ReturnPreparation[]
  'gst:preparation': G.ReturnPreparation
  'gst:previewPreparation': F.ReportDoc
  'gst:exportPreparation': { path: string | null; bytes: number }
  'gst:reconList': G.ReconBatch[]
  'gst:reconGet': G.ReconDetail
  'gst:reconImport': G.ReconDetail
  'gst:reconRematch': G.ReconDetail
  'gst:reconReview': { updated: number }
  'integration:overview': G.IntegrationOverview
  'integration:save': G.IntegrationOverview
  'integration:saveCredentials': G.IntegrationOverview
  'integration:deleteCredentials': G.IntegrationOverview
  'integration:apiLog': G.ApiRequestRow[]
  'einvoice:workspace': G.EInvoiceWorkspace
  'einvoice:list': G.EInvoiceRow[]
  'einvoice:get': G.EInvoiceDetail
  'einvoice:eligibility': G.EInvoiceEligibility
  'einvoice:generate': G.EInvoiceDetail
  'einvoice:retry': G.EInvoiceDetail
  'einvoice:cancel': G.EInvoiceDetail
  'einvoice:status': G.EInvoiceDetail
  'einvoice:printHtml': { html: string; fileName: string }
  'einvoice:exportPdf': { path: string | null; bytes: number }
  'einvoice:print': { printed: boolean }
  'ewaybill:sources': G.EwbSourceCandidate[]
  'ewaybill:preview': G.EwbPreview
  'ewaybill:updateTransporter': T.EwayBill
  'ewaybill:extend': T.EwayBill
  'ewaybill:status': T.EwayBill
  'ewaybill:printHtml': { html: string; fileName: string }
  'ewaybill:exportPdf': { path: string | null; bytes: number }
  'ewaybill:print': { printed: boolean }
  'transport:masters': G.TransportMasters
  'transport:saveTransporter': G.Transporter[]
  'transport:saveVehicle': G.Vehicle[]
  'transport:saveDoc': G.TransportDoc[]
  'transport:docs': G.TransportDoc[]
  'workspace:status': B.WorkspaceStatus
  'workspace:setupCompany': { relaunching: boolean }
  'workspace:switch': { relaunching: boolean }
  'auth:changePassword': T.SessionInfo
  'user:adminList': T.UserAdminRow[]
  'user:create': T.UserAdminRow
  'user:update': T.UserAdminRow
  'user:resetPassword': T.UserAdminRow
  'user:unlock': T.UserAdminRow
  'backup:overview': B.BackupOverview
  'backup:create': B.BackupInfo
  'backup:verify': B.BackupVerifyResult
  'backup:saveSettings': B.BackupOverview
  'backup:chooseDirectory': B.BackupOverview | null
  'backup:import': B.BackupInfo | null
  'backup:restore': { outcome: 'RESTORED' | 'ROLLED_BACK'; message: string; safetyBackup: string; relaunching: boolean }
}

/** What the renderer sends (pre-parse input type). */
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcInputSchemas)[C]>
/** What handlers receive (post-parse output type). */
export type IpcParsed<C extends IpcChannel> = z.output<(typeof ipcInputSchemas)[C]>
export type IpcOutput<C extends IpcChannel> = IpcOutputs[C]
