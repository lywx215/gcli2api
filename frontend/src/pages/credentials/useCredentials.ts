import { useEffect, useRef, useState } from 'react'
import { api, failureMessage, withdrawnCapability } from './api'
import { Generation, initialFilters, materialize, supportedFilters, toggleSelection, type Capabilities, type CredentialPage, type Filters } from './model'
export function useCredentials() {
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const [offset, setOffset] = useState(0); const [limit, setLimit] = useState(25)
  const [data, setData] = useState<CredentialPage | null>(null); const [caps, setCaps] = useState<Capabilities>(new Set())
  const capsRef = useRef(caps); const discovered = useRef(false); const denied = useRef(new Set<string>())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0); const [detailEpoch, setDetailEpoch] = useState(0)
  const [materializing, setMaterializing] = useState(false); const [progress, setProgress] = useState(0)
  const reads = useRef(new Generation()); const tasks = useRef(new Generation()); const session = useRef(new Generation())
  const controller = useRef<AbortController | null>(null)
  const cancelSelection = () => { tasks.current.invalidate(); setMaterializing(false) }
  const clearScope = () => { cancelSelection(); setSelected(new Set()); setDetailEpoch(v => v + 1) }
  function acceptCapabilities(advertised: Capabilities) {
    const next = new Set([...advertised].filter(cap => !denied.current.has(cap)))
    const changed = discovered.current && [...capsRef.current].some(c => !next.has(c))
    capsRef.current = next; discovered.current = true; setCaps(next)
    if (changed) { clearScope(); setData(null); setNotice('服务能力已撤回；旧选择、详情和任务已清除。'); const normalized = supportedFilters(filters, next); if (JSON.stringify(normalized) !== JSON.stringify(filters)) { setFilters(normalized); setOffset(0) } }
    return changed
  }
  const revoke = (e: unknown) => {
    const cap = withdrawnCapability(e)
    if (!cap || denied.current.has(cap)) return false
    denied.current.add(cap)
    const next = new Set(capsRef.current); next.delete(cap); acceptCapabilities(next); setRefresh(v => v + 1); return true
  }
  useEffect(() => () => { session.current.invalidate(); reads.current.invalidate(); tasks.current.invalidate(); controller.current?.abort() }, [])
  useEffect(() => {
    reads.current.invalidate(); const valid = reads.current.capture(); const active = session.current.capture()
    const c = new AbortController(); controller.current = c; setLoading(true); setError(''); setData(null)
    void (async () => {
      try {
        const page = await api.list(filters, capsRef.current, offset, limit, c.signal)
        if (!valid() || !active()) return
        acceptCapabilities(page.caps)
        if (JSON.stringify(supportedFilters(filters, capsRef.current)) !== JSON.stringify(filters)) return
        setData({ ...page, caps: capsRef.current })
        if (offset > 0 && !page.items.length && page.total <= offset) setOffset(Math.max(0, Math.ceil(page.total / limit) - 1) * limit)
      } catch (e) {
        if (!valid() || !active() || c.signal.aborted) return
        if (!revoke(e)) setError(failureMessage(e))
      } finally { if (valid() && active()) setLoading(false) }
    })()
    return () => { c.abort(); reads.current.invalidate() }
    // Capability changes are processed against the response rather than issuing an extra probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, offset, limit, refresh])
  function applyFilters(next: Filters) { reads.current.invalidate(); controller.current?.abort(); clearScope(); setData(null); setFilters(supportedFilters(next, capsRef.current)); setOffset(0) }
  function invalidateReads() { reads.current.invalidate(); controller.current?.abort(); setData(null) }
  async function selectAll() {
    cancelSelection(); const valid = tasks.current.capture(); const active = session.current.capture(); setMaterializing(true); setProgress(0); setError('')
    try {
      const result = await materialize(async (offset, limit) => {
        const page = await api.list(filters, capsRef.current, offset, limit)
        if (valid() && active()) acceptCapabilities(page.caps)
        return page
      }, () => valid() && active(), setProgress)
      if (result && valid() && active()) { setSelected(result); setNotice('已按分页读取物化文件集合；读取期间列表可能变化，此集合不是原子快照。') }
    } catch (e) { if (valid() && active() && !revoke(e)) setError(failureMessage(e)) }
    finally { if (valid() && active()) setMaterializing(false) }
  }
  return { data, caps, filters, offset, limit, selected, loading, error, notice, detailEpoch, materializing, progress,
    applyFilters, selectAll, cancelSelection, revoke, invalidateReads, setNotice,
    captureTask: () => { const a = session.current.capture(); const b = tasks.current.capture(); return () => a() && b() },
    refresh: () => { invalidateReads(); setRefresh(v => v + 1) },
    setOffset: (value: number) => { reads.current.invalidate(); setOffset(value) },
    setLimit: (value: number) => { reads.current.invalidate(); setLimit(value); setOffset(0) },
    toggle: (names: string[], checked: boolean) => { cancelSelection(); setSelected(s => toggleSelection(s, names, checked)) },
    clearSelection: () => { cancelSelection(); setSelected(new Set()) },
  }
}
export type CredentialController = ReturnType<typeof useCredentials>
