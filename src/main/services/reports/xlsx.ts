/**
 * Minimal, dependency-free Excel (.xlsx / Office Open XML) writer for report
 * exports. Produces a real workbook: numbers are numeric cells with number
 * formats, dates are Excel dates, text is escaped inline strings.
 * The ZIP container is written with Node's zlib (deflate) and a CRC-32 table.
 */
import { deflateRawSync } from 'node:zlib'
import type { ReportDoc } from '@shared/finance'

// ───────── ZIP ─────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  // Fixed DOS timestamp (2026-01-01 00:00) keeps output deterministic.
  const dosTime = 0
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const compressed = deflateRawSync(f.data, { level: 6 })
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, compressed)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(f.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += local.length + name.length + compressed.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

// ───────── Workbook ─────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)))
/** Excel serial date (1900 system). */
const excelDate = (iso: string) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000)

// Style indexes into cellXfs below.
const S = { text: 0, bold: 1, money: 2, moneyBold: 3, header: 4, date: 5, qty: 6, title: 7, muted: 8, moneyTotal: 9, number: 10, headerRight: 11 }
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="165" formatCode="dd-mmm-yyyy"/><numFmt numFmtId="166" formatCode="#,##0.###"/></numFmts>
<fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0F1F45"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF64748B"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3ECFD"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF0F1F45"/></top><bottom style="double"><color rgb="FF0F1F45"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
</cellXfs>
</styleSheet>`

type Cell = { v: string | number | null; s: number; t: 'str' | 'num' }

function sheetXml(rows: Cell[][], widths: number[], freezeRow: number): string {
  const body = rows
    .map((cells, r) => {
      const cs = cells
        .map((c, i) => {
          const ref = `${colName(i)}${r + 1}`
          if (c.v === null || c.v === '') return c.s ? `<c r="${ref}" s="${c.s}"/>` : ''
          return c.t === 'num' ? `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>` : `<c r="${ref}" s="${c.s}" t="inlineStr"><is><t xml:space="preserve">${esc(String(c.v))}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cs}</row>`
    })
    .join('')
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  const pane = freezeRow > 0 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${body}</sheetData><pageSetup orientation="landscape" paperSize="9"/></worksheet>`
}

/** Builds an .xlsx workbook (one sheet) for a report. Money is exported in rupees with two decimals. */
export function reportToXlsx(doc: ReportDoc): Buffer {
  const rows: Cell[][] = []
  const text = (v: string | null, s = S.text): Cell => ({ v, s, t: 'str' })
  rows.push([text(`${doc.companyName}${doc.isDemo ? ' (DEMO company — sample data)' : ''}`, S.title)])
  rows.push([text(doc.title, S.bold)])
  rows.push([text(doc.subtitle, S.text)])
  if (doc.companyGstin) rows.push([text(`GSTIN ${doc.companyGstin}`, S.muted)])
  for (const s of doc.summary) rows.push([text(s.label, S.bold), text(s.value)])
  rows.push([])
  rows.push(doc.columns.map((c) => text(c.label, c.type === 'money' || c.type === 'qty' || c.type === 'number' ? S.headerRight : S.header)))
  const headerRow = rows.length
  for (const r of doc.rows) {
    const strong = r.style === 'group' || r.style === 'subtotal' || r.style === 'total'
    rows.push(
      doc.columns.map((c, i) => {
        const v = r.cells[c.key]
        if (v === null || v === undefined || v === '') return { v: null, s: r.style === 'total' && c.type === 'money' ? S.moneyTotal : 0, t: 'str' }
        if (c.type === 'money' && typeof v === 'number') return { v: (v / 100).toFixed(2), s: r.style === 'total' ? S.moneyTotal : strong ? S.moneyBold : S.money, t: 'num' }
        if (c.type === 'qty' && typeof v === 'number') return { v: v / 1000, s: S.qty, t: 'num' }
        if (c.type === 'number' && typeof v === 'number') return { v, s: S.number, t: 'num' }
        if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { v: excelDate(v), s: S.date, t: 'num' }
        const indent = i === 0 && r.indent ? '    '.repeat(r.indent) : ''
        return { v: `${indent}${v}`, s: strong ? S.bold : r.style === 'muted' ? S.muted : S.text, t: 'str' }
      })
    )
  }
  rows.push([])
  for (const n of doc.notes) rows.push([text(n, S.muted)])
  rows.push([text(`Generated ${doc.generatedAt.replace('T', ' ').slice(0, 16)} UTC${doc.generatedBy ? ` by ${doc.generatedBy}` : ''} · SA Business ERP`, S.muted)])
  const widths = doc.columns.map((c) => c.width ?? (c.type === 'money' ? 16 : c.type === 'date' ? 12 : c.type === 'qty' || c.type === 'number' ? 11 : 28))

  const sheetName = esc(doc.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(doc.title)}</dc:title><dc:creator>SA Business ERP</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${doc.generatedAt.slice(0, 19)}Z</dcterms:created></cp:coreProperties>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(rows, widths, headerRow) }
  ]
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })))
}
