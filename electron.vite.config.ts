import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Production CSP is strict (script-src 'self'). The Vite dev server needs an inline
 * React-refresh preamble and a websocket for HMR, so relax the CSP in dev only.
 */
function devCsp(): Plugin {
  return {
    name: 'sa-erp-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preload: bundle everything (it may only require 'electron').
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { ...alias, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), devCsp()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
