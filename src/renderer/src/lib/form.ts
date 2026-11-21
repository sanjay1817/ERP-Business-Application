import { useCallback, useState } from 'react'
import { toMilli, toPaise, paiseToRupeesString, milliToString } from '@shared/money'
import { ApiError } from './api'
import { useToast } from './toast'

export type FormValues = Record<string, string | boolean>

/** Minimal form state: string inputs, server-driven field errors, honest save feedback. */
export function useForm(initial: FormValues) {
  const [values, setValues] = useState<FormValues>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const reset = useCallback((v: FormValues) => {
    setValues(v)
    setErrors({})
    setFormError(null)
  }, [])

  const bind = (name: string) => ({
    name,
    value: String(values[name] ?? ''),
    invalid: !!errors[name],
    onChange: (e: { target: { value: string } }) => {
      setValues((v) => ({ ...v, [name]: e.target.value }))
      if (errors[name]) setErrors(({ [name]: _removed, ...rest }) => rest)
    }
  })
  const set = (name: string, value: string | boolean) => setValues((v) => ({ ...v, [name]: value }))

  /** Runs the save; shows success ONLY after the main process confirms it. */
  async function submit<T>(build: () => unknown, save: (payload: never) => Promise<T>, successTitle: (r: T) => string): Promise<T | null> {
    setFormError(null)
    setErrors({})
    let payload: unknown
    try {
      payload = build()
    } catch (e) {
      if (e instanceof ConversionError) {
        setErrors({ [e.field]: e.message })
        setFormError('Please correct the highlighted fields')
        return null
      }
      throw e
    }
    setSaving(true)
    try {
      const result = await save(payload as never)
      toast('success', successTitle(result))
      return result
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError({ code: 'INTERNAL', message: String(e) })
      setErrors(err.fieldErrors)
      setFormError(err.message)
      return null
    } finally {
      setSaving(false)
    }
  }

  return { values, errors, formError, saving, bind, set, reset, submit }
}

export class ConversionError extends Error {
  constructor(public field: string, message: string) {
    super(message)
  }
}

/** ₹ string → paise (empty → 0 or null). Throws ConversionError for the field. */
export function rupees(values: FormValues, field: string, opts: { nullable?: boolean; allowNegative?: boolean } = {}): number | null {
  const raw = String(values[field] ?? '').trim()
  if (raw === '') return opts.nullable ? null : 0
  try {
    const p = toPaise(raw)
    if (p < 0 && !opts.allowNegative) throw new ConversionError(field, 'Amount cannot be negative')
    return p
  } catch (e) {
    if (e instanceof ConversionError) throw e
    throw new ConversionError(field, 'Enter a valid amount, e.g. 1250.50')
  }
}

export function quantity(values: FormValues, field: string): number {
  const raw = String(values[field] ?? '').trim()
  if (raw === '') return 0
  try {
    return toMilli(raw)
  } catch {
    throw new ConversionError(field, 'Enter a valid quantity')
  }
}

export function integer(values: FormValues, field: string): number {
  const raw = String(values[field] ?? '').trim()
  if (raw === '') return 0
  if (!/^-?\d+$/.test(raw)) throw new ConversionError(field, 'Enter a whole number')
  return Number(raw)
}

export const text = (values: FormValues, field: string): string => String(values[field] ?? '').trim()
export const paiseToInput = (p: number | null | undefined): string => (p == null ? '' : paiseToRupeesString(p))
export const milliToInput = (m: number | null | undefined): string => (m == null ? '' : milliToString(m))
