import type { ReactNode } from 'react'
import { cx } from './ui'

export function StatTile({ label, value, sub, icon, accent, onClick }: { label: string; value: string; sub?: ReactNode; icon: ReactNode; accent: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={cx('rounded-xl border border-line bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)]', onClick && 'transition hover:border-brand-500/40 hover:shadow-md')}>
      <div className="flex items-start justify-between">
        <p className="text-[12.5px] font-semibold text-ink-2">{label}</p>
        <span className={cx('grid size-8 place-items-center rounded-lg', accent)}>{icon}</span>
      </div>
      <p className="tabular mt-2 text-[22px] leading-none font-bold tracking-tight text-ink">{value}</p>
      {sub && <p className="mt-2 text-[12px] text-ink-3">{sub}</p>}
    </Tag>
  )
}
