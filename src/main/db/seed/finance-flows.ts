/**
 * DEMO scenario, Phase 3 — operating expenses, contra entries, a bank loan,
 * interest, manual adjustments and bank reconciliations. Everything goes through
 * the real voucher and reconciliation services, so the books stay balanced.
 */
import { toPaise } from '@shared/money'
import type { ServiceContext } from '../../services/context'
import { AppError } from '../../services/errors'
import { createVoucher } from '../../services/finance/vouchers'
import * as BR from '../../services/finance/bankrec'

export interface FinanceFlowDeps {
  ctx: ServiceContext
  todayIso: string
  fyStart: string
  plusDays: (iso: string, n: number) => string
  bankId: number
  cashId: number
  customerId: (code: string) => number
}

export function financeFlows(f: FinanceFlowDeps): void {
  const { ctx, todayIso, plusDays, bankId, cashId } = f
  const db = ctx.db
  const day = (n: number) => {
    const x = plusDays(todayIso, -n)
    return x < f.fyStart ? f.fyStart : x
  }
  const acc = (code: string) => (db.prepare('SELECT id FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(ctx.companyId, code) as { id: number }).id
  const pay = (date: string, expense: string, amount: number, narration: string, from = bankId, ref: string | null = null) =>
    createVoucher(ctx, { type: 'JOURNAL', date, narration, referenceNo: ref, lines: [{ accountId: acc(expense), debitPaise: amount }, { accountId: from, creditPaise: amount }] })

  // Term loan received and equipment bought for the office.
  createVoucher(ctx, { type: 'JOURNAL', date: day(110), narration: 'Term loan disbursed by the bank', referenceNo: 'LN/2026/0419', lines: [{ accountId: bankId, debitPaise: toPaise(500000) }, { accountId: acc('2500'), creditPaise: toPaise(500000) }] })
  pay(day(105), '1600', toPaise(185000), 'Office server and networking equipment (fixed asset)', bankId, 'INV-SRV-0091')
  pay(day(100), '1610', toPaise(64000), 'Office workstations and storage (fixed asset)', bankId, 'CFC/2026/551')

  // Monthly operating expenses for the last three months.
  for (const [n, month] of [[95, 'Aug'], [65, 'Sep'], [35, 'Oct']] as const) {
    pay(day(n), '6200', toPaise(45000), `Office rent for ${month}`, bankId, `RENT-${month.toUpperCase()}`)
    pay(day(n - 1), '6100', toPaise(168000), `Staff salaries for ${month}`, bankId, `SAL-${month.toUpperCase()}`)
    pay(day(n - 3), '6300', toPaise(7850 + n * 10), `Electricity and internet for ${month}`, cashId)
    pay(day(n - 4), '6900', toPaise(4150), `Interest on term loan for ${month}`, bankId)
    pay(day(n - 5), '5700', toPaise(12500), `Installation technicians (contract labour) for ${month}`, bankId)
  }
  pay(day(40), '6500', toPaise(22000), 'Trade fair stall and brochures', bankId, 'EXPO-2611')
  pay(day(25), '6700', toPaise(6400), 'Sales team travel to Coimbatore', cashId)
  pay(day(20), '6600', toPaise(3800), 'Courier and local delivery charges', cashId)
  pay(day(15), '6400', toPaise(5200), 'Printing and stationery', cashId)
  pay(day(12), '6800', toPaise(590), 'Bank charges for NEFT/RTGS', bankId)

  // Contra: cash deposited to bank; petty cash withdrawn.
  createVoucher(ctx, { type: 'CONTRA', date: day(30), narration: 'Cash sales deposited into current account', referenceNo: 'DEP-3011', lines: [{ accountId: bankId, debitPaise: toPaise(40000) }, { accountId: cashId, creditPaise: toPaise(40000) }] })
  createVoucher(ctx, { type: 'CONTRA', date: day(9), narration: 'Petty cash withdrawn from bank', referenceNo: 'CHQ-000418', lines: [{ accountId: cashId, debitPaise: toPaise(15000) }, { accountId: bankId, creditPaise: toPaise(15000) }] })

  // Interest earned on the current account balance.
  createVoucher(ctx, { type: 'JOURNAL', date: day(31), narration: 'Interest credited by bank (quarterly)', lines: [{ accountId: bankId, debitPaise: toPaise(2140) }, { accountId: acc('4510'), creditPaise: toPaise(2140) }] })

  // Manual adjustments an auditor would review: a salary provision (large, round) and a customer balance write-off.
  createVoucher(ctx, { type: 'JOURNAL', date: day(4), narration: 'Provision for staff bonus payable', lines: [{ accountId: acc('6100'), debitPaise: toPaise(100000) }, { accountId: acc('2600'), creditPaise: toPaise(100000) }] })
  createVoucher(ctx, {
    type: 'JOURNAL', date: day(3), narration: 'Short payment written off as discount allowed', referenceNo: 'WO/2026/07',
    lines: [{ accountId: acc('6400'), debitPaise: toPaise(350) }, { accountId: acc('1300'), creditPaise: toPaise(350), partyType: 'CUSTOMER', partyId: f.customerId('C003') }]
  })
  // A data-entry slip: rejected because debits ≠ credits (recorded in the audit log, nothing posted).
  try {
    createVoucher(ctx, { type: 'JOURNAL', date: day(2), narration: 'Advertising accrual', lines: [{ accountId: acc('6500'), debitPaise: toPaise(12000) }, { accountId: acc('2600'), creditPaise: toPaise(1200) }] })
  } catch (e) {
    if (!(e instanceof AppError)) throw e
  }

  // Bank reconciliation of the current account up to the end of last month (completed) …
  const lastMonthEnd = new Date(Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, 0)).toISOString().slice(0, 10)
  if (lastMonthEnd >= f.fyStart) {
    let rec = BR.createReconciliation(ctx, { accountId: bankId, statementDate: lastMonthEnd, statementBalancePaise: 0, notes: 'Monthly reconciliation' })
    // Every book entry cleared except the last two withdrawals (cheques not yet presented).
    const pending = new Set(rec.unclearedWithdrawals.slice(-2).map((b) => b.journalLineId))
    for (const b of [...rec.unclearedDeposits, ...rec.unclearedWithdrawals]) {
      if (pending.has(b.journalLineId)) continue
      BR.tickBookLine(ctx, { id: rec.id, journalLineId: b.journalLineId, clearedDate: b.date })
    }
    rec = BR.getReconciliation(ctx, rec.id)
    BR.updateReconciliation(ctx, { id: rec.id, statementDate: lastMonthEnd, statementBalancePaise: rec.summary.adjustedBookBalancePaise, notes: 'Monthly reconciliation' })
    BR.completeReconciliation(ctx, rec.id)
  }

  // … and the current month in progress: a pasted statement, auto-matched, with one bank-only charge left to record.
  const current = BR.createReconciliation(ctx, { accountId: bankId, statementDate: day(1), statementBalancePaise: 0, notes: 'Statement downloaded from net banking' })
  const sample = [...current.unclearedDeposits, ...current.unclearedWithdrawals].filter((b) => b.date > lastMonthEnd).slice(0, 4)
  const csv = [
    'Date,Description,Reference,Deposit,Withdrawal',
    ...sample.map((b) => `${b.date},${b.particulars.replace(/,/g, ' ')},${b.voucherNo ?? ''},${b.direction === 'DEPOSIT' ? (b.amountPaise / 100).toFixed(2) : ''},${b.direction === 'WITHDRAWAL' ? (b.amountPaise / 100).toFixed(2) : ''}`),
    `${day(2)},SMS ALERT CHARGES Q3,,,${(1770 / 100).toFixed(2)}`
  ].join('\n')
  BR.addStatementLines(ctx, { id: current.id, csv })
  const matched = BR.autoMatch(ctx, current.id).detail
  // Closing balance printed on that statement: books adjusted for items not yet through the bank, plus the bank-only charge.
  const s = matched.summary
  BR.updateReconciliation(ctx, { id: current.id, statementDate: matched.statementDate, statementBalancePaise: s.adjustedBookBalancePaise + s.unmatchedStatementDepositsPaise - s.unmatchedStatementWithdrawalsPaise, notes: 'Statement downloaded from net banking' })
}
