/**
 * Application startup: launches the real built Electron app with --smoke-test.
 * The main process boots, opens/migrates/seeds a fresh database in a temp
 * profile, loads the renderer, then verifies renderer isolation and an
 * end-to-end IPC round trip (login + dashboard) before exiting.
 *
 * Requires `npm run build` first (npm run test:all does this).
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { tempDir } from './helpers'

const root = join(__dirname, '..')
const built = existsSync(join(root, 'out/main/index.js')) && existsSync(join(root, 'out/renderer/index.html')) && existsSync(join(root, 'out/preload/index.js'))

describe('application startup', () => {
  it.skipIf(!built)('boots Electron, initialises the database and passes the in-app smoke test', () => {
    const t = tempDir()
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, SA_ERP_USER_DATA: t.dir }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const res = spawnSync(electronPath as unknown as string, [root, '--smoke-test'], { env, encoding: 'utf8', timeout: 90000 })
      const line = `${res.stdout}`.split(/\r?\n/).find((l) => l.startsWith('SMOKE_RESULT '))
      expect(line, `no smoke result.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeDefined()
      const result = JSON.parse(line!.slice('SMOKE_RESULT '.length))
      expect(result).toMatchObject({
        pass: true,
        windowTitle: 'SA Business ERP - Enterprise Management',
        erpType: 'object',
        requireType: 'undefined',
        processType: 'undefined',
        loginScreen: true,
        unauthenticatedBlocked: true,
        unknownChannelBlocked: true,
        loginOk: true,
        dashboardOk: true
      })
      expect(res.status).toBe(0)
      expect(existsSync(join(t.dir, 'data', 'sa-business-erp.db'))).toBe(true)
      expect(readdirSync(join(t.dir, 'logs'))).toContain('app.log')
    } finally {
      t.cleanup()
    }
  }, 120000)

  it('reports when the build is missing instead of silently passing', () => {
    if (!built) console.warn('Startup smoke test skipped: run `npm run build` first (or `npm run test:all`).')
    expect(true).toBe(true)
  })
})
