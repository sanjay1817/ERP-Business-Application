import type { IpcError, IpcErrorCode } from '@shared/types'

export class AppError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>
  ) {
    super(message)
    this.name = 'AppError'
  }
  toIpc(): IpcError {
    return { code: this.code, message: this.message, ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}) }
  }
}

/**
 * Raised when a journal's debits and credits differ. The posting transaction rolls
 * back; callers record the rejected attempt in the audit log afterwards.
 */
export class UnbalancedJournalError extends AppError {
  constructor(
    public readonly debitPaise: number,
    public readonly creditPaise: number,
    public readonly context: { narration?: string; sourceKind?: string | null; entryDate?: string } = {}
  ) {
    super('BUSINESS_RULE', `Journal is not balanced (debit ${debitPaise} ≠ credit ${creditPaise} paise)`)
    this.name = 'UnbalancedJournalError'
  }
}

export const notFound = (what: string): AppError => new AppError('NOT_FOUND', `${what} was not found`)
export const conflict = (message: string, fieldErrors?: Record<string, string>): AppError => new AppError('CONFLICT', message, fieldErrors)
export const businessRule = (message: string, fieldErrors?: Record<string, string>): AppError => new AppError('BUSINESS_RULE', message, fieldErrors)
export const validation = (message: string, fieldErrors?: Record<string, string>): AppError => new AppError('VALIDATION', message, fieldErrors)

interface SqliteLikeError {
  code?: string
  message: string
}

const UNIQUE_FIELD_HINTS: Array<[RegExp, string, string]> = [
  [/\.code$/, 'code', 'This code is already in use'],
  [/supplier_invoice_no/, 'supplierRef', 'This supplier invoice number is already recorded for this supplier'],
  [/invoice_no|doc_no/, 'number', 'This document number already exists for the financial year'],
  [/username/, 'username', 'This username is already taken'],
  [/receipt_no|voucher_no|entry_no/, 'number', 'This document number already exists']
]

/** Translate SQLite constraint failures into user-facing errors (never leak SQL). */
export function fromSqliteError(err: unknown): AppError | null {
  const e = err as SqliteLikeError
  if (!e || typeof e.code !== 'string' || !e.code.startsWith('SQLITE_')) return null
  switch (e.code) {
    case 'SQLITE_CONSTRAINT_UNIQUE':
    case 'SQLITE_CONSTRAINT_PRIMARYKEY': {
      const columns = e.message.replace(/^UNIQUE constraint failed: /, '')
      const hint = UNIQUE_FIELD_HINTS.find(([re]) => re.test(columns))
      return conflict(hint ? hint[2] : 'A record with the same unique value already exists', hint ? { [hint[1]]: hint[2] } : undefined)
    }
    case 'SQLITE_CONSTRAINT_TRIGGER':
      return businessRule(e.message)
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
      return businessRule('This record is linked to other data and cannot be changed this way')
    case 'SQLITE_CONSTRAINT_CHECK':
    case 'SQLITE_CONSTRAINT_NOTNULL':
      return validation('The data violates a database rule and was not saved')
    case 'SQLITE_BUSY':
      return new AppError('INTERNAL', 'The database is busy. Please try again.')
    default:
      return null
  }
}
