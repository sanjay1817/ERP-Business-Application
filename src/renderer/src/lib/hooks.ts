import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

export interface QueryState<T> {
  data: T | undefined
  error: ApiError | null
  loading: boolean
  reload: () => void
}

/** Load data from the main process; re-runs when deps change. Stale responses are ignored. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const id = ++seq.current
    setLoading(true)
    fn()
      .then((d) => {
        if (id === seq.current) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (id === seq.current) setError(e instanceof ApiError ? e : new ApiError({ code: 'INTERNAL', message: String(e) }))
      })
      .finally(() => id === seq.current && setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
