/**
 * GST configuration: registrations, company GST settings, effective-dated
 * compliance rules, HSN/SAC master and effective-dated HSN rate rules.
 * Nothing here alters a posted document; these are master/configuration data.
 */
import {
  RULE_KEYS, RULE_UNITS, type ComplianceRule, type GstConfig, type GstRegistration, type GstSettings, type HsnCode, type HsnRateRule, type RuleKey, type RuleSet,
  type TaxCategory, type TaxRateRow
} from '@shared/gst'
import type { z } from 'zod'
import type { GstSettingsInput, HsnRateSaveInput, HsnSaveInput, RegistrationSaveInput, RuleSaveInput, TaxRateDatesInput } from '@shared/gst'
import { writeAudit } from '../audit'
import { bool, inTransaction, type ServiceContext } from '../context'
import { businessRule, notFound } from '../errors'

type Row = Record<string, unknown>
export const todayIso = (): string => new Date().toISOString().slice(0, 10)

// ───────── Rules ─────────

/** Effective value of every rule on a date: a company rule wins over the default. */
export function rulesAt(ctx: ServiceContext, date: string, cache?: Map<string, RuleSet>): RuleSet {
  // Optional per-call cache (one register build / validation run), so thousands of documents
  // on the same dates do not re-read the rules table. Never shared across calls, so it cannot go stale.
  const hit = cache?.get(date)
  if (hit) return hit
  const result = rulesAtUncached(ctx, date)
  cache?.set(date, result)
  return result
}

function rulesAtUncached(ctx: ServiceContext, date: string): RuleSet {
  const rows = ctx.db
    .prepare(
      `SELECT rule_key, value_num, company_id FROM compliance_rules
       WHERE (company_id = ? OR company_id IS NULL) AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY rule_key, CASE WHEN company_id IS NULL THEN 1 ELSE 0 END, effective_from DESC`
    )
    .all(ctx.companyId, date, date) as Array<{ rule_key: RuleKey; value_num: number }>
  const out: Partial<RuleSet> = {}
  for (const r of rows) if (out[r.rule_key] === undefined) out[r.rule_key] = r.value_num
  // Dates before every rule (e.g. pre-GST documents) use the earliest rule of that key.
  for (const k of RULE_KEYS.filter((x) => out[x] === undefined)) {
    const first = ctx.db.prepare(`SELECT value_num FROM compliance_rules WHERE rule_key = ? AND (company_id = ? OR company_id IS NULL) AND effective_from > ? ORDER BY effective_from, company_id IS NULL LIMIT 1`).get(k, ctx.companyId, date) as { value_num: number } | undefined
    if (first) out[k] = first.value_num
  }
  const missing = RULE_KEYS.filter((k) => out[k] === undefined)
  if (missing.length) throw businessRule(`No compliance rule is effective on ${date} for: ${missing.join(', ')}. Add one in GST → Configuration.`)
  return out as RuleSet
}

export function listRules(ctx: ServiceContext, today = todayIso()): ComplianceRule[] {
  return (
    ctx.db
      .prepare(`SELECT * FROM compliance_rules WHERE company_id = ? OR company_id IS NULL ORDER BY rule_key, effective_from DESC, company_id IS NULL`)
      .all(ctx.companyId) as Row[]
  ).map((r) => ({
    id: r.id as number, companySpecific: r.company_id != null, ruleKey: r.rule_key as RuleKey, valueNum: r.value_num as number, unit: RULE_UNITS[r.rule_key as RuleKey] ?? '',
    effectiveFrom: r.effective_from as string, effectiveTo: r.effective_to as string | null, description: r.description as string, sourceNote: r.source_note as string | null,
    activeToday: (r.effective_from as string) <= today && (!r.effective_to || (r.effective_to as string) >= today)
  }))
}

/** Creates or edits a company-specific rule (defaults are never edited; a company rule overrides them). */
export function saveRule(ctx: ServiceContext, input: z.infer<typeof RuleSaveInput>): ComplianceRule[] {
  return inTransaction(ctx.db, () => {
    const desc = (ctx.db.prepare('SELECT description FROM compliance_rules WHERE rule_key = ? AND company_id IS NULL ORDER BY effective_from DESC LIMIT 1').get(input.ruleKey) as { description: string } | undefined)?.description ?? input.ruleKey
    const overlap = ctx.db
      .prepare(
        `SELECT id FROM compliance_rules WHERE company_id = ? AND rule_key = ? AND id <> ? AND effective_from <= COALESCE(?, '9999-12-31') AND COALESCE(effective_to, '9999-12-31') >= ?`
      )
      .get(ctx.companyId, input.ruleKey, input.id ?? -1, input.effectiveTo ?? null, input.effectiveFrom)
    if (overlap) throw businessRule('Another company rule for this key overlaps these dates; end it first', { effectiveFrom: 'Overlaps an existing company rule' })
    if (input.id) {
      const cur = ctx.db.prepare('SELECT company_id FROM compliance_rules WHERE id = ?').get(input.id) as { company_id: number | null } | undefined
      if (!cur) throw notFound('Rule')
      if (cur.company_id !== ctx.companyId) throw businessRule('Default rules cannot be edited; add a company rule to override it')
      ctx.db.prepare(`UPDATE compliance_rules SET value_num=?, effective_from=?, effective_to=?, source_note=?, updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(input.valueNum, input.effectiveFrom, input.effectiveTo ?? null, input.sourceNote, ctx.userId, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO compliance_rules (company_id, rule_key, value_num, effective_from, effective_to, description, source_note, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ctx.companyId, input.ruleKey, input.valueNum, input.effectiveFrom, input.effectiveTo ?? null, desc, input.sourceNote, ctx.userId)
    }
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_RULE_SAVE', entityType: 'compliance_rule', summary: `Compliance rule ${input.ruleKey} = ${input.valueNum} from ${input.effectiveFrom}${input.effectiveTo ? ` to ${input.effectiveTo}` : ''}`, details: input })
    return listRules(ctx)
  })
}

// ───────── Registrations & settings ─────────

const toReg = (r: Row): GstRegistration => ({
  id: r.id as number, gstin: r.gstin as string, registrationType: r.registration_type as string, stateCode: r.state_code as string, branchId: r.branch_id as number | null,
  branchName: r.branch_name as string | null, legalName: r.legal_name as string | null, tradeName: r.trade_name as string | null, address: r.address as string | null,
  pincode: r.pincode as string | null, effectiveFrom: r.effective_from as string, effectiveTo: r.effective_to as string | null, isPrimary: bool(r.is_primary), isActive: bool(r.is_active)
})

export function listRegistrations(ctx: ServiceContext): GstRegistration[] {
  return (ctx.db.prepare(`SELECT g.*, b.name AS branch_name FROM gst_registrations g LEFT JOIN branches b ON b.id = g.branch_id WHERE g.company_id = ? ORDER BY g.is_primary DESC, g.gstin`).all(ctx.companyId) as Row[]).map(toReg)
}

/** GSTIN used for a document: its branch's registration, else the primary registration, else the company GSTIN. */
export function primaryGstin(ctx: ServiceContext): string | null {
  const r = ctx.db.prepare(`SELECT gstin FROM gst_registrations WHERE company_id = ? AND is_primary = 1 AND is_active = 1`).get(ctx.companyId) as { gstin: string } | undefined
  if (r) return r.gstin
  return (ctx.db.prepare('SELECT gstin FROM companies WHERE id = ?').get(ctx.companyId) as { gstin: string | null }).gstin
}

export function saveRegistration(ctx: ServiceContext, input: z.infer<typeof RegistrationSaveInput>): GstRegistration[] {
  return inTransaction(ctx.db, () => {
    const pan = (ctx.db.prepare('SELECT pan, gstin FROM companies WHERE id = ?').get(ctx.companyId) as { pan: string | null; gstin: string | null })
    const companyPan = pan.pan ?? pan.gstin?.slice(2, 12) ?? null
    if (companyPan && input.gstin.slice(2, 12) !== companyPan) throw businessRule('Every registration of a company must carry the company PAN', { gstin: `PAN inside the GSTIN must be ${companyPan}` })
    if (input.branchId && !ctx.db.prepare('SELECT 1 FROM branches WHERE id = ? AND company_id = ?').get(input.branchId, ctx.companyId)) throw businessRule('Select a valid branch', { branchId: 'Select a valid branch' })
    if (input.isPrimary) ctx.db.prepare(`UPDATE gst_registrations SET is_primary = 0 WHERE company_id = ? AND id <> ?`).run(ctx.companyId, input.id ?? -1)
    const values = [input.gstin, input.registrationType, input.stateCode, input.branchId ?? null, input.legalName, input.tradeName, input.address, input.pincode, input.effectiveFrom, input.effectiveTo ?? null, input.isPrimary ? 1 : 0, input.isActive ? 1 : 0]
    if (input.id) {
      if (!ctx.db.prepare('SELECT 1 FROM gst_registrations WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId)) throw notFound('Registration')
      ctx.db.prepare(`UPDATE gst_registrations SET gstin=?, registration_type=?, state_code=?, branch_id=?, legal_name=?, trade_name=?, address=?, pincode=?, effective_from=?, effective_to=?, is_primary=?, is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...values, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO gst_registrations (gstin, registration_type, state_code, branch_id, legal_name, trade_name, address, pincode, effective_from, effective_to, is_primary, is_active, company_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values, ctx.companyId)
    }
    if (input.branchId) ctx.db.prepare('UPDATE branches SET gstin = ? WHERE id = ?').run(input.gstin, input.branchId)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: input.id ? 'GST_REGISTRATION_UPDATE' : 'GST_REGISTRATION_CREATE', entityType: 'gst_registration', summary: `GST registration ${input.gstin} (${input.registrationType}) saved`, details: input })
    return listRegistrations(ctx)
  })
}

export function getSettings(ctx: ServiceContext): GstSettings {
  const r = ctx.db.prepare('SELECT * FROM gst_company_settings WHERE company_id = ?').get(ctx.companyId) as Row | undefined
  if (!r) return { aatoPaise: null, aatoFy: null, einvoiceEnabled: false, einvoiceExemptReason: null, returnFrequency: 'MONTHLY', lutNumber: null, lutValidFrom: null, lutValidUpto: null, updatedAt: null }
  return {
    aatoPaise: r.aato_paise as number | null, aatoFy: r.aato_fy as string | null, einvoiceEnabled: bool(r.einvoice_enabled), einvoiceExemptReason: r.einvoice_exempt_reason as string | null,
    returnFrequency: r.return_frequency as 'MONTHLY' | 'QUARTERLY', lutNumber: r.lut_number as string | null, lutValidFrom: r.lut_valid_from as string | null,
    lutValidUpto: r.lut_valid_upto as string | null, updatedAt: r.updated_at as string
  }
}

export function saveSettings(ctx: ServiceContext, input: z.infer<typeof GstSettingsInput>): GstSettings {
  return inTransaction(ctx.db, () => {
    const before = getSettings(ctx)
    ctx.db
      .prepare(
        `INSERT INTO gst_company_settings (company_id, aato_paise, aato_fy, einvoice_enabled, einvoice_exempt_reason, return_frequency, lut_number, lut_valid_from, lut_valid_upto, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id) DO UPDATE SET aato_paise=excluded.aato_paise, aato_fy=excluded.aato_fy, einvoice_enabled=excluded.einvoice_enabled,
           einvoice_exempt_reason=excluded.einvoice_exempt_reason, return_frequency=excluded.return_frequency, lut_number=excluded.lut_number,
           lut_valid_from=excluded.lut_valid_from, lut_valid_upto=excluded.lut_valid_upto, updated_by=excluded.updated_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
      )
      .run(ctx.companyId, input.aatoPaise, input.aatoFy, input.einvoiceEnabled ? 1 : 0, input.einvoiceExemptReason, input.returnFrequency, input.lutNumber, input.lutValidFrom, input.lutValidUpto, ctx.userId)
    const after = getSettings(ctx)
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'GST_SETTINGS_UPDATE', entityType: 'gst_settings', summary: `GST settings updated (e-invoicing ${after.einvoiceEnabled ? 'enabled' : 'disabled'})`, details: { before, after } })
    return after
  })
}

// ───────── HSN master & rates ─────────

const toRate = (r: Row): HsnRateRule => ({
  id: r.id as number, hsnCode: r.hsn_code as string, effectiveFrom: r.effective_from as string, effectiveTo: r.effective_to as string | null, taxCategory: r.tax_category as TaxCategory,
  rateBps: r.rate_bps as number, cessBps: r.cess_bps as number, reverseCharge: bool(r.reverse_charge), notes: r.notes as string | null, source: r.source as 'USER' | 'PRODUCT_MASTER'
})

/** Rate rule for an HSN on a date (exact code first, then the longest matching prefix, e.g. 8471 for 84713010). */
export function rateRuleAt(ctx: ServiceContext, hsn: string, date: string, cache?: Map<string, HsnRateRule | null>): HsnRateRule | null {
  const key = `${hsn}|${date}`
  if (cache?.has(key)) return cache.get(key)!
  const r = ctx.db
    .prepare(
      `SELECT * FROM hsn_rate_rules WHERE company_id = ? AND ? LIKE hsn_code || '%' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY LENGTH(hsn_code) DESC, effective_from DESC LIMIT 1`
    )
    .get(ctx.companyId, hsn, date, date) as Row | undefined
  const out = r ? toRate(r) : null
  cache?.set(key, out)
  return out
}

export function listHsn(ctx: ServiceContext, today = todayIso()): HsnCode[] {
  const rows = ctx.db
    .prepare(`SELECT h.*, (SELECT COUNT(*) FROM products p WHERE p.company_id = h.company_id AND p.hsn_sac = h.code) AS product_count FROM hsn_codes h WHERE h.company_id = ? ORDER BY h.code`)
    .all(ctx.companyId) as Row[]
  return rows.map((r) => ({
    id: r.id as number, code: r.code as string, description: r.description as string, kind: r.kind as 'GOODS' | 'SERVICE', defaultUqc: r.default_uqc as string | null,
    isActive: bool(r.is_active), productCount: r.product_count as number, currentRate: rateRuleAt(ctx, r.code as string, today)
  }))
}

export function listHsnRates(ctx: ServiceContext, hsnCode?: string): HsnRateRule[] {
  return (ctx.db.prepare(`SELECT * FROM hsn_rate_rules WHERE company_id = ? ${hsnCode ? 'AND hsn_code = ?' : ''} ORDER BY hsn_code, effective_from DESC`).all(...(hsnCode ? [ctx.companyId, hsnCode] : [ctx.companyId])) as Row[]).map(toRate)
}

export function saveHsn(ctx: ServiceContext, input: z.infer<typeof HsnSaveInput>): HsnCode[] {
  return inTransaction(ctx.db, () => {
    if (input.id) {
      const cur = ctx.db.prepare('SELECT code FROM hsn_codes WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId) as { code: string } | undefined
      if (!cur) throw notFound('HSN code')
      if (cur.code !== input.code && ctx.db.prepare('SELECT 1 FROM hsn_rate_rules WHERE company_id = ? AND hsn_code = ?').get(ctx.companyId, cur.code))
        throw businessRule('This code has rate rules; add a new code instead of renaming it', { code: 'Has rate rules' })
      ctx.db.prepare(`UPDATE hsn_codes SET code=?, description=?, kind=?, default_uqc=?, is_active=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(input.code, input.description, input.kind, input.defaultUqc, input.isActive ? 1 : 0, input.id)
    } else {
      ctx.db.prepare(`INSERT INTO hsn_codes (company_id, code, description, kind, default_uqc, is_active) VALUES (?, ?, ?, ?, ?, ?)`).run(ctx.companyId, input.code, input.description, input.kind, input.defaultUqc, input.isActive ? 1 : 0)
    }
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'HSN_SAVE', entityType: 'hsn_code', summary: `HSN/SAC ${input.code} saved`, details: input })
    return listHsn(ctx)
  })
}

/** Adds an effective-dated rate. An open-ended earlier rule is closed the day before the new one starts. */
export function saveHsnRate(ctx: ServiceContext, input: z.infer<typeof HsnRateSaveInput>): HsnRateRule[] {
  return inTransaction(ctx.db, () => {
    if (!ctx.db.prepare('SELECT 1 FROM hsn_codes WHERE company_id = ? AND code = ?').get(ctx.companyId, input.hsnCode)) throw businessRule('Add the code to the HSN/SAC master first', { hsnCode: 'Not in the HSN/SAC master' })
    const values = [input.effectiveFrom, input.effectiveTo ?? null, input.taxCategory, input.rateBps, input.cessBps, input.reverseCharge ? 1 : 0, input.notes]
    if (input.id) {
      if (!ctx.db.prepare('SELECT 1 FROM hsn_rate_rules WHERE id = ? AND company_id = ?').get(input.id, ctx.companyId)) throw notFound('Rate rule')
      ctx.db.prepare(`UPDATE hsn_rate_rules SET effective_from=?, effective_to=?, tax_category=?, rate_bps=?, cess_bps=?, reverse_charge=?, notes=?, source='USER', updated_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...values, ctx.userId, input.id)
    } else {
      const open = ctx.db.prepare(`SELECT id, effective_from FROM hsn_rate_rules WHERE company_id = ? AND hsn_code = ? AND effective_to IS NULL AND effective_from < ?`).get(ctx.companyId, input.hsnCode, input.effectiveFrom) as { id: number } | undefined
      if (open) ctx.db.prepare(`UPDATE hsn_rate_rules SET effective_to = date(?, '-1 day'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(input.effectiveFrom, open.id)
      ctx.db.prepare(`INSERT INTO hsn_rate_rules (effective_from, effective_to, tax_category, rate_bps, cess_bps, reverse_charge, notes, company_id, hsn_code, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(...values, ctx.companyId, input.hsnCode, ctx.userId)
    }
    const overlaps = ctx.db
      .prepare(`SELECT COUNT(*) n FROM hsn_rate_rules a JOIN hsn_rate_rules b ON a.company_id = b.company_id AND a.hsn_code = b.hsn_code AND a.id < b.id
                WHERE a.company_id = ? AND a.hsn_code = ? AND a.effective_from <= COALESCE(b.effective_to, '9999-12-31') AND b.effective_from <= COALESCE(a.effective_to, '9999-12-31')`)
      .get(ctx.companyId, input.hsnCode) as { n: number }
    if (overlaps.n > 0) throw businessRule('Rate periods for this code overlap; adjust the dates', { effectiveFrom: 'Overlaps another rate period' })
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'HSN_RATE_SAVE', entityType: 'hsn_rate_rule', summary: `HSN/SAC ${input.hsnCode}: ${input.taxCategory} ${input.rateBps / 100}% from ${input.effectiveFrom}${input.reverseCharge ? ' (reverse charge)' : ''}`, details: input })
    return listHsnRates(ctx, input.hsnCode)
  })
}

/** Adds every product HSN that is not yet in the master (rates must then be set by the user). */
export function importHsnFromProducts(ctx: ServiceContext): { added: number } {
  return inTransaction(ctx.db, () => {
    const r = ctx.db
      .prepare(
        `INSERT INTO hsn_codes (company_id, code, description, kind, default_uqc)
         SELECT p.company_id, p.hsn_sac, MIN(p.name), MIN(p.item_type), MIN(u.code) FROM products p JOIN units u ON u.id = p.unit_id
         WHERE p.company_id = ? AND NOT EXISTS (SELECT 1 FROM hsn_codes h WHERE h.company_id = p.company_id AND h.code = p.hsn_sac) GROUP BY p.company_id, p.hsn_sac`
      )
      .run(ctx.companyId)
    if (r.changes) writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'HSN_IMPORT', entityType: 'hsn_code', summary: `${r.changes} HSN/SAC codes added from the product master` })
    return { added: r.changes }
  })
}

export function listTaxRates(ctx: ServiceContext): TaxRateRow[] {
  return (ctx.db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM products p WHERE p.tax_rate_id = t.id AND p.company_id = ?) AS n FROM tax_rates t ORDER BY rate_bps`).all(ctx.companyId) as Row[]).map((r) => ({
    id: r.id as number, name: r.name as string, rateBps: r.rate_bps as number, cessBps: r.cess_bps as number, isActive: bool(r.is_active),
    effectiveFrom: r.effective_from as string | null, effectiveTo: r.effective_to as string | null, productCount: r.n as number
  }))
}

export function saveTaxRateDates(ctx: ServiceContext, input: z.infer<typeof TaxRateDatesInput>): TaxRateRow[] {
  return inTransaction(ctx.db, () => {
    const r = ctx.db.prepare(`UPDATE tax_rates SET effective_from = ?, effective_to = ?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(input.effectiveFrom, input.effectiveTo, input.id)
    if (!r.changes) throw notFound('Tax rate')
    writeAudit(ctx.db, { companyId: ctx.companyId, userId: ctx.userId, action: 'TAX_RATE_DATES', entityType: 'tax_rate', entityId: input.id, summary: `Tax rate #${input.id} effective ${input.effectiveFrom ?? 'always'} to ${input.effectiveTo ?? 'open'}` })
    return listTaxRates(ctx)
  })
}

export function gstConfig(ctx: ServiceContext, today = todayIso()): GstConfig {
  const c = ctx.db.prepare('SELECT name, gstin, state_code, legal_name FROM companies WHERE id = ?').get(ctx.companyId) as { name: string; gstin: string | null; state_code: string; legal_name: string | null }
  return {
    company: { name: c.name, gstin: c.gstin, stateCode: c.state_code, legalName: c.legal_name },
    registrations: listRegistrations(ctx),
    settings: getSettings(ctx),
    rules: listRules(ctx, today),
    effectiveToday: rulesAt(ctx, today),
    taxRates: listTaxRates(ctx),
    branches: ctx.db.prepare('SELECT id, code, name, gstin, state_code AS stateCode FROM branches WHERE company_id = ? ORDER BY id').all(ctx.companyId) as GstConfig['branches']
  }
}
