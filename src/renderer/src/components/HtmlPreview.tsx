import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { ErrorBanner, Spinner } from './ui'

/** Shows print HTML produced by the main process (already escaped) inside an isolated shadow root. */
export function HtmlPreview({ open, title, load, onClose }: { open: boolean; title: string; load: () => Promise<{ html: string }>; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    if (!open) return
    setHtml(null)
    setError(null)
    load().then((r) => setHtml(r.html)).catch((e: Error) => setError(e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!html || !host.current) return
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' })
    root.innerHTML = `<style>.wm{position:absolute!important} body{margin:0}</style>${html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')}${html.match(/<style>[\s\S]*?<\/style>/i)?.[0] ?? ''}`
  }, [html])
  return (
    <Modal open={open} title={title} onClose={onClose} width="max-w-5xl">
      {error && <ErrorBanner error={error} />}
      {!html && !error && <Spinner label="Preparing preview…" />}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-white p-6"><div ref={host} className="relative" /></div>
    </Modal>
  )
}
