import { formatINR, formatINRCompact, milliToString, paiseToRupeesString } from '@shared/money'
import { stateName } from '@shared/india'

export { formatINR, formatINRCompact, milliToString, paiseToRupeesString, stateName }

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const formatPercentBps = (bps: number): string => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`

export const titleCase = (s: string): string => s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
