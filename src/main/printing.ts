/**
 * Printing & PDF via a hidden, sandboxed BrowserWindow with JavaScript disabled.
 * The HTML comes from our own template (all values escaped) and is loaded as a
 * data: URL, so nothing is fetched from disk or network.
 */
import { app, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrintingDeps } from './ipc/routes'

/** Chromium fills .pageNumber / .totalPages; rendered inside the page's bottom margin. */
export const PAGE_FOOTER =
  '<div style="width:100%;font-family:Segoe UI,Arial,sans-serif;font-size:7px;color:#64748b;text-align:right;padding:0 10mm 2mm 0">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>'

async function withDocumentWindow<T>(html: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, devTools: false }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`)
    return await fn(win)
  } finally {
    win.destroy()
  }
}

export function createPrinting(getParent: () => BrowserWindow | null): PrintingDeps {
  return {
    toPdf: (html) =>
      withDocumentWindow(html, (win) =>
        win.webContents
          .printToPDF({
            pageSize: 'A4', printBackground: true, preferCSSPageSize: true,
            // "Page X of Y" in the bottom margin, so loose printed pages can be put back in order.
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: PAGE_FOOTER
          })
          .then((b) => Buffer.from(b))
      ),
    print: (html) =>
      withDocumentWindow(
        html,
        (win) => new Promise<boolean>((resolve) => win.webContents.print({ silent: false, printBackground: true }, (ok) => resolve(ok)))
      ),
    async savePdf(defaultFileName, data) {
      const parent = getParent()
      const opts = { title: 'Export PDF', defaultPath: join(app.getPath('documents'), defaultFileName), filters: [{ name: 'PDF', extensions: ['pdf'] }] }
      const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, data)
      return res.filePath
    },
    async saveFile(defaultFileName, data, filter) {
      const parent = getParent()
      const opts = { title: 'Export', defaultPath: join(app.getPath('documents'), defaultFileName), filters: [filter] }
      const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, data)
      return res.filePath
    }
  }
}
