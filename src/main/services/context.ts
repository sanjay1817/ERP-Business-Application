import type { DB } from '../db/connection'

/** Everything a service needs to act on behalf of a user within a company. */
export interface ServiceContext {
  db: DB
  userId: number | null
  companyId: number
}

/** Run fn inside a transaction (nested calls become savepoints). */
export function inTransaction<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)()
}

export const bool = (v: unknown): boolean => v === 1 || v === true
