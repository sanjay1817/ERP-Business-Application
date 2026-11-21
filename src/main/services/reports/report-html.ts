/**
 * Print / PDF layout for financial reports (A4; landscape for wide reports).
 * Every value is HTML-escaped. Rendered by Chromium in a sandboxed window with
 * JavaScript disabled (see src/main/printing.ts).
 */
import { formatReportCell, type ReportColumn, type ReportDoc } from '@shared/finance'

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export const formatCell = formatReportCell

export function reportHtml(doc: ReportDoc): string {
  const landscape = doc.columns.length > 6
  const numeric = (c: ReportColumn) => c.type === 'money' || c.type === 'qty' || c.type === 'number'
  const head = doc.columns.map((c) => `<th class="${numeric(c) ? 'r' : ''}">${esc(c.label)}</th>`).join('')
  const body = doc.rows
    .map((r) => {
      const cells = doc.columns
        .map((c, i) => {
          const v = formatCell(c, r.cells[c.key] ?? null)
          const pad = i === 0 && r.indent ? ` style="padding-left:${6 + r.indent * 14}px"` : ''
          const neg = c.type === 'money' && typeof r.cells[c.key] === 'number' && (r.cells[c.key] as number) < 0 ? ' neg' : ''
          return `<td class="${numeric(c) ? 'r' : ''}${neg}"${pad}>${esc(v)}</td>`
        })
        .join('')
      return `<tr class="${r.style ?? ''}">${cells}</tr>`
    })
    .join('')
  const summary = doc.summary.length
    ? `<div class="summary">${doc.summary.map((s) => `<div class="kv ${s.tone ?? ''}"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`).join('')}</div>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 11mm 10mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 9.5px; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f1f45; padding-bottom: 6px; margin-bottom: 8px; }
  .head h1 { margin: 0; font-size: 16px; color: #0f1f45; }
  .head .co { font-size: 11px; font-weight: 700; }
  .muted { color: #64748b; }
  .demo { display: inline-block; border: 1px solid #b45309; color: #92400e; background: #fffbeb; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-size: 8.5px; margin-left: 6px; }
  .summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .kv { border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px 8px; }
  .kv span { display: block; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
  .kv b { font-size: 10.5px; }
  .kv.good b { color: #047857; } .kv.bad b { color: #b91c1c; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { background: #0f1f45; color: #fff; font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; padding: 4px 5px; text-align: left; }
  td { padding: 3px 5px; border-bottom: 1px solid #edf1f6; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .neg { color: #b91c1c; }
  tr.group td { font-weight: 700; background: #f1f5f9; text-transform: uppercase; font-size: 8.5px; letter-spacing: .4px; }
  tr.subtotal td { font-weight: 700; }
  tr.total td { font-weight: 800; border-top: 1.5px solid #0f1f45; border-bottom: 2px double #0f1f45; }
  tr.muted td { color: #64748b; font-style: italic; }
  .notes { margin-top: 8px; color: #64748b; font-size: 8.5px; }
  .foot { margin-top: 6px; color: #94a3b8; font-size: 8px; }
  .wm { position: fixed; top: 40%; left: 0; right: 0; text-align: center; transform: rotate(-20deg); font-size: 64px; font-weight: 900; color: rgba(180, 83, 9, 0.07); }
</style></head><body>
${doc.isDemo ? '<div class="wm">DEMO</div>' : ''}
<div class="head">
  <div><div class="co">${esc(doc.companyName)}${doc.isDemo ? '<span class="demo">DEMO — sample data</span>' : ''}</div>${doc.companyGstin ? `<div class="muted">GSTIN ${esc(doc.companyGstin)}</div>` : ''}</div>
  <div style="text-align:right"><h1>${esc(doc.title)}</h1><div class="muted">${esc(doc.subtitle)}</div></div>
</div>
${summary}
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${doc.notes.length ? `<div class="notes">${doc.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : ''}
<div class="foot">Generated ${esc(doc.generatedAt.replace('T', ' ').slice(0, 16))} UTC${doc.generatedBy ? ` by ${esc(doc.generatedBy)}` : ''} · SA Business ERP</div>
</body></html>`
}
