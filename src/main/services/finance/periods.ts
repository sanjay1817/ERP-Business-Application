import type { PeriodsInfo } from '@shared/finance'
import { financialYearOf, financialYearRange } from '@shared/india'
import type { ServiceContext } from '../context'
import { validation } from '../errors'

export const todayIso = (): string => new Date().toISOString().slice(0, 10)
export const addDays = (iso: string, n: number): string => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)
export const daysBetween = (a: string, b: string): number => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000)

export function fyStartMonth(ctx: ServiceContext): number {
  const row = ctx.db.prepare('SELECT fy_start_month FROM companies WHERE id = ?').get(ctx.companyId) as { fy_start_month: number } | undefined
  return row?.fy_start_month ?? 4
}

/** Financial year containing `date` for the active company. */
export function fyFor(ctx: ServiceContext, date: string): { fy: string; from: string; to: string } {
  const start = fyStartMonth(ctx)
  const fy = financialYearOf(date, start)
  return { fy, ...financialYearRange(fy, start) }
}

export function assertPeriod(from: string, to: string): void {
  if (from > to) throw validation('Please correct the highlighted fields', { to: 'End date must be on or after the start date' })
}

/** Financial years with posted journals, plus the current one (newest first). */
export function periods(ctx: ServiceContext, today = todayIso()): PeriodsInfo {
  const start = fyStartMonth(ctx)
  const span = ctx.db.prepare('SELECT MIN(entry_date) AS lo, MAX(entry_date) AS hi FROM journal_entries WHERE company_id = ?').get(ctx.companyId) as { lo: string | null; hi: string | null }
  const current = financialYearOf(today, start)
  const first = span.lo ? financialYearOf(span.lo < today ? span.lo : today, start) : current
  const last = span.hi && span.hi > today ? financialYearOf(span.hi, start) : current
  const years: PeriodsInfo['years'] = []
  for (let y = Number(last.slice(0, 4)); y >= Number(first.slice(0, 4)); y--) {
    const fy = `${y}-${String((y + 1) % 100).padStart(2, '0')}`
    const range = financialYearRange(fy, start)
    const has = ctx.db.prepare('SELECT 1 FROM journal_entries WHERE company_id = ? AND entry_date BETWEEN ? AND ? LIMIT 1').get(ctx.companyId, range.from, range.to)
    years.push({ fy, ...range, hasData: !!has })
  }
  return { fyStartMonth: start, today, currentFy: current, years }
}
