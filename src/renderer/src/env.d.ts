/// <reference types="vite/client" />

interface Window {
  /** The only bridge to the main process (see src/preload/index.ts). */
  readonly erp: {
    invoke(channel: string, input?: unknown): Promise<unknown>
  }
}
