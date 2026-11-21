/**
 * Workspace: which database files exist and which one the app opens.
 *
 * Company books and the DEMO sample data live in separate SQLite files:
 *   <data folder>\data\company\sa-business-erp-company.db   company (production) data
 *   <data folder>\data\sa-business-erp.db                    DEMO data (the pre-Phase 5 location)
 * The choice is kept in <data folder>\workspace.json (outside the databases, so a
 * restore never changes it). A pre-Phase 5 database at the old location is kept in
 * place: demo-only content stays the demo database; a file that already holds a
 * real company becomes the company database instead.
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { DbEnvironment, DbProfileEnvironment } from '@shared/backup'
import { environmentOf, isSqliteFile, writeFileAtomic } from './backup'

export const WORKSPACE_FILE = 'workspace.json'
export const LEGACY_DB = join('data', 'sa-business-erp.db')
export const DEFAULT_COMPANY_DB = join('data', 'company', 'sa-business-erp-company.db')
export const ALT_DEMO_DB = join('data', 'demo', 'sa-business-erp-demo.db')

export interface WorkspaceConfig {
  version: 1
  /** null = nothing chosen yet (first run). */
  active: DbEnvironment | null
  /** Paths relative to the data folder. */
  companyDb: string
  demoDb: string
}

/** Classify a database file without modifying it. */
export function classifyDatabaseFile(path: string): DbProfileEnvironment {
  if (!existsSync(path) || !isSqliteFile(path)) return 'UNKNOWN'
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return environmentOf(db).environment
  } finally {
    db.close()
  }
}

function defaultConfig(root: string): WorkspaceConfig {
  const legacy = join(root, LEGACY_DB)
  if (existsSync(legacy)) {
    const env = classifyDatabaseFile(legacy)
    if (env === 'COMPANY') return { version: 1, active: 'COMPANY', companyDb: LEGACY_DB, demoDb: ALT_DEMO_DB }
    return { version: 1, active: 'DEMO', companyDb: DEFAULT_COMPANY_DB, demoDb: LEGACY_DB }
  }
  return { version: 1, active: null, companyDb: DEFAULT_COMPANY_DB, demoDb: LEGACY_DB }
}

const safeRelative = (p: unknown): p is string => typeof p === 'string' && !!p && !isAbsolute(p) && !normalize(p).startsWith('..')

export interface LoadedWorkspace {
  config: WorkspaceConfig
  notice: string | null
}

export function loadWorkspace(root: string): LoadedWorkspace {
  const file = join(root, WORKSPACE_FILE)
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceConfig
      if (c.version === 1 && safeRelative(c.companyDb) && safeRelative(c.demoDb) && (c.active === null || c.active === 'DEMO' || c.active === 'COMPANY'))
        return { config: c, notice: null }
    } catch {
      /* fall through */
    }
    // Keep the damaged file for support and rebuild the configuration from what is on disk.
    renameSync(file, `${file}.damaged-${Date.now()}`)
    const config = defaultConfig(root)
    saveWorkspace(root, config)
    return { config, notice: 'The workspace settings file was damaged and has been rebuilt from the database files found.' }
  }
  const config = defaultConfig(root)
  if (existsSync(join(root, LEGACY_DB))) saveWorkspace(root, config)
  return { config, notice: null }
}

export function saveWorkspace(root: string, config: WorkspaceConfig): void {
  mkdirSync(root, { recursive: true })
  writeFileAtomic(join(root, WORKSPACE_FILE), JSON.stringify(config, null, 2))
}

export const dbPathFor = (root: string, config: WorkspaceConfig, env: DbEnvironment) => resolve(root, env === 'COMPANY' ? config.companyDb : config.demoDb)

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
