import {
  ArchiveRestore, BarChart3, BookOpenText, Boxes, Building2, Database, FileCheck2, LayoutDashboard, Landmark, Percent, Settings, ShieldCheck,
  ShoppingCart, TrendingUp, Truck, Users, type LucideIcon
} from 'lucide-react'
import { KINDS, kindBySlug } from '@shared/documents'

export interface NavItem {
  label: string
  path: string
  icon: LucideIcon
  permission?: string
  group: 'Overview' | 'Transactions' | 'Compliance' | 'Control' | 'Administration'
}

export const NAV: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, permission: 'dashboard.view', group: 'Overview' },
  { label: 'Sales', path: '/sales', icon: TrendingUp, permission: 'sales.view', group: 'Transactions' },
  { label: 'Purchase', path: '/purchase', icon: ShoppingCart, permission: 'purchase.view', group: 'Transactions' },
  { label: 'Inventory', path: '/inventory', icon: Boxes, permission: 'inventory.view', group: 'Transactions' },
  { label: 'Finance & Accounts', path: '/finance', icon: BookOpenText, permission: 'finance.view', group: 'Transactions' },
  { label: 'Banking', path: '/banking', icon: Landmark, permission: 'banking.view', group: 'Transactions' },
  { label: 'GST Management', path: '/gst', icon: Percent, permission: 'gst.view', group: 'Compliance' },
  { label: 'E-Invoice', path: '/einvoice', icon: FileCheck2, permission: 'einvoice.view', group: 'Compliance' },
  { label: 'E-Way Bill', path: '/ewaybill', icon: Truck, permission: 'ewaybill.view', group: 'Compliance' },
  { label: 'Auditor', path: '/auditor', icon: ShieldCheck, permission: 'audit.view', group: 'Control' },
  { label: 'Reports', path: '/reports', icon: BarChart3, permission: 'reports.view', group: 'Control' },
  { label: 'Masters', path: '/masters', icon: Database, group: 'Administration' },
  { label: 'User Management', path: '/users', icon: Users, permission: 'user.view', group: 'Administration' },
  { label: 'Backup & Restore', path: '/backup', icon: ArchiveRestore, permission: 'backup.view', group: 'Administration' },
  { label: 'Settings', path: '/settings', icon: Settings, permission: 'settings.view', group: 'Administration' }
]

export const MASTERS = [
  { label: 'Companies', path: '/masters/companies', permission: 'company.view', icon: Building2 },
  { label: 'Customers', path: '/masters/customers', permission: 'customer.view', icon: Users },
  { label: 'Suppliers', path: '/masters/suppliers', permission: 'supplier.view', icon: Truck },
  { label: 'Products & Services', path: '/masters/products', permission: 'product.view', icon: Boxes },
  { label: 'Transport', path: '/masters/transport', permission: 'ewaybill.view', icon: Truck }
]

const SUB_LABELS: Record<string, string> = { customers: 'Customers', register: 'Register', receipts: 'Receipts', payments: 'Payments' }
const SECTION_LABELS: Record<string, string> = {
  ledger: 'General Ledger', 'trial-balance': 'Trial Balance', 'profit-loss': 'Profit & Loss', 'balance-sheet': 'Balance Sheet', 'day-book': 'Day Book',
  vouchers: 'Vouchers', receivables: 'Receivables', payables: 'Payables', accounts: 'Chart of Accounts', 'cash-book': 'Cash Book', 'bank-book': 'Bank Book',
  reconciliation: 'Bank Reconciliation', exceptions: 'Exception report', journals: 'Journal inspector', stock: 'Stock movements', trail: 'Audit trail'
}
const GST_LABELS: Record<string, string> = {
  sales: 'Sales register', purchases: 'Purchase register & ITC', gstr1: 'GSTR-1', gstr3b: 'GSTR-3B', validation: 'Validation', reconciliation: 'Reconciliation', config: 'Configuration', new: 'New'
}

/** Breadcrumb labels for every routed path segment. */
export function breadcrumbsFor(pathname: string): Array<{ label: string; path: string }> {
  const crumbs: Array<{ label: string; path: string }> = [{ label: 'Home', path: '/dashboard' }]
  const top = NAV.find((n) => pathname === n.path || pathname.startsWith(`${n.path}/`))
  if (top && top.path !== '/dashboard') crumbs.push({ label: top.label, path: top.path })
  if (top && (top.path === '/sales' || top.path === '/purchase')) {
    const [, , seg, id] = pathname.split('/')
    if (seg) {
      const side = top.path === '/sales' ? 'SALES' : 'PURCHASE'
      const kind = kindBySlug(side, seg)
      crumbs.push({ label: kind ? KINDS[kind].plural : (SUB_LABELS[seg] ?? seg), path: `${top.path}/${seg}` })
      if (id) crumbs.push({ label: id === 'new' ? 'New' : `#${id}`, path: pathname })
    }
  }
  if (top && (top.path === '/gst' || top.path === '/einvoice' || top.path === '/ewaybill')) {
    const [, , seg, id] = pathname.split('/')
    if (seg) {
      crumbs.push({ label: GST_LABELS[seg] ?? `#${seg}`, path: `${top.path}/${seg}` })
      if (id) crumbs.push({ label: `#${id}`, path: pathname })
    }
  }
  if (top && (top.path === '/finance' || top.path === '/banking' || top.path === '/auditor')) {
    const [, , seg, id] = pathname.split('/')
    if (seg) {
      crumbs.push({ label: SECTION_LABELS[seg] ?? seg, path: `${top.path}/${seg}` })
      if (id) crumbs.push({ label: id === 'new' ? 'New' : `#${id}`, path: pathname })
    }
  }
  const master = MASTERS.find((m) => pathname.startsWith(m.path))
  if (master) crumbs.push({ label: master.label, path: master.path })
  if (top?.path === '/dashboard') crumbs.push({ label: 'Dashboard', path: '/dashboard' })
  return crumbs
}
