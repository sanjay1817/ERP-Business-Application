/**
 * Integration settings (mode per company and service), encrypted credentials and
 * the API request history. Credentials are encrypted with the OS key store
 * (Electron safeStorage / Windows DPAPI) and are never returned to the renderer,
 * written to logs or included in audit details.
 */
import type { z } from 'zod'
import {
  INTEGRATION_SERVICES, type ApiRequestRow, type CredentialSaveInput, type CredentialStatus, type IntegrationMode, type IntegrationOverview, type IntegrationSaveInput,
  type IntegrationService, type IntegrationSetting
} from '@shared/gst'
import { writeAudit } from '../audit'
import { bool, inTransaction, type ServiceContext } from '../context'
import { businessRule } from '../errors'

/** OS-backed encryption. The Electron implementation wraps safeStorage; tests inject a fake. */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

export const NOT_CONNECTED_NOTICE =
  'No government system is connected. Live and sandbox modes need an authorised GSP/IRP/e-way bill API provider, credentials issued to this GSTIN, and an adapter written from that provider’s current technical specification. Until then every live/sandbox request fails safely and nothing is reported as successful.'

type Row = Record<string, unknown>

export function integrationSetting(ctx: ServiceContext, service: IntegrationService): IntegrationSetting {
  const r = ctx.db.prepare('SELECT * FROM integration_settings WHERE company_id = ? AND service = ?').get(ctx.companyId, service) as Row | undefined
  const mode = (r?.mode as IntegrationMode) ?? 'DEMO'
  return {
    service, mode, providerName: (r?.provider_name as string | null) ?? null, apiBaseUrl: (r?.api_base_url as string | null) ?? null,
    timeoutMs: (r?.timeout_ms as number) ?? 30000, maxRetries: (r?.max_retries as number) ?? 2, updatedAt: (r?.updated_at as string | null) ?? null,
    connected: false,
    status: service === 'GST_RETURNS'
      ? 'Preparation and file export only — returns are never sent to the GST portal by this application'
      : mode === 'DEMO' ? 'Demo provider — results are labelled DEMO and are not government records' : `${mode === 'LIVE' ? 'Live' : 'Sandbox'} mode selected — not connected (no authorised adapter installed)`
  }
}

export function integrationOverview(ctx: ServiceContext, cipher?: SecretCipher): IntegrationOverview {
  const creds = ctx.db.prepare('SELECT service, environment, username_hint, updated_at FROM integration_credentials WHERE company_id = ?').all(ctx.companyId) as Row[]
  const credentials: CredentialStatus[] = []
  for (const service of INTEGRATION_SERVICES)
    for (const environment of ['SANDBOX', 'LIVE'] as const) {
      const c = creds.find((x) => x.service === service && x.environment === environment)
      credentials.push({ service, environment, stored: !!c, usernameHint: (c?.username_hint as string | null) ?? null, updatedAt: (c?.updated_at as string | null) ?? null })
    }
  return { settings: INTEGRATION_SERVICES.map((s) => integrationSetting(ctx, s)), credentials, secureStorageAvailable: !!cipher?.isAvailable(), notice: NOT_CONNECTED_NOTICE }
}

export function saveIntegration(ctx: ServiceContext, input: z.infer<typeof IntegrationSaveInput>, cipher?: SecretCipher): IntegrationOverview {
  return inTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO integration_settings (company_id, service, mode, provider_name, api_base_url, timeout_ms, max_retries, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, service) DO UPDATE SET mode=excluded.mode, provider_name=excluded.provider_name, api_base_url=excluded.api_base_url, timeout_ms=excluded.timeout_ms,
           max_retries=excluded.max_retries, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ctx.companyId, input.service, input.mode, input.providerName, input.apiBaseUrl, input.timeoutMs, input.maxRetries, ctx.userId)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'INTEGRATION_UPDATE', entityType: 'integration', summary: `${input.service} integration set to ${input.mode}${input.providerName ? ` (${input.providerName})` : ''}`, details: { ...input } })
    return integrationOverview(ctx, cipher)
  })
}

const mask = (u: string) => (u.length <= 3 ? '***' : `${u.slice(0, 2)}***${u.slice(-1)}`)

export function saveCredentials(ctx: ServiceContext, input: z.infer<typeof CredentialSaveInput>, cipher?: SecretCipher): IntegrationOverview {
  if (!cipher || !cipher.isAvailable()) throw businessRule('Secure credential storage (Windows Data Protection) is not available, so credentials were not saved. They are never stored in plain text.')
  const blob = cipher.encrypt(JSON.stringify({ username: input.username, password: input.password, clientId: input.clientId ?? null, clientSecret: input.clientSecret ?? null }))
  return inTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO integration_credentials (company_id, service, environment, secret_blob, username_hint, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, service, environment) DO UPDATE SET secret_blob=excluded.secret_blob, username_hint=excluded.username_hint, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ctx.companyId, input.service, input.environment, blob, mask(input.username), ctx.userId)
    // Audit records that credentials changed — never their values.
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'CREDENTIALS_UPDATE', entityType: 'integration', summary: `${input.service} ${input.environment.toLowerCase()} credentials stored (encrypted)` })
    return integrationOverview(ctx, cipher)
  })
}

export function deleteCredentials(ctx: ServiceContext, service: IntegrationService, environment: 'SANDBOX' | 'LIVE', cipher?: SecretCipher): IntegrationOverview {
  return inTransaction(ctx.db, () => {
    const r = ctx.db.prepare('DELETE FROM integration_credentials WHERE company_id = ? AND service = ? AND environment = ?').run(ctx.companyId, service, environment)
    if (r.changes) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'CREDENTIALS_DELETE', entityType: 'integration', summary: `${service} ${environment.toLowerCase()} credentials removed` })
    return integrationOverview(ctx, cipher)
  })
}

/** For a live adapter only (main process). Never exposed through IPC. */
export function readCredentials(ctx: ServiceContext, service: IntegrationService, environment: 'SANDBOX' | 'LIVE', cipher?: SecretCipher): { username: string; password: string; clientId: string | null; clientSecret: string | null } | null {
  const r = ctx.db.prepare('SELECT secret_blob FROM integration_credentials WHERE company_id = ? AND service = ? AND environment = ?').get(ctx.companyId, service, environment) as { secret_blob: Buffer } | undefined
  if (!r || !cipher?.isAvailable()) return null
  return JSON.parse(cipher.decrypt(r.secret_blob))
}

export function apiLog(ctx: ServiceContext, f: { entityType?: string; entityId?: number; service?: string; limit?: number } = {}): ApiRequestRow[] {
  const where = ['a.company_id = ?']
  const args: unknown[] = [ctx.companyId]
  if (f.entityType) { where.push('a.entity_type = ?'); args.push(f.entityType) }
  if (f.entityId) { where.push('a.entity_id = ?'); args.push(f.entityId) }
  if (f.service) { where.push('a.service = ?'); args.push(f.service) }
  return (ctx.db.prepare(`SELECT a.*, u.full_name AS user_name FROM api_requests a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`).all(...args, f.limit ?? 200) as Row[]).map((r) => ({
    id: r.id as number, service: r.service as string, provider: r.provider as string, environment: r.environment as string, operation: r.operation as string,
    entityType: r.entity_type as string | null, entityId: r.entity_id as number | null, requestKey: r.request_key as string, attempt: r.attempt as number,
    outcome: r.outcome as 'SUCCESS' | 'FAILED', errorClass: r.error_class as string | null, errorCode: r.error_code as string | null, errorMessage: r.error_message as string | null,
    retryable: bool(r.retryable), requestSummary: r.request_summary as string | null, responseRef: r.response_ref as string | null, durationMs: r.duration_ms as number,
    userName: r.user_name as string | null, createdAt: r.created_at as string
  }))
}
