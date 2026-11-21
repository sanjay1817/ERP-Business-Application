/**
 * Phase 5 — backup, restore, workspace (demo vs company database) and user
 * administration DTOs and inputs. Shared by the main process and the renderer.
 */
import { z } from 'zod'
import { CompanyInput } from './schemas'

export const DB_ENVIRONMENTS = ['DEMO', 'COMPANY'] as const
export type DbEnvironment = (typeof DB_ENVIRONMENTS)[number]
/** What a database file says about itself (UNSET = fresh file not yet set up; UNKNOWN = file older than schema 6 that could not be classified). */
export type DbProfileEnvironment = DbEnvironment | 'UNSET' | 'UNKNOWN'

export const BACKUP_REASONS = ['MANUAL', 'AUTO', 'PRE_UPGRADE', 'PRE_RESTORE', 'IMPORTED'] as const
export type BackupReason = (typeof BACKUP_REASONS)[number]
export const BACKUP_REASON_LABELS: Record<BackupReason, string> = {
  MANUAL: 'Manual', AUTO: 'Automatic', PRE_UPGRADE: 'Before upgrade', PRE_RESTORE: 'Before restore', IMPORTED: 'Imported file'
}

export const BACKUP_FORMAT = 'sa-erp-backup/1'

export interface BackupCounts {
  companies: number
  users: number
  documents: number
  journalLines: number
  stockMovements: number
  auditLogs: number
}

/** Sidecar manifest written next to every completed backup (<name>.db + <name>.json). */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  fileName: string
  createdAt: string
  reason: BackupReason
  label: string | null
  environment: DbProfileEnvironment
  databaseUid: string | null
  schemaVersion: number
  appVersion: string
  sizeBytes: number
  sha256: string
  integrity: 'ok'
  foreignKeyViolations: number
  counts: BackupCounts
  /** Set for IMPORTED backups: the original file name chosen by the user. */
  sourceName?: string | null
}

export interface BackupInfo extends BackupManifest {
  /** Absolute path of the .db file (main process only uses it; shown for the administrator). */
  path: string
}

export interface BackupVerifyResult {
  ok: boolean
  fileName: string
  errors: string[]
  warnings: string[]
  schemaVersion: number | null
  environment: DbProfileEnvironment
  sha256: string | null
  counts: BackupCounts | null
  foreignKeyViolations: number
}

export interface BackupSettings {
  autoEnabled: boolean
  intervalHours: number
  keepAutomatic: number
  keepSafety: number
  /** null = <data folder>\backups */
  directory: string | null
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { autoEnabled: true, intervalHours: 24, keepAutomatic: 14, keepSafety: 10, directory: null }

export interface RestoreHistoryEntry {
  at: string
  environment: DbEnvironment
  outcome: 'RESTORED' | 'FAILED' | 'ROLLED_BACK' | 'RECOVERED'
  backupFile: string | null
  safetyBackup: string | null
  message: string
  user: string | null
}

export interface BackupOverview {
  environment: DbEnvironment
  databasePath: string
  directory: string
  defaultDirectory: string
  settings: BackupSettings
  backups: BackupInfo[]
  lastAutomaticAt: string | null
  nextAutomaticDue: string | null
  partialFilesRemoved: number
  restoreHistory: RestoreHistoryEntry[]
  schemaVersion: number
}

export interface WorkspaceStatus {
  /** null when no database is open (first run: choose company setup or demo). */
  environment: DbEnvironment | null
  needsSetup: boolean
  companyDatabaseExists: boolean
  demoDatabaseExists: boolean
  databasePath: string | null
  dataDirectory: string
  /** Message to show once, e.g. an interrupted restore that was rolled back at startup. */
  startupNotice: string | null
}

// ───────── Inputs ─────────

const password = z.string().min(1, 'Required').max(200)
/** Password policy for real company data. Demo passwords are refused. */
export const NewPassword = z
  .string()
  .min(10, 'At least 10 characters')
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letters and at least one number')
  .refine((p) => !['admin@123', 'accounts@123', 'auditor@123', 'password123', '1234567890'].includes(p.toLowerCase()), 'This password is publicly known; choose another')

export const Username = z.string().trim().min(3, 'At least 3 characters').max(40).regex(/^[A-Za-z0-9._-]+$/, 'Letters, numbers, dot, dash or underscore only')

export const BackupCreateInput = z.strictObject({ label: z.string().trim().max(80).nullable().optional() })
export const BackupFileInput = z.strictObject({ fileName: z.string().min(5).max(200).regex(/^[A-Za-z0-9._-]+\.db$/, 'Invalid backup file name') })
export const BackupSettingsInput = z.strictObject({
  autoEnabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(24 * 7),
  keepAutomatic: z.number().int().min(1).max(365),
  keepSafety: z.number().int().min(1).max(100),
  /** true = keep the current folder; false = reset to default. Choosing a new folder uses backup:chooseDirectory. */
  useDefaultDirectory: z.boolean().optional()
})
export const RESTORE_CONFIRM_PHRASE = 'RESTORE'
export const BackupRestoreInput = z.strictObject({
  fileName: BackupFileInput.shape.fileName,
  confirmText: z.string().max(40),
  password
})

export const WorkspaceSwitchInput = z.strictObject({ target: z.enum(DB_ENVIRONMENTS) })
export const WorkspaceSetupInput = z
  .strictObject({
    company: CompanyInput,
    adminUsername: Username,
    adminFullName: z.string().trim().min(2).max(100),
    adminPassword: NewPassword,
    confirmPassword: z.string()
  })
  .refine((v) => v.adminPassword === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] })
  .refine((v) => v.adminPassword.toLowerCase() !== v.adminUsername.toLowerCase(), { message: 'Password must differ from the username', path: ['adminPassword'] })

export const ChangePasswordInput = z
  .strictObject({ currentPassword: password, newPassword: NewPassword, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] })
  .refine((v) => v.newPassword !== v.currentPassword, { message: 'Choose a different password', path: ['newPassword'] })

export const ROLE_CODES = ['ADMIN', 'ACCOUNTANT', 'SALES', 'AUDITOR'] as const
export const UserCreateInput = z.strictObject({
  username: Username,
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(120).nullable().optional(),
  roleCode: z.enum(ROLE_CODES),
  temporaryPassword: NewPassword
})
export const UserUpdateInput = z.strictObject({
  id: z.number().int().positive(),
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(120).nullable().optional(),
  roleCode: z.enum(ROLE_CODES),
  isActive: z.boolean()
})
export const UserResetPasswordInput = z.strictObject({ id: z.number().int().positive(), temporaryPassword: NewPassword })
export const UserUnlockInput = z.strictObject({ id: z.number().int().positive() })
