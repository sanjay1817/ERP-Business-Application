import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle, ArrowRightLeft, Ban, CheckCircle2, ChevronDown, Eye, FileDown, IndianRupee, Plus, Printer, Save, Send, ShieldCheck, Trash2, X
} from 'lucide-react'
import { KINDS, docRoute, isInvoiceKind, kindBySlug, type DocumentDetail, type DocumentKind, type DocumentSaveInputT, type Side, type ValidationResult } from '@shared/documents'
import { financialYearOf, GST_STATES, stateName } from '@shared/india'
import { formatINR, milliToString, paiseToRupeesString, toBps, toMilli, toPaise } from '@shared/money'
import { computeTaxDocument, computeTaxLine, isInterStateSupply, roundToRupee, type TaxLineResult } from '@shared/tax'
import type { Customer, Lookups, Product, Supplier } from '@shared/types'
import { api, ApiError } from '../../lib/api'
import { useQuery } from '../../lib/hooks'
import { useSession } from '../../lib/session'
import { useToast } from '../../lib/toast'
import { formatDate, formatDateTime, formatPercentBps } from '../../lib/format'
import { Badge, Button, Card, ErrorBanner, Field, Input, KeyValue, PageHeader, Select, Spinner, cx } from '../../components/ui'
import { SearchSelect, type SelectOption } from '../../components/SearchSelect'
import { ConfirmDialog, Modal } from '../../components/Modal'
import { DocumentPreview, ModuleNav, PaymentBadge, StatusBadge, paymentsSlug, sideRoot } from './common'
import { CompliancePanel } from './CompliancePanel'

type Party = Customer | Supplier
interface LineState {
  key: string
  productId: number | null
  description: string
  qty: string
  rate: string
  discMode: 'PCT' | 'AMT'
  disc: string
  taxRateBps: number | null
  sourceLineId: number | null
  remainingMilli: number | null
}
interface HeaderState {
  partyId: number | null
  date: string
  dueDate: string
  placeOfSupply: string
  warehouseId: string
  referenceNo: string
  supplierRef: string
  supplierRefDate: string
  billingAddress: string
  shippingAddress: string
  paymentTermsDays: string
  pricingMode: 'EXCLUSIVE' | 'INCLUSIVE'
  notes: string
  terms: string
  reason: string
  freight: string
  freightTaxBps: number
  otherCharges: string
  otherChargesLabel: string
  otherChargesTaxBps: number
  sourceKind: DocumentKind | null
  sourceId: number | null
}

const today = () => new Date().toISOString().slice(0, 10)
let keySeq = 0
const newKey = () => `l${++keySeq}`
const emptyLine = (): LineState => ({ key: newKey(), productId: null, description: '', qty: '1', rate: '', discMode: 'PCT', disc: '', taxRateBps: null, sourceLineId: null, remainingMilli: null })
const tryNum = <T,>(fn: () => T): T | null => {
  try {
    return fn()
  } catch {
    return null
  }
}
const joinAddr = (...p: Array<string | null | undefined>) => p.filter((x) => x && x.trim()).join(', ')

export default function DocumentEditorPage({ side }: { side: Side }) {
  const { slug = '', id = '' } = useParams()
  const kind = kindBySlug(side, slug)
  if (!kind) return <Navigate to={sideRoot(side)} replace />
  return <Editor key={`${kind}-${id}`} side={side} kind={kind} idParam={id} />
}

function Editor({ side, kind, idParam }: { side: Side; kind: DocumentKind; idParam: string }) {
  const cfg = KINDS[kind]
  const isNew = idParam === 'new'
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const toast = useToast()
  const { session, can } = useSession()
  const perm = side === 'SALES' ? 'sales' : 'purchase'
  const canPost = can(`${perm}.post`)
  const isReturn = kind === 'SALES_RETURN' || kind === 'PURCHASE_RETURN'

  const lookups = useQuery<Lookups>(() => api('lookup:all'))
  const products = useQuery<Product[]>(() => api('product:list', {}))
  const parties = useQuery<Party[]>(() => (cfg.party === 'CUSTOMER' ? api('customer:list', {}) : api('supplier:list', {})))
  const [doc, setDoc] = useState<DocumentDetail | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [header, setHeader] = useState<HeaderState | null>(null)
  const [lines, setLines] = useState<LineState[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'validate' | 'post' | 'cancel' | 'delete' | 'convert' | 'pdf' | 'print'>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [confirmPost, setConfirmPost] = useState<ValidationResult | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const productMap = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const partyMap = useMemo(() => new Map((parties.data ?? []).map((p) => [p.id, p])), [parties.data])

  const fromDoc = useCallback((d: DocumentDetail) => {
    setDoc(d)
    setHeader({
      partyId: d.partyId, date: d.date, dueDate: d.dueDate ?? '', placeOfSupply: d.placeOfSupply, warehouseId: d.warehouseId ? String(d.warehouseId) : '',
      referenceNo: d.referenceNo ?? '', supplierRef: d.supplierRef ?? '', supplierRefDate: d.supplierRefDate ?? '', billingAddress: d.billingAddress ?? '',
      shippingAddress: d.shippingAddress ?? '', paymentTermsDays: String(d.paymentTermsDays ?? 0), pricingMode: d.pricingMode, notes: d.notes ?? '', terms: d.terms ?? '',
      reason: d.reason ?? '', freight: d.freightPaise ? paiseToRupeesString(d.freightPaise) : '', freightTaxBps: d.freightTaxBps || 1800,
      otherCharges: d.otherChargesPaise ? paiseToRupeesString(d.otherChargesPaise) : '', otherChargesLabel: d.otherChargesLabel ?? '', otherChargesTaxBps: d.otherChargesTaxBps || 1800,
      sourceKind: d.source?.kind ?? null, sourceId: d.source?.id ?? null
    })
    setLines(
      d.lines.map((l) => ({
        key: newKey(), productId: l.productId, description: l.description ?? '', qty: milliToString(l.qtyMilli), rate: paiseToRupeesString(l.ratePaise),
        discMode: l.discountBps != null ? 'PCT' : 'AMT', disc: l.discountBps != null ? (l.discountBps ? String(l.discountBps / 100) : '') : l.discountPaise ? paiseToRupeesString(l.discountPaise) : '',
        taxRateBps: l.taxRateBps, sourceLineId: l.sourceLineId, remainingMilli: l.sourceRemainingMilli
      }))
    )
    setErrors({})
    setFormError(null)
    setDirty(false)
  }, [])

  // Load an existing document, or initialise a new one.
  useEffect(() => {
    if (isNew) {
      setHeader({
        partyId: null, date: today(), dueDate: '', placeOfSupply: session?.company?.stateCode ?? '33', warehouseId: '', referenceNo: '', supplierRef: '', supplierRefDate: '',
        billingAddress: '', shippingAddress: '', paymentTermsDays: '', pricingMode: 'EXCLUSIVE', notes: '', terms: '', reason: '', freight: '', freightTaxBps: 1800,
        otherCharges: '', otherChargesLabel: '', otherChargesTaxBps: 1800, sourceKind: null, sourceId: null
      })
      setLines([emptyLine()])
      return
    }
    api('doc:get', { kind, id: Number(idParam) }).then(fromDoc).catch((e: ApiError) => setLoadError(e))
  }, [isNew, idParam, kind, fromDoc, session?.company?.stateCode])

  // Default warehouse for new documents; ?party= preselects the party.
  useEffect(() => {
    if (!isNew || !header || !lookups.data) return
    if (!header.warehouseId && lookups.data.warehouses[0]) setHeader((h) => h && { ...h, warehouseId: String(lookups.data!.warehouses[0].id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, lookups.data])
  useEffect(() => {
    const p = Number(params.get('party'))
    if (isNew && p && parties.data && header && !header.partyId) selectParty(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, parties.data])

  const editable = (doc?.status ?? 'DRAFT') === 'DRAFT' && canPost
  const party = header?.partyId ? (partyMap.get(header.partyId) ?? null) : null
  const companyState = session?.company?.stateCode ?? '33'
  const interState = party
    ? cfg.party === 'CUSTOMER'
      ? isInterStateSupply({ supplierState: companyState, placeOfSupply: header!.placeOfSupply, partyRegistrationType: party.gstRegistrationType })
      : isInterStateSupply({ supplierState: party.stateCode, placeOfSupply: header!.placeOfSupply, partyRegistrationType: party.gstRegistrationType })
    : false
  const lineLinked = !!header?.sourceKind && cfg.lineLinkedSource.includes(header.sourceKind)
  const pricingMode = isReturn ? 'EXCLUSIVE' : (header?.pricingMode ?? 'EXCLUSIVE')

  const set = <K extends keyof HeaderState>(k: K, v: HeaderState[K]) => {
    setHeader((h) => h && { ...h, [k]: v })
    setDirty(true)
    if (errors[k as string]) setErrors(({ [k as string]: _r, ...rest }) => rest)
  }

  function selectParty(id: number | null) {
    const p = id ? partyMap.get(id) : null
    setHeader((h) => {
      if (!h) return h
      if (!p) return { ...h, partyId: null }
      const c = p as Customer
      const s = p as Supplier
      return {
        ...h,
        partyId: p.id,
        placeOfSupply: cfg.party === 'CUSTOMER' ? (c.shippingStateCode ?? p.stateCode) : companyState,
        paymentTermsDays: String(cfg.party === 'CUSTOMER' ? (c.creditDays ?? 0) : (s.paymentTermsDays ?? 0)),
        billingAddress: joinAddr(p.addressLine1, p.addressLine2, p.city, p.pincode),
        shippingAddress: cfg.party === 'CUSTOMER' && c.shippingAddressLine1 ? joinAddr(c.shippingAddressLine1, c.shippingAddressLine2, c.shippingCity, c.shippingPincode) : ''
      }
    })
    setDirty(true)
    setErrors(({ partyId: _p, ...rest }) => rest)
  }

  const updateLine = (key: string, patch: Partial<LineState>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setDirty(true)
  }
  const selectProduct = (key: string, id: number | null) => {
    const p = id ? productMap.get(id) : null
    updateLine(key, p ? { productId: p.id, description: p.name, rate: paiseToRupeesString(side === 'SALES' ? p.salePricePaise : p.purchasePricePaise), taxRateBps: p.taxRateBps } : { productId: null })
  }
  const addLine = useCallback(() => {
    const l = emptyLine()
    setLines((ls) => [...ls, l])
    setFocusKey(l.key)
    setDirty(true)
  }, [])
  const removeLine = (key: string) => {
    setLines((ls) => ls.filter((l) => l.key !== key))
    setDirty(true)
  }

  // ───── Live tax calculation (same engine as the main process) ─────
  const computed = useMemo(() => {
    const results: Array<TaxLineResult | null> = lines.map((l) => {
      const qty = tryNum(() => toMilli(l.qty || '0'))
      const rate = tryNum(() => toPaise(l.rate || '0'))
      if (!l.productId || !qty || qty <= 0 || rate == null || l.taxRateBps == null) return null
      const discBps = l.discMode === 'PCT' ? tryNum(() => toBps(l.disc || '0')) : null
      const discPaise = l.discMode === 'AMT' ? tryNum(() => toPaise(l.disc || '0')) : 0
      return tryNum(() => computeTaxLine({ qtyMilli: qty, ratePaise: rate, discountBps: discBps, discountPaise: discPaise ?? 0, taxRateBps: l.taxRateBps! }, pricingMode, interState))
    })
    const freight = cfg.charges ? (tryNum(() => toPaise(header?.freight || '0')) ?? 0) : 0
    const other = cfg.charges ? (tryNum(() => toPaise(header?.otherCharges || '0')) ?? 0) : 0
    const valid = results.filter((r): r is TaxLineResult => !!r)
    // Footer = sum of per-line results + charges, rounded exactly as the server does.
    const sum = (k: keyof TaxLineResult) => valid.reduce((s, r) => s + r[k], 0)
    const charges = computeTaxDocument({ pricingMode: 'EXCLUSIVE', interState, lines: [], charges: [{ amountPaise: freight, taxRateBps: header?.freightTaxBps ?? 0 }, { amountPaise: other, taxRateBps: header?.otherChargesTaxBps ?? 0 }] }).totals
    const taxable = sum('taxablePaise') + charges.taxablePaise
    const cgst = sum('cgst') + charges.cgst
    const sgst = sum('sgst') + charges.sgst
    const igst = sum('igst') + charges.igst
    const exact = taxable + cgst + sgst + igst
    const grand = roundToRupee(exact)
    return { results, subtotal: sum('grossPaise'), discount: sum('discountPaise'), chargesPaise: charges.taxablePaise, taxable, cgst, sgst, igst, roundOff: grand - exact, grand }
  }, [lines, header?.freight, header?.otherCharges, header?.freightTaxBps, header?.otherChargesTaxBps, pricingMode, interState, cfg.charges])

  // ───── Save / validate / post ─────
  function buildPayload(): { payload: DocumentSaveInputT; map: number[] } | null {
    if (!header) return null
    const errs: Record<string, string> = {}
    const map: number[] = []
    const payloadLines: DocumentSaveInputT['lines'] = []
    lines.forEach((l, i) => {
      if (!l.productId) {
        if (l.qty !== '1' || l.rate || l.description) errs[`lines.${i}.productId`] = 'Select an item'
        return
      }
      const qty = tryNum(() => toMilli(l.qty))
      const rate = tryNum(() => toPaise(l.rate || '0'))
      const discBps = l.discMode === 'PCT' ? tryNum(() => toBps(l.disc || '0')) : null
      const discPaise = l.discMode === 'AMT' ? tryNum(() => toPaise(l.disc || '0')) : 0
      if (qty == null || qty <= 0) errs[`lines.${i}.qtyMilli`] = 'Enter a quantity'
      if (rate == null || rate < 0) errs[`lines.${i}.ratePaise`] = 'Enter a valid rate'
      if ((l.discMode === 'PCT' && discBps == null) || (l.discMode === 'AMT' && discPaise == null)) errs[`lines.${i}.discountPaise`] = 'Invalid discount'
      map.push(i)
      payloadLines.push({
        productId: l.productId, description: l.description, qtyMilli: qty ?? 0, ratePaise: rate ?? 0,
        discountBps: l.discMode === 'PCT' ? (discBps ?? 0) : null, discountPaise: l.discMode === 'AMT' ? (discPaise ?? 0) : 0,
        taxRateBps: l.taxRateBps, sourceLineId: l.sourceLineId
      })
    })
    const money = (v: string, field: string) => {
      const p = tryNum(() => toPaise(v || '0'))
      if (p == null || p < 0) errs[field] = 'Enter a valid amount'
      return p ?? 0
    }
    const terms = header.paymentTermsDays.trim()
    if (terms && !/^\d+$/.test(terms)) errs.paymentTermsDays = 'Enter whole days'
    const payload: DocumentSaveInputT = {
      kind, id: doc?.id, partyId: header.partyId, date: header.date, dueDate: header.dueDate || null, placeOfSupply: header.placeOfSupply || null,
      warehouseId: header.warehouseId ? Number(header.warehouseId) : null, referenceNo: header.referenceNo, supplierRef: header.supplierRef,
      supplierRefDate: header.supplierRefDate || null, billingAddress: header.billingAddress, shippingAddress: header.shippingAddress,
      paymentTermsDays: terms ? Number(terms) : null, pricingMode, notes: header.notes, terms: header.terms, reason: header.reason,
      freightPaise: cfg.charges ? money(header.freight, 'freightPaise') : 0, freightTaxBps: header.freightTaxBps,
      otherChargesPaise: cfg.charges ? money(header.otherCharges, 'otherChargesPaise') : 0, otherChargesLabel: header.otherChargesLabel, otherChargesTaxBps: header.otherChargesTaxBps,
      sourceKind: header.sourceKind, sourceId: header.sourceId, lines: payloadLines
    }
    if (Object.keys(errs).length) {
      setErrors(errs)
      setFormError('Please correct the highlighted fields')
      return null
    }
    return { payload, map }
  }

  /** Saves the draft; returns the saved document or null on error. Success is only shown after the main process confirms. */
  async function save(silent = false): Promise<DocumentDetail | null> {
    const built = buildPayload()
    if (!built) return null
    setBusy('save')
    setFormError(null)
    try {
      const saved = await api('doc:saveDraft', built.payload)
      fromDoc(saved)
      if (!silent) toast('success', `${cfg.label} draft saved`)
      if (isNew) navigate(docRoute(kind, saved.id), { replace: true })
      return saved
    } catch (e) {
      const err = e as ApiError
      const mapped: Record<string, string> = {}
      for (const [k, v] of Object.entries(err.fieldErrors ?? {})) {
        const m = /^lines\.(\d+)\.(.+)$/.exec(k)
        mapped[m ? `lines.${built.map[Number(m[1])] ?? m[1]}.${m[2]}` : k] = v
      }
      setErrors(mapped)
      setFormError(err.message)
      return null
    } finally {
      setBusy(null)
    }
  }

  async function validate(): Promise<ValidationResult | null> {
    const saved = dirty || !doc ? await save(true) : doc
    if (!saved) return null
    setBusy('validate')
    try {
      const v = await api('doc:validate', { kind, id: saved.id })
      setValidation(v)
      return v
    } catch (e) {
      setFormError((e as Error).message)
      return null
    } finally {
      setBusy(null)
    }
  }

  async function startPost() {
    const v = await validate()
    if (v?.ok) setConfirmPost(v)
  }

  async function post() {
    if (!doc) return
    setBusy('post')
    try {
      const posted = await api('doc:post', { kind, id: doc.id })
      fromDoc(posted)
      setConfirmPost(null)
      setValidation(null)
      toast('success', `${cfg.label} ${posted.number} posted`, cfg.ledger || cfg.stock !== 'NONE' ? 'Stock and ledger were updated.' : undefined)
    } catch (e) {
      setConfirmPost(null)
      setFormError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function cancelDoc() {
    if (!doc) return
    setBusy('cancel')
    try {
      const c = await api('doc:cancel', { kind, id: doc.id, reason: cancelReason })
      fromDoc(c)
      setCancelOpen(false)
      toast('success', `${cfg.label} ${c.number} cancelled`, c.reversalEntryNo ? `Reversal entry ${c.reversalEntryNo}` : undefined)
    } catch (e) {
      toast('error', 'Could not cancel', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteDoc() {
    if (!doc) return
    setBusy('delete')
    try {
      await api('doc:deleteDraft', { kind, id: doc.id })
      toast('success', 'Draft deleted')
      navigate(`${sideRoot(side)}/${cfg.slug}`)
    } catch (e) {
      toast('error', 'Could not delete draft', (e as Error).message)
      setBusy(null)
    }
  }

  async function convert(target: DocumentKind) {
    if (!doc) return
    setConvertOpen(false)
    setBusy('convert')
    try {
      const d = await api('doc:convert', { kind, id: doc.id, target })
      toast('success', `${KINDS[target].label} draft created from ${doc.number}`, 'Review and post it when ready.')
      navigate(docRoute(target, d.id))
    } catch (e) {
      toast('error', `Could not create ${KINDS[target].label.toLowerCase()}`, (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf() {
    if (!doc) return
    setBusy('pdf')
    try {
      const r = await api('doc:exportPdf', { kind, id: doc.id })
      if (r.path) toast('success', 'PDF saved', r.path)
    } catch (e) {
      toast('error', 'PDF export failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  async function print() {
    if (!doc) return
    setBusy('print')
    try {
      const r = await api('doc:print', { kind, id: doc.id })
      if (r.printed) toast('success', 'Sent to printer')
    } catch (e) {
      toast('error', 'Printing failed', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Keyboard: Ctrl+S save · Ctrl+Enter / Alt+N add line
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!editable) return
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      } else if (((e.ctrlKey || e.metaKey) && e.key === 'Enter') || (e.altKey && e.key.toLowerCase() === 'n')) {
        e.preventDefault()
        addLine()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editable, addLine])

  // ───── Render ─────
  if (loadError) return (<div><ModuleNav side={side} /><ErrorBanner error={loadError} /></div>)
  if (!header || !lookups.data || !products.data || !parties.data) return (<div><ModuleNav side={side} /><Spinner /></div>)

  const L = lookups.data
  const status = doc?.status ?? 'DRAFT'
  const productOptions: SelectOption[] = products.data
    .filter((p) => cfg.allowServices || p.itemType === 'GOODS')
    .map((p) => ({
      value: p.id,
      label: `${p.code} — ${p.name}`,
      sublabel: `${p.itemType === 'SERVICE' ? 'Service · SAC' : 'Goods · HSN'} ${p.hsnSac} · GST ${formatPercentBps(p.taxRateBps)}${p.trackInventory ? ` · Stock ${milliToString(p.stockQtyMilli)} ${p.unitCode}` : ''}`,
      keywords: `${p.hsnSac} ${p.categoryName ?? ''}`
    }))
  const partyOptions: SelectOption[] = parties.data.map((p) => ({ value: p.id, label: p.name, sublabel: `${p.code} · ${p.gstin ?? p.gstRegistrationType.toLowerCase()} · ${stateName(p.stateCode)}`, keywords: `${p.code} ${p.gstin ?? ''} ${p.city ?? ''}` }))
  const fy = tryNum(() => financialYearOf(header.date)) ?? '—'
  const E = errors
  const showWarehouse = cfg.stock !== 'NONE' || isInvoiceKind(kind)
  const convertTargets = cfg.converts.filter((t) => can(`${KINDS[t].side === 'SALES' ? 'sales' : 'purchase'}.post`))
  const canRecordPayment = doc && isInvoiceKind(kind) && status === 'POSTED' && doc.balanceDuePaise > 0 && canPost
  const title = isNew ? `New ${cfg.label.toLowerCase()}` : status === 'DRAFT' ? `${cfg.label} (draft)` : `${cfg.label} ${doc?.number}`

  return (
    <div>
      <ModuleNav side={side} />
      <PageHeader
        title={title}
        badge={
          <span className="flex items-center gap-1.5">
            <StatusBadge status={status} />
            {doc && <PaymentBadge status={doc.paymentStatus} />}
            {session?.company?.isDemo && <Badge tone="amber">DEMO</Badge>}
            {doc?.source && (
              <Link to={docRoute(doc.source.kind, doc.source.id)} className="ml-1 text-[12.5px] font-semibold text-brand-700 hover:underline">
                from {KINDS[doc.source.kind].label} {doc.source.number}
              </Link>
            )}
          </span>
        }
        description={cfg.description}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {editable && doc && <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleteOpen(true)} disabled={!!busy}>Delete draft</Button>}
            {editable && <Button variant="secondary" icon={<ShieldCheck className="size-4" />} loading={busy === 'validate'} onClick={() => void validate()} disabled={!!busy}>Validate</Button>}
            {editable && <Button variant="secondary" icon={<Save className="size-4" />} loading={busy === 'save'} onClick={() => void save()} disabled={!!busy} title="Ctrl+S">Save draft</Button>}
            {editable && <Button icon={<Send className="size-4" />} loading={busy === 'post'} onClick={() => void startPost()} disabled={!!busy}>Post…</Button>}
            {doc && status !== 'DRAFT' && <Button variant="secondary" icon={<Eye className="size-4" />} onClick={() => setPreviewOpen(true)}>Preview</Button>}
            {doc && status !== 'DRAFT' && <Button variant="secondary" icon={<Printer className="size-4" />} loading={busy === 'print'} onClick={() => void print()}>Print</Button>}
            {doc && status !== 'DRAFT' && <Button variant="secondary" icon={<FileDown className="size-4" />} loading={busy === 'pdf'} onClick={() => void exportPdf()}>Export PDF</Button>}
            {doc && status === 'POSTED' && convertTargets.length > 0 && (
              <div className="relative">
                <Button variant="secondary" icon={<ArrowRightLeft className="size-4" />} loading={busy === 'convert'} onClick={() => setConvertOpen((o) => !o)}>
                  Convert <ChevronDown className="size-3.5" />
                </Button>
                {convertOpen && (
                  <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-line bg-white py-1 shadow-xl">
                    {convertTargets.map((t) => (
                      <button key={t} onClick={() => void convert(t)} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-brand-50">→ {KINDS[t].label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {canRecordPayment && (
              <Button icon={<IndianRupee className="size-4" />} onClick={() => navigate(`${sideRoot(side)}/${paymentsSlug(side)}/new?party=${doc!.partyId}&invoice=${doc!.id}`)}>
                {side === 'SALES' ? 'Record receipt' : 'Record payment'}
              </Button>
            )}
            {doc && status === 'POSTED' && can(`${perm}.cancel`) && <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => (setCancelReason(''), setCancelOpen(true))}>Cancel…</Button>}
          </div>
        }
      />

      {formError && <ErrorBanner error={new Error(formError)} />}
      {validation && status === 'DRAFT' && <ValidationPanel v={validation} onClose={() => setValidation(null)} />}
      {status === 'CANCELLED' && doc && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          <strong>Cancelled</strong> on {formatDateTime(doc.cancelledAt)} — {doc.cancelReason}. Stock and ledger effects were reversed{doc.reversalEntryNo ? ` by ${doc.reversalEntryNo}` : ''}.
        </div>
      )}

      {/* ───── Header ───── */}
      <Card className="mb-4" bodyClassName="p-5">
        <fieldset disabled={!editable} className="grid grid-cols-4 gap-x-4 gap-y-3.5">
          <Field label={cfg.party === 'CUSTOMER' ? 'Customer' : 'Supplier'} required={cfg.partyRequired} error={E.partyId} className="col-span-2">
            <SearchSelect options={partyOptions} value={header.partyId} onChange={selectParty} disabled={!editable || (!!header.sourceId && !!doc?.source && isReturn)} invalid={!!E.partyId} placeholder={`Search ${cfg.party === 'CUSTOMER' ? 'customers' : 'suppliers'}…`} autoFocus={isNew && !params.get('party')} aria-label="Party" />
          </Field>
          <Field label="GSTIN">
            <Input value={party?.gstin ?? (party ? `Unregistered (${party.gstRegistrationType.toLowerCase()})` : '')} readOnly disabled className="font-mono" />
          </Field>
          <Field label={`${cfg.label} no.`}>
            <Input value={status === 'DRAFT' ? 'Assigned when posted' : (doc?.number ?? '')} readOnly disabled className="font-mono" />
          </Field>
          <Field label="Date" required error={E.date}>
            <Input type="date" value={header.date} onChange={(e) => set('date', e.target.value)} invalid={!!E.date} />
          </Field>
          <Field label="Financial year"><Input value={fy} readOnly disabled /></Field>
          <Field label={cfg.dueDateLabel} error={E.dueDate} hint={isInvoiceKind(kind) && !header.dueDate ? 'Defaults to date + payment terms' : undefined}>
            <Input type="date" value={header.dueDate} onChange={(e) => set('dueDate', e.target.value)} invalid={!!E.dueDate} />
          </Field>
          {isInvoiceKind(kind) ? (
            <Field label="Payment terms (days)" error={E.paymentTermsDays}>
              <Input value={header.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} inputMode="numeric" invalid={!!E.paymentTermsDays} />
            </Field>
          ) : (
            <Field label="Reference no." error={E.referenceNo}><Input value={header.referenceNo} onChange={(e) => set('referenceNo', e.target.value)} /></Field>
          )}
          <Field label="Place of supply" error={E.placeOfSupply} hint={party ? (interState ? 'Inter-state → IGST' : 'Intra-state → CGST + SGST') : undefined}>
            <Select value={header.placeOfSupply} onChange={(e) => set('placeOfSupply', e.target.value)}>
              {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.code} - {s.name}</option>)}
            </Select>
          </Field>
          {showWarehouse && (
            <Field label="Warehouse" error={E.warehouseId} required={cfg.stock !== 'NONE'}>
              <Select value={header.warehouseId} onChange={(e) => set('warehouseId', e.target.value)} invalid={!!E.warehouseId}>
                <option value="">Select…</option>
                {L.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
          )}
          {isInvoiceKind(kind) && <Field label="Reference no." error={E.referenceNo}><Input value={header.referenceNo} onChange={(e) => set('referenceNo', e.target.value)} placeholder="PO / order ref." /></Field>}
          {cfg.supplierRefLabel && (
            <>
              <Field label={cfg.supplierRefLabel} required={kind === 'PURCHASE_INVOICE'} error={E.supplierRef}>
                <Input value={header.supplierRef} onChange={(e) => set('supplierRef', e.target.value)} invalid={!!E.supplierRef} className="font-mono" />
              </Field>
              <Field label="Supplier doc. date" error={E.supplierRefDate}><Input type="date" value={header.supplierRefDate} onChange={(e) => set('supplierRefDate', e.target.value)} /></Field>
            </>
          )}
          {!isReturn && (
            <Field label="Prices" hint={header.pricingMode === 'INCLUSIVE' ? 'Rates include GST; tax is back-calculated' : 'Rates exclude GST'}>
              <Select value={header.pricingMode} onChange={(e) => set('pricingMode', e.target.value as HeaderState['pricingMode'])}>
                <option value="EXCLUSIVE">Exclusive of GST</option>
                <option value="INCLUSIVE">Inclusive of GST</option>
              </Select>
            </Field>
          )}
          {(isReturn || kind === 'CREDIT_NOTE' || kind === 'DEBIT_NOTE') && (
            <Field label="Reason" error={E.reason} className="col-span-2"><Input value={header.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Damaged goods, rate difference" /></Field>
          )}
          <Field label={cfg.party === 'CUSTOMER' ? 'Billing address' : 'Supplier address'} className="col-span-2" error={E.billingAddress}>
            <textarea value={header.billingAddress} onChange={(e) => set('billingAddress', e.target.value)} rows={2} className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50" />
          </Field>
          {cfg.party === 'CUSTOMER' && (
            <Field label="Shipping address" className="col-span-2" hint={!header.shippingAddress ? 'Same as billing' : undefined}>
              <textarea value={header.shippingAddress} onChange={(e) => set('shippingAddress', e.target.value)} rows={2} className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-brand-500 focus:ring-3 focus:ring-brand-100 focus:outline-none disabled:bg-slate-50" />
            </Field>
          )}
        </fieldset>
      </Card>

      {/* ───── Lines ───── */}
      <Card
        className="mb-4"
        title="Items"
        subtitle={`${pricingMode === 'INCLUSIVE' ? 'Rates include GST' : 'Rates exclude GST'} · ${interState ? 'IGST' : 'CGST + SGST'}${editable ? ' · Ctrl+Enter adds a line, Ctrl+S saves' : ''}`}
        bodyClassName="p-0"
        actions={editable && !isReturn ? <Button variant="secondary" icon={<Plus className="size-4" />} onClick={addLine}>Add line</Button> : undefined}
      >
        <div className="overflow-x-auto">
          <table className={cx('w-full text-[13px]', interState ? 'min-w-[960px]' : 'min-w-[1040px]')}>
            <thead>
              <tr className="bg-slate-50 text-left text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
                <th className="w-8 px-3 py-2">#</th>
                <th className="px-2 py-2">Item</th>
                <th className="w-20 px-2 py-2">HSN/SAC</th>
                <th className="w-24 px-2 py-2 text-right">Qty</th>
                <th className="w-28 px-2 py-2 text-right">Rate</th>
                <th className="w-28 px-2 py-2 text-right">Discount</th>
                <th className="w-24 px-2 py-2">GST</th>
                <th className="w-28 px-2 py-2 text-right">Taxable</th>
                {interState ? <th className="w-24 px-2 py-2 text-right">IGST</th> : (<><th className="w-24 px-2 py-2 text-right">CGST</th><th className="w-24 px-2 py-2 text-right">SGST</th></>)}
                <th className="w-28 px-2 py-2 text-right">Total</th>
                <th className="w-9" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const p = l.productId ? productMap.get(l.productId) : null
                const r = computed.results[i]
                const lockedProduct = !!l.sourceLineId && (isReturn || lineLinked)
                const lockedRate = isReturn && !!l.sourceLineId
                const le = (f: string) => E[`lines.${i}.${f}`]
                return (
                  <tr key={l.key} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 pt-4 text-ink-3">{i + 1}</td>
                    <td className="px-2 py-2">
                      <SearchSelect options={productOptions} value={l.productId} onChange={(v) => selectProduct(l.key, v)} disabled={!editable || lockedProduct} invalid={!!le('productId')} autoFocus={focusKey === l.key} placeholder="Search item, code or HSN…" aria-label={`Item line ${i + 1}`} />
                      <input value={l.description} onChange={(e) => updateLine(l.key, { description: e.target.value })} disabled={!editable} placeholder="Description" className="mt-1 h-7 w-full rounded-md border border-transparent px-2 text-[12px] text-ink-2 hover:border-line focus:border-brand-500 focus:outline-none disabled:bg-transparent" />
                      {le('productId') && <p className="mt-0.5 text-[11.5px] font-medium text-red-600">{le('productId')}</p>}
                      {l.remainingMilli != null && status === 'DRAFT' && <p className="mt-0.5 text-[11.5px] text-ink-3">Available from source: {milliToString(Math.max(0, l.remainingMilli))}</p>}
                    </td>
                    <td className="px-2 py-2 pt-4 font-mono text-[12px] text-ink-2">{p?.hsnSac ?? '—'}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Input value={l.qty} onChange={(e) => updateLine(l.key, { qty: e.target.value })} inputMode="decimal" invalid={!!le('qtyMilli')} className="h-9 text-right tabular" aria-label={`Quantity line ${i + 1}`} />
                      </div>
                      <p className="mt-0.5 text-right text-[11px] text-ink-3">{p?.unitCode ?? ''}</p>
                      {le('qtyMilli') && <p className="text-right text-[11.5px] font-medium text-red-600">{le('qtyMilli')}</p>}
                    </td>
                    <td className="px-2 py-2">
                      <Input value={l.rate} onChange={(e) => updateLine(l.key, { rate: e.target.value })} inputMode="decimal" disabled={!editable || lockedRate} invalid={!!le('ratePaise')} className="h-9 text-right tabular" aria-label={`Rate line ${i + 1}`} />
                      {le('ratePaise') && <p className="text-right text-[11.5px] font-medium text-red-600">{le('ratePaise')}</p>}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex">
                        <Input value={l.disc} onChange={(e) => updateLine(l.key, { disc: e.target.value })} inputMode="decimal" disabled={!editable || lockedRate} invalid={!!le('discountPaise')} className="h-9 rounded-r-none text-right tabular" aria-label={`Discount line ${i + 1}`} />
                        <button type="button" disabled={!editable || lockedRate} onClick={() => updateLine(l.key, { discMode: l.discMode === 'PCT' ? 'AMT' : 'PCT', disc: '' })} className="h-9 rounded-r-lg border border-l-0 border-line bg-slate-50 px-2 text-[12px] font-semibold text-ink-2 hover:bg-slate-100 disabled:opacity-60" title="Toggle percent / amount">
                          {l.discMode === 'PCT' ? '%' : '₹'}
                        </button>
                      </div>
                      {le('discountPaise') && <p className="text-right text-[11.5px] font-medium text-red-600">{le('discountPaise')}</p>}
                    </td>
                    <td className="px-2 py-2">
                      <Select value={l.taxRateBps ?? ''} onChange={(e) => updateLine(l.key, { taxRateBps: e.target.value === '' ? null : Number(e.target.value) })} disabled={!editable || lockedRate} invalid={!!le('taxRateBps')} className="h-9" aria-label={`GST line ${i + 1}`}>
                        <option value="">—</option>
                        {L.taxRates.map((t) => <option key={t.id} value={t.rateBps}>{formatPercentBps(t.rateBps)}</option>)}
                      </Select>
                    </td>
                    <td className="tabular px-2 py-2 pt-4 text-right">{r ? formatINR(r.taxablePaise) : '—'}{r && r.discountPaise > 0 && <p className="text-[11px] text-ink-3">−{formatINR(r.discountPaise)}</p>}</td>
                    {interState ? <td className="tabular px-2 py-2 pt-4 text-right">{r ? formatINR(r.igst) : '—'}</td> : (<><td className="tabular px-2 py-2 pt-4 text-right">{r ? formatINR(r.cgst) : '—'}</td><td className="tabular px-2 py-2 pt-4 text-right">{r ? formatINR(r.sgst) : '—'}</td></>)}
                    <td className="tabular px-2 py-2 pt-4 text-right font-semibold">{r ? formatINR(r.totalPaise) : '—'}</td>
                    <td className="py-2 pt-3 pr-2">
                      {editable && (
                        <button type="button" onClick={() => removeLine(l.key)} className="rounded p-1.5 text-ink-3 hover:bg-red-50 hover:text-red-600" aria-label={`Remove line ${i + 1}`}>
                          <X className="size-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {lines.length === 0 && (
                <tr><td colSpan={12} className="px-4 py-8 text-center text-ink-3">No lines. {editable && !isReturn && <button onClick={addLine} className="font-semibold text-brand-700 hover:underline">Add a line</button>}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ───── Footer ───── */}
      <div className="grid grid-cols-5 gap-4">
        <div className="col-span-3 space-y-4">
          {cfg.charges && (
            <Card title="Freight & other charges" subtitle="Freight on stocked goods is added to their inventory cost; otherwise it is expensed">
              <fieldset disabled={!editable} className="grid grid-cols-3 gap-3">
                <Field label="Freight (₹)" error={E.freightPaise}><Input value={header.freight} onChange={(e) => set('freight', e.target.value)} inputMode="decimal" className="text-right tabular" /></Field>
                <Field label="GST on freight" error={E.freightTaxBps}>
                  <Select value={header.freightTaxBps} onChange={(e) => set('freightTaxBps', Number(e.target.value))}>{L.taxRates.map((t) => <option key={t.id} value={t.rateBps}>{formatPercentBps(t.rateBps)}</option>)}</Select>
                </Field>
                <div />
                <Field label="Other charges" hint="e.g. packing, loading"><Input value={header.otherChargesLabel} onChange={(e) => set('otherChargesLabel', e.target.value)} placeholder="Label" /></Field>
                <Field label="Amount (₹)" error={E.otherChargesPaise}><Input value={header.otherCharges} onChange={(e) => set('otherCharges', e.target.value)} inputMode="decimal" className="text-right tabular" /></Field>
                <Field label="GST on charges" error={E.otherChargesTaxBps}><Select value={header.otherChargesTaxBps} onChange={(e) => set('otherChargesTaxBps', Number(e.target.value))}>{L.taxRates.map((t) => <option key={t.id} value={t.rateBps}>{formatPercentBps(t.rateBps)}</option>)}</Select></Field>
              </fieldset>
            </Card>
          )}
          <Card title="Notes & terms">
            <fieldset disabled={!editable} className="grid grid-cols-2 gap-3">
              <Field label="Notes (printed)"><textarea value={header.notes} onChange={(e) => set('notes', e.target.value)} rows={3} className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-brand-500 focus:outline-none disabled:bg-slate-50" /></Field>
              <Field label="Terms & conditions" hint={!header.terms && side === 'SALES' ? 'Company default terms are printed when empty' : undefined}>
                <textarea value={header.terms} onChange={(e) => set('terms', e.target.value)} rows={3} className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-brand-500 focus:outline-none disabled:bg-slate-50" />
              </Field>
            </fieldset>
          </Card>
          {doc && status !== 'DRAFT' && <TrailCard doc={doc} side={side} />}
          {doc && status !== 'DRAFT' && (kind === 'SALES_INVOICE' || kind === 'DELIVERY_CHALLAN' || kind === 'CREDIT_NOTE' || kind === 'SALES_RETURN') && <CompliancePanel kind={kind} id={doc.id} />}
        </div>
        <Card title="Summary" className="col-span-2 self-start">
          <dl className="tabular space-y-1.5 text-[13.5px]">
            <Row label="Subtotal" value={formatINR(computed.subtotal)} />
            <Row label="Total discount" value={computed.discount ? `−${formatINR(computed.discount)}` : formatINR(0)} />
            {cfg.charges && <Row label="Freight & charges" value={formatINR(computed.chargesPaise)} />}
            <Row label="Total taxable value" value={formatINR(computed.taxable)} strong />
            {interState ? <Row label="IGST" value={formatINR(computed.igst)} /> : (<><Row label="CGST" value={formatINR(computed.cgst)} /><Row label="SGST" value={formatINR(computed.sgst)} /></>)}
            <Row label="Round off" value={formatINR(computed.roundOff)} />
            <div className="my-2 border-t-2 border-navy-900" />
            <Row label="Grand total" value={formatINR(computed.grand)} big />
            {doc && isInvoiceKind(kind) && status === 'POSTED' && (
              <>
                <div className="my-2 border-t border-line" />
                <Row label={side === 'SALES' ? 'Amount received' : 'Amount paid'} value={formatINR(doc.settledPaise)} />
                <Row label="Balance due" value={formatINR(doc.balanceDuePaise)} strong />
              </>
            )}
            {doc && status === 'POSTED' && Math.abs(doc.grandTotalPaise - computed.grand) > 0 && <p className="text-[11.5px] text-amber-700">Stored total: {formatINR(doc.grandTotalPaise)}</p>}
          </dl>
        </Card>
      </div>

      <ConfirmDialog
        open={!!confirmPost}
        title={`Post ${cfg.label.toLowerCase()}?`}
        confirmLabel={`Post ${cfg.label.toLowerCase()}`}
        busy={busy === 'post'}
        onConfirm={() => void post()}
        onClose={() => setConfirmPost(null)}
      >
        <p className="text-[13.5px] text-ink-2">Posting assigns the next {cfg.label.toLowerCase()} number and cannot be undone. Corrections require a {cfg.ledger ? 'cancellation by reversal or a credit/debit note' : 'cancellation'}.</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
          <KeyValue label={cfg.party === 'CUSTOMER' ? 'Customer' : 'Supplier'} value={party?.name ?? '—'} />
          <KeyValue label="Grand total" value={<strong>{formatINR(doc?.grandTotalPaise ?? computed.grand)}</strong>} />
          <KeyValue label="Date" value={formatDate(header.date)} />
          <KeyValue label="Supply" value={interState ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'} />
        </dl>
        <h4 className="mt-4 mb-1.5 text-[12px] font-bold tracking-wider text-ink-3 uppercase">Effects</h4>
        <ul className="space-y-1 text-[13px] text-ink-2">{effectsOf(kind, lineLinked, lines.some((l) => l.productId && productMap.get(l.productId)?.trackInventory)).map((e) => <li key={e}>• {e}</li>)}</ul>
        {confirmPost && confirmPost.warnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
            {confirmPost.warnings.map((w) => <p key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}
          </div>
        )}
      </ConfirmDialog>

      <Modal
        open={cancelOpen}
        title={`Cancel ${cfg.label.toLowerCase()} ${doc?.number ?? ''}?`}
        onClose={() => setCancelOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>Back</Button>
            <Button variant="danger" loading={busy === 'cancel'} disabled={cancelReason.trim().length < 3} onClick={() => void cancelDoc()}>Cancel by reversal</Button>
          </>
        }
      >
        <p className="text-[13.5px] text-ink-2">The document keeps its number and is marked cancelled. A reversing journal is posted and any stock movement is reversed at its original value. This cannot be undone.</p>
        <Field label="Reason" required className="mt-3"><Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} autoFocus placeholder="e.g. Raised against the wrong customer" /></Field>
      </Modal>

      <ConfirmDialog open={deleteOpen} title="Delete this draft?" confirmLabel="Delete draft" danger busy={busy === 'delete'} onConfirm={() => void deleteDoc()} onClose={() => setDeleteOpen(false)}>
        <p className="text-[13.5px] text-ink-2">Drafts have no stock or accounting effect. The deletion is recorded in the audit log.</p>
      </ConfirmDialog>

      {doc && status !== 'DRAFT' && <DocumentPreview kind={kind} id={doc.id} open={previewOpen} onClose={() => setPreviewOpen(false)} />}
    </div>
  )
}

function Row({ label, value, strong, big }: { label: string; value: string; strong?: boolean; big?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={cx('text-ink-2', (strong || big) && 'font-semibold text-ink')}>{label}</dt>
      <dd className={cx(strong && 'font-semibold', big && 'text-[19px] font-bold text-ink')}>{value}</dd>
    </div>
  )
}

function ValidationPanel({ v, onClose }: { v: ValidationResult; onClose: () => void }) {
  return (
    <div className={cx('mb-4 rounded-lg border px-4 py-3 text-[13px]', v.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900')} role="status">
      <div className="flex items-start gap-2">
        {v.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
        <div className="flex-1">
          <p className="font-semibold">{v.ok ? 'Validation passed — ready to post' : `${v.errors.length} issue${v.errors.length > 1 ? 's' : ''} must be fixed before posting`}</p>
          {v.errors.map((e) => <p key={e}>• {e}</p>)}
          {v.warnings.map((w) => <p key={w} className="text-amber-800">⚠ {w}</p>)}
        </div>
        <button onClick={onClose} aria-label="Dismiss"><X className="size-4" /></button>
      </div>
    </div>
  )
}

function TrailCard({ doc, side }: { doc: DocumentDetail; side: Side }) {
  return (
    <Card title="Document trail">
      <dl className="grid grid-cols-2 gap-3">
        <KeyValue label="Posted" value={formatDateTime(doc.postedAt)} />
        <KeyValue label="Journal entry" value={doc.journalEntryNo ? <span className="font-mono">{doc.journalEntryNo}</span> : 'No ledger effect'} />
        {doc.reversalEntryNo && <KeyValue label="Reversal entry" value={<span className="font-mono">{doc.reversalEntryNo}</span>} />}
        {doc.source && <KeyValue label="Created from" value={<Link className="font-mono text-brand-700 hover:underline" to={docRoute(doc.source.kind, doc.source.id)}>{doc.source.number}</Link>} />}
      </dl>
      {doc.children.length > 0 && (
        <div className="mt-3">
          <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">Created from this document</p>
          <ul className="mt-1 space-y-1">
            {doc.children.map((c) => (
              <li key={`${c.kind}-${c.id}`} className="flex items-center gap-2 text-[13px]">
                <Link className="font-mono font-semibold text-brand-700 hover:underline" to={docRoute(c.kind, c.id)}>{c.status === 'DRAFT' ? `Draft #${c.id}` : c.number}</Link>
                <span className="text-ink-3">{KINDS[c.kind].label} · {formatDate(c.date)}</span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {doc.allocations.length > 0 && (
        <div className="mt-3">
          <p className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">{side === 'SALES' ? 'Receipts & credits applied' : 'Payments & debits applied'}</p>
          <table className="mt-1 w-full text-[13px]">
            <tbody>
              {doc.allocations.map((a) => (
                <tr key={`${a.sourceType}-${a.sourceId}`} className="border-t border-slate-100">
                  <td className="py-1.5 font-mono">{a.number}</td>
                  <td className="py-1.5 text-ink-3">{a.sourceType.replace('_', ' ').toLowerCase()}</td>
                  <td className="py-1.5 text-ink-3">{formatDate(a.date)}</td>
                  <td className="tabular py-1.5 text-right font-semibold">{formatINR(a.amountPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function effectsOf(kind: DocumentKind, fromChallan: boolean, hasStockedGoods: boolean): string[] {
  const list = effectsFor(kind, fromChallan)
  return hasStockedGoods ? list : list.filter((e) => !/stock/i.test(e)).concat(KINDS[kind].stock !== 'NONE' ? ['No stock effect: no stocked goods on this document'] : [])
}

function effectsFor(kind: DocumentKind, fromChallan: boolean): string[] {
  switch (kind) {
    case 'SALES_QUOTATION':
    case 'SALES_ORDER':
    case 'PURCHASE_REQUISITION':
    case 'PURCHASE_ORDER':
      return ['No stock or accounting effect', 'Can be converted into the next document']
    case 'DELIVERY_CHALLAN':
      return ['Stock of goods reduced in the selected warehouse', 'Dr Cost of Goods Sold / Cr Stock in Hand at moving-average cost']
    case 'SALES_INVOICE':
      return [
        'Dr Sundry Debtors (customer) with the grand total',
        'Cr Sales (goods / services) and Output CGST, SGST or IGST',
        fromChallan ? 'No stock change for lines already dispatched by the delivery challan' : 'Stock of goods reduced; Dr COGS / Cr Stock in Hand at moving-average cost'
      ]
    case 'SALES_RETURN':
      return ['Returned goods added back to stock at original cost (Dr Stock / Cr COGS)', 'Dr Sales Returns and Output GST / Cr customer', 'Reduces the balance of the original invoice']
    case 'CREDIT_NOTE':
      return ['Dr Sales Returns & Allowances and Output GST / Cr customer', 'No stock effect; reduces the original invoice balance']
    case 'GOODS_RECEIPT':
      return ['Stock of goods increased at order value', 'Dr Stock in Hand / Cr Goods Received Not Invoiced']
    case 'PURCHASE_INVOICE':
      return [
        'Cr Sundry Creditors (supplier) with the grand total',
        'Dr Stock in Hand for goods (incl. freight); Dr expenses for services and charges',
        'Dr Input CGST, SGST or IGST',
        'Lines received through a GRN clear Goods Received Not Invoiced instead of adding stock again'
      ]
    case 'PURCHASE_RETURN':
      return ['Goods removed from stock at original cost', 'Dr supplier / Cr Stock in Hand and Input GST', 'Reduces the balance of the original bill']
    case 'DEBIT_NOTE':
      return ['Dr supplier / Cr Purchase Returns & Allowances and Input GST', 'No stock effect; reduces the original bill balance']
  }
}
