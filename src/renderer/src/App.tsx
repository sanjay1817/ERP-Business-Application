import { Component, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { SessionProvider, useSession } from './lib/session'
import { ToastProvider } from './lib/toast'
import AppShell from './layouts/AppShell'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import MastersHub from './pages/masters/MastersHub'
import CompaniesPage from './pages/masters/CompaniesPage'
import { CustomersPage, SuppliersPage } from './pages/masters/PartiesPage'
import ProductsPage from './pages/masters/ProductsPage'
import DocumentListPage from './pages/docs/DocumentListPage'
import DocumentEditorPage from './pages/docs/DocumentEditorPage'
import { PaymentEditorPage, PaymentListPage } from './pages/docs/PaymentsPages'
import { CustomerSelectionPage, ModuleDashboard, RegisterPage } from './pages/docs/ModulePages'
import InventoryPage from './pages/InventoryPage'
import { GstOverviewPage, GstPurchaseRegisterPage, GstSalesRegisterPage, GstValidationPage } from './pages/gst/GstRegisterPages'
import { Gstr1Page, Gstr3bPage } from './pages/gst/GstReturnPages'
import { GstReconDetailPage, GstReconListPage } from './pages/gst/GstReconPages'
import GstConfigPage from './pages/gst/GstConfigPage'
import { EInvoiceDetailPage, EInvoiceWorkspacePage } from './pages/einvoice/EInvoicePages'
import TransportPage from './pages/masters/TransportPage'
import EwayBillPage, { EwayBillNewPage } from './pages/EwayBillPage'
import { AuditorExceptions, AuditorJournals, AuditorOverview, AuditorStock, AuditTrail } from './pages/AuditorPage'
import FinanceDashboard from './pages/finance/FinanceDashboard'
import { ChartOfAccountsPage, DayBookPage, GeneralLedgerPage, TrialBalancePage } from './pages/finance/LedgerPages'
import { BalanceSheetPage, ProfitLossPage } from './pages/finance/StatementPages'
import { VoucherListPage, VoucherPage } from './pages/finance/VoucherPages'
import { AgeingPage, PartyStatementPage } from './pages/finance/AgeingPages'
import { BankingOverviewPage, CashBankBookPage, ReconciliationListPage, ReconciliationPage } from './pages/banking/BankingPages'
import ReportsPage from './pages/ReportsPage'
import UsersPage from './pages/UsersPage'
import SettingsPage from './pages/SettingsPage'
import BackupPage from './pages/BackupPage'
import { FirstRunPage, ForcedPasswordChangePage } from './pages/WorkspacePages'
import { api } from './lib/api'
import { useQuery } from './lib/hooks'
import type { WorkspaceStatus } from '@shared/backup'
import { RequirePermission } from './components/RequirePermission'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid h-full place-items-center p-10">
        <div className="max-w-lg rounded-xl border border-red-200 bg-white p-6 shadow">
          <h1 className="text-lg font-bold text-red-700">Something went wrong on this screen</h1>
          <p className="mt-2 text-[13px] text-ink-2">{this.state.error.message}</p>
          <button className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white" onClick={() => (this.setState({ error: null }), (location.hash = '#/dashboard'))}>
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }
}

function Gate() {
  const { session, ready } = useSession()
  const ws = useQuery<WorkspaceStatus>(() => api('workspace:status'))
  if (!ready || (!ws.data && !ws.error))
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  if (ws.data?.needsSetup) return <FirstRunPage status={ws.data} />
  if (!session) return <LoginPage workspace={ws.data ?? null} />
  if (session.mustChangePassword) return <ForcedPasswordChangePage />
  const P = (perm: string, el: ReactNode) => <RequirePermission permission={perm}>{el}</RequirePermission>
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={P('dashboard.view', <DashboardPage />)} />
        <Route path="/sales" element={P('sales.view', <ModuleDashboard key="sales" side="SALES" />)} />
        <Route path="/sales/customers" element={P('sales.view', <CustomerSelectionPage />)} />
        <Route path="/sales/register" element={P('sales.view', <RegisterPage key="sales-reg" side="SALES" />)} />
        <Route path="/sales/receipts" element={P('sales.view', <PaymentListPage key="rct" type="RECEIPT" />)} />
        <Route path="/sales/receipts/:id" element={P('sales.view', <PaymentEditorPage type="RECEIPT" />)} />
        <Route path="/sales/:slug" element={P('sales.view', <DocumentListPage side="SALES" />)} />
        <Route path="/sales/:slug/:id" element={P('sales.view', <DocumentEditorPage side="SALES" />)} />
        <Route path="/purchase" element={P('purchase.view', <ModuleDashboard key="purchase" side="PURCHASE" />)} />
        <Route path="/purchase/register" element={P('purchase.view', <RegisterPage key="pur-reg" side="PURCHASE" />)} />
        <Route path="/purchase/payments" element={P('purchase.view', <PaymentListPage key="pay" type="PAYMENT" />)} />
        <Route path="/purchase/payments/:id" element={P('purchase.view', <PaymentEditorPage type="PAYMENT" />)} />
        <Route path="/purchase/:slug" element={P('purchase.view', <DocumentListPage side="PURCHASE" />)} />
        <Route path="/purchase/:slug/:id" element={P('purchase.view', <DocumentEditorPage side="PURCHASE" />)} />
        <Route path="/inventory" element={P('inventory.view', <InventoryPage />)} />
        <Route path="/finance" element={P('finance.view', <FinanceDashboard />)} />
        <Route path="/finance/ledger" element={P('finance.view', <GeneralLedgerPage />)} />
        <Route path="/finance/trial-balance" element={P('finance.view', <TrialBalancePage />)} />
        <Route path="/finance/profit-loss" element={P('finance.view', <ProfitLossPage />)} />
        <Route path="/finance/balance-sheet" element={P('finance.view', <BalanceSheetPage />)} />
        <Route path="/finance/day-book" element={P('finance.view', <DayBookPage />)} />
        <Route path="/finance/vouchers" element={P('finance.view', <VoucherListPage />)} />
        <Route path="/finance/vouchers/:id" element={P('finance.view', <VoucherPage />)} />
        <Route path="/finance/receivables" element={P('finance.view', <AgeingPage key="ar" side="CUSTOMER" />)} />
        <Route path="/finance/receivables/:partyId" element={P('finance.view', <PartyStatementPage key="ar-p" side="CUSTOMER" />)} />
        <Route path="/finance/payables" element={P('finance.view', <AgeingPage key="ap" side="SUPPLIER" />)} />
        <Route path="/finance/payables/:partyId" element={P('finance.view', <PartyStatementPage key="ap-p" side="SUPPLIER" />)} />
        <Route path="/finance/accounts" element={P('finance.view', <ChartOfAccountsPage />)} />
        <Route path="/banking" element={P('banking.view', <BankingOverviewPage />)} />
        <Route path="/banking/cash-book" element={P('banking.view', <CashBankBookPage key="cash" kind="CASH" />)} />
        <Route path="/banking/bank-book" element={P('banking.view', <CashBankBookPage key="bank" kind="BANK" />)} />
        <Route path="/banking/reconciliation" element={P('banking.view', <ReconciliationListPage />)} />
        <Route path="/banking/reconciliation/:id" element={P('banking.view', <ReconciliationPage />)} />
        <Route path="/gst" element={P('gst.view', <GstOverviewPage />)} />
        <Route path="/gst/sales" element={P('gst.view', <GstSalesRegisterPage />)} />
        <Route path="/gst/purchases" element={P('gst.view', <GstPurchaseRegisterPage />)} />
        <Route path="/gst/gstr1" element={P('gst.view', <Gstr1Page />)} />
        <Route path="/gst/gstr3b" element={P('gst.view', <Gstr3bPage />)} />
        <Route path="/gst/validation" element={P('gst.view', <GstValidationPage />)} />
        <Route path="/gst/reconciliation" element={P('gst.view', <GstReconListPage />)} />
        <Route path="/gst/reconciliation/:id" element={P('gst.view', <GstReconDetailPage />)} />
        <Route path="/gst/config" element={P('gst.view', <GstConfigPage />)} />
        <Route path="/einvoice" element={P('einvoice.view', <EInvoiceWorkspacePage />)} />
        <Route path="/einvoice/:id" element={P('einvoice.view', <EInvoiceDetailPage />)} />
        <Route path="/ewaybill" element={P('ewaybill.view', <EwayBillPage />)} />
        <Route path="/ewaybill/new" element={P('ewaybill.manage', <EwayBillNewPage />)} />
        <Route path="/auditor" element={P('audit.view', <AuditorOverview />)} />
        <Route path="/auditor/exceptions" element={P('audit.view', <AuditorExceptions />)} />
        <Route path="/auditor/journals" element={P('audit.view', <AuditorJournals />)} />
        <Route path="/auditor/stock" element={P('audit.view', <AuditorStock />)} />
        <Route path="/auditor/trail" element={P('audit.view', <AuditTrail />)} />
        <Route path="/reports" element={P('reports.view', <ReportsPage />)} />
        <Route path="/masters" element={<MastersHub />} />
        <Route path="/masters/companies" element={P('company.view', <CompaniesPage />)} />
        <Route path="/masters/customers" element={P('customer.view', <CustomersPage />)} />
        <Route path="/masters/suppliers" element={P('supplier.view', <SuppliersPage />)} />
        <Route path="/masters/products" element={P('product.view', <ProductsPage />)} />
        <Route path="/masters/transport" element={P('ewaybill.view', <TransportPage />)} />
        <Route path="/users" element={P('user.view', <UsersPage />)} />
        <Route path="/settings" element={P('settings.view', <SettingsPage />)} />
        <Route path="/backup" element={P('backup.view', <BackupPage />)} />
        <Route path="*" element={<Navigate to={session.roleCode === 'AUDITOR' ? '/auditor' : session.permissions.includes('dashboard.view') ? '/dashboard' : '/masters'} replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <SessionProvider>
          <HashRouter>
            <Gate />
          </HashRouter>
        </SessionProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}
