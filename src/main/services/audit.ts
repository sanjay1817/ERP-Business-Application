import type { DB } from '../db/connection'

export interface AuditEntry {
  companyId: number | null
  userId: number | null
  action: string
  entityType: string
  entityId?: number | null
  summary: string
  details?: unknown
}

const SECRET_KEYS = /password|hash|secret|token/i

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)]))
  }
  return value
}

/** Field-level diff for update audits. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of Object.keys(after)) {
    if (key === 'updatedAt' || key === 'balancePaise') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { from: before[key], to: after[key] }
  }
  return out
}

export function writeAudit(db: DB, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, summary, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.companyId,
    entry.userId,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.summary,
    entry.details === undefined ? null : JSON.stringify(redact(entry.details))
  )
}
