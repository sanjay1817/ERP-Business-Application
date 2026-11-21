import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  readonly filePath: string | null
}

const MAX_BYTES = 5 * 1024 * 1024
const SECRET = /pass(word)?|secret|token|hash|authorization/i

/** Recursively redact secret-looking keys and truncate huge strings before logging. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]'
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') }
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET.test(k) ? '[REDACTED]' : sanitize(v, depth + 1)]))
  }
  return value
}

/** JSON-lines file logger with size-based rotation (app.log → app.1.log). */
export function createFileLogger(dir: string, echo = true): Logger {
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'app.log')
  const write = (level: string, message: string, meta?: unknown) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(meta === undefined ? {} : { meta: sanitize(meta) }) })
    try {
      if (existsSync(filePath) && statSync(filePath).size > MAX_BYTES) renameSync(filePath, join(dir, 'app.1.log'))
      appendFileSync(filePath, line + '\n', 'utf8')
    } catch {
      // Logging must never crash the app.
    }
    if (echo) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${level}] ${message}`)
  }
  return {
    filePath,
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta)
  }
}

export const silentLogger: Logger = { filePath: null, info: () => {}, warn: () => {}, error: () => {} }
