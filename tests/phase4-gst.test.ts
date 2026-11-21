/**
 * Phase 4 — GST configuration, classification, registers, GSTR-1 / GSTR-3B preparation,
 * ITC classification, validation and GST reconciliation. Exact figures from the p4Fixture.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { buildGstin } from '@shared/india'
import { classifyNote, classifyOutward, HsnRateSaveInput, ItcClassifyInput, HsnSaveInput, minHsnDigits, RegistrationSaveInput, invalidDocumentNumber, type RuleSet } from '@shared/gst'
import { openDatabase } from '../src/main/db/connection'
import { currentSchemaVersion, migrate } from '../src/main/db/migrator'
import { MIGRATIONS } from '../src/main/db/migrations'
import { createCompany } from '../src/main/services/company'
import { createCustomer } from '../src/main/services/parties'
import { createProduct, getLookups } from '../src/main/services/products'
import { postOpeningFunds } from '../src/main/services/posting'
import { postDocument, saveDraft, cancelDocument } from '../src/main/services/documents/engine'
import { CustomerInput, ProductInput } from '@shared/schemas'
import { DocumentSaveInput } from '@shared/documents'
import { toMilli } from '@shared/money'
import { listRegistrations, rateRuleAt, rulesAt, saveHsnRate, saveRegistration, saveRule } from '../src/main/services/gst/config'
import { purchaseRegister, salesRegister } from '../src/main/services/gst/registers'
import { getPreparation, gstr1, gstr3b, listPreparations, markExported, prepareReturn, preparationJson, validateGst } from '../src/main/services/gst/returns'
import { classifyItc } from '../src/main/services/gst/itc'
import { importRecon, parseReconCsv, reconDetail, reviewRecon } from '../src/main/services/gst/recon'
import { integrityReport } from '../src/main/services/finance/audit-checks'
import { p4Fixture, R, COMPANY_GSTIN, type P4 } from './phase4-fixtures'

let f: P4
beforeAll(() => {
  f = p4Fixture()
})

const RULES = (over: Partial<RuleSet> = {}): RuleSet => ({
  B2CL_INVOICE_THRESHOLD_PAISE: R(100000), EINVOICE_AATO_THRESHOLD_PAISE: R(50000000), EINVOICE_REPORTING_LIMIT_DAYS: 30, EINVOICE_REPORTING_LIMIT_AATO_PAISE: R(100000000),
  IRN_CANCEL_WINDOW_HOURS: 24, EWB_CONSIGNMENT_THRESHOLD_PAISE: R(50000), EWB_KM_PER_DAY_REGULAR: 200, EWB_KM_PER_DAY_ODC: 20, EWB_CANCEL_WINDOW_HOURS: 24,
  EWB_EXTENSION_WINDOW_HOURS: 8, EWB_MAX_DISTANCE_KM: 4000, HSN_MIN_DIGITS_SMALL: 4, HSN_MIN_DIGITS_LARGE: 6, HSN_LARGE_AATO_PAISE: R(50000000), GST_RECON_TOLERANCE_PAISE: 100, ...over
})

describe('GST registration and configuration', () => {
  it('validates GSTIN format, check digit, state and PAN of a registration', () => {
    const base = { gstin: buildGstin('29', 'AAACT4321Q'), registrationType: 'REGULAR', stateCode: '29', legalName: null, tradeName: null, address: null, pincode: null, effectiveFrom: '2026-04-01', isPrimary: false }
    expect(RegistrationSaveInput.safeParse(base).success).toBe(true)
    expect(RegistrationSaveInput.safeParse({ ...base, gstin: base.gstin.slice(0, 14) + (base.gstin[14] === 'A' ? 'B' : 'A') }).success).toBe(false) // check digit
    expect(RegistrationSaveInput.safeParse({ ...base, stateCode: '33' }).success).toBe(false) // state ≠ GSTIN state
    expect(RegistrationSaveInput.safeParse({ ...base, effectiveTo: '2026-01-01' }).success).toBe(false)
    // A second registration of the company must carry the same PAN.
    expect(() => saveRegistration(f.ctx, RegistrationSaveInput.parse({ ...base, gstin: buildGstin('29', 'AABCZ9999Q') }))).toThrow(/PAN/)
    const regs = saveRegistration(f.ctx, RegistrationSaveInput.parse(base))
    expect(regs.map((r) => r.gstin).sort()).toEqual([COMPANY_GSTIN, base.gstin].sort())
    expect(regs.filter((r) => r.isPrimary).map((r) => r.gstin)).toEqual([COMPANY_GSTIN]) // backfilled at company creation
    // Making the new one primary demotes the old one (one primary per company).
    saveRegistration(f.ctx, RegistrationSaveInput.parse({ ...base, id: regs.find((r) => r.gstin === base.gstin)!.id, isPrimary: true }))
    expect(listRegistrations(f.ctx).filter((r) => r.isPrimary).map((r) => r.gstin)).toEqual([base.gstin])
    saveRegistration(f.ctx, RegistrationSaveInput.parse({ ...base, id: listRegistrations(f.ctx).find((r) => r.gstin === COMPANY_GSTIN)!.id, gstin: COMPANY_GSTIN, stateCode: '33', isPrimary: true }))
    expect(listRegistrations(f.ctx).find((r) => r.isPrimary)!.gstin).toBe(COMPANY_GSTIN)
  })

  it('applies effective-dated HSN rates (a new rate closes the old period; overlaps are rejected)', () => {
    const g = p4Fixture({ withDocs: false })
    expect(rateRuleAt(g.ctx, '84713010', '2026-10-01')!.rateBps).toBe(1800)
    saveHsnRate(g.ctx, HsnRateSaveInput.parse({ hsnCode: '84713010', effectiveFrom: '2026-12-01', taxCategory: 'TAXABLE', rateBps: 500, notes: 'test change' }))
    expect(rateRuleAt(g.ctx, '84713010', '2026-11-30')!.rateBps).toBe(1800)
    expect(rateRuleAt(g.ctx, '84713010', '2026-12-01')!.rateBps).toBe(500)
    expect(rateRuleAt(g.ctx, '84713010', '2026-11-30')!.effectiveTo).toBe('2026-11-30')
    expect(() => saveHsnRate(g.ctx, HsnRateSaveInput.parse({ hsnCode: '84713010', effectiveFrom: '2026-06-01', effectiveTo: '2026-12-15', taxCategory: 'TAXABLE', rateBps: 1200 }))).toThrow(/overlap/)
    // Prefix match: a rule for a 4-digit heading covers longer codes; the most specific rule wins.
    expect(() => saveHsnRate(g.ctx, HsnRateSaveInput.parse({ hsnCode: '8471', effectiveFrom: '2017-07-01', taxCategory: 'TAXABLE', rateBps: 1200 }))).toThrow(/master/)
    // Non-taxable categories carry 0%.
    expect(HsnRateSaveInput.safeParse({ hsnCode: '49011010', effectiveFrom: '2017-07-01', taxCategory: 'EXEMPT', rateBps: 500 }).success).toBe(false)
  })

  it('validates HSN / SAC codes and the minimum digits for the turnover', () => {
    expect(HsnSaveInput.safeParse({ code: '998313', description: 'IT consulting', kind: 'SERVICE', defaultUqc: null }).success).toBe(true)
    expect(HsnSaveInput.safeParse({ code: '848310', description: 'x', kind: 'SERVICE', defaultUqc: null }).success).toBe(false) // SAC must start 99
    expect(HsnSaveInput.safeParse({ code: '991', description: 'x', kind: 'SERVICE', defaultUqc: null }).success).toBe(false) // too short
    expect(HsnSaveInput.safeParse({ code: '998313', description: 'x', kind: 'GOODS', defaultUqc: null }).success).toBe(false)
    expect(minHsnDigits(RULES(), R(40000000))).toBe(4)
    expect(minHsnDigits(RULES(), R(60000000))).toBe(6)
    expect(minHsnDigits(RULES(), null)).toBe(4)
  })

  it('uses effective-dated compliance rules, with company rules overriding defaults', () => {
    const g = p4Fixture({ withDocs: false })
    expect(rulesAt(g.ctx, '2024-07-31').B2CL_INVOICE_THRESHOLD_PAISE).toBe(R(250000))
    expect(rulesAt(g.ctx, '2024-08-01').B2CL_INVOICE_THRESHOLD_PAISE).toBe(R(100000))
    expect(rulesAt(g.ctx, '2020-12-31').EWB_KM_PER_DAY_REGULAR).toBe(100)
    expect(rulesAt(g.ctx, '2021-01-01').EWB_KM_PER_DAY_REGULAR).toBe(200)
    saveRule(g.ctx, { ruleKey: 'EWB_CONSIGNMENT_THRESHOLD_PAISE', valueNum: R(100000), effectiveFrom: '2026-01-01', effectiveTo: null, sourceNote: 'State limit (test)' })
    expect(rulesAt(g.ctx, '2026-06-01').EWB_CONSIGNMENT_THRESHOLD_PAISE).toBe(R(100000))
    expect(rulesAt(g.ctx, '2025-06-01').EWB_CONSIGNMENT_THRESHOLD_PAISE).toBe(R(50000))
    expect(() => saveRule(g.ctx, { ruleKey: 'EWB_CONSIGNMENT_THRESHOLD_PAISE', valueNum: 1, effectiveFrom: '2026-03-01', effectiveTo: null, sourceNote: null })).toThrow(/overlaps/)
  })
})

describe('outward classification', () => {
  const base = { partyRegType: 'REGULAR', partyGstin: '33AABCA1234F1Z5', interState: false, invoiceValuePaise: R(500000), igstPaise: 0, b2clThresholdPaise: R(100000) }
  it('classifies B2B, B2C Large / Small, exports and SEZ supplies', () => {
    expect(classifyOutward(base)).toBe('B2B')
    expect(classifyOutward({ ...base, partyRegType: 'COMPOSITION' })).toBe('B2B')
    expect(classifyOutward({ ...base, partyRegType: 'CONSUMER', partyGstin: null, interState: true })).toBe('B2CL')
    expect(classifyOutward({ ...base, partyRegType: 'CONSUMER', partyGstin: null, interState: true, invoiceValuePaise: R(100000) })).toBe('B2CS') // not above the limit
    expect(classifyOutward({ ...base, partyRegType: 'UNREGISTERED', partyGstin: null, interState: false })).toBe('B2CS') // intra-state is always B2CS
    expect(classifyOutward({ ...base, partyRegType: 'CONSUMER', partyGstin: null, interState: true, invoiceValuePaise: R(200000), b2clThresholdPaise: R(250000) })).toBe('B2CS') // earlier ₹2.5 lakh rule
    expect(classifyOutward({ ...base, partyRegType: 'OVERSEAS', partyGstin: null, igstPaise: 100 })).toBe('EXPWP')
    expect(classifyOutward({ ...base, partyRegType: 'OVERSEAS', partyGstin: null })).toBe('EXPWOP')
    expect(classifyOutward({ ...base, partyRegType: 'SEZ', igstPaise: 100 })).toBe('SEZWP')
    expect(classifyOutward({ ...base, partyRegType: 'SEZ' })).toBe('SEZWOP')
  })
  it('classifies credit notes (CDNR / CDNUR / B2CS adjustment)', () => {
    expect(classifyNote('B2B', base)).toBe('CDNR')
    expect(classifyNote('SEZWP', { ...base, partyRegType: 'SEZ' })).toBe('CDNR')
    expect(classifyNote('EXPWOP', { ...base, partyRegType: 'OVERSEAS', partyGstin: null })).toBe('CDNUR')
    expect(classifyNote('B2CL', { ...base, partyRegType: 'CONSUMER', partyGstin: null, interState: true })).toBe('CDNUR')
    expect(classifyNote('B2CS', { ...base, partyRegType: 'CONSUMER', partyGstin: null, invoiceValuePaise: R(2360) })).toBe('B2CS_ADJ')
  })
  it('checks GST document numbers', () => {
    expect(invalidDocumentNumber('INV/2026-27/0001')).toBeNull()
    expect(invalidDocumentNumber('INV/2026-27/00001')).toMatch(/16/)
    expect(invalidDocumentNumber('0INV1')).toMatch(/start/)
    expect(invalidDocumentNumber('INV 1')).toMatch(/letters/)
  })
})

describe('GST registers agree with posted documents and the GST ledgers', () => {
  it('sales register: sections, credit notes, nil/exempt and ledger agreement', () => {
    const r = salesRegister(f.ctx, { from: '2026-10-01', to: '2026-10-31', status: 'POSTED' })
    const sec = (k: string) => r.docs.filter((d) => d.section === k).map((d) => d.number)
    expect(sec('B2B')).toHaveLength(3)
    expect(sec('B2CL')).toEqual([f.inv.F.number])
    expect(sec('B2CS')).toEqual([f.inv.G.number])
    expect(sec('SEZWP')).toEqual([f.inv.C.number])
    expect(sec('SEZWOP')).toEqual([f.inv.D.number])
    expect(sec('EXPWOP')).toEqual([f.inv.E.number])
    expect(sec('CDNR')).toEqual([f.cn.CN1.number])
    expect(sec('B2CS_ADJ')).toEqual([f.cn.CN2.number])
    expect(r.docs.find((d) => d.number === f.inv.H.number)!.exemptPaise).toBe(R(4500))
    expect(r.docs.find((d) => d.number === f.cn.CN1.number)!.originalNo).toBe(f.inv.B.number)
    // Totals (taxable / exempt lines excluded from taxable): 2000+10000+2000+4000+6000+120000+2000+1000 − 2000 − 1000
    expect(r.totals.taxablePaise).toBe(R(144000))
    expect(r.totals.igstPaise).toBe(R(1800 + 360 + 21600 + 360 - 360 - 180))
    expect(r.totals.cgstPaise).toBe(R(270))
    expect(r.ledger).toMatchObject({ agrees: true, igstPaise: R(23580), cgstPaise: R(270), sgstPaise: R(270) })
    // HSN summary nets credit notes.
    const hsn = (code: string, rate: number) => r.hsn.find((h) => h.hsn === code && h.ratePct === rate)!
    expect(hsn('84713010', 18)).toMatchObject({ qtyMilli: toMilli(3), taxablePaise: R(3000), cgstPaise: R(270), sgstPaise: R(270) })
    expect(hsn('998313', 18).taxablePaise).toBe(R(131000))
    expect(hsn('998313', 0).taxablePaise).toBe(R(10000))
    expect(hsn('49011010', 0).taxablePaise).toBe(R(4500))
    // Drill-down routes open the original documents.
    expect(r.docs.find((d) => d.number === f.inv.A.number)!.route).toBe(`/sales/invoices/${f.inv.A.id}`)
  })

  it('purchase register: ITC classification, reverse charge, debit notes and ledger agreement', () => {
    const r = purchaseRegister(f.ctx, { from: '2026-10-01', to: '2026-10-31', status: 'POSTED' })
    const doc = (id: number, kind = 'PURCHASE_INVOICE') => r.docs.find((d) => d.id === id && d.kind === kind)!
    expect(doc(f.pur.P1.id).itc.eligibility).toBe('ELIGIBLE')
    expect(doc(f.pur.P2.id).itc.eligibility).toBe('PENDING') // never assumed eligible
    expect(doc(f.pur.P3.id).itc).toMatchObject({ eligibility: 'INELIGIBLE', reason: 'Used for exempt supplies' })
    expect(doc(f.pur.P4.id)).toMatchObject({ rcmSuggested: true, rcmTaxPaise: R(1800), cgstPaise: R(900), sgstPaise: R(900) })
    expect(doc(f.pur.P4.id).itc).toMatchObject({ eligibility: 'ELIGIBLE', reverseCharge: true })
    const dn = doc(f.pur.DN1.id, 'DEBIT_NOTE')
    expect(dn).toMatchObject({ sign: -1, taxablePaise: R(100), cgstPaise: R(9), originalNo: f.pur.P1.number })
    expect(dn.itc.eligibility).toBe('ELIGIBLE') // inherited from the bill
    expect(dn.itc.stored).toBe(false)
    expect(doc(f.pur.P1.id).supplierRef).toBe('V1/101')
    expect(r.rcm.count).toBe(1)
    // Ledger holds tax charged by suppliers (self-assessed RCM tax is not posted).
    expect(r.ledger).toMatchObject({ agrees: true, cgstPaise: R(270 + 90 - 9), sgstPaise: R(270 + 90 - 9), igstPaise: R(75) })
    expect(purchaseRegister(f.ctx, { from: '2026-10-01', to: '2026-10-31', status: 'POSTED', category: 'PENDING' }).docs.map((d) => d.id)).toEqual([f.pur.P2.id])
  })

  it('excludes drafts, separates cancelled documents and filters by GSTIN', () => {
    const g = p4Fixture({ withDocs: false })
    const draft = saveDraft(g.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: g.c.b2bIntra, date: '2026-10-15', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(2000) }] }))
    const posted = postDocument(g.ctx, 'SALES_INVOICE', saveDraft(g.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: g.c.b2bIntra, date: '2026-10-16', lines: [{ productId: g.p.service, qtyMilli: toMilli(2), ratePaise: R(2000) }] })).id)
    cancelDocument(g.ctx, 'SALES_INVOICE', posted.id, 'Wrong customer')
    const reg = (status: 'POSTED' | 'CANCELLED' | 'ALL') => salesRegister(g.ctx, { from: '2026-10-01', to: '2026-10-31', status })
    expect(reg('POSTED').docs).toHaveLength(0)
    expect(reg('CANCELLED').docs.map((d) => d.id)).toEqual([posted.id])
    expect(reg('ALL').docs.map((d) => d.id)).not.toContain(draft.id)
    // The cancelled invoice and its reversal both sit in the ledger; the register still agrees (reversals excluded on both sides).
    expect(reg('POSTED').ledger.agrees).toBe(true)
    expect(gstr1(g.ctx, '2026-10').docs).toEqual([{ nature: 'Invoices for outward supply', from: posted.number, to: posted.number, total: 1, cancelled: 1 }])
    expect(salesRegister(f.ctx, { from: '2026-10-01', to: '2026-10-31', gstin: '29ZZZZZ0000Z1Z5' }).docs).toHaveLength(0)
    expect(salesRegister(f.ctx, { from: '2026-10-01', to: '2026-10-31', gstin: COMPANY_GSTIN }).docs.length).toBe(10)
  })
})

describe('GSTR-1 preparation', () => {
  it('builds every table from the period’s documents', () => {
    const g1 = gstr1(f.ctx, '2026-10')
    expect(g1.gstin).toBe(COMPANY_GSTIN)
    expect(g1.b2b.map((r) => [r.number, r.taxablePaise])).toEqual([[f.inv.A.number, R(2000)], [f.inv.B.number, R(10000)], [f.inv.H.number, R(1000)]])
    expect(g1.b2b.find((r) => r.number === f.inv.B.number)).toMatchObject({ pos: '29', igstPaise: R(1800), gstin: buildGstin('29', 'AABCB1234F') })
    expect(g1.b2cl).toEqual([{ number: f.inv.F.number, date: '2026-10-11', valuePaise: R(141600), pos: '29', ratePct: 18, taxablePaise: R(120000), igstPaise: R(21600), cessPaise: 0 }])
    expect(g1.b2cs).toEqual([{ pos: '29', supplyType: 'INTER', ratePct: 18, taxablePaise: R(1000), igstPaise: R(180), cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }]) // 2,000 − credit 1,000
    expect(g1.exp).toEqual([{ type: 'WOPAY', number: f.inv.E.number, date: '2026-10-10', valuePaise: R(6000), ratePct: 0, taxablePaise: R(6000), igstPaise: 0 }])
    expect(g1.sez.map((r) => [r.type, r.taxablePaise, r.igstPaise])).toEqual([['SEZWP', R(2000), R(360)], ['SEZWOP', R(4000), 0]])
    expect(g1.cdnr).toEqual([expect.objectContaining({ noteNo: f.cn.CN1.number, noteType: 'C', originalNo: f.inv.B.number, taxablePaise: R(2000), igstPaise: R(360) })])
    expect(g1.cdnur).toEqual([])
    expect(g1.nil.find((n) => n.description.startsWith('Intra-state supplies to registered'))).toMatchObject({ exemptPaise: R(4500), nilPaise: 0 })
    expect(g1.docs).toEqual([
      { nature: 'Invoices for outward supply', from: f.inv.A.number, to: f.inv.H.number, total: 8, cancelled: 0 },
      { nature: 'Credit notes', from: f.cn.CN1.number, to: f.cn.CN2.number, total: 2, cancelled: 0 }
    ])
    expect(g1.outwardDebitNotes).toBe('NOT_SUPPORTED')
    const s = (k: string) => g1.sections.find((x) => x.key === k)!
    expect([s('b2b').count, s('b2cl').count, s('exp').count, s('sez').count, s('cdnr').count]).toEqual([3, 1, 1, 2, 1])
    expect(s('cdnr').taxablePaise).toBe(-R(2000))
  })
})

describe('GSTR-3B preparation and ITC', () => {
  it('computes liability, reverse charge and only classified ITC', () => {
    const g3 = gstr3b(f.ctx, '2026-10')
    const row = (k: string) => (g3.outward.find((r) => r.key === k) ?? g3.itc.find((r) => r.key === k))!
    expect(row('3.1a')).toMatchObject({ taxablePaise: R(132000), igstPaise: R(23220), cgstPaise: R(270), sgstPaise: R(270) })
    expect(row('3.1b')).toMatchObject({ taxablePaise: R(12000), igstPaise: R(360) })
    expect(row('3.1c').taxablePaise).toBe(R(4500))
    expect(row('3.1d')).toMatchObject({ taxablePaise: R(10000), cgstPaise: R(900), sgstPaise: R(900), igstPaise: 0 })
    expect(row('4A3')).toMatchObject({ cgstPaise: R(900), sgstPaise: R(900) })
    expect(row('4A5')).toMatchObject({ cgstPaise: R(351), sgstPaise: R(351), igstPaise: 0 }) // P1 270 − DN 9 + ineligible P3 90
    expect(row('4B1')).toMatchObject({ cgstPaise: R(90), sgstPaise: R(90) })
    expect(row('4C')).toMatchObject({ cgstPaise: R(1161), sgstPaise: R(1161), igstPaise: 0 })
    expect(g3.itcPending).toEqual({ count: 1, igstPaise: R(75), cgstPaise: 0, sgstPaise: 0 }) // P2 excluded until classified
    expect(g3.interStateUnregistered).toEqual([{ pos: '29', taxablePaise: R(121000), igstPaise: R(21780) }])
    expect(g3.indicativeNet.find((x) => x.head === 'CGST')).toEqual({ head: 'CGST', liabilityPaise: R(1170), itcPaise: R(1161), netPaise: R(9) })
    expect(g3.indicativeNet.find((x) => x.head === 'IGST')!.liabilityPaise).toBe(R(23580))
  })

  it('never assumes credit: unregistered suppliers have none unless under RCM; reasons are required', () => {
    expect(() => classifyItc(f.ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: f.pur.P4.id }], eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null })).toThrow(/unregistered/)
    const g = p4Fixture({ withDocs: false })
    const reg = purchaseRegister(g.ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(reg.docs).toEqual([])
    expect(ItcClassifyInput.safeParse({ documents: [{ kind: 'PURCHASE_INVOICE', id: 1 }], eligibility: 'BLOCKED', itcType: 'INPUTS', reverseCharge: false, reason: null }).success).toBe(false)
    expect(ItcClassifyInput.safeParse({ documents: [{ kind: 'PURCHASE_INVOICE', id: 1 }], eligibility: 'BLOCKED', itcType: 'INPUTS', reverseCharge: false, reason: 'Motor car (s.17(5))' }).success).toBe(true)
  })

  it('moves ITC between pending and eligible when classified, and it shows in GSTR-3B', () => {
    const g = p4Fixture()
    expect(gstr3b(g.ctx, '2026-10').itcPending.count).toBe(1)
    classifyItc(g.ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: g.pur.P2.id }], eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null })
    const g3 = gstr3b(g.ctx, '2026-10')
    expect(g3.itcPending.count).toBe(0)
    expect(g3.itc.find((r) => r.key === '4C')!.igstPaise).toBe(R(75))
  })
})

describe('GST validation report', () => {
  it('passes the fixture without errors and reports pending ITC as a warning', () => {
    const v = validateGst(f.ctx, '2026-10-01', '2026-10-31')
    expect(v.issues.filter((i) => i.severity === 'ERROR')).toEqual([])
    expect(v.issues.some((i) => i.category === 'ITC_REVIEW' && i.number === f.pur.P2.number)).toBe(true)
    expect(v.checkedDocuments).toBe(15)
  })

  it('detects missing GSTIN, short HSN, wrong rate, tax differences, duplicate references and missing LUT', () => {
    const g = p4Fixture({ withDocs: false, aatoCrore: 6 })
    const L = getLookups(g.ctx)
    const short = createProduct(g.ctx, ProductInput.parse({ code: 'SHORT', name: 'Short HSN item', description: null, itemType: 'GOODS', categoryId: null, unitId: L.units[0].id, hsnSac: '8471', taxRateId: L.taxRates.find((t) => t.rateBps === 1800)!.id, salePricePaise: R(100), purchasePricePaise: R(50), mrpPaise: null, reorderLevelMilli: 0, trackInventory: false })).id
    const post = (input: Parameters<typeof DocumentSaveInput.parse>[0]) => postDocument(g.ctx, 'SALES_INVOICE', saveDraft(g.ctx, DocumentSaveInput.parse(input)).id)
    post({ kind: 'SALES_INVOICE', partyId: g.c.b2bIntra, date: '2026-10-05', lines: [{ productId: short, qtyMilli: toMilli(1), ratePaise: R(100) }] })
    post({ kind: 'SALES_INVOICE', partyId: g.c.b2bIntra, date: '2026-10-06', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(1000), taxRateBps: 500 }] })
    // Zero-rated without IGST but the LUT has lapsed for this date.
    g.db.prepare(`UPDATE gst_company_settings SET lut_valid_from = '2026-11-01' WHERE company_id = ?`).run(g.ctx.companyId)
    post({ kind: 'SALES_INVOICE', partyId: g.c.sez, date: '2026-10-07', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(1000), taxRateBps: 0 }] })
    // Duplicate supplier invoice number entered for two different suppliers with the same value (flag for review).
    const bill = (partyId: number, ref: string) => postDocument(g.ctx, 'PURCHASE_INVOICE', saveDraft(g.ctx, DocumentSaveInput.parse({ kind: 'PURCHASE_INVOICE', partyId, date: '2026-10-08', supplierRef: ref, supplierRefDate: '2026-10-08', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(500) }] })).id)
    bill(g.s.vendor, 'DUP-1')
    bill(g.s.vendorOut, 'DUP-1')
    const v = validateGst(g.ctx, '2026-10-01', '2026-10-31')
    const cats = (cat: string) => v.issues.filter((i) => i.category === cat).map((i) => i.message)
    expect(cats('MISSING_HSN').some((m) => /4 digits; at least 6/.test(m))).toBe(true)
    expect(cats('CLASSIFICATION').some((m) => /5% charged, but HSN 998313 is 18%/.test(m))).toBe(true)
    expect(cats('MISSING_INFO').some((m) => /LUT/.test(m))).toBe(true)
    expect(cats('DUPLICATE_REFERENCE').some((m) => /Same supplier invoice number and value/.test(m))).toBe(true)
    expect(cats('ITC_REVIEW')).toHaveLength(2)
    expect(v.errors).toBeGreaterThanOrEqual(3)
    // Tax recomputation catches a stored tax that does not match taxable × rate (simulated on a draft-free copy).
    const tampered = p4Fixture({ withDocs: false })
    const inv = postDocument(tampered.ctx, 'SALES_INVOICE', saveDraft(tampered.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: tampered.c.b2bIntra, date: '2026-10-05', lines: [{ productId: tampered.p.service, qtyMilli: toMilli(1), ratePaise: R(1000) }] })).id)
    tampered.db.exec('DROP TRIGGER trg_sii_upd_guard')
    tampered.db.prepare('UPDATE sales_invoice_items SET cgst_paise = cgst_paise + 500 WHERE invoice_id = ?').run(inv.id)
    expect(validateGst(tampered.ctx, '2026-10-01', '2026-10-31').issues.some((i) => i.category === 'TAX_DIFFERENCE' && i.number === inv.number)).toBe(true)
  })

  it('flags a registered customer without GSTIN and a credit note without an original invoice', () => {
    const g = p4Fixture({ withDocs: false })
    const reg = createCustomer(g.ctx, CustomerInput.parse({ code: 'NOG', name: 'Registered, GSTIN missing', partyType: 'BUSINESS', gstRegistrationType: 'UNREGISTERED', gstin: null, pan: null, contactPerson: null, phone: null, email: null, addressLine1: 'x', addressLine2: null, city: 'x', stateCode: '33', pincode: '600001', shippingAddressLine1: null, shippingAddressLine2: null, shippingCity: null, shippingStateCode: null, shippingPincode: null, creditLimitPaise: 0, creditDays: 0, openingBalancePaise: 0 })).id
    g.db.prepare(`UPDATE customers SET gst_registration_type = 'REGULAR' WHERE id = ?`).run(reg)
    postDocument(g.ctx, 'SALES_INVOICE', saveDraft(g.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: reg, date: '2026-10-05', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(1000) }] })).id)
    postDocument(g.ctx, 'CREDIT_NOTE', saveDraft(g.ctx, DocumentSaveInput.parse({ kind: 'CREDIT_NOTE', partyId: g.c.b2bIntra, date: '2026-10-06', reason: 'Goodwill', lines: [{ productId: g.p.service, qtyMilli: toMilli(1), ratePaise: R(100) }] })).id)
    const v = validateGst(g.ctx, '2026-10-01', '2026-10-31')
    expect(v.issues.some((i) => i.category === 'MISSING_GSTIN' && /no buyer GSTIN/.test(i.message))).toBe(true)
    expect(v.issues.some((i) => i.category === 'INVALID_REFERENCE' && /original invoice/.test(i.message))).toBe(true)
  })
})

describe('return preparation (prepared / exported — never filed)', () => {
  it('blocks preparation on validation errors, freezes snapshots, detects stale data and exports', () => {
    const g = p4Fixture()
    const p1 = prepareReturn(g.ctx, 'GSTR1', '2026-10')
    expect(p1).toMatchObject({ status: 'PREPARED', returnType: 'GSTR1', gstin: COMPANY_GSTIN, stale: false })
    expect(JSON.stringify(Object.values(p1))).not.toMatch(/FILED"/)
    const p3 = prepareReturn(g.ctx, 'GSTR3B', '2026-10')
    expect((p3.data as { itc: Array<{ key: string; cgstPaise: number }> }).itc.find((r) => r.key === '4C')!.cgstPaise).toBe(R(1161))
    // The snapshot is frozen at the database level.
    expect(() => g.db.prepare(`UPDATE gst_return_preparations SET summary_json = '{}' WHERE id = ?`).run(p1.id)).toThrow(/frozen/)
    expect(() => g.db.prepare(`DELETE FROM gst_return_preparations WHERE id = ?`).run(p1.id)).toThrow(/cannot be deleted/)
    // A change to the period's ITC classification makes the snapshot stale (it is never silently updated).
    classifyItc(g.ctx, { documents: [{ kind: 'PURCHASE_INVOICE', id: g.pur.P2.id }], eligibility: 'ELIGIBLE', itcType: 'INPUTS', reverseCharge: false, reason: null })
    expect(getPreparation(g.ctx, p3.id).stale).toBe(true)
    markExported(g.ctx, p1.id, 'JSON')
    expect(getPreparation(g.ctx, p1.id)).toMatchObject({ status: 'EXPORTED', exportFormat: 'JSON' })
    const json = JSON.parse(preparationJson(getPreparation(g.ctx, p1.id)).toString('utf8'))
    expect(json.notice).toMatch(/NOT the GSTN offline-tool upload schema and has NOT been filed/)
    expect(listPreparations(g.ctx, 'GSTR1')).toHaveLength(1)
    // An error blocks preparation.
    const bad = p4Fixture({ withDocs: false })
    postDocument(bad.ctx, 'SALES_INVOICE', saveDraft(bad.ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: bad.c.b2bIntra, date: '2026-10-05', lines: [{ productId: bad.p.service, qtyMilli: toMilli(1), ratePaise: R(1000), taxRateBps: 500 }] })).id)
    expect(() => prepareReturn(bad.ctx, 'GSTR1', '2026-10')).toThrow(/validation error/)
    expect(() => prepareReturn(bad.ctx, 'GSTR1', '2099-01')).toThrow(/not started/)
  })
})

describe('GST reconciliation', () => {
  it('parses CSV strictly and reports row errors', () => {
    expect(parseReconCsv('invoice_no,invoice_date\nA,2026-10-01').errors[0]).toMatch(/Missing column/)
    const r = parseReconCsv('supplier_gstin,invoice_no,invoice_date,taxable,igst\n33ABC,A1,2026-13-01,100,0\n,A2,01/10/2026,1,00.5x\n,"A,3",05/10/2026,"1,000.50",18')
    expect(r.errors).toEqual([expect.stringMatching(/Row 2: invoice date/), expect.stringMatching(/Row 3: an amount/)])
    expect(r.rows).toEqual([expect.objectContaining({ invoiceNo: 'A,3', invoiceDate: '2026-10-05', taxablePaise: 100050, igstPaise: 1800 })])
  })

  it('matches statement rows to the purchase register and records review decisions', () => {
    const g = p4Fixture()
    const vg = buildGstin('33', 'AABCD1234F')
    const og = buildGstin('27', 'AABCE1234F')
    const csv = [
      'supplier_gstin,supplier_name,invoice_no,invoice_date,type,taxable,igst,cgst,sgst,cess',
      `${vg},Vendor,V1 / 101,2026-10-02,INVOICE,3000.00,0,270.00,270.00,0`, // matched (number normalised)
      `${vg},Vendor,V1/102,2026-10-04,INVOICE,1500.00,0,135.00,135.00,0`, // value difference
      `${vg},Vendor,V1/102,2026-10-04,INVOICE,1500.00,0,135.00,135.00,0`, // duplicate row
      `${vg},Vendor,MH/2210,2026-10-03,INVOICE,1500.00,75.00,0,0,0`, // right number, wrong GSTIN
      `${og},Other,ZZ/1,2026-10-09,INVOICE,999.00,49.95,0,0,0`, // not in books
      `${vg},Vendor,V1/CN/9,2026-10-20,CREDIT_NOTE,100.00,0,9.00,9.00,0` // supplier credit note ↔ our debit note
    ].join('\n')
    const d = importRecon(g.ctx, { label: 'Oct statement', source: 'GSTR2B_CSV', periodFrom: '2026-10-01', periodTo: '2026-10-31', csv })
    expect(d.lines.map((l) => l.matchStatus)).toEqual(['MATCHED', 'VALUE_DIFFERENCE', 'DUPLICATE_IN_STATEMENT', 'GSTIN_MISMATCH', 'NOT_IN_BOOKS', 'MATCHED'])
    expect(d.lines[1]).toMatchObject({ diffTaxablePaise: R(500), diffTaxPaise: R(90) })
    expect(d.lines[5].matched!.kind).toBe('DEBIT_NOTE')
    // The advocate's RCM bill has no GSTIN, so it is not expected in the statement.
    expect(d.booksOnly.map((b) => b.number)).toEqual([])
    expect(d.disclaimer).toMatch(/not, by itself, evidence of any wrongdoing/)
    expect(JSON.stringify(d)).not.toMatch(/fraud/i)
    reviewRecon(g.ctx, [d.lines[1].id], 'ON_HOLD', 'Asked supplier')
    expect(reconDetail(g.ctx, d.batch.id).lines[1]).toMatchObject({ reviewStatus: 'ON_HOLD', reviewNote: 'Asked supplier' })
    // A tolerance rule treats tiny differences as matched.
    const t = importRecon(g.ctx, { label: 'Rounding', source: 'SUPPLIER_STATEMENT', periodFrom: '2026-10-01', periodTo: '2026-10-31', csv: `supplier_gstin,invoice_no,invoice_date,taxable,igst,cgst,sgst\n${vg},V1/101,2026-10-02,3000.50,0,270.00,270.00` })
    expect(t.lines[0].matchStatus).toBe('MATCHED')
    expect(t.booksOnly.map((b) => b.number).sort()).toEqual([g.pur.P2.number, g.pur.P3.number, g.pur.DN1.number].sort())
  })
})

describe('migration 005 on an existing Phase 3 database', () => {
  it('adds GST structures, backfills registrations and HSN rates, and changes no posted history', () => {
    const db = openDatabase({ filePath: ':memory:' })
    migrate(db, MIGRATIONS.slice(0, 4))
    expect(currentSchemaVersion(db)).toBe(4)
    const company = createCompany(db, null, { code: 'P3', name: 'Phase Three Co', legalName: 'P3 Pvt Ltd', gstin: buildGstin('33', 'AABCP3333Q'), pan: 'AABCP3333Q', stateCode: '33', addressLine1: 'x', addressLine2: null, city: 'Chennai', pincode: '600001', phone: null, email: null, fyStartMonth: 4 })
    const ctx = { db, userId: null, companyId: company.id }
    const L = getLookups(ctx)
    const cust = createCustomer(ctx, CustomerInput.parse({ code: 'C1', name: 'Old', partyType: 'BUSINESS', gstRegistrationType: 'REGULAR', gstin: buildGstin('33', 'AABCZ1234F'), pan: 'AABCZ1234F', contactPerson: null, phone: null, email: null, addressLine1: 'X', addressLine2: null, city: 'Chennai', stateCode: '33', pincode: null, shippingAddressLine1: null, shippingAddressLine2: null, shippingCity: null, shippingStateCode: null, shippingPincode: null, creditLimitPaise: 0, creditDays: 30, openingBalancePaise: 0 })).id
    const svc = createProduct(ctx, ProductInput.parse({ code: 'S', name: 'Service', description: null, itemType: 'SERVICE', categoryId: null, unitId: L.units[0].id, hsnSac: '998313', taxRateId: L.taxRates.find((t) => t.rateBps === 1800)!.id, salePricePaise: R(100), purchasePricePaise: 0, mrpPaise: null, reorderLevelMilli: 0, trackInventory: false })).id
    postOpeningFunds(ctx, '2026-04-01', R(5000), R(10000))
    postDocument(ctx, 'SALES_INVOICE', saveDraft(ctx, DocumentSaveInput.parse({ kind: 'SALES_INVOICE', partyId: cust, date: '2026-09-01', lines: [{ productId: svc, qtyMilli: toMilli(10), ratePaise: R(100) }] })).id)
    db.prepare(`INSERT INTO transporters (company_id, name, transporter_id) VALUES (?, 'Old Carrier', ?)`).run(company.id, buildGstin('33', 'AABCQ1111Q'))
    expect(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('gst_registrations','einvoices','api_requests')`).get()).toEqual({ n: 0 })
    const snapshot = () => JSON.stringify(['journal_entries', 'journal_entry_lines', 'sales_invoices', 'sales_invoice_items', 'stock_movements', 'payment_allocations', 'audit_logs'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()))
    const before = snapshot()
    const report = migrate(db, MIGRATIONS.slice(0, 5))
    expect(report.applied.map((m) => m.version)).toEqual([5])
    expect(snapshot()).toBe(before)
    expect(listRegistrations(ctx)).toEqual([expect.objectContaining({ gstin: buildGstin('33', 'AABCP3333Q'), isPrimary: true, effectiveFrom: '2017-07-01' })])
    expect(rateRuleAt(ctx, '998313', '2026-09-01')).toMatchObject({ rateBps: 1800, taxCategory: 'TAXABLE', source: 'PRODUCT_MASTER' })
    expect(db.prepare(`SELECT modes FROM transporters WHERE company_id = ?`).get(company.id)).toEqual({ modes: 'ROAD' })
    const perms = (role: string) => (db.prepare(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id WHERE r.code = ? AND p.code IN ('gst.manage','einvoice.view','einvoice.manage','integration.manage') ORDER BY p.code`).all(role) as Array<{ code: string }>).map((x) => x.code)
    expect(perms('ADMIN')).toEqual(['einvoice.manage', 'einvoice.view', 'gst.manage', 'integration.manage'])
    expect(perms('ACCOUNTANT')).toEqual(['einvoice.manage', 'einvoice.view', 'gst.manage'])
    expect(perms('AUDITOR')).toEqual(['einvoice.view'])
    expect(perms('SALES')).toEqual(['einvoice.view'])
    // The upgraded books still reconcile and GST reports work on the old data.
    expect(integrityReport(ctx, '2026-10-31').checks.filter((c) => !c.ok)).toEqual([])
    expect(salesRegister(ctx, { from: '2026-09-01', to: '2026-09-30' })).toMatchObject({ totals: expect.objectContaining({ taxablePaise: R(1000), cgstPaise: R(90) }), ledger: expect.objectContaining({ agrees: true }) })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(migrate(db, MIGRATIONS.slice(0, 5)).applied).toEqual([])
  })
})
