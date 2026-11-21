/**
 * Phase 5 — report totals are recomputed here independently (direct SQL over
 * journal lines, documents and stock) and compared with every report, and the
 * Excel workbook is unzipped and read back to prove it carries the same figures.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import type { DB } from '../src/main/db/connection'
import type { ServiceContext } from '../src/main/services/context'
import { buildReport } from '../src/main/services/reports/report-docs'
import { reportToXlsx } from '../src/main/services/reports/xlsx'
import { reportHtml } from '../src/main/services/reports/report-html'
import { periods } from '../src/main/services/finance/periods'
import { salesRegister, purchaseRegister } from '../src/main/services/gst/registers'
import type { ReportDoc, ReportKind } from '@shared/finance'
import { demoDb, TEST_TODAY } from './helpers'

let db: DB
let ctx: ServiceContext
let from: string
let to: string
const C = () => ctx.companyId

/** Σ(debit − credit) for accounts matching a condition, entries in [a, b]. */
function net(where: string, a: string | null, b: string, args: unknown[] = []): number {
  return (db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_paise - l.credit_paise), 0) AS v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE e.company_id = ? AND e.entry_date <= ? ${a ? 'AND e.entry_date >= ?' : ''} AND (${where})`
    )
    .get(C(), b, ...(a ? [a] : []), ...args) as { v: number }).v
}
const totalRow = (d: ReportDoc) => d.rows.filter((r) => r.style === 'total')
const cell = (d: ReportDoc, label: RegExp, key: string): number => {
  const r = d.rows.find((x) => Object.values(x.cells).some((v) => typeof v === 'string' && label.test(v)))
  expect(r, `${d.kind}: row ${label}`).toBeDefined()
  return r!.cells[key] as number
}

/** Minimal ZIP reader (central directory + raw deflate) for the generated workbook. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString()
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28)
    const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize)
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    p += 46 + nlen + elen + clen
  }
  return out
}
/** Numeric cells of the sheet, by row number. */
function sheetNumbers(xlsx: Buffer): Map<number, number[]> {
  const sheet = unzip(xlsx)['xl/worksheets/sheet1.xml']
  const rows = new Map<number, number[]>()
  for (const m of sheet.matchAll(/<c r="[A-Z]+(\d+)"[^>]*?(?:t="n")?[^>]*><v>(-?[\d.]+)<\/v><\/c>/g)) {
    const r = Number(m[1])
    rows.set(r, [...(rows.get(r) ?? []), Number(m[2])])
  }
  return rows
}

beforeAll(async () => {
  const d = await demoDb()
  db = d.db
  ctx = d.ctx
  const p = periods(ctx, TEST_TODAY.toISOString().slice(0, 10))
  const fy = p.years.find((y) => y.fy === p.currentFy)!
  from = fy.from
  to = TEST_TODAY.toISOString().slice(0, 10)
})

describe('report totals equal an independent recomputation from the books', () => {
  it('trial balance and day book equal the journal line sums; the trial balance balances', () => {
    const tb = buildReport(ctx, { report: 'TRIAL_BALANCE', from, to })
    const t = totalRow(tb)[0].cells
    const periodDr = (db.prepare(`SELECT SUM(l.debit_paise) d, SUM(l.credit_paise) c FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id WHERE e.company_id = ? AND e.entry_date BETWEEN ? AND ?`).get(C(), from, to) as { d: number; c: number })
    expect(t.pd).toBe(periodDr.d)
    expect(t.pc).toBe(periodDr.c)
    expect(t.cd).toBe(t.cc)
    expect(t.od).toBe(t.oc)
    const dbk = buildReport(ctx, { report: 'DAY_BOOK', from, to })
    const entries = db.prepare(`SELECT COUNT(*) n, SUM(total_debit_paise) v FROM journal_entries WHERE company_id = ? AND entry_date BETWEEN ? AND ?`).get(C(), from, to) as { n: number; v: number }
    expect(totalRow(dbk)[0].cells.debit).toBe(entries.v)
    expect(totalRow(dbk)[0].cells.account).toBe(`Total (${entries.n} entries)`)
  })

  it('profit & loss net profit and balance sheet totals equal account-type sums', () => {
    const pl = buildReport(ctx, { report: 'PROFIT_LOSS', from, to })
    const profit = -net(`a.account_type IN ('INCOME','EXPENSE')`, from, to)
    expect(cell(pl, /^NET (PROFIT|LOSS)$/, 'amount')).toBe(profit)
    const bs = buildReport(ctx, { report: 'BALANCE_SHEET', asOf: to })
    const assets = net(`a.account_type = 'ASSET'`, null, to)
    const liabEq = -net(`a.account_type IN ('LIABILITY','EQUITY','INCOME','EXPENSE')`, null, to)
    expect(cell(bs, /^Total assets$/i, 'amount')).toBe(assets)
    expect(cell(bs, /^Total liabilities and equity$/, 'amount')).toBe(liabEq)
    expect(assets).toBe(liabEq)
  })

  it('cash book closing, receivables and payables equal their control-account balances', () => {
    const cash = buildReport(ctx, { report: 'CASH_BOOK', from, to })
    expect(cell(cash, /^Closing balance$/, 'balance')).toBe(net(`a.system_key = 'CASH'`, null, to))
    const ar = buildReport(ctx, { report: 'RECEIVABLES', asOf: to })
    expect(totalRow(ar)[0].cells.net).toBe(net(`a.system_key = 'AR'`, null, to))
    const ap = buildReport(ctx, { report: 'PAYABLES', asOf: to })
    expect(totalRow(ap)[0].cells.net).toBe(-net(`a.system_key = 'AP'`, null, to))
  })

  it('stock valuation equals current stock balances and the Stock-in-Hand ledger', () => {
    // Valued as of the last movement, the report must equal the running stock balances.
    const lastMove = (db.prepare('SELECT MAX(movement_date) d FROM stock_movements WHERE company_id = ?').get(C()) as { d: string }).d
    const asOf = lastMove > to ? lastMove : to
    const sv = buildReport(ctx, { report: 'STOCK_VALUATION', asOf })
    const balances = (db.prepare('SELECT COALESCE(SUM(value_paise),0) v FROM stock_balances WHERE company_id = ?').get(C()) as { v: number }).v
    expect(totalRow(sv)[0].cells.value).toBe(balances)
    expect(totalRow(sv)[0].cells.value).toBe(net(`a.system_key = 'INVENTORY'`, null, asOf))
  })

  it('sales and purchase registers equal the posted documents, and GST summary equals the GST registers', () => {
    for (const [report, table] of [['SALES_REGISTER', 'sales_invoices'], ['PURCHASE_REGISTER', 'purchase_invoices']] as const) {
      const doc = buildReport(ctx, { report, from, to })
      const sql = db.prepare(`SELECT COUNT(*) n, SUM(taxable_paise) t, SUM(cgst_paise) c, SUM(sgst_paise) s, SUM(igst_paise) i, SUM(grand_total_paise) g FROM ${table} WHERE company_id = ? AND status = 'POSTED' AND invoice_date BETWEEN ? AND ?`).get(C(), from, to) as Record<string, number>
      const t = totalRow(doc)[0].cells
      expect([t.taxable, t.cgst, t.sgst, t.igst, t.total], report).toEqual([sql.t, sql.c, sql.s, sql.i, sql.g])
      expect(t.party).toBe(`Total (${sql.n} posted)`)
    }
    const g = totalRow(buildReport(ctx, { report: 'GST_SUMMARY', from, to }))[0].cells
    const sales = salesRegister(ctx, { from, to }).totals
    const purchases = purchaseRegister(ctx, { from, to }).totals
    expect([g.oc, g.os, g.oi]).toEqual([sales.cgstPaise, sales.sgstPaise, sales.igstPaise])
    expect([g.ic, g.is, g.ii]).toEqual([purchases.cgstPaise, purchases.sgstPaise, purchases.igstPaise])
  })
})

describe('every report exports to a valid workbook and printable HTML carrying the same totals', () => {
  const KINDS: Array<[ReportKind, Record<string, string>]> = [
    ['DAY_BOOK', {}], ['CASH_BOOK', {}], ['TRIAL_BALANCE', {}], ['PROFIT_LOSS', {}], ['BALANCE_SHEET', { asOf: '' }], ['RECEIVABLES', { asOf: '' }],
    ['PAYABLES', { asOf: '' }], ['STOCK_VALUATION', { asOf: '' }], ['SALES_REGISTER', {}], ['PURCHASE_REGISTER', {}], ['GST_SUMMARY', {}]
  ]
  it.each(KINDS)('%s', (kind, shape) => {
    const doc = buildReport(ctx, { report: kind, ...('asOf' in shape ? { asOf: to } : { from, to }) })
    const xlsx = reportToXlsx(doc)
    const files = unzip(xlsx)
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) expect(files[f], `${kind}: ${f}`).toBeDefined()
    // Well-formed XML (no unescaped & or <) in every part.
    for (const [name, xml] of Object.entries(files)) expect(xml.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, ''), `${kind} ${name}`).not.toMatch(/&/)
    // The total row's money figures appear on one sheet row, in rupees.
    const totals = totalRow(doc)[0]
    const money = doc.columns.filter((c) => c.type === 'money' && typeof totals.cells[c.key] === 'number').map((c) => Number(((totals.cells[c.key] as number) / 100).toFixed(2)))
    const rows = sheetNumbers(xlsx)
    const match = [...rows.values()].find((nums) => money.every((m) => nums.includes(m)))
    expect(match, `${kind}: totals ${money.join(', ')} not found in the sheet`).toBeDefined()
    // The printable HTML says DEMO for demo data and escapes content.
    const html = reportHtml(doc)
    expect(html).toContain('DEMO')
    expect(html).not.toMatch(/<script/i)
  })
})
