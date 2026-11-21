/**
 * Phase 5 in the real built Electron app (temp profiles only):
 *  - backup → change → restore, then a normal restart completes the restore from its journal;
 *  - fresh install → first-run company setup → restart into the company database (no demo data or demo passwords).
 * Requires `npm run build` first (npm run test:all does this).
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { tempDir } from './helpers'

const root = join(__dirname, '..')
const built = existsSync(join(root, 'out/main/index.js')) && existsSync(join(root, 'out/renderer/index.html'))

function run(dir: string, flag: string, tag: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, SA_ERP_USER_DATA: dir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const res = spawnSync(electronPath as unknown as string, [root, flag], { env, encoding: 'utf8', timeout: 150000 })
  const line = `${res.stdout}`.split(/\r?\n/).find((l) => l.startsWith(`${tag} `))
  expect(line, `no ${tag}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`).toBeDefined()
  return JSON.parse(line!.slice(tag.length + 1))
}

describe('Phase 5 end-to-end (real Electron app)', () => {
  it.skipIf(!built)('backup, restore and restart-time completion of the restore', () => {
    const t = tempDir()
    try {
      const a = run(t.dir, '--e2e-backup=run', 'E2E_BACKUP_RESULT')
      expect(a).toMatchObject({ pass: true, restoreOutcome: 'RESTORED', auditorForbidden: true, wrongPasswordRefused: true, pathTraversalRefused: true })
      const b = run(t.dir, '--e2e-backup=verify', 'E2E_BACKUP_RESULT')
      expect(b).toMatchObject({ pass: true, afterBackupUserGone: true, restoreAudited: true, leftovers: [], integrityFailures: [] })
    } finally {
      t.cleanup()
    }
  }, 320000)

  it.skipIf(!built)('fresh install: first-run company setup creates a separate company database without demo data', () => {
    const t = tempDir()
    try {
      const a = run(t.dir, '--e2e-setup=run', 'E2E_SETUP_RESULT')
      expect(a).toMatchObject({ pass: true, firstRun: true, loginBlocked: true, publishedPasswordRefused: true, noDemoDbCreated: true })
      const b = run(t.dir, '--e2e-setup=verify', 'E2E_SETUP_RESULT')
      expect(b).toMatchObject({ pass: true, environment: 'COMPANY', noDemoCredentials: true, demoLoginFails: true, ownerLogin: true, emptyBooks: true })
    } finally {
      t.cleanup()
    }
  }, 320000)
})
