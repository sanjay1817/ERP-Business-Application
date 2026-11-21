import type { Migration } from '../migrator'

/**
 * Phase 5 — indexes found missing by the 20 000-invoice performance run.
 * The auditor's exception report looks up each journal's reversal and each document's
 * cancellation entry; without these indexes every lookup scanned all journal entries
 * (2.8 s for 200 lookups at that size). Creates indexes only; no data changes.
 */
export const migration007: Migration = {
  version: 7,
  name: 'performance_indexes',
  sql: `
CREATE INDEX IF NOT EXISTS idx_je_reversal_of ON journal_entries(reversal_of_id);
CREATE INDEX IF NOT EXISTS idx_je_source_kind ON journal_entries(source_kind, source_id);
`
}
