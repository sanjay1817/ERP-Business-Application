import type { Migration } from '../migrator'

export const PERMISSIONS: ReadonlyArray<[code: string, module: string, description: string]> = [
  ['dashboard.view', 'Dashboard', 'View dashboard'],
  ['company.view', 'Masters', 'View companies'],
  ['company.manage', 'Masters', 'Create and edit companies'],
  ['customer.view', 'Masters', 'View customers'],
  ['customer.manage', 'Masters', 'Create and edit customers'],
  ['supplier.view', 'Masters', 'View suppliers'],
  ['supplier.manage', 'Masters', 'Create and edit suppliers'],
  ['product.view', 'Masters', 'View products and services'],
  ['product.manage', 'Masters', 'Create and edit products and services'],
  ['sales.view', 'Sales', 'View sales invoices'],
  ['sales.post', 'Sales', 'Post sales invoices'],
  ['purchase.view', 'Purchase', 'View purchase invoices'],
  ['purchase.post', 'Purchase', 'Post purchase invoices'],
  ['inventory.view', 'Inventory', 'View stock'],
  ['finance.view', 'Finance', 'View ledgers and journals'],
  ['gst.view', 'GST', 'View GST summaries'],
  ['banking.view', 'Banking', 'View bank and cash'],
  ['ewaybill.view', 'E-Way Bill', 'View e-way bills'],
  ['ewaybill.manage', 'E-Way Bill', 'Generate, update and cancel e-way bills'],
  ['audit.view', 'Auditor', 'View audit trail'],
  ['user.view', 'Users', 'View users and roles'],
  ['user.manage', 'Users', 'Manage users and roles'],
  ['settings.view', 'Settings', 'View application settings']
]

const ROLES: ReadonlyArray<[code: string, name: string, description: string, perms: '*' | string[]]> = [
  ['ADMIN', 'Administrator', 'Full access to all modules', '*'],
  [
    'ACCOUNTANT',
    'Accountant',
    'Finance, GST and masters',
    ['dashboard.view', 'company.view', 'customer.view', 'customer.manage', 'supplier.view', 'supplier.manage', 'product.view', 'sales.view', 'sales.post', 'purchase.view', 'purchase.post', 'inventory.view', 'finance.view', 'gst.view', 'banking.view', 'ewaybill.view', 'ewaybill.manage', 'settings.view']
  ],
  ['SALES', 'Sales Executive', 'Customers and sales', ['dashboard.view', 'customer.view', 'customer.manage', 'product.view', 'sales.view', 'sales.post', 'inventory.view', 'ewaybill.view']],
  ['AUDITOR', 'Auditor (read-only)', 'Read-only access including audit trail', ['dashboard.view', 'company.view', 'customer.view', 'supplier.view', 'product.view', 'sales.view', 'purchase.view', 'inventory.view', 'finance.view', 'gst.view', 'banking.view', 'ewaybill.view', 'audit.view', 'settings.view']]
]

// GST UQC codes.
const UNITS: ReadonlyArray<[code: string, name: string, decimals: number]> = [
  ['NOS', 'Numbers', 0],
  ['PCS', 'Pieces', 0],
  ['BOX', 'Box', 0],
  ['KGS', 'Kilograms', 3],
  ['MTR', 'Metres', 2],
  ['LTR', 'Litres', 3],
  ['SET', 'Sets', 0],
  ['HRS', 'Hours', 2],
  ['OTH', 'Others (Service)', 2]
]

// GST slabs in force after the September 2025 rate rationalisation.
const TAX_RATES: ReadonlyArray<[name: string, bps: number]> = [
  ['GST 0% (Exempt/Nil)', 0],
  ['GST 0.25%', 25],
  ['GST 3%', 300],
  ['GST 5%', 500],
  ['GST 18%', 1800],
  ['GST 40%', 4000]
]

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`

function buildSql(): string {
  const lines: string[] = []
  for (const [code, module, desc] of PERMISSIONS) lines.push(`INSERT INTO permissions (code, module, description) VALUES (${q(code)}, ${q(module)}, ${q(desc)});`)
  for (const [code, name, desc, perms] of ROLES) {
    lines.push(`INSERT INTO roles (code, name, description, is_system) VALUES (${q(code)}, ${q(name)}, ${q(desc)}, 1);`)
    const filter = perms === '*' ? '' : `WHERE code IN (${perms.map(q).join(', ')})`
    lines.push(`INSERT INTO role_permissions (role_id, permission_id) SELECT (SELECT id FROM roles WHERE code = ${q(code)}), id FROM permissions ${filter};`)
  }
  for (const [code, name, dec] of UNITS) lines.push(`INSERT INTO units (code, name, decimal_places) VALUES (${q(code)}, ${q(name)}, ${dec});`)
  for (const [name, bps] of TAX_RATES) lines.push(`INSERT INTO tax_rates (name, rate_bps) VALUES (${q(name)}, ${bps});`)
  return lines.join('\n')
}

export const migration002: Migration = { version: 2, name: 'reference_data', sql: buildSql() }
