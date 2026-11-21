import type { Migration } from '../migrator'
import { migration001 } from './001_initial_schema'
import { migration002 } from './002_reference_data'
import { migration003 } from './003_transactions'
import { migration004 } from './004_finance'
import { migration005 } from './005_gst_compliance'
import { migration006 } from './006_production'
import { migration007 } from './007_performance_indexes'

/** Ordered list of all schema migrations. Never edit an applied migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007]
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
