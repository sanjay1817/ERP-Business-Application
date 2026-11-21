/**
 * Input tax credit classification. Stored beside the immutable purchase documents;
 * an unclassified document is PENDING and never counted as eligible credit.
 */
import type { z } from 'zod'
import { KINDS } from '@shared/documents'
import type { ItcClassifyInput } from '@shared/gst'
import { writeAudit } from '../audit'
import { inTransaction, type ServiceContext } from '../context'
import { businessRule } from '../errors'
import { loadHeader } from '../documents/store'

export function classifyItc(ctx: ServiceContext, input: z.infer<typeof ItcClassifyInput>): { updated: number } {
  return inTransaction(ctx.db, () => {
    const upsert = ctx.db.prepare(
      `INSERT INTO purchase_itc (company_id, document_kind, document_id, eligibility, itc_type, reverse_charge, reason, classified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_kind, document_id) DO UPDATE SET eligibility=excluded.eligibility, itc_type=excluded.itc_type, reverse_charge=excluded.reverse_charge,
         reason=excluded.reason, classified_by=excluded.classified_by, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
    const numbers: string[] = []
    for (const d of input.documents) {
      const h = loadHeader(ctx, d.kind, d.id) // tenancy + existence
      if (h.status === 'DRAFT') throw businessRule(`${KINDS[d.kind].label} ${h._number} is a draft; classify credit after posting`)
      const gstin = (h as Record<string, unknown>)._party_gstin as string | null
      if (!gstin && !input.reverseCharge && input.eligibility === 'ELIGIBLE')
        throw businessRule(`${h._number}: the supplier is unregistered, so no input tax credit is available unless tax is paid under reverse charge`)
      upsert.run(ctx.companyId, d.kind, d.id, input.eligibility, input.itcType, input.reverseCharge ? 1 : 0, input.reason, ctx.userId)
      numbers.push(h._number)
    }
    writeAudit(ctx.db, {
      companyId: ctx.companyId, userId: ctx.userId, action: 'ITC_CLASSIFY', entityType: 'purchase_itc',
      summary: `ITC classified as ${input.eligibility.toLowerCase()}${input.reverseCharge ? ' (reverse charge)' : ''} for ${numbers.length} document(s): ${numbers.slice(0, 5).join(', ')}${numbers.length > 5 ? '…' : ''}`,
      details: input
    })
    return { updated: numbers.length }
  })
}
