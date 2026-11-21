/**
 * Builds a uniform ReportDoc (columns + rows) for each financial report. The same
 * document drives the on-screen preview, PDF/print (report-html) and Excel
 * (xlsx), so all three always show identical figures.
 */
import { AGEING_BUCKETS, AGEING_LABELS, REPORT_KINDS, ReportParams, type ReportColumn, type ReportDoc, type ReportParamsT, type ReportRow } from '@shared/finance'
import { formatINR } from '@shared/money'
import type { ServiceContext } from '../context'
import { businessRule } from '../errors'
import { register } from '../documents/summary'
import { gstSummaryRange } from '../reports'
import { ageing } from '../finance/ageing'
import { balanceSheet, cashBook, dayBook, generalLedger, profitAndLoss, trialBalanceReport } from '../finance/statements'
import { getReconciliation } from '../finance/bankrec'

const dmy = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
const period = (from: string, to: string) => `${dmy(from)} to ${dmy(to)}`
const col = (key: string, label: string, type: ReportColumn['type'] = 'text', width?: number): ReportColumn => ({ key, label, type, width })
const row = (cells: ReportRow['cells'], style?: ReportRow['style'], indent?: number): ReportRow => ({ cells, style, indent })

interface Built {
  title?: string
  subtitle: string
  columns: ReportColumn[]
  rows: ReportRow[]
  summary?: ReportDoc['summary']
  notes?: string[]
}

export function buildReport(ctx: ServiceContext, raw: ReportParamsT): ReportDoc {
  const p = ReportParams.parse(raw)
  const company = ctx.db.prepare('SELECT name, gstin, is_demo FROM companies WHERE id = ?').get(ctx.companyId) as { name: string; gstin: string | null; is_demo: number }
  const user = ctx.userId ? (ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(ctx.userId) as { username: string } | undefined)?.username ?? null : null
  const b = BUILDERS[p.report](ctx, p as Required<Pick<typeof p, 'report'>> & typeof p)
  return {
    kind: p.report,
    title: b.title ?? REPORT_KINDS[p.report].label,
    subtitle: b.subtitle,
    companyName: company.name,
    companyGstin: company.gstin,
    isDemo: company.is_demo === 1,
    columns: b.columns,
    rows: b.rows,
    summary: b.summary ?? [],
    notes: b.notes ?? [],
    generatedAt: new Date().toISOString(),
    generatedBy: user
  }
}

type P = ReturnType<typeof ReportParams.parse>
const BUILDERS: Record<keyof typeof REPORT_KINDS, (ctx: ServiceContext, p: P) => Built> = {
  DAY_BOOK: (ctx, p) => {
    const entries = dayBook(ctx, p.from!, p.to!)
    const rows: ReportRow[] = []
    let dr = 0
    for (const e of entries) {
      e.lines.forEach((l, i) => {
        rows.push(row({
          date: i === 0 ? e.date : null, voucher: i === 0 ? e.voucherType : null, number: i === 0 ? (e.voucherNo ?? e.entryNo) : null,
          account: `${l.accountCode} ${l.accountName}${l.party ? ` · ${l.party}` : ''}`, debit: l.debitPaise || null, credit: l.creditPaise || null
        }, undefined, i === 0 ? 0 : 0))
      })
      if (e.narration) rows.push(row({ account: e.narration }, 'muted', 1))
      dr += e.amountPaise
    }
    rows.push(row({ account: `Total (${entries.length} entries)`, debit: dr, credit: dr }, 'total'))
    return {
      subtitle: period(p.from!, p.to!),
      columns: [col('date', 'Date', 'date'), col('voucher', 'Voucher', 'text', 20), col('number', 'Voucher no.', 'text', 18), col('account', 'Account / narration', 'text', 48), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')],
      rows,
      summary: [{ label: 'Journal entries', value: String(entries.length) }, { label: 'Total value', value: formatINR(dr) }]
    }
  },
  CASH_BOOK: (ctx, p) => {
    const cash = ctx.db.prepare(`SELECT id FROM chart_of_accounts WHERE company_id = ? AND system_key = 'CASH'`).get(ctx.companyId) as { id: number } | undefined
    if (!cash) throw businessRule('Cash account is not configured')
    return bookReport(ctx, cash.id, p.from!, p.to!)
  },
  BANK_BOOK: (ctx, p) => bookReport(ctx, p.accountId!, p.from!, p.to!),
  GENERAL_LEDGER: (ctx, p) => {
    const gl = generalLedger(ctx, { accountId: p.accountId!, from: p.from!, to: p.to! })
    const drcr = (v: number) => (v === 0 ? '' : v > 0 ? 'Dr' : 'Cr')
    const rows: ReportRow[] = [row({ particulars: 'Opening balance', balance: Math.abs(gl.openingPaise), side: drcr(gl.openingPaise) }, 'subtotal')]
    for (const l of gl.lines)
      rows.push(row({ date: l.date, voucher: l.voucherType, number: l.voucherNo, particulars: l.particulars, narration: l.narration, debit: l.debitPaise || null, credit: l.creditPaise || null, balance: Math.abs(l.balancePaise), side: drcr(l.balancePaise) }))
    rows.push(row({ particulars: 'Total for the period', debit: gl.debitPaise, credit: gl.creditPaise }, 'subtotal'))
    rows.push(row({ particulars: 'Closing balance', balance: Math.abs(gl.closingPaise), side: drcr(gl.closingPaise) }, 'total'))
    return {
      title: `General Ledger — ${gl.account.code} ${gl.account.name}`,
      subtitle: period(p.from!, p.to!),
      columns: [col('date', 'Date', 'date'), col('voucher', 'Voucher', 'text', 18), col('number', 'Voucher no.', 'text', 18), col('particulars', 'Particulars', 'text', 34), col('narration', 'Narration', 'text', 34), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('balance', 'Balance', 'money'), col('side', 'Dr/Cr', 'text', 6)],
      rows,
      summary: [
        { label: 'Opening', value: `${formatINR(Math.abs(gl.openingPaise))} ${drcr(gl.openingPaise)}` },
        { label: 'Debits', value: formatINR(gl.debitPaise) },
        { label: 'Credits', value: formatINR(gl.creditPaise) },
        { label: 'Closing', value: `${formatINR(Math.abs(gl.closingPaise))} ${drcr(gl.closingPaise)}` }
      ],
      notes: ['Income and expense accounts open at zero at the start of each financial year.']
    }
  },
  TRIAL_BALANCE: (ctx, p) => {
    const tb = trialBalanceReport(ctx, p.from!, p.to!)
    const rows = tb.rows.map((r) =>
      row({ code: r.code, name: r.name, type: r.accountType, od: r.openingDebitPaise || null, oc: r.openingCreditPaise || null, pd: r.periodDebitPaise || null, pc: r.periodCreditPaise || null, cd: r.closingDebitPaise || null, cc: r.closingCreditPaise || null })
    )
    const t = tb.totals
    rows.push(row({ name: 'Total', od: t.openingDebitPaise, oc: t.openingCreditPaise, pd: t.periodDebitPaise, pc: t.periodCreditPaise, cd: t.closingDebitPaise, cc: t.closingCreditPaise }, 'total'))
    if (!tb.balanced) rows.push(row({ name: 'DIFFERENCE (not balanced)', od: tb.differences.openingPaise || null, pd: tb.differences.periodPaise || null, cd: tb.differences.closingPaise || null }, 'subtotal'))
    return {
      subtitle: `${period(p.from!, p.to!)} · FY ${tb.financialYear}`,
      columns: [col('code', 'Code', 'text', 8), col('name', 'Account', 'text', 34), col('type', 'Type', 'text', 10), col('od', 'Opening Dr', 'money'), col('oc', 'Opening Cr', 'money'), col('pd', 'Period Dr', 'money'), col('pc', 'Period Cr', 'money'), col('cd', 'Closing Dr', 'money'), col('cc', 'Closing Cr', 'money')],
      rows,
      summary: [{ label: 'Status', value: tb.balanced ? 'Balanced' : `NOT balanced — closing difference ${formatINR(tb.differences.closingPaise)}`, tone: tb.balanced ? 'good' : 'bad' }],
      notes: [
        'Drafts are excluded: only posted journal entries are included. Reversed entries appear together with their reversals.',
        tb.priorYearsProfitPaise ? `Profit of earlier years (${formatINR(tb.priorYearsProfitPaise)}) is carried into Retained Earnings; income and expense accounts open at zero.` : 'Income and expense accounts open at zero at the start of each financial year.'
      ]
    }
  },
  PROFIT_LOSS: (ctx, p) => {
    const pl = profitAndLoss(ctx, p.from!, p.to!)
    const rows: ReportRow[] = []
    const section = (s: (typeof pl.income)[number]) => {
      rows.push(row({ label: s.label }, 'group'))
      for (const i of s.items) rows.push(row({ code: i.code, label: i.label, amount: i.amountPaise }, undefined, 1))
      rows.push(row({ label: `Total ${s.label.toLowerCase()}`, amount: s.totalPaise }, 'subtotal'))
    }
    const get = (k: string) => [...pl.income, ...pl.expenses].find((s) => s.key === k)!
    section(get('SALES'))
    section(get('COGS'))
    section(get('DIRECT_EXPENSE'))
    rows.push(row({ label: 'GROSS PROFIT', amount: pl.grossProfitPaise }, 'total'))
    section(get('INDIRECT_EXPENSE'))
    section(get('ADMIN_EXPENSE'))
    rows.push(row({ label: 'OPERATING PROFIT', amount: pl.operatingProfitPaise }, 'total'))
    section(get('OTHER_INCOME'))
    section(get('FINANCE_EXPENSE'))
    rows.push(row({ label: pl.netProfitPaise >= 0 ? 'NET PROFIT' : 'NET LOSS', amount: pl.netProfitPaise }, 'total'))
    return {
      subtitle: period(p.from!, p.to!),
      columns: [col('code', 'Code', 'text', 8), col('label', 'Particulars', 'text', 46), col('amount', 'Amount', 'money', 18)],
      rows,
      summary: [
        { label: 'Sales revenue', value: formatINR(pl.salesRevenuePaise) },
        { label: 'Gross profit', value: formatINR(pl.grossProfitPaise) },
        { label: 'Operating profit', value: formatINR(pl.operatingProfitPaise) },
        { label: 'Net profit', value: formatINR(pl.netProfitPaise), tone: pl.netProfitPaise >= 0 ? 'good' : 'bad' }
      ],
      notes: ['Amounts exclude GST. Sales revenue is net of returns and credit notes. Purchases of stocked goods are capitalised to inventory and expensed as cost of goods sold when sold.']
    }
  },
  BALANCE_SHEET: (ctx, p) => {
    const bs = balanceSheet(ctx, p.asOf!)
    const rows: ReportRow[] = []
    const block = (title: string, sections: typeof bs.assets, total: number) => {
      rows.push(row({ label: title }, 'group'))
      for (const s of sections) {
        rows.push(row({ label: s.label, amount: s.totalPaise }, 'subtotal', 1))
        for (const i of s.items) rows.push(row({ code: i.code, label: i.label, amount: i.amountPaise }, undefined, 2))
      }
      rows.push(row({ label: `Total ${title.toLowerCase()}`, amount: total }, 'total'))
    }
    block('Assets', bs.assets, bs.totalAssetsPaise)
    block('Liabilities', bs.liabilities, bs.totalLiabilitiesPaise)
    block('Equity', bs.equity, bs.totalEquityPaise)
    rows.push(row({ label: 'Total liabilities and equity', amount: bs.totalLiabilitiesPaise + bs.totalEquityPaise }, 'total'))
    if (!bs.balanced) rows.push(row({ label: 'DIFFERENCE: Assets − (Liabilities + Equity)', amount: bs.differencePaise }, 'subtotal'))
    return {
      subtitle: `As of ${dmy(p.asOf!)} · FY ${bs.financialYear}`,
      columns: [col('code', 'Code', 'text', 8), col('label', 'Particulars', 'text', 46), col('amount', 'Amount', 'money', 18)],
      rows,
      summary: [
        { label: 'Total assets', value: formatINR(bs.totalAssetsPaise) },
        { label: 'Liabilities + equity', value: formatINR(bs.totalLiabilitiesPaise + bs.totalEquityPaise) },
        { label: 'Assets = Liabilities + Equity', value: bs.balanced ? 'Yes' : `No — difference ${formatINR(bs.differencePaise)}`, tone: bs.balanced ? 'good' : 'bad' }
      ],
      notes: ['Customer credit balances are shown as advances from customers; supplier debit balances as advances to suppliers.']
    }
  },
  RECEIVABLES: (ctx, p) => ageingReport(ctx, 'CUSTOMER', p.asOf!),
  PAYABLES: (ctx, p) => ageingReport(ctx, 'SUPPLIER', p.asOf!),
  STOCK_VALUATION: (ctx, p) => {
    const items = ctx.db
      .prepare(
        `SELECT p.code, p.name, w.name AS wh, u.code AS unit, SUM(m.qty_in_milli - m.qty_out_milli) AS q, SUM(CASE WHEN m.qty_in_milli > 0 THEN m.value_paise ELSE -m.value_paise END) AS v
         FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id JOIN units u ON u.id = p.unit_id
         WHERE m.company_id = ? AND m.movement_date <= ? GROUP BY m.product_id, m.warehouse_id HAVING q <> 0 OR v <> 0 ORDER BY p.code, w.name`
      )
      .all(ctx.companyId, p.asOf) as Array<{ code: string; name: string; wh: string; unit: string; q: number; v: number }>
    const total = items.reduce((s, i) => s + i.v, 0)
    const ledger = (ctx.db
      .prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
                WHERE je.company_id = ? AND a.system_key = 'INVENTORY' AND je.entry_date <= ?`)
      .get(ctx.companyId, p.asOf) as { b: number }).b
    const rows = items.map((i) => row({ code: i.code, name: i.name, wh: i.wh, unit: i.unit, qty: i.q, rate: i.q ? Math.round((i.v * 1000) / i.q) : null, value: i.v }))
    rows.push(row({ name: 'Total stock valuation', value: total }, 'total'))
    rows.push(row({ name: 'Stock in Hand ledger balance', value: ledger }, ledger === total ? 'muted' : 'subtotal'))
    return {
      subtitle: `As of ${dmy(p.asOf!)} · moving-average cost`,
      columns: [col('code', 'Code', 'text', 12), col('name', 'Item', 'text', 40), col('wh', 'Warehouse', 'text', 18), col('unit', 'Unit', 'text', 7), col('qty', 'Quantity', 'qty'), col('rate', 'Avg cost', 'money'), col('value', 'Value', 'money')],
      rows,
      summary: [
        { label: 'Stock value', value: formatINR(total) },
        { label: 'Agrees with ledger', value: ledger === total ? 'Yes' : `No — ledger ${formatINR(ledger)}`, tone: ledger === total ? 'good' : 'bad' }
      ]
    }
  },
  SALES_REGISTER: (ctx, p) => registerReport(ctx, 'SALES', p.from!, p.to!),
  PURCHASE_REGISTER: (ctx, p) => registerReport(ctx, 'PURCHASE', p.from!, p.to!),
  GST_SUMMARY: (ctx, p) => {
    const g = gstSummaryRange(ctx, p.from!, p.to!)
    const rows = g.map((r) => {
      const out = r.outputCgstPaise + r.outputSgstPaise + r.outputIgstPaise
      const inp = r.inputCgstPaise + r.inputSgstPaise + r.inputIgstPaise
      return row({ month: r.month, ot: r.outputTaxablePaise, oc: r.outputCgstPaise, os: r.outputSgstPaise, oi: r.outputIgstPaise, it: r.inputTaxablePaise, ic: r.inputCgstPaise, is: r.inputSgstPaise, ii: r.inputIgstPaise, net: out - inp })
    })
    const s = (k: string) => rows.reduce((a, r) => a + ((r.cells[k] as number) ?? 0), 0)
    rows.push(row({ month: 'Total', ot: s('ot'), oc: s('oc'), os: s('os'), oi: s('oi'), it: s('it'), ic: s('ic'), is: s('is'), ii: s('ii'), net: s('net') }, 'total'))
    return {
      subtitle: period(p.from!, p.to!),
      columns: [col('month', 'Month', 'text', 10), col('ot', 'Output taxable', 'money'), col('oc', 'Output CGST', 'money'), col('os', 'Output SGST', 'money'), col('oi', 'Output IGST', 'money'), col('it', 'Input taxable', 'money'), col('ic', 'Input CGST', 'money'), col('is', 'Input SGST', 'money'), col('ii', 'Input IGST', 'money'), col('net', 'Net (output − input)', 'money')],
      rows,
      notes: ['Credit notes and sales returns reduce output tax; debit notes and purchase returns reduce input tax. This summary does not file GST returns.']
    }
  },
  BANK_RECONCILIATION: (ctx, p) => {
    const r = getReconciliation(ctx, p.reconciliationId!)
    const s = r.summary
    const rows: ReportRow[] = [row({ particulars: `Balance as per books on ${dmy(r.statementDate)}`, amount: s.bookBalancePaise }, 'subtotal')]
    const list = (title: string, items: typeof r.unclearedDeposits, total: number) => {
      rows.push(row({ particulars: title }, 'group'))
      for (const b of items) rows.push(row({ date: b.date, voucher: b.voucherNo ?? b.entryNo, particulars: b.particulars, amount: b.amountPaise }, undefined, 1))
      rows.push(row({ particulars: `Total (${items.length})`, amount: total }, 'subtotal', 1))
    }
    list('Add: payments recorded in the books, not yet debited by the bank', r.unclearedWithdrawals, s.unclearedWithdrawalsPaise)
    list('Less: receipts recorded in the books, not yet credited by the bank', r.unclearedDeposits, s.unclearedDepositsPaise)
    rows.push(row({ particulars: 'Adjusted balance as per books', amount: s.adjustedBookBalancePaise }, 'subtotal'))
    const bankOnly = r.statementLines.filter((l) => !l.matched)
    rows.push(row({ particulars: 'Bank-only items not yet recorded in the books' }, 'group'))
    for (const l of bankOnly) rows.push(row({ date: l.date, voucher: l.reference, particulars: l.description, amount: l.depositPaise || -l.withdrawalPaise }, undefined, 1))
    rows.push(row({ particulars: `Net (${bankOnly.length})`, amount: s.unmatchedStatementDepositsPaise - s.unmatchedStatementWithdrawalsPaise }, 'subtotal', 1))
    rows.push(row({ particulars: 'Expected balance as per bank statement', amount: s.adjustedBookBalancePaise + s.unmatchedStatementDepositsPaise - s.unmatchedStatementWithdrawalsPaise }, 'subtotal'))
    rows.push(row({ particulars: 'Balance as per bank statement', amount: r.statementBalancePaise }, 'total'))
    if (s.differencePaise !== 0) rows.push(row({ particulars: 'UNEXPLAINED DIFFERENCE', amount: s.differencePaise }, 'subtotal'))
    return {
      title: `Bank Reconciliation Statement — ${r.accountName}`,
      subtitle: `As of ${dmy(r.statementDate)} · ${r.status === 'COMPLETED' ? 'Completed' : 'In progress'}`,
      columns: [col('date', 'Date', 'date'), col('voucher', 'Voucher / ref.', 'text', 18), col('particulars', 'Particulars', 'text', 56), col('amount', 'Amount', 'money', 18)],
      rows,
      summary: [
        { label: 'Balance as per books', value: formatINR(s.bookBalancePaise) },
        { label: 'Balance as per bank', value: formatINR(r.statementBalancePaise) },
        { label: 'Status', value: s.status === 'RECONCILED' ? 'Reconciled' : `Not reconciled — difference ${formatINR(s.differencePaise)}${s.unmatchedStatementLines ? `, ${s.unmatchedStatementLines} unmatched line(s)` : ''}`, tone: s.status === 'RECONCILED' ? 'good' : 'bad' }
      ],
      notes: ['Reconciliation never changes posted transactions; matching only records which book entries the bank has cleared.']
    }
  }
}

function bookReport(ctx: ServiceContext, accountId: number, from: string, to: string): Built {
  const b = cashBook(ctx, accountId, from, to)
  const rows: ReportRow[] = [row({ particulars: 'Opening balance', balance: b.openingPaise }, 'subtotal')]
  for (const r of b.rows)
    rows.push(row({ date: r.date, voucher: r.voucherType, number: r.voucherNo, particulars: r.particulars, receipt: r.receiptPaise || null, payment: r.paymentPaise || null, balance: r.balancePaise }))
  rows.push(row({ particulars: 'Total for the period', receipt: b.receiptsPaise, payment: b.paymentsPaise }, 'subtotal'))
  rows.push(row({ particulars: 'Closing balance', balance: b.closingPaise }, 'total'))
  return {
    title: `${b.account.isCash ? 'Cash Book' : 'Bank Book'} — ${b.account.name}`,
    subtitle: period(from, to),
    columns: [col('date', 'Date', 'date'), col('voucher', 'Voucher', 'text', 20), col('number', 'Voucher no.', 'text', 18), col('particulars', 'Particulars', 'text', 44), col('receipt', b.account.isCash ? 'Receipts' : 'Deposits', 'money'), col('payment', b.account.isCash ? 'Payments' : 'Withdrawals', 'money'), col('balance', 'Balance', 'money')],
    rows,
    summary: [
      { label: 'Opening', value: formatINR(b.openingPaise) },
      { label: b.account.isCash ? 'Receipts' : 'Deposits', value: formatINR(b.receiptsPaise) },
      { label: b.account.isCash ? 'Payments' : 'Withdrawals', value: formatINR(b.paymentsPaise) },
      { label: 'Contra in / out', value: `${formatINR(b.contraInPaise)} / ${formatINR(b.contraOutPaise)}` },
      { label: 'Closing', value: formatINR(b.closingPaise) }
    ]
  }
}

function ageingReport(ctx: ServiceContext, side: 'CUSTOMER' | 'SUPPLIER', asOf: string): Built {
  const a = ageing(ctx, side, asOf)
  const rows = a.rows.map((r) => row({ party: `${r.name} (${r.code})`, ...Object.fromEntries(AGEING_BUCKETS.map((b) => [b, r.buckets[b] || null])), gross: r.grossPaise, onAccount: r.onAccountPaise || null, net: r.netPaise }))
  rows.push(row({ party: 'Total', ...Object.fromEntries(AGEING_BUCKETS.map((b) => [b, a.totals[b]])), gross: a.totals.grossPaise, onAccount: a.totals.onAccountPaise, net: a.totals.netPaise }, 'total'))
  rows.push(row({ party: `${side === 'CUSTOMER' ? 'Sundry Debtors' : 'Sundry Creditors'} ledger balance`, net: a.controlAccountPaise }, a.agrees ? 'muted' : 'subtotal'))
  return {
    subtitle: `As of ${dmy(asOf)} · ageing by days past due date`,
    columns: [
      col('party', side === 'CUSTOMER' ? 'Customer' : 'Supplier', 'text', 38),
      ...AGEING_BUCKETS.map((b) => col(b, AGEING_LABELS[b], 'money')),
      col('gross', 'Open items', 'money'), col('onAccount', side === 'CUSTOMER' ? 'Advances / on account' : 'Advances paid', 'money'), col('net', 'Net outstanding', 'money')
    ],
    rows,
    summary: [
      { label: 'Net outstanding', value: formatINR(a.totals.netPaise) },
      { label: 'Overdue', value: formatINR(a.totals.overduePaise) },
      { label: 'Agrees with ledger', value: a.agrees ? 'Yes' : `No — difference ${formatINR(a.differencePaise)}`, tone: a.agrees ? 'good' : 'bad' }
    ],
    notes: ['Items without a due date are aged from their document date. Unallocated receipts/payments and credit/debit notes are shown on account.']
  }
}

function registerReport(ctx: ServiceContext, side: 'SALES' | 'PURCHASE', from: string, to: string): Built {
  const rows = register(ctx, { side, from, to, includeCancelled: true }).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
  const live = rows.filter((r) => r.status === 'POSTED')
  const out: ReportRow[] = rows.map((r) =>
    row({
      date: r.date, number: r.number, party: r.partyName, gstin: r.partyGstin, ref: r.partyRef, taxable: r.taxablePaise, cgst: r.cgstPaise || null, sgst: r.sgstPaise || null, igst: r.igstPaise || null,
      total: r.grandTotalPaise, balance: r.status === 'POSTED' ? r.balanceDuePaise : null, status: r.status === 'CANCELLED' ? 'Cancelled' : r.paymentStatus === 'PAID' ? 'Paid' : r.paymentStatus === 'PARTIAL' ? 'Part-paid' : r.overdueDays > 0 ? `Overdue ${r.overdueDays}d` : 'Unpaid'
    }, r.status === 'CANCELLED' ? 'muted' : undefined)
  )
  const s = (f: (r: (typeof live)[number]) => number) => live.reduce((a, r) => a + f(r), 0)
  out.push(row({ party: `Total (${live.length} posted)`, taxable: s((r) => r.taxablePaise), cgst: s((r) => r.cgstPaise), sgst: s((r) => r.sgstPaise), igst: s((r) => r.igstPaise), total: s((r) => r.grandTotalPaise), balance: s((r) => r.balanceDuePaise) }, 'total'))
  return {
    subtitle: period(from, to),
    columns: [
      col('date', 'Date', 'date'), col('number', side === 'SALES' ? 'Invoice no.' : 'Voucher no.', 'text', 18), col('party', side === 'SALES' ? 'Customer' : 'Supplier', 'text', 32), col('gstin', 'GSTIN', 'text', 17),
      ...(side === 'PURCHASE' ? [col('ref', 'Supplier bill no.', 'text', 16)] : []),
      col('taxable', 'Taxable', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('igst', 'IGST', 'money'), col('total', 'Total', 'money'), col('balance', 'Balance due', 'money'), col('status', 'Status', 'text', 12)
    ],
    rows: out,
    summary: [{ label: 'Posted', value: String(live.length) }, { label: 'Total value', value: formatINR(s((r) => r.grandTotalPaise)) }],
    notes: ['Cancelled documents are listed for completeness and excluded from totals.']
  }
}
