import type { IpcChannel } from '@shared/ipc-channels'
import type { IpcInput, IpcOutput } from '@shared/ipc-contract'
import type { IpcError, IpcResult } from '@shared/types'

export class ApiError extends Error {
  readonly code: IpcError['code']
  readonly fieldErrors: Record<string, string>
  constructor(err: IpcError) {
    super(err.message)
    this.code = err.code
    this.fieldErrors = err.fieldErrors ?? {}
  }
}

type Listener = () => void
const unauthenticatedListeners = new Set<Listener>()
export const onUnauthenticated = (fn: Listener): (() => void) => {
  unauthenticatedListeners.add(fn)
  return () => unauthenticatedListeners.delete(fn)
}

/** Typed call into the main process. Resolves with data or throws ApiError — never a fake success. */
export async function api<C extends IpcChannel>(channel: C, ...input: undefined extends IpcInput<C> ? [IpcInput<C>?] : [IpcInput<C>]): Promise<IpcOutput<C>> {
  let res: IpcResult<IpcOutput<C>>
  try {
    res = (await window.erp.invoke(channel, input[0])) as IpcResult<IpcOutput<C>>
  } catch {
    throw new ApiError({ code: 'INTERNAL', message: 'Could not reach the application service. Please restart the application.' })
  }
  if (!res || typeof res !== 'object' || !('ok' in res)) throw new ApiError({ code: 'INTERNAL', message: 'Unexpected response from the application service' })
  if (!res.ok) {
    if (res.error.code === 'UNAUTHENTICATED' && channel !== 'auth:login') unauthenticatedListeners.forEach((fn) => fn())
    throw new ApiError(res.error)
  }
  return res.data
}
