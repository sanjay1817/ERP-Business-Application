/**
 * Electron security configuration. Pure functions (no 'electron' import) so the
 * policy itself is unit-testable.
 */
import { pathToFileURL } from 'node:url'

export interface SecureWebPreferences {
  preload: string
  contextIsolation: true
  nodeIntegration: false
  nodeIntegrationInWorker: false
  nodeIntegrationInSubFrames: false
  sandbox: true
  webSecurity: true
  allowRunningInsecureContent: false
  webviewTag: false
  experimentalFeatures: false
  navigateOnDragDrop: false
  spellcheck: false
  devTools: boolean
}

export function secureWebPreferences(preloadPath: string, allowDevTools: boolean): SecureWebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: allowDevTools
  }
}

/**
 * Only the app's own renderer may call IPC: the Vite dev server origin in
 * development, or the packaged index.html file in production.
 */
export function createSenderValidator(opts: { devServerUrl?: string; rendererIndexPath: string }): (url: string) => boolean {
  const devOrigin = opts.devServerUrl ? new URL(opts.devServerUrl).origin : null
  const fileUrl = pathToFileURL(opts.rendererIndexPath).href.toLowerCase()
  return (url: string) => {
    if (!url) return false
    try {
      const u = new URL(url)
      if (devOrigin && u.origin === devOrigin) return true
      if (u.protocol === 'file:') return `${u.origin === 'null' ? 'file://' : u.origin}${u.pathname}`.toLowerCase() === fileUrl
      return false
    } catch {
      return false
    }
  }
}

/** Navigation inside the window is limited to the same trusted app URL. */
export const isAllowedNavigation = (isTrusted: (url: string) => boolean) => (url: string): boolean => isTrusted(url)

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
