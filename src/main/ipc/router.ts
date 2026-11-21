import { ipcInputSchemas, type IpcOutput, type IpcParsed } from '@shared/ipc-contract'
import { isIpcChannel, type IpcChannel } from '@shared/ipc-channels'
import type { IpcResult } from '@shared/types'
import type { DB } from '../db/connection'
import type { Logger } from '../logger'
import type { SessionStore } from '../services/auth'
import type { ServiceContext } from '../services/context'
import { AppError, fromSqliteError, UnbalancedJournalError } from '../services/errors'
import { writeAudit } from '../services/audit'

/** 'public' = no sign-in needed, 'session' = any signed-in user, otherwise a permission code. */
export type Access = 'public' | 'session' | string

export interface HandlerContext {
  db: DB
  sessions: SessionStore
  /** Service context for the signed-in user's active company. */
  svc(): ServiceContext
}

export interface RouteDef<C extends IpcChannel> {
  access: Access
  handler: (ctx: HandlerContext, input: IpcParsed<C>) => IpcOutput<C> | Promise<IpcOutput<C>>
}

export type Routes = { [C in IpcChannel]: RouteDef<C> }

export interface RouterDeps {
  /** null = no database open yet (first-run setup): only NO_DATABASE_CHANNELS are served. */
  db: DB | null
  sessions: SessionStore
  routes: Routes
  logger: Logger
  isTrustedSender: (url: string) => boolean
}

const SENSITIVE_CHANNELS: ReadonlySet<string> = new Set(['auth:login', 'auth:changePassword', 'user:create', 'user:resetPassword', 'backup:restore', 'workspace:setupCompany', 'integration:saveCredentials'])

/** Served while no database is open (first run): choose company setup or the demo. */
export const NO_DATABASE_CHANNELS: ReadonlySet<string> = new Set(['workspace:status', 'workspace:setupCompany', 'workspace:switch', 'app:loginInfo', 'auth:session'])

/** The only requests accepted from a user who must change their password first (enforced here, not in the UI). */
export const PASSWORD_CHANGE_CHANNELS: ReadonlySet<string> = new Set(['auth:changePassword', 'auth:logout', 'auth:session', 'app:loginInfo', 'app:info', 'workspace:status', 'workspace:switch'])

/**
 * Single choke point for every renderer request:
 *   channel allow-list → sender origin → Zod validation → authentication → permission → handler → error mapping.
 * Always resolves to an IpcResult envelope; internals (SQL, stack traces) never reach the renderer.
 */
export function createRouter(deps: RouterDeps) {
  const { sessions, routes, logger } = deps

  const ctx: HandlerContext = {
    get db() {
      return deps.db as DB
    },
    sessions,
    svc() {
      const s = sessions.get()
      if (!s) throw new AppError('UNAUTHENTICATED', 'Please sign in')
      if (!s.company) throw new AppError('BUSINESS_RULE', 'No company is selected. Create or select a company first.')
      return { db: deps.db as DB, userId: s.userId, companyId: s.company.id }
    }
  }

  return async function dispatch(channel: unknown, rawInput: unknown, senderUrl: string): Promise<IpcResult<unknown>> {
    if (!isIpcChannel(channel)) {
      logger.warn('IPC rejected: unknown channel', { channel: String(channel).slice(0, 80) })
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } }
    }
    if (!deps.isTrustedSender(senderUrl)) {
      logger.warn('IPC rejected: untrusted sender', { channel, senderUrl: senderUrl.slice(0, 200) })
      return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'Request origin is not trusted' } }
    }

    const parsed = ipcInputSchemas[channel].safeParse(rawInput)
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || '_'
        if (!fieldErrors[key]) fieldErrors[key] = issue.message
      }
      return { ok: false, error: { code: 'VALIDATION', message: 'Please correct the highlighted fields', fieldErrors } }
    }

    if ((!deps.db || !deps.db.open) && !NO_DATABASE_CHANNELS.has(channel)) {
      return { ok: false, error: { code: 'SETUP_REQUIRED', message: 'No database is open. Set up your company or open the demo first.' } }
    }

    const route = routes[channel] as RouteDef<typeof channel>
    if (route.access !== 'public') {
      const session = sessions.get()
      if (!session) return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } }
      if (session.mustChangePassword && !PASSWORD_CHANGE_CHANNELS.has(channel)) {
        return { ok: false, error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your password to continue' } }
      }
      if (route.access !== 'session' && !session.permissions.includes(route.access)) {
        logger.warn('IPC rejected: permission denied', { channel, user: session.username, needs: route.access })
        return { ok: false, error: { code: 'FORBIDDEN', message: 'You do not have permission for this action' } }
      }
    }

    const started = Date.now()
    try {
      const data = await route.handler(ctx, parsed.data as never)
      const ms = Date.now() - started
      if (ms > 500) logger.warn('Slow IPC handler', { channel, ms })
      return { ok: true, data }
    } catch (err) {
      if (err instanceof UnbalancedJournalError) {
        // The posting transaction has rolled back; record the rejected attempt for the auditor.
        const s = sessions.get()
        try {
          writeAudit(deps.db as DB, {
            companyId: s?.company?.id ?? null, userId: s?.userId ?? null, action: 'JOURNAL_REJECTED', entityType: 'journal',
            summary: `Unbalanced journal rejected (${err.context.sourceKind ?? 'unknown source'}): debit ${err.debitPaise} vs credit ${err.creditPaise} paise`,
            details: { channel, ...err.context, debitPaise: err.debitPaise, creditPaise: err.creditPaise, differencePaise: err.debitPaise - err.creditPaise }
          })
        } catch (auditErr) {
          logger.error('Could not audit rejected journal', { error: auditErr })
        }
      }
      const appErr = err instanceof AppError ? err : fromSqliteError(err)
      if (appErr) {
        if (appErr.code !== 'VALIDATION' && appErr.code !== 'UNAUTHENTICATED') logger.info('IPC business error', { channel, code: appErr.code, message: appErr.message })
        return { ok: false, error: appErr.toIpc() }
      }
      logger.error('IPC handler failed', { channel, input: SENSITIVE_CHANNELS.has(channel) ? '[REDACTED]' : rawInput, error: err })
      return { ok: false, error: { code: 'INTERNAL', message: 'An unexpected error occurred. Details were written to the application log.' } }
    }
  }
}

export type Dispatch = ReturnType<typeof createRouter>
