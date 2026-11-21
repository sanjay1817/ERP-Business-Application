/**
 * Common runner for every government-integration call (e-invoice, e-way bill, returns).
 *
 *  - Timeout per attempt; error classification; bounded retries for transient classes only.
 *  - Every attempt is written to the append-only api_requests log (no credentials, no
 *    personal data beyond document references; error text is scrubbed and truncated).
 *  - Before retrying a create-type call after a timeout, `reconcile` asks the provider
 *    whether the first attempt actually succeeded, so a retry never creates a duplicate.
 */
import { RETRYABLE, type ErrorClass } from '@shared/gst'
import type { ServiceContext } from '../context'

export class ProviderError extends Error {
  constructor(
    public readonly errorClass: ErrorClass,
    public readonly code: string,
    message: string,
    public readonly field?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.errorClass)
  }
}

export interface CallMeta {
  service: 'EINVOICE' | 'EWAYBILL' | 'GST_RETURNS'
  provider: string
  environment: string
  operation: string
  entityType: string
  entityId: number | null
  requestKey: string
  /** Short, non-sensitive description, e.g. "INV/2026-27/0012 · ₹1,18,000". */
  summary: string
  timeoutMs: number
  maxRetries: number
}

export interface CallOptions<T> {
  /** After a TIMEOUT/NETWORK failure, asks the provider whether the request was processed (returns the result, or null). */
  reconcile?: () => Promise<T | null>
  sleep?: (ms: number) => Promise<void>
  responseRef?: (v: T) => string | null
}

export type CallResult<T> = { ok: true; value: T; attempts: number; reconciled: boolean } | { ok: false; error: ProviderError; attempts: number }

const SECRET = /(password|passwd|secret|token|authorization|bearer|api[-_]?key|client[-_]?secret)\s*[:=]?\s*\S+/gi
export const scrub = (s: string): string => s.replace(SECRET, '$1=[REDACTED]').slice(0, 300)

export function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  const e = err as { name?: string; code?: string; message?: string }
  if (e?.name === 'AbortError') return new ProviderError('TIMEOUT', 'ABORTED', 'The request timed out')
  if (e?.code && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(e.code)) return new ProviderError('NETWORK', e.code, 'The provider could not be reached')
  return new ProviderError('UNKNOWN', 'UNEXPECTED', scrub(e?.message ?? 'Unexpected provider error'))
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('TIMEOUT', 'TIMEOUT', `No response within ${Math.round(ms / 1000)} s`)), ms)
    })
  ])
}

function log(ctx: ServiceContext, m: CallMeta, attempt: number, outcome: 'SUCCESS' | 'FAILED', ms: number, err: ProviderError | null, responseRef: string | null): void {
  ctx.db
    .prepare(
      `INSERT INTO api_requests (company_id, service, provider, environment, operation, entity_type, entity_id, request_key, attempt, outcome, error_class, error_code, error_message, retryable, request_summary, response_ref, duration_ms, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ctx.companyId, m.service, m.provider, m.environment, m.operation, m.entityType, m.entityId, m.requestKey, attempt, outcome, err?.errorClass ?? null, err?.code ?? null,
      err ? scrub(err.message) : null, err?.retryable ? 1 : 0, scrub(m.summary), responseRef, ms, ctx.userId)
}

/** Runs `fn` with timeout + retry and records every attempt. Never throws: the caller decides how to report a failure. */
export async function callProvider<T>(ctx: ServiceContext, m: CallMeta, fn: (attempt: number) => Promise<T>, opts: CallOptions<T> = {}): Promise<CallResult<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last: ProviderError | null = null
  let attempts = 0
  for (let attempt = 1; attempt <= m.maxRetries + 1; attempt++) {
    attempts = attempt
    const started = Date.now()
    try {
      // Before re-sending after an ambiguous failure, check whether the first request went through.
      if (attempt > 1 && last && (last.errorClass === 'TIMEOUT' || last.errorClass === 'NETWORK') && opts.reconcile) {
        const found = await withTimeout(opts.reconcile(), m.timeoutMs).catch(() => null)
        if (found) {
          log(ctx, { ...m, operation: `${m.operation}:STATUS_CHECK` }, attempt, 'SUCCESS', Date.now() - started, null, opts.responseRef?.(found) ?? null)
          return { ok: true, value: found, attempts: attempt, reconciled: true }
        }
      }
      const value = await withTimeout(fn(attempt), m.timeoutMs)
      log(ctx, m, attempt, 'SUCCESS', Date.now() - started, null, opts.responseRef?.(value) ?? null)
      return { ok: true, value, attempts: attempt, reconciled: false }
    } catch (e) {
      last = classify(e)
      log(ctx, m, attempt, 'FAILED', Date.now() - started, last, null)
      if (!last.retryable || attempt > m.maxRetries) break
      await sleep(Math.min(4000, 250 * 2 ** (attempt - 1)))
    }
  }
  return { ok: false, error: last!, attempts }
}
