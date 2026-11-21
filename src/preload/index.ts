/**
 * Sandboxed preload. Exposes exactly one capability to the renderer: invoking
 * an allow-listed IPC channel. No Node, filesystem, shell or ipcRenderer access
 * is exposed. Input validation and authorisation happen in the main process.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, IPC_PREFIX } from '@shared/ipc-channels'

const allowed: ReadonlySet<string> = new Set(IPC_CHANNELS)

const api = Object.freeze({
  invoke(channel: string, input?: unknown): Promise<unknown> {
    if (typeof channel !== 'string' || !allowed.has(channel)) {
      return Promise.resolve({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } })
    }
    return ipcRenderer.invoke(IPC_PREFIX + channel, input)
  }
})

contextBridge.exposeInMainWorld('erp', api)
