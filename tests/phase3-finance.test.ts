/**
 * Phase 3 — finance & accounting: trial balance, opening/closing balances, P&L,
 * balance sheet, general ledger drill-down, ageing, cash/bank books, bank
 * reconciliation, vouchers, duplicate prevention, reversals, drafts and FY filtering.
 * Scenarios use exact rupee amounts so every figure is checked, not just "balanced".
 */
import { describe, expect, it } from 'vitest'
import { toMilli, toPaise } from '@shared/money'
import { fixture, type Fixture } from './phase2-fixtures'
import { demoDb } from './helpers'
import { createPayment } from '../src/main/services/documents/payments'
import { cancelDocument } from '../src/main/services/documents/engine'
import { createVoucher, cancelVoucher } from '../src/main/services/finance/vouchers'
import { ageing, partyStatement } from '../src/main/services/finance/ageing'
import * as FS from '../src/main/services/finance/statements'
import * as BR from '../src/main/services/finance/bankrec'
import { periods, todayIso } from '../src/main/services/finance/periods'
import { integrityReport } from '../src/main/services/finance/audit-checks'
import { accountId } from '../src/main/services/ledger'

const R = toPaise
const FY_FROM = '2026-04-01'
const AS_OF = '2026-10-31'

/** Exact scenario (amounts in rupees):
 *  opening (fixture): bank 5,00,000 / capital; stock 10 widgets 6,000 / opening equity
 *  2026-03-15 (FY 2025-26): service sale 2,000 + 18% GST = 2,360 (due 2026-04-14)
 *  2026-10-01: sale of 2 widgets 2,000 + GST 360 = 2,360 (cost 1,200; due 2026-10-31)
 *  2026-10-05: purchase of 4 gears 600 + 5% GST 30 = 630 (due 2026-10-20)
 *  2026-10-06: rent 10,000; contract labour 500; bank charges 100; interest income 50 (all bank)
 *  2026-10-10: receipt 3,000 — 2,360 allocated to the October invoice, 640 on account
 */
function scenario() {
  const f = fixture()
  const acc = (code: string) => (f.db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(f.ctx.companyId, code) as { id: number }).id
  const oldInv = f.post(f.save({ kind: 'SALES_INVOICE', partyId: f.intra, date: '2026-03-15', dueDate: '2026-04-14', lines: [{ productId: f.service, qtyMilli: toMilli(1), ratePaise: R(2000) }] }))
  const inv = f.post(f.save({ kind: 'SALES_INVOICE', partyId: f.intra, date: '2026-10-01', dueDate: '2026-10-31', warehouseId: f.wh, lines: [{ productId: f.widget, qtyMilli: toMilli(2), ratePaise: R(1000) }] }))
  const bill = f.post(f.save({ kind: 'PURCHASE_INVOICE', partyId: f.vendor, date: '2026-10-05', dueDate: '2026-10-20', supplierRef: 'V-1001', supplierRefDate: '2026-10-05', warehouseId: f.wh, lines: [{ productId: f.gear, qtyMilli: toMilli(4), ratePaise: R(150) }] }))
  const v = (code: string, amount: number, narration: string, bankDebit = false) =>
    createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-06', narration, lines: bankDebit ? [{ accountId: f.bank, debitPaise: R(amount) }, { accountId: acc(code), creditPaise: R(amount) }] : [{ accountId: acc(code), debitPaise: R(amount) }, { accountId: f.bank, creditPaise: R(amount) }] })
  const rent = v('6200', 10000, 'Office rent October')
  const labour = v('5700', 500, 'Installation labour')
  v('6800', 100, 'Bank charges')
  v('4510', 50, 'Interest credited', true)
  const receipt = createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: '2026-10-10', amountPaise: R(3000), mode: 'BANK_TRANSFER', accountId: f.bank, referenceNo: 'UTR-555', allocations: [{ invoiceId: inv.id, amountPaise: R(2360) }] })
  return { f, acc, oldInv, inv, bill, rent, labour, receipt }
}

const tbRow = (tb: ReturnType<typeof FS.trialBalanceReport>, code: string) => tb.rows.find((r) => r.code === code)!

describe('trial balance', () => {
  it('is accurate: exact opening, period and closing columns per account, balanced in total', () => {
    const { f } = scenario()
    const tb = FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF)
    expect(tb.balanced).toBe(true)
    expect(tb.differences).toEqual({ openingPaise: 0, periodPaise: 0, closingPaise: 0 })
    // Opening for FY 2026-27 comes from FY 2025-26: debtor, GST and prior-year profit in retained earnings.
    expect(tbRow(tb, '1300')).toMatchObject({ openingDebitPaise: R(2360), periodDebitPaise: R(2360), periodCreditPaise: R(3000), closingDebitPaise: R(1720), closingCreditPaise: 0 })
    expect(tbRow(tb, '3200')).toMatchObject({ openingCreditPaise: R(2000), closingCreditPaise: R(2000) })
    expect(tb.rows.find((r) => r.code === '4200')).toBeUndefined() // last year's service income does not carry forward
    expect(tbRow(tb, '1200')).toMatchObject({ openingDebitPaise: 0, periodDebitPaise: R(503050), periodCreditPaise: R(10600), closingDebitPaise: R(492450) })
    expect(tbRow(tb, '1400')).toMatchObject({ periodDebitPaise: R(6600), periodCreditPaise: R(1200), closingDebitPaise: R(5400) })
    expect(tbRow(tb, '4100')).toMatchObject({ closingCreditPaise: R(2000) })
    expect(tbRow(tb, '5100')).toMatchObject({ closingDebitPaise: R(1200) })
    expect(tbRow(tb, '2100')).toMatchObject({ closingCreditPaise: R(630) })
    expect(tb.totals.openingDebitPaise).toBe(R(2360))
    expect(tb.totals.openingCreditPaise).toBe(R(2360))
    expect(tb.totals.closingDebitPaise).toBe(tb.totals.closingCreditPaise)
    expect(tb.priorYearsProfitPaise).toBe(R(2000))
  })

  it('reports a difference instead of hiding it (corrupted line injected below the triggers)', () => {
    const { f } = scenario()
    // Simulate corruption the engine can never produce: drop the immutability trigger and break one line.
    f.db.exec('DROP TRIGGER trg_jel_no_update')
    f.db.prepare(`UPDATE journal_entry_lines SET debit_paise = debit_paise + 100 WHERE id = (SELECT MAX(id) FROM journal_entry_lines WHERE debit_paise > 0)`).run()
    const tb = FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF)
    expect(tb.balanced).toBe(false)
    expect(tb.differences.closingPaise).toBe(100)
    const integrity = integrityReport(f.ctx, AS_OF)
    expect(integrity.allOk).toBe(false)
    expect(integrity.checks.find((c) => c.key === 'trial_balance')!.ok).toBe(false)
    expect(integrity.checks.find((c) => c.key === 'journals_balanced')!.ok).toBe(false)
  })

  it('opening balances: a mid-year period opens with the year-to-date movement; income accounts restart each FY', () => {
    const { f } = scenario()
    const oct = FS.trialBalanceReport(f.ctx, '2026-10-06', AS_OF)
    // Before 6 Oct this FY: the widget sale (2,000) — so sales open with 2,000 credit and have no movement in the period.
    expect(tbRow(oct, '4100')).toMatchObject({ openingCreditPaise: R(2000), periodCreditPaise: 0, closingCreditPaise: R(2000) })
    expect(tbRow(oct, '1200')).toMatchObject({ openingDebitPaise: R(500000), closingDebitPaise: R(492450) })
    expect(oct.balanced).toBe(true)
    const lastYear = FS.trialBalanceReport(f.ctx, '2025-04-01', '2026-03-31')
    expect(tbRow(lastYear, '4200')).toMatchObject({ openingCreditPaise: 0, periodCreditPaise: R(2000), closingCreditPaise: R(2000) })
    expect(lastYear.rows.find((r) => r.code === '1200')).toBeUndefined() // bank opening was posted in FY 2026-27
  })

  it('closing balances: every row satisfies opening + debits − credits, and equals the account ledger', () => {
    const { f } = scenario()
    const tb = FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF)
    for (const r of tb.rows) {
      const closing = r.openingDebitPaise - r.openingCreditPaise + r.periodDebitPaise - r.periodCreditPaise
      expect(r.closingDebitPaise - r.closingCreditPaise, r.code).toBe(closing)
      if (!r.accountId || r.code === '3200') continue
      const gl = FS.generalLedger(f.ctx, { accountId: r.accountId, from: FY_FROM, to: AS_OF })
      expect(gl.closingPaise, r.code).toBe(closing)
      expect(gl.debitPaise, r.code).toBe(r.periodDebitPaise)
    }
  })
})

describe('profit and loss', () => {
  it('classifies accounts and computes gross, operating and net profit exactly', () => {
    const { f } = scenario()
    const pl = FS.profitAndLoss(f.ctx, FY_FROM, AS_OF)
    expect(pl).toMatchObject({
      salesRevenuePaise: R(2000), cogsPaise: R(1200), directExpensesPaise: R(500), grossProfitPaise: R(300),
      adminExpensesPaise: R(10000), indirectExpensesPaise: 0, operatingProfitPaise: R(-9700),
      otherIncomePaise: R(50), financeExpensesPaise: R(100), netProfitPaise: R(-9750)
    })
    expect(pl.totalIncomePaise - pl.totalExpensesPaise).toBe(pl.netProfitPaise)
    // Net profit equals the negative of all income/expense balances in the trial balance.
    const tb = FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF)
    const plNet = tb.rows.filter((r) => r.accountType === 'INCOME' || r.accountType === 'EXPENSE').reduce((s, r) => s + r.closingCreditPaise - r.closingDebitPaise, 0)
    expect(plNet).toBe(pl.netProfitPaise)
    expect(pl.expenses.find((s) => s.key === 'ADMIN_EXPENSE')!.items).toEqual([expect.objectContaining({ code: '6200', amountPaise: R(10000) })])
    // Prior financial year shows last year's service income only.
    expect(FS.profitAndLoss(f.ctx, '2025-04-01', '2026-03-31')).toMatchObject({ salesRevenuePaise: R(2000), netProfitPaise: R(2000) })
  })

  it('nets sales returns and credit notes against revenue', () => {
    const { f, inv } = scenario()
    f.post(f.save({ kind: 'CREDIT_NOTE', partyId: f.intra, date: '2026-10-20', sourceKind: 'SALES_INVOICE', sourceId: inv.id, reason: 'Allowance', lines: [{ productId: f.widget, qtyMilli: toMilli(1), ratePaise: R(100) }] }))
    expect(FS.profitAndLoss(f.ctx, FY_FROM, AS_OF).salesRevenuePaise).toBe(R(1900))
  })
})

describe('balance sheet', () => {
  it('holds Assets = Liabilities + Equity with exact sections, retained earnings and current-year profit', () => {
    const { f } = scenario()
    const bs = FS.balanceSheet(f.ctx, AS_OF)
    const sec = (list: typeof bs.assets, key: string) => list.find((s) => s.key === key)!.totalPaise
    expect(sec(bs.assets, 'BANK')).toBe(R(492450))
    expect(sec(bs.assets, 'RECEIVABLES')).toBe(R(1720))
    expect(sec(bs.assets, 'INVENTORY')).toBe(R(5400))
    expect(sec(bs.assets, 'OTHER_ASSET')).toBe(R(30))
    expect(sec(bs.liabilities, 'PAYABLES')).toBe(R(630))
    expect(sec(bs.liabilities, 'TAX_LIABILITY')).toBe(R(720))
    expect(sec(bs.equity, 'CAPITAL')).toBe(R(506000))
    expect(bs.retainedEarningsPaise).toBe(R(2000))
    expect(bs.currentYearProfitPaise).toBe(R(-9750))
    expect(bs.totalAssetsPaise).toBe(R(499600))
    expect(bs.totalLiabilitiesPaise + bs.totalEquityPaise).toBe(R(499600))
    expect(bs).toMatchObject({ balanced: true, differencePaise: 0, financialYear: '2026-27' })
  })

  it('shows supplier advances as assets and customer advances as liabilities, still balancing', () => {
    const { f } = scenario()
    createPayment(f.ctx, { type: 'PAYMENT', partyId: f.vendorOut, date: '2026-10-12', amountPaise: R(1000), mode: 'BANK_TRANSFER', accountId: f.bank, allocations: [] })
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.inter, date: '2026-10-12', amountPaise: R(800), mode: 'BANK_TRANSFER', accountId: f.bank, allocations: [] })
    const bs = FS.balanceSheet(f.ctx, AS_OF)
    expect(bs.assets.find((s) => s.key === 'OTHER_ASSET')!.items).toContainEqual(expect.objectContaining({ label: 'Advances to suppliers', amountPaise: R(1000) }))
    expect(bs.liabilities.find((s) => s.key === 'OTHER_LIABILITY')!.items).toContainEqual(expect.objectContaining({ label: 'Advances from customers', amountPaise: R(800) }))
    expect(bs.balanced).toBe(true)
  })

  it('supports as-of dates: the balance sheet before the October transactions differs and still balances', () => {
    const { f } = scenario()
    const sep = FS.balanceSheet(f.ctx, '2026-09-30')
    expect(sep.balanced).toBe(true)
    expect(sep.totalAssetsPaise).toBe(R(500000 + 6000 + 2360))
    expect(sep.currentYearProfitPaise).toBe(0)
  })
})

describe('general ledger', () => {
  it('lists opening, running balance and closing, and traces every line to its source document', () => {
    const { f, inv, receipt, rent, oldInv } = scenario()
    const gl = FS.generalLedger(f.ctx, { accountId: accountId(f.db, f.ctx.companyId, 'AR'), from: FY_FROM, to: AS_OF })
    expect(gl.openingPaise).toBe(R(2360))
    expect(gl.lines.map((l) => [l.voucherType, l.voucherNo, l.route, l.debitPaise, l.creditPaise, l.balancePaise])).toEqual([
      ['Sales', inv.number, `/sales/invoices/${inv.id}`, R(2360), 0, R(4720)],
      ['Receipt', receipt.number, `/sales/receipts/${receipt.id}`, 0, R(3000), R(1720)]
    ])
    expect(gl.closingPaise).toBe(R(1720))
    expect(gl.lines[0].particulars).toContain('Party C1')
    // Party filter and voucher drill-down.
    const party = FS.generalLedger(f.ctx, { accountId: accountId(f.db, f.ctx.companyId, 'AR'), from: '2025-04-01', to: AS_OF, partyType: 'CUSTOMER', partyId: f.intra })
    expect(party.lines.map((l) => l.voucherNo)).toEqual([oldInv.number, inv.number, receipt.number])
    const bank = FS.generalLedger(f.ctx, { accountId: f.bank, from: '2026-10-06', to: '2026-10-06' })
    const rentLine = bank.lines.find((l) => l.voucherNo === rent.number)!
    expect(rentLine).toMatchObject({ voucherType: 'Journal', route: `/finance/vouchers/${rent.id}`, creditPaise: R(10000) })
    const j = FS.journalDetail(f.ctx, rentLine.journalId)
    expect(j.source).toMatchObject({ voucherType: 'Journal', voucherNo: rent.number, route: `/finance/vouchers/${rent.id}` })
    expect(j.lines.reduce((s, l) => s + l.debitPaise - l.creditPaise, 0)).toBe(0)
  })
})

describe('receivables and payables ageing', () => {
  it('ages customer open items into buckets, keeps advances on account and agrees with Sundry Debtors', () => {
    const { f, oldInv } = scenario()
    const ar = ageing(f.ctx, 'CUSTOMER', AS_OF)
    expect(ar.agrees).toBe(true)
    expect(ar.controlAccountPaise).toBe(R(1720))
    const row = ar.rows.find((r) => r.partyId === f.intra)!
    expect(row).toMatchObject({ grossPaise: R(2360), onAccountPaise: R(640), netPaise: R(1720), ledgerPaise: R(1720), differencePaise: 0, overduePaise: R(2360), oldestOverdueDays: 200, overdueInvoices: 1 })
    expect(row.buckets).toEqual({ CURRENT: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: R(2360) })
    const st = partyStatement(f.ctx, 'CUSTOMER', f.intra, AS_OF)
    expect(st.items).toEqual([expect.objectContaining({ kind: 'INVOICE', number: oldInv.number, dueDate: '2026-04-14', daysOverdue: 200, bucket: 'D90_PLUS', balancePaise: R(2360) })])
    expect(st.onAccount).toEqual([expect.objectContaining({ kind: 'RECEIPT', unallocatedPaise: R(640) })])
    expect(st.payments[0]).toMatchObject({ amountPaise: R(3000), allocatedPaise: R(2360) })
  })

  it('ages as of any date: before the receipt, both invoices are open and the October one is current', () => {
    const { f } = scenario()
    const ar = ageing(f.ctx, 'CUSTOMER', '2026-10-09')
    const row = ar.rows.find((r) => r.partyId === f.intra)!
    expect(row.buckets).toMatchObject({ CURRENT: R(2360), D90_PLUS: R(2360) })
    expect(row).toMatchObject({ onAccountPaise: 0, netPaise: R(4720) })
    expect(ar.agrees).toBe(true)
  })

  it('covers every bucket boundary (0, 1, 30, 31, 60, 61, 90, 91 days)', () => {
    const f = fixture()
    const dues: Array<[string, string]> = [['2026-10-31', 'CURRENT'], ['2026-10-30', 'D1_30'], ['2026-10-01', 'D1_30'], ['2026-09-30', 'D31_60'], ['2026-09-01', 'D31_60'], ['2026-08-31', 'D61_90'], ['2026-08-02', 'D61_90'], ['2026-08-01', 'D90_PLUS']]
    for (const [due] of dues) f.post(f.save({ kind: 'SALES_INVOICE', partyId: f.inter, date: '2026-07-01', dueDate: due, lines: [{ productId: f.service, qtyMilli: toMilli(1), ratePaise: R(100) }] }))
    const st = partyStatement(f.ctx, 'CUSTOMER', f.inter, AS_OF)
    expect(st.items.map((i) => [i.dueDate, i.daysOverdue, i.bucket])).toEqual(
      [...dues].sort((a, b) => a[0].localeCompare(b[0])).map(([d, b]) => [d, Math.max(0, Math.round((Date.parse(`${AS_OF}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000)), b])
    )
  })

  it('ages supplier bills, advances and debit notes; payables agree with Sundry Creditors', () => {
    const { f, bill } = scenario()
    createPayment(f.ctx, { type: 'PAYMENT', partyId: f.vendor, date: '2026-10-25', amountPaise: R(300), mode: 'BANK_TRANSFER', accountId: f.bank, allocations: [{ invoiceId: bill.id, amountPaise: R(300) }] })
    f.post(f.save({ kind: 'DEBIT_NOTE', partyId: f.vendor, date: '2026-10-26', sourceKind: 'PURCHASE_INVOICE', sourceId: bill.id, supplierRef: 'CN-77', reason: 'Rate difference', lines: [{ productId: f.gear, qtyMilli: toMilli(1), ratePaise: R(20) }] }))
    createPayment(f.ctx, { type: 'PAYMENT', partyId: f.vendorOut, date: '2026-10-27', amountPaise: R(1000), mode: 'BANK_TRANSFER', accountId: f.bank, allocations: [] })
    const ap = ageing(f.ctx, 'SUPPLIER', AS_OF)
    expect(ap.agrees).toBe(true)
    const v = ap.rows.find((r) => r.partyId === f.vendor)!
    expect(v.buckets.D1_30).toBe(R(630 - 300 - 21)) // 11 days past due; debit note 20 + 5% GST settles the bill
    expect(v.netPaise).toBe(R(309))
    const adv = ap.rows.find((r) => r.partyId === f.vendorOut)!
    expect(adv).toMatchObject({ grossPaise: 0, onAccountPaise: R(1000), netPaise: R(-1000), ledgerPaise: R(-1000) })
    expect(ap.controlAccountPaise).toBe(R(309 - 1000))
  })
})

describe('cash book and bank book', () => {
  it('cash book: opening, receipts, payments, contra and running balance', () => {
    const { f, acc } = scenario()
    expect(() => createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-07', narration: 'Travel', lines: [{ accountId: acc('6700'), debitPaise: R(100) }, { accountId: f.cash, creditPaise: R(100) }] })).toThrow(/Insufficient cash/)
    createVoucher(f.ctx, { type: 'CONTRA', date: '2026-10-07', narration: 'Cash withdrawn', lines: [{ accountId: f.cash, debitPaise: R(20000) }, { accountId: f.bank, creditPaise: R(20000) }] })
    createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-08', narration: 'Travel', lines: [{ accountId: acc('6700'), debitPaise: R(1500) }, { accountId: f.cash, creditPaise: R(1500) }] })
    createPayment(f.ctx, { type: 'RECEIPT', partyId: f.inter, date: '2026-10-09', amountPaise: R(1000), mode: 'CASH', accountId: f.cash, allocations: [] })
    const cb = FS.cashBook(f.ctx, f.cash, '2026-10-08', AS_OF)
    expect(cb).toMatchObject({ openingPaise: R(20000), receiptsPaise: R(1000), paymentsPaise: R(1500), closingPaise: R(19500), contraInPaise: 0 })
    expect(cb.rows.map((r) => r.balancePaise)).toEqual([R(18500), R(19500)])
    const full = FS.cashBook(f.ctx, f.cash, FY_FROM, AS_OF)
    expect(full).toMatchObject({ openingPaise: 0, contraInPaise: R(20000), closingPaise: R(19500) })
    expect(full.rows[0]).toMatchObject({ isContra: true, voucherType: 'Contra', receiptPaise: R(20000) })
    expect(full.account.isCash).toBe(true)
  })

  it('bank book: deposits, withdrawals and contra flagged; closing equals the ledger', () => {
    const { f } = scenario()
    createVoucher(f.ctx, { type: 'CONTRA', date: '2026-10-07', narration: 'Cash withdrawn', lines: [{ accountId: f.cash, debitPaise: R(20000) }, { accountId: f.bank, creditPaise: R(20000) }] })
    const bb = FS.cashBook(f.ctx, f.bank, FY_FROM, AS_OF)
    expect(bb.openingPaise).toBe(0)
    expect(bb.receiptsPaise).toBe(R(500000 + 50 + 3000))
    expect(bb.paymentsPaise).toBe(R(10000 + 500 + 100 + 20000))
    expect(bb.contraOutPaise).toBe(R(20000))
    expect(bb.closingPaise).toBe(R(472450))
    expect(bb.closingPaise).toBe(f.ledger('BANK'))
    expect(bb.rows.filter((r) => r.isContra)).toHaveLength(1)
  })
})

describe('bank reconciliation', () => {
  it('matches statement lines without changing posted transactions, records bank-only items and completes', () => {
    const { f, acc, labour } = scenario()
    const snapshot = () => JSON.stringify(f.db.prepare('SELECT * FROM journal_entries ORDER BY id').all()) + JSON.stringify(f.db.prepare('SELECT * FROM journal_entry_lines ORDER BY id').all())
    const maxJournal = (f.db.prepare('SELECT MAX(id) m FROM journal_entries').get() as { m: number }).m
    const before = snapshot()
    let rec = BR.createReconciliation(f.ctx, { accountId: f.bank, statementDate: AS_OF, statementBalancePaise: R(492773) })
    expect(rec.summary).toMatchObject({ bookBalancePaise: R(492450), status: 'UNRECONCILED' })
    expect(() => BR.createReconciliation(f.ctx, { accountId: f.bank, statementDate: AS_OF, statementBalancePaise: 0 })).toThrow(/already in progress/)
    expect(() => BR.createReconciliation(f.ctx, { accountId: f.cash, statementDate: AS_OF, statementBalancePaise: 0 })).toThrow()
    rec = BR.addStatementLines(f.ctx, {
      id: rec.id,
      csv: 'Date,Description,Reference,Deposit,Withdrawal\n01/04/2026,Capital introduced,,"5,00,000.00",\n2026-10-06,Rent,,,10000\n2026-10-06,Interest,,50,\n2026-10-06,Charges,,,100\n2026-10-11,NEFT Party C1,UTR-555,3000,\n2026-10-30,SMS charges,,,177'
    })
    expect(rec.statementLines).toHaveLength(6)
    const auto = BR.autoMatch(f.ctx, rec.id)
    expect(auto.matched).toBe(5)
    rec = auto.detail
    // The labour payment (500) has not reached the bank yet; the SMS charge (177) is not in the books.
    expect(rec.unclearedWithdrawals.map((b) => b.voucherNo)).toEqual([labour.number])
    expect(rec.summary).toMatchObject({ unclearedWithdrawalsPaise: R(500), adjustedBookBalancePaise: R(492950), unmatchedStatementWithdrawalsPaise: R(177), differencePaise: 0, unmatchedStatementLines: 1, status: 'UNRECONCILED' })
    expect(() => BR.completeReconciliation(f.ctx, rec.id)).toThrow(/not matched/)
    // Wrong manual matches are rejected.
    const sms = rec.statementLines.find((l) => l.description === 'SMS charges')!
    expect(() => BR.matchLine(f.ctx, { id: rec.id, statementLineId: sms.id, journalLineId: rec.unclearedWithdrawals[0].journalLineId })).toThrow(/Amounts differ/)
    expect(snapshot()).toBe(before)
    // Record the bank charge in the books (a new voucher), which matches it.
    rec = BR.recordInBooks(f.ctx, { id: rec.id, statementLineId: sms.id, contraAccountId: acc('6800'), narration: 'SMS alert charges' })
    expect(rec.summary).toMatchObject({ bookBalancePaise: R(492273), differencePaise: 0, unmatchedStatementLines: 0, status: 'RECONCILED' })
    rec = BR.completeReconciliation(f.ctx, rec.id)
    expect(rec.status).toBe('COMPLETED')
    // Existing journals are byte-for-byte unchanged; only the new charge voucher was added.
    const after = JSON.stringify(f.db.prepare('SELECT * FROM journal_entries WHERE id <= ? ORDER BY id').all(maxJournal)) + JSON.stringify(f.db.prepare('SELECT * FROM journal_entry_lines WHERE journal_entry_id <= ? ORDER BY id').all(maxJournal))
    expect(after).toBe(before)
    // Completed reconciliations are locked, even against direct SQL.
    expect(() => BR.addStatementLines(f.ctx, { id: rec.id, csv: '2026-10-31,X,,1,' })).toThrow(/completed/)
    expect(() => f.db.prepare('DELETE FROM bank_statement_lines WHERE reconciliation_id = ?').run(rec.id)).toThrow(/completed bank reconciliation/)
    expect(() => f.db.prepare('UPDATE bank_reconciliations SET statement_balance_paise = 0 WHERE id = ?').run(rec.id)).toThrow(/completed bank reconciliation/)
    // The next reconciliation starts with the still-uncleared labour cheque.
    const next = BR.createReconciliation(f.ctx, { accountId: f.bank, statementDate: AS_OF, statementBalancePaise: R(492773 - 500) })
    expect(next.unclearedWithdrawals.map((b) => b.voucherNo)).toEqual([labour.number])
    const ticked = BR.tickBookLine(f.ctx, { id: next.id, journalLineId: next.unclearedWithdrawals[0].journalLineId, clearedDate: AS_OF })
    expect(ticked.summary.status).toBe('RECONCILED')
    expect(FS.cashBook(f.ctx, f.bank, FY_FROM, AS_OF).rows.every((r) => r.cleared)).toBe(true)
  })

  it('rejects malformed statement CSV with row-level messages', () => {
    const { f } = scenario()
    const rec = BR.createReconciliation(f.ctx, { accountId: f.bank, statementDate: AS_OF, statementBalancePaise: 0 })
    expect(() => BR.addStatementLines(f.ctx, { id: rec.id, csv: '2026-13-01,Bad date,,10,' })).toThrow(/Row 1: invalid date/)
    expect(() => BR.addStatementLines(f.ctx, { id: rec.id, csv: '2026-10-01,Both,,10,10' })).toThrow(/either a deposit or a withdrawal/)
    expect(() => BR.addStatementLines(f.ctx, { id: rec.id, csv: '2026-11-30,Late,,10,' })).toThrow(/after the statement date/)
    expect(BR.getReconciliation(f.ctx, rec.id).statementLines).toHaveLength(0)
  })
})

describe('vouchers, duplicates and reversals', () => {
  it('rejects unbalanced vouchers, audits the attempt and posts nothing', () => {
    const { f, acc } = scenario()
    const n = f.count('SELECT COUNT(*) n FROM journal_entries')
    expect(() => createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-20', narration: 'Accrual', lines: [{ accountId: acc('6500'), debitPaise: R(1200) }, { accountId: acc('2600'), creditPaise: R(120) }] })).toThrow(/must equal credits/)
    expect(f.count('SELECT COUNT(*) n FROM journal_entries')).toBe(n)
    expect(f.count(`SELECT COUNT(*) n FROM audit_logs WHERE action = 'JOURNAL_REJECTED'`)).toBe(1)
    expect(f.count('SELECT COUNT(*) n FROM vouchers')).toBe(4)
  })

  it('validates accounts: contra only between cash/bank, parties on debtors/creditors, never Stock in Hand', () => {
    const { f, acc } = scenario()
    const bad = (lines: Parameters<typeof createVoucher>[1]['lines'], type: 'CONTRA' | 'JOURNAL' = 'JOURNAL') => () => createVoucher(f.ctx, { type, date: '2026-10-20', narration: 'Test', lines })
    expect(bad([{ accountId: acc('6200'), debitPaise: 100 }, { accountId: f.bank, creditPaise: 100 }], 'CONTRA')).toThrow()
    expect(bad([{ accountId: acc('1300'), debitPaise: 100 }, { accountId: f.bank, creditPaise: 100 }])).toThrow()
    expect(bad([{ accountId: acc('1400'), debitPaise: 100 }, { accountId: f.bank, creditPaise: 100 }])).toThrow()
    expect(bad([{ accountId: acc('6200'), debitPaise: 100, partyType: 'CUSTOMER', partyId: f.intra }, { accountId: f.bank, creditPaise: 100 }])).toThrow()
    expect(bad([{ accountId: acc('6000'), debitPaise: 100 }, { accountId: f.bank, creditPaise: 100 }])).toThrow()
    expect(bad([{ accountId: acc('6200'), debitPaise: 100, creditPaise: 100 }, { accountId: f.bank, creditPaise: 0 }])).toThrow()
  })

  it('prevents duplicate posting: the same request key returns the first posting; a reused bank reference is refused', () => {
    const { f, acc, inv } = scenario()
    const key = 'f3b1c2d4-1111-2222-3333-444455556666'
    const n = f.count('SELECT COUNT(*) n FROM journal_entries')
    const a = createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-20', narration: 'Rent advance', requestKey: key, lines: [{ accountId: acc('1700'), debitPaise: R(5000) }, { accountId: f.bank, creditPaise: R(5000) }] })
    const b = createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-20', narration: 'Rent advance', requestKey: key, lines: [{ accountId: acc('1700'), debitPaise: R(5000) }, { accountId: f.bank, creditPaise: R(5000) }] })
    expect(b.id).toBe(a.id)
    expect(f.count('SELECT COUNT(*) n FROM journal_entries')).toBe(n + 1)
    const pk = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
    const r1 = createPayment(f.ctx, { type: 'RECEIPT', partyId: f.inter, date: '2026-10-21', amountPaise: R(700), mode: 'UPI', accountId: f.bank, requestKey: pk, allocations: [] })
    const r2 = createPayment(f.ctx, { type: 'RECEIPT', partyId: f.inter, date: '2026-10-21', amountPaise: R(700), mode: 'UPI', accountId: f.bank, requestKey: pk, allocations: [] })
    expect(r2.id).toBe(r1.id)
    expect(f.count('SELECT COUNT(*) n FROM payment_receipts WHERE customer_id = ?', f.inter)).toBe(1)
    expect(() => createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-20', narration: 'Other', requestKey: pk, lines: [{ accountId: acc('1700'), debitPaise: 1 }, { accountId: f.bank, creditPaise: 1 }] })).toThrow(/different transaction/)
    // Same UTR for the same customer (formatting ignored) is refused.
    expect(() => createPayment(f.ctx, { type: 'RECEIPT', partyId: f.intra, date: '2026-10-22', amountPaise: R(10), mode: 'UPI', accountId: f.bank, referenceNo: 'utr 555', allocations: [{ invoiceId: inv.id, amountPaise: 1 }] })).toThrow()
    expect(f.count('SELECT COUNT(*) n FROM payment_receipts WHERE customer_id = ?', f.intra)).toBe(1)
  })

  it('reversals and cancelled documents: books stay balanced, ageing follows the cancellation date, P&L nets to zero', () => {
    const { f, acc } = scenario()
    const today = todayIso()
    const extra = f.post(f.save({ kind: 'SALES_INVOICE', partyId: f.inter, date: '2026-10-15', dueDate: '2026-10-15', lines: [{ productId: f.service, qtyMilli: toMilli(1), ratePaise: R(1000) }] }))
    const beforeCancel = ageing(f.ctx, 'CUSTOMER', AS_OF).rows.find((r) => r.partyId === f.inter)!.netPaise
    expect(beforeCancel).toBe(R(1180))
    cancelDocument(f.ctx, 'SALES_INVOICE', extra.id, 'Raised in error')
    const v = createVoucher(f.ctx, { type: 'JOURNAL', date: '2026-10-20', narration: 'Wrong expense', lines: [{ accountId: acc('6400'), debitPaise: R(250) }, { accountId: f.bank, creditPaise: R(250) }] })
    const vc = cancelVoucher(f.ctx, v.id, 'Duplicate entry')
    expect(vc).toMatchObject({ status: 'CANCELLED', cancelReason: 'Duplicate entry' })
    expect(vc.reversalEntryNo).toMatch(/^JV\//)
    expect(() => cancelVoucher(f.ctx, v.id, 'again')).toThrow(/already cancelled/)
    expect(() => f.db.prepare('UPDATE vouchers SET amount_paise = 1 WHERE id = ?').run(v.id)).toThrow(/cannot be edited/)
    expect(() => f.db.prepare('DELETE FROM vouchers WHERE id = ?').run(v.id)).toThrow(/cannot be deleted/)
    // As of 31 Oct (before the cancellation date) the invoice is still outstanding; from today it is not.
    expect(ageing(f.ctx, 'CUSTOMER', AS_OF).rows.find((r) => r.partyId === f.inter)!.netPaise).toBe(R(1180))
    expect(ageing(f.ctx, 'CUSTOMER', today).rows.find((r) => r.partyId === f.inter)).toBeUndefined()
    expect(ageing(f.ctx, 'CUSTOMER', today).agrees).toBe(true)
    const tb = FS.trialBalanceReport(f.ctx, FY_FROM, today)
    expect(tb.balanced).toBe(true)
    expect(FS.profitAndLoss(f.ctx, FY_FROM, today).netProfitPaise).toBe(R(-9750))
    const reversals = FS.dayBook(f.ctx, today, today).filter((e) => e.isCancellation)
    expect(reversals.map((e) => e.voucherType).sort()).toEqual(['Journal (cancellation)', 'Sales (cancellation)'])
    expect(integrityReport(f.ctx, today).allOk).toBe(true)
  })
})

describe('drafts and financial-year filtering', () => {
  it('drafts never appear as posted financial transactions', () => {
    const { f } = scenario()
    const before = { tb: FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF), day: FS.dayBook(f.ctx, FY_FROM, AS_OF).length, ar: ageing(f.ctx, 'CUSTOMER', AS_OF) }
    f.save({ kind: 'SALES_INVOICE', partyId: f.intra, date: '2026-10-25', lines: [{ productId: f.widget, qtyMilli: toMilli(1), ratePaise: R(1000) }] })
    f.save({ kind: 'PURCHASE_INVOICE', partyId: f.vendor, date: '2026-10-25', supplierRef: 'DRAFT-BILL', lines: [{ productId: f.gear, qtyMilli: toMilli(1), ratePaise: R(150) }] })
    f.save({ kind: 'CREDIT_NOTE', partyId: f.intra, date: '2026-10-25', lines: [{ productId: f.service, qtyMilli: toMilli(1), ratePaise: R(10) }] })
    expect(FS.trialBalanceReport(f.ctx, FY_FROM, AS_OF)).toEqual(before.tb)
    expect(FS.dayBook(f.ctx, FY_FROM, AS_OF)).toHaveLength(before.day)
    expect(ageing(f.ctx, 'CUSTOMER', AS_OF)).toEqual(before.ar)
    expect(integrityReport(f.ctx, AS_OF).checks.find((c) => c.key === 'drafts')!.ok).toBe(true)
  })

  it('lists financial years with data and restricts every report to the selected year', () => {
    const { f } = scenario()
    const p = periods(f.ctx, '2026-11-16')
    expect(p.currentFy).toBe('2026-27')
    expect(p.years.map((y) => [y.fy, y.from, y.to, y.hasData])).toEqual([['2026-27', '2026-04-01', '2027-03-31', true], ['2025-26', '2025-04-01', '2026-03-31', true]])
    const prev = FS.dayBook(f.ctx, '2025-04-01', '2026-03-31')
    expect(prev).toHaveLength(1)
    expect(FS.dayBook(f.ctx, FY_FROM, '2027-03-31').every((e) => e.date >= FY_FROM)).toBe(true)
    expect(FS.profitAndLoss(f.ctx, '2025-04-01', '2026-03-31').netProfitPaise).toBe(R(2000))
    expect(FS.balanceSheet(f.ctx, '2026-03-31')).toMatchObject({ financialYear: '2025-26', currentYearProfitPaise: R(2000), retainedEarningsPaise: 0, balanced: true })
    expect(FS.balanceSheet(f.ctx, AS_OF)).toMatchObject({ financialYear: '2026-27', retainedEarningsPaise: R(2000) })
    expect(() => FS.trialBalanceReport(f.ctx, AS_OF, FY_FROM)).toThrow()
  })
})

describe('finance dashboard and integrity on the DEMO company', () => {
  it('derives every KPI from posted transactions and all reconciliation checks pass', async () => {
    const { ctx } = await demoDb()
    const integrity = integrityReport(ctx)
    expect(integrity.checks.filter((c) => !c.ok)).toEqual([])
    const { from, to } = { from: '2026-04-01', to: '2026-11-14' }
    const d = FS.financeDashboard(ctx, from, to)
    const pl = FS.profitAndLoss(ctx, from, to)
    expect(d.kpis.netProfitPaise).toBe(pl.netProfitPaise)
    expect(d.kpis.incomePaise - d.kpis.expensesPaise).toBe(d.kpis.netProfitPaise)
    const ledger = (key: string) => (ctx.db.prepare(`SELECT COALESCE(SUM(l.debit_paise - l.credit_paise),0) b FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id WHERE a.company_id = ? AND a.system_key = ? AND je.entry_date <= ?`).get(ctx.companyId, key, to) as { b: number }).b
    expect(d.kpis.receivablesPaise).toBe(ledger('AR'))
    expect(d.kpis.payablesPaise).toBe(-ledger('AP'))
    expect(d.kpis.cashPaise).toBe(ledger('CASH'))
    expect(d.kpis.overdueReceivablesCount).toBeGreaterThan(0)
    expect(d.checks).toEqual({ trialBalanceBalanced: true, balanceSheetBalanced: true })
    expect(d.monthly.length).toBeGreaterThan(0)
    expect(d.monthly.reduce((s, m) => s + m.netPaise, 0)).toBe(pl.netProfitPaise)
    expect(d.recent.length).toBeGreaterThan(0)
    // Demo reconciliations: one completed, one in progress with a bank-only charge still to record.
    const recs = BR.listReconciliations(ctx)
    expect(recs.map((r) => r.status).sort()).toEqual(['COMPLETED', 'IN_PROGRESS'])
    const open = BR.getReconciliation(ctx, recs.find((r) => r.status === 'IN_PROGRESS')!.id)
    expect(open.summary.unmatchedStatementLines).toBe(1)
  })
})

export type { Fixture }
