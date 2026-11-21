import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cx } from './ui'

export interface SelectOption {
  value: number
  label: string
  sublabel?: string
  /** Extra text searched but not shown (codes, GSTIN, HSN…). */
  keywords?: string
  disabled?: boolean
  right?: ReactNode
}

interface Props {
  options: SelectOption[]
  value: number | null
  onChange: (value: number | null) => void
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  clearable?: boolean
  className?: string
  /** Shown when the list is empty. */
  emptyText?: string
  'aria-label'?: string
}

/**
 * Accessible, keyboard-friendly searchable select (combobox).
 * Type to filter · ↑/↓ to move · Enter to choose · Esc to close · Tab moves on.
 * The list is portalled so it is never clipped by scrolling tables.
 */
export function SearchSelect({ options, value, onChange, placeholder = 'Select…', disabled, invalid, autoFocus, clearable, className, emptyText = 'No matches', ...aria }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  const selected = options.find((o) => o.value === value) ?? null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options.slice(0, 200)
    const words = q.split(/\s+/)
    return options.filter((o) => {
      const hay = `${o.label} ${o.sublabel ?? ''} ${o.keywords ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    }).slice(0, 200)
  }, [options, query])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!open) return
    const update = () => inputRef.current && setRect(inputRef.current.getBoundingClientRect())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (o: SelectOption) => {
    if (o.disabled) return
    onChange(o.value)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) {
        e.preventDefault()
        choose(filtered[active])
      } else if (!open) {
        e.preventDefault()
        setOpen(true)
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation()
        setOpen(false)
        setQuery('')
      }
    } else if (e.key === 'Tab') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className={cx('relative', className)}>
      <div className="relative">
        {open && <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-invalid={invalid || undefined}
          aria-label={aria['aria-label']}
          disabled={disabled}
          value={open ? query : (selected?.label ?? '')}
          placeholder={selected && open ? selected.label : placeholder}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            if (!open) setOpen(true)
          }}
          onFocus={() => !disabled && (setOpen(true), setActive(Math.max(0, filtered.findIndex((o) => o.value === value))))}
          onBlur={() => setTimeout(() => (setOpen(false), setQuery('')), 120)}
          onKeyDown={onKeyDown}
          className={cx(
            'h-9 w-full truncate rounded-lg border bg-white pr-8 text-[13.5px] text-ink placeholder:text-ink-3 focus:ring-3 focus:outline-none disabled:bg-slate-50 disabled:text-ink-2',
            open ? 'pl-8' : 'pl-3',
            invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : 'border-line focus:border-brand-500 focus:ring-brand-100'
          )}
        />
        {clearable && selected && !disabled ? (
          <button type="button" tabIndex={-1} onMouseDown={(e) => (e.preventDefault(), onChange(null))} className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear">
            <X className="size-3.5" />
          </button>
        ) : (
          <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
        )}
      </div>
      {open &&
        rect &&
        createPortal(
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 320), maxHeight: 300 }}
            className="z-[200] overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-xl shadow-slate-900/15"
          >
            {filtered.length === 0 && <li className="px-3 py-3 text-center text-[13px] text-ink-3">{emptyText}</li>}
            {filtered.map((o, i) => (
              <li
                key={o.value}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                onMouseDown={(e) => (e.preventDefault(), choose(o))}
                onMouseEnter={() => setActive(i)}
                className={cx('flex cursor-pointer items-center gap-2 px-3 py-1.5', i === active && 'bg-brand-50', o.disabled && 'cursor-not-allowed opacity-50')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{o.label}</span>
                  {o.sublabel && <span className="block truncate text-[11.5px] text-ink-3">{o.sublabel}</span>}
                </span>
                {o.right}
                {o.value === value && <Check className="size-4 shrink-0 text-brand-600" />}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  )
}
