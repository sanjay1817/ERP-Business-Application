/**
 * GST reconciliation: compares an imported supplier statement / GSTR-2B-style CSV
 * with the purchase register. Differences are review items — never conclusions
 * about the supplier or the transaction.
 */
import type { z } from 'zod'
import type { ReconBatch, ReconBookOnly, ReconDetail, ReconImportInput, ReconLine } from '@shared/gst'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { businessRule, notFound, validation } from '../errors'
import { rulesAt } from './config'
import { inwardDocs, type InwardDocX } from './registers'

type Row = Record<string, unknown>
const norm = (s: string) => s.toUpperCase().replace(/[\s\-/_.]/g, '').replace(/^0+/, '')
export const RECON_DISCLAIMER = 'Differences are listed for review with the supplier. A difference is not, by itself, evidence of any wrongdoing; it is often timing, a typing error or a supplier correction.'

/** RFC-4180-style split (quoted fields, doubled quotes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  out.push(cur.trim())
  return out
}

const HEADERS: Record<string, string[]> = {
  gstin: ['supplier_gstin', 'gstin', 'gstin of supplier', 'supplier gstin', 'ctin'],
  name: ['supplier_name', 'trade/legal name', 'supplier name', 'name', 'trade name'],
  invoiceNo: ['invoice_no', 'invoice number', 'invoice no', 'document number', 'note number', 'inum'],
  invoiceDate: ['invoice_date', 'invoice date', 'document date', 'note date', 'idt'],
  type: ['type', 'document type', 'note type'],
  taxable: ['taxable', 'taxable value', 'taxable_value', 'txval'],
  igst: ['igst', 'integrated tax', 'integrated tax (₹)', 'iamt'],
  cgst: ['cgst', 'central tax', 'central tax (₹)', 'camt'],
  sgst: ['sgst', 'state/ut tax', 'state tax', 'state/ut tax (₹)', 'samt'],
  cess: ['cess', 'cess (₹)', 'csamt']
}

function parseDate(s: string): string | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  let iso: string | null = null
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s)
  if (m) iso = `${m[3]}-${m[2]}-${m[1]}`
  if (!iso || Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) return null
  return iso
}
function parseAmount(s: string): number | null {
  if (s === '') return 0
  const t = s.replace(/[₹,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  const [r, p = ''] = t.replace('-', '').split('.')
  const v = Number(r) * 100 + Number((p + '00').slice(0, 2))
  return t.startsWith('-') ? -v : v
}

export interface ParsedReconRow { supplierGstin: string | null; supplierName: string | null; invoiceNo: string; invoiceDate: string; documentType: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE'; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }

export function parseReconCsv(csv: string): { rows: ParsedReconRow[]; errors: string[] } {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return { rows: [], errors: ['The CSV needs a header row and at least one data row'] }
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const col: Record<string, number> = {}
  for (const [key, names] of Object.entries(HEADERS)) col[key] = head.findIndex((h) => names.includes(h))
  const missing = ['invoiceNo', 'invoiceDate', 'taxable'].filter((k) => col[k] < 0)
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}. Expected headers such as supplier_gstin, supplier_name, invoice_no, invoice_date, taxable, igst, cgst, sgst, cess`] }
  const rows: ParsedReconRow[] = []
  const errors: string[] = []
  lines.slice(1).forEach((line, i) => {
    const f = splitCsvLine(line)
    const get = (k: string) => (col[k] >= 0 ? (f[col[k]] ?? '').trim() : '')
    const n = i + 2
    const date = parseDate(get('invoiceDate'))
    const amounts = ['taxable', 'igst', 'cgst', 'sgst', 'cess'].map((k) => parseAmount(get(k)))
    const gstin = get('gstin').toUpperCase() || null
    if (!get('invoiceNo')) return void errors.push(`Row ${n}: invoice number is missing`)
    if (!date) return void errors.push(`Row ${n}: invoice date "${get('invoiceDate')}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`)
    if (amounts.some((a) => a === null)) return void errors.push(`Row ${n}: an amount is not a number`)
    if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) return void errors.push(`Row ${n}: GSTIN "${gstin}" is not 15 characters`)
    const t = get('type').toUpperCase()
    const documentType = /^(C|CN|CREDIT|CREDIT NOTE|CREDIT_NOTE)$/.test(t) ? 'CREDIT_NOTE' : /^(D|DN|DEBIT|DEBIT NOTE|DEBIT_NOTE)$/.test(t) ? 'DEBIT_NOTE' : 'INVOICE'
    const [taxable, igst, cgst, sgst, cess] = amounts as number[]
    rows.push({ supplierGstin: gstin, supplierName: get('name') || null, invoiceNo: get('invoiceNo'), invoiceDate: date, documentType, taxablePaise: taxable, igstPaise: igst, cgstPaise: cgst, sgstPaise: sgst, cessPaise: cess })
  })
  return { rows, errors }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

/** (Re)matches every line of a batch. Review decisions are kept. */
export function matchBatch(ctx: ServiceContext, batchId: number): void {
  const b = ctx.db.prepare('SELECT * FROM gst_recon_batches WHERE id = ? AND company_id = ?').get(batchId, ctx.companyId) as Row | undefined
  if (!b) throw notFound('Reconciliation')
  const tol = rulesAt(ctx, b.period_to as string).GST_RECON_TOLERANCE_PAISE
  const books = inwardDocs(ctx, { from: addDays(b.period_from as string, -365), to: addDays(b.period_to as string, 60), status: 'POSTED' })
  const kindOf = (d: InwardDocX) => (d.kind === 'PURCHASE_INVOICE' ? 'INVOICE' : 'CREDIT_NOTE')
  const keyOf = (gstin: string | null, ref: string, type: string) => `${gstin ?? ''}|${norm(ref)}|${type}`
  const bookByKey = new Map<string, InwardDocX[]>()
  for (const d of books) {
    if (!d.supplierRef) continue
    const k = keyOf(d.partyGstin, d.supplierRef, kindOf(d))
    bookByKey.set(k, [...(bookByKey.get(k) ?? []), d])
  }
  const lines = ctx.db.prepare('SELECT * FROM gst_recon_lines WHERE batch_id = ? ORDER BY row_no').all(batchId) as Row[]
  const used = new Set<string>()
  const seen = new Set<string>()
  const upd = ctx.db.prepare('UPDATE gst_recon_lines SET match_status=?, matched_kind=?, matched_id=?, diff_taxable_paise=?, diff_tax_paise=?, match_note=? WHERE id=?')
  for (const l of lines) {
    const type = l.document_type === 'DEBIT_NOTE' ? 'INVOICE' : (l.document_type as string)
    const k = keyOf(l.supplier_gstin as string | null, l.invoice_no as string, type)
    const tax = (l.igst_paise as number) + (l.cgst_paise as number) + (l.sgst_paise as number)
    const set = (status: string, d: InwardDocX | null, note: string | null) => {
      const bTax = d ? d.igstPaise + d.cgstPaise + d.sgstPaise : 0
      upd.run(status, d?.kind ?? null, d?.id ?? null, d ? (l.taxable_paise as number) - d.taxablePaise : 0, d ? tax - bTax : 0, note, l.id)
      if (d) used.add(`${d.kind}:${d.id}`)
    }
    if (seen.has(k)) { set('DUPLICATE_IN_STATEMENT', null, 'Same supplier GSTIN and document number appears earlier in this statement'); continue }
    seen.add(k)
    const exact = (bookByKey.get(k) ?? []).filter((d) => !used.has(`${d.kind}:${d.id}`))
    if (exact.length) {
      const d = exact[0]
      const dTaxable = (l.taxable_paise as number) - d.taxablePaise
      const dTax = tax - (d.igstPaise + d.cgstPaise + d.sgstPaise)
      const notes = [exact.length > 1 || (bookByKey.get(k)?.length ?? 0) > 1 ? `Recorded ${(bookByKey.get(k) ?? []).length} times in the books` : null, d.date !== l.invoice_date && d.supplierRefDate !== l.invoice_date ? `Date differs (books ${d.supplierRefDate ?? d.date})` : null].filter(Boolean)
      if ((bookByKey.get(k)?.length ?? 0) > 1) set('DUPLICATE_IN_BOOKS', d, notes.join('; '))
      else if (Math.abs(dTaxable) <= tol && Math.abs(dTax) <= tol) set('MATCHED', d, notes.join('; ') || null)
      else set('VALUE_DIFFERENCE', d, [`Taxable differs by ${(dTaxable / 100).toFixed(2)}, tax by ${(dTax / 100).toFixed(2)}`, ...notes].join('; '))
      continue
    }
    const close = (d: InwardDocX) => Math.abs((l.taxable_paise as number) - d.taxablePaise) <= tol && Math.abs(tax - (d.igstPaise + d.cgstPaise + d.sgstPaise)) <= tol
    const free = books.filter((d) => !used.has(`${d.kind}:${d.id}`) && kindOf(d) === type && d.supplierRef)
    const gstinDiff = free.find((d) => norm(d.supplierRef!) === norm(l.invoice_no as string) && d.partyGstin !== l.supplier_gstin && close(d))
    if (gstinDiff) { set('GSTIN_MISMATCH', gstinDiff, `Books record ${gstinDiff.partyGstin ?? 'no GSTIN'} for ${gstinDiff.partyName}`); continue }
    const near = free.find((d) => d.partyGstin === l.supplier_gstin && close(d) && Math.abs(Date.parse(d.supplierRefDate ?? d.date) - Date.parse(l.invoice_date as string)) <= 7 * 86400000)
    if (near) { set('PROBABLE', near, `Same supplier and value; document number recorded as ${near.supplierRef}`); continue }
    set('NOT_IN_BOOKS', null, 'No purchase document with this supplier GSTIN and number')
  }
}

export function importRecon(ctx: ServiceContext, input: z.infer<typeof ReconImportInput>): ReconDetail {
  const parsed = parseReconCsv(input.csv)
  if (parsed.errors.length) throw validation(`The CSV has ${parsed.errors.length} problem(s): ${parsed.errors.slice(0, 5).join(' · ')}`, { csv: parsed.errors.slice(0, 5).join('\n') })
  if (!parsed.rows.length) throw businessRule('The CSV contains no rows')
  const id = inTransaction(ctx.db, () => {
    const batchId = Number(ctx.db.prepare(`INSERT INTO gst_recon_batches (company_id, label, source, period_from, period_to, row_count, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ctx.companyId, input.label, input.source, input.periodFrom, input.periodTo, parsed.rows.length, ctx.userId).lastInsertRowid)
    const ins = ctx.db.prepare(`INSERT INTO gst_recon_lines (batch_id, row_no, supplier_gstin, supplier_name, invoice_no, invoice_date, document_type, taxable_paise, igst_paise, cgst_paise, sgst_paise, cess_paise) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    parsed.rows.forEach((r, i) => ins.run(batchId, i + 1, r.supplierGstin, r.supplierName, r.invoiceNo, r.invoiceDate, r.documentType, r.taxablePaise, r.igstPaise, r.cgstPaise, r.sgstPaise, r.cessPaise))
    matchBatch({ ...ctx }, batchId)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_RECON_IMPORT', entityType: 'gst_recon', entityId: batchId, summary: `GST reconciliation "${input.label}" imported: ${parsed.rows.length} rows` })
    return batchId
  })
  return reconDetail(ctx, id)
}

export function rematch(ctx: ServiceContext, batchId: number): ReconDetail {
  inTransaction(ctx.db, () => matchBatch(ctx, batchId))
  return reconDetail(ctx, batchId)
}

const BATCH_SELECT = `SELECT b.*, u.full_name AS by_name FROM gst_recon_batches b LEFT JOIN users u ON u.id = b.created_by`
function toBatch(ctx: ServiceContext, r: Row): ReconBatch {
  const counts = Object.fromEntries((ctx.db.prepare('SELECT match_status s, COUNT(*) n FROM gst_recon_lines WHERE batch_id = ? GROUP BY match_status').all(r.id) as Array<{ s: string; n: number }>).map((x) => [x.s, x.n]))
  const pending = (ctx.db.prepare(`SELECT COUNT(*) n FROM gst_recon_lines WHERE batch_id = ? AND review_status = 'PENDING' AND match_status <> 'MATCHED'`).get(r.id) as { n: number }).n
  return { id: r.id as number, label: r.label as string, source: r.source as string, periodFrom: r.period_from as string, periodTo: r.period_to as string, rowCount: r.row_count as number, createdAt: r.created_at as string, createdBy: r.by_name as string | null, counts, pendingReview: pending }
}

export function listRecon(ctx: ServiceContext): ReconBatch[] {
  return (ctx.db.prepare(`${BATCH_SELECT} WHERE b.company_id = ? ORDER BY b.id DESC`).all(ctx.companyId) as Row[]).map((r) => toBatch(ctx, r))
}

export function reconDetail(ctx: ServiceContext, batchId: number): ReconDetail {
  const b = ctx.db.prepare(`${BATCH_SELECT} WHERE b.id = ? AND b.company_id = ?`).get(batchId, ctx.companyId) as Row | undefined
  if (!b) throw notFound('Reconciliation')
  const books = inwardDocs(ctx, { from: addDays(b.period_from as string, -365), to: addDays(b.period_to as string, 60), status: 'POSTED' })
  const byId = new Map(books.map((d) => [`${d.kind}:${d.id}`, d]))
  const lines: ReconLine[] = (ctx.db.prepare('SELECT * FROM gst_recon_lines WHERE batch_id = ? ORDER BY row_no').all(batchId) as Row[]).map((r) => {
    const d = r.matched_kind ? byId.get(`${r.matched_kind}:${r.matched_id}`) : undefined
    return {
      id: r.id as number, rowNo: r.row_no as number, supplierGstin: r.supplier_gstin as string | null, supplierName: r.supplier_name as string | null, invoiceNo: r.invoice_no as string,
      invoiceDate: r.invoice_date as string, documentType: r.document_type as string, taxablePaise: r.taxable_paise as number, igstPaise: r.igst_paise as number, cgstPaise: r.cgst_paise as number,
      sgstPaise: r.sgst_paise as number, cessPaise: r.cess_paise as number, matchStatus: r.match_status as string,
      matched: d ? { kind: d.kind, id: d.id, number: d.number, supplierRef: d.supplierRef, date: d.date, taxablePaise: d.taxablePaise, taxPaise: d.igstPaise + d.cgstPaise + d.sgstPaise, route: d.route } : null,
      diffTaxablePaise: r.diff_taxable_paise as number, diffTaxPaise: r.diff_tax_paise as number, matchNote: r.match_note as string | null,
      reviewStatus: r.review_status as string, reviewNote: r.review_note as string | null, reviewedAt: r.reviewed_at as string | null
    }
  })
  const used = new Set(lines.filter((l) => l.matched).map((l) => `${l.matched!.kind}:${l.matched!.id}`))
  const booksOnly: ReconBookOnly[] = books
    .filter((d) => d.date >= (b.period_from as string) && d.date <= (b.period_to as string) && !used.has(`${d.kind}:${d.id}`) && d.partyGstin)
    .map((d) => ({ kind: d.kind, id: d.id, number: d.number, supplierRef: d.supplierRef, supplierGstin: d.partyGstin, partyName: d.partyName, date: d.date, taxablePaise: d.taxablePaise, taxPaise: d.igstPaise + d.cgstPaise + d.sgstPaise, route: d.route }))
  return { batch: toBatch(ctx, b), lines, booksOnly, disclaimer: RECON_DISCLAIMER }
}

export function reviewRecon(ctx: ServiceContext, lineIds: number[], status: string, note: string | null): { updated: number } {
  return inTransaction(ctx.db, () => {
    const r = ctx.db
      .prepare(`UPDATE gst_recon_lines SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id IN (${lineIds.map(() => '?').join(',')}) AND batch_id IN (SELECT id FROM gst_recon_batches WHERE company_id = ?)`)
      .run(status, note, ctx.userId, ...lineIds, ctx.companyId)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_RECON_REVIEW', entityType: 'gst_recon_line', summary: `${r.changes} reconciliation line(s) marked ${status.toLowerCase().replace('_', ' ')}${note ? `: ${note}` : ''}` })
    return { updated: r.changes }
  })
}
