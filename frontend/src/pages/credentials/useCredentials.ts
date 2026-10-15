import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { getSessionSnapshot, getSessionValidationSnapshot, useAuth } from '@/auth'
import {
  getPanelChannelSnapshot,
  isPanelScopeCurrent,
  subscribePanelChannel,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { createCredentialApi, failureMessage, withdrawnCapability } from './api'
import {
  Generation,
  initialFilters,
  materialize,
  supportedFilters,
  toggleSelection,
  type Capabilities,
  type CredentialPage,
  type Filters,
} from './model'

export function useCredentials(mode: PanelMode = 'antigravity') {
  const { authenticated, sessionEpoch } = useAuth()
  const channelSnapshot = useSyncExternalStore(subscribePanelChannel, getPanelChannelSnapshot)

  const authRef = useRef({ authenticated, sessionEpoch })
  authRef.current = { authenticated, sessionEpoch }

  const isVerifiedOwner = authenticated && mode === channelSnapshot.mode

  const scope: PanelScope | null = isVerifiedOwner
    ? Object.freeze({
        mode,
        channelEpoch: channelSnapshot.channelEpoch,
        sessionEpoch,
      })
    : null

  const scopeKey = scope ? `${mode}:${scope.channelEpoch}:${scope.sessionEpoch}` : null

  const isScopeValid = (targetScope: PanelScope | null): targetScope is PanelScope => {
    if (!targetScope) return false
    if (!authRef.current.authenticated) return false
    const currentSession = getSessionSnapshot()
    const currentValidation = getSessionValidationSnapshot()
    const isAuthVerified =
      currentSession.token !== null &&
      currentValidation.sessionEpoch === currentSession.sessionEpoch &&
      currentValidation.status === 'verified' &&
      currentSession.sessionEpoch === targetScope.sessionEpoch
    if (!isAuthVerified) return false
    return isPanelScopeCurrent(targetScope, targetScope.sessionEpoch)
  }

  const [filters, setFilters] = useState<Filters>(() => supportedFilters(initialFilters, new Set(), mode))
  const [offset, setOffsetState] = useState(0)
  const [limit, setLimitState] = useState(25)
  const [data, setData] = useState<CredentialPage | null>(null)
  const [caps, setCaps] = useState<Capabilities>(new Set())
  const capsRef = useRef(caps)
  const discovered = useRef(false)
  const denied = useRef(new Set<string>())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(isVerifiedOwner)
  const [error, setError] = useState('')
  const [notice, setNoticeState] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [detailEpoch, setDetailEpoch] = useState(0)
  const [materializing, setMaterializing] = useState(false)
  const [progress, setProgress] = useState(0)

  const reads = useRef(new Generation())
  const tasks = useRef(new Generation())
  const session = useRef(new Generation())
  const controller = useRef<AbortController | null>(null)

  // Scope identity replacement guard
  const [prevScopeKey, setPrevScopeKey] = useState<string | null>(scopeKey)
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey)
    session.current.invalidate()
    reads.current.invalidate()
    tasks.current.invalidate()
    controller.current?.abort()
    controller.current = null
    capsRef.current = new Set()
    discovered.current = false
    denied.current.clear()
    setData(null)
    setCaps(new Set())
    setSelected(new Set())
    setNoticeState('')
    setProgress(0)
    setMaterializing(false)
    setLoading(isVerifiedOwner)
    setError('')
    setDetailEpoch(v => v + 1)
    setOffsetState(0)
    const normalized = supportedFilters(filters, new Set(), mode)
    if (JSON.stringify(normalized) !== JSON.stringify(filters)) {
      setFilters(normalized)
    }
  }

  const cancelSelection = () => {
    if (!isScopeValid(scope)) return
    tasks.current.invalidate()
    setMaterializing(false)
  }

  const clearScope = () => {
    cancelSelection()
    setSelected(new Set())
    setDetailEpoch(v => v + 1)
  }

  function acceptCapabilities(advertised: Capabilities) {
    if (!isScopeValid(scope)) return false
    const next = new Set([...advertised].filter(cap => !denied.current.has(cap)))
    const changed = discovered.current && [...capsRef.current].some(c => !next.has(c))
    capsRef.current = next
    discovered.current = true
    setCaps(next)
    if (changed) {
      clearScope()
      setData(null)
      setNoticeState('服务能力已撤回；旧选择、详情和任务已清除。')
      const normalized = supportedFilters(filters, next, mode)
      if (JSON.stringify(normalized) !== JSON.stringify(filters)) {
        setFilters(normalized)
        setOffsetState(0)
      }
    }
    return changed
  }

  const revoke = (e: unknown) => {
    if (!isScopeValid(scope)) return false
    const cap = withdrawnCapability(e, mode)
    if (!cap || denied.current.has(cap)) return false
    denied.current.add(cap)
    const next = new Set(capsRef.current)
    next.delete(cap)
    acceptCapabilities(next)
    setRefresh(v => v + 1)
    return true
  }

  useEffect(() => () => {
    session.current.invalidate()
    reads.current.invalidate()
    tasks.current.invalidate()
    controller.current?.abort()
  }, [])

  useEffect(() => {
    if (!isScopeValid(scope)) {
      return
    }
    reads.current.invalidate()
    const valid = reads.current.capture()
    const active = session.current.capture()
    const c = new AbortController()
    controller.current = c
    setLoading(true)
    setError('')
    setData(null)
    const currentScope = scope
    const boundApi = createCredentialApi(mode, currentScope)
    void (async () => {
      try {
        const page = await boundApi.list(filters, capsRef.current, offset, limit, c.signal)
        if (!isScopeValid(currentScope) || !valid() || !active() || c.signal.aborted) return
        acceptCapabilities(page.caps)
        if (JSON.stringify(supportedFilters(filters, capsRef.current, mode)) !== JSON.stringify(filters)) return
        setData({ ...page, caps: capsRef.current })
        if (offset > 0 && !page.items.length && page.total <= offset) {
          setOffsetState(Math.max(0, Math.ceil(page.total / limit) - 1) * limit)
        }
      } catch (e) {
        if (!isScopeValid(currentScope) || !valid() || !active() || c.signal.aborted) return
        if (!revoke(e)) setError(failureMessage(e))
      } finally {
        if (isScopeValid(currentScope) && valid() && active()) setLoading(false)
      }
    })()
    return () => {
      c.abort()
      reads.current.invalidate()
    }
    // Capability changes are processed against the response rather than issuing an extra probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, offset, limit, refresh, scopeKey])

  function applyFilters(next: Filters) {
    if (!isScopeValid(scope)) return
    reads.current.invalidate()
    controller.current?.abort()
    clearScope()
    setData(null)
    setFilters(supportedFilters(next, capsRef.current, mode))
    setOffsetState(0)
  }

  function invalidateReads() {
    if (!isScopeValid(scope)) return
    reads.current.invalidate()
    controller.current?.abort()
    setData(null)
  }

  async function selectAll() {
    if (!isScopeValid(scope)) return
    cancelSelection()
    const valid = tasks.current.capture()
    const active = session.current.capture()
    const currentScope = scope
    const guard = () => isScopeValid(currentScope) && valid() && active()
    const boundApi = createCredentialApi(mode, currentScope)
    setMaterializing(true)
    setProgress(0)
    setError('')
    try {
      const result = await materialize(
        async (pageOffset, pageLimit) => {
          if (!guard()) throw new DOMException('作用域已变更。', 'AbortError')
          const page = await boundApi.list(filters, capsRef.current, pageOffset, pageLimit)
          if (guard()) acceptCapabilities(page.caps)
          return page
        },
        () => guard(),
        count => {
          if (guard()) setProgress(count)
        }
      )
      if (result && guard()) {
        setSelected(result)
        setNoticeState('已按分页读取物化文件集合；读取期间列表可能变化，此集合不是原子快照。')
      }
    } catch (e) {
      if (guard() && !revoke(e)) setError(failureMessage(e))
    } finally {
      if (guard()) setMaterializing(false)
    }
  }

  const setNotice: Dispatch<SetStateAction<string>> = (value: SetStateAction<string>) => {
    if (!isScopeValid(scope)) return
    setNoticeState(value)
  }

  return {
    data: isVerifiedOwner ? data : null,
    caps: isVerifiedOwner ? caps : new Set<string>(),
    filters: isVerifiedOwner ? filters : supportedFilters(filters, new Set(), mode),
    offset: isVerifiedOwner ? offset : 0,
    limit,
    selected: isVerifiedOwner ? selected : new Set<string>(),
    loading: isVerifiedOwner ? loading : false,
    error: isVerifiedOwner ? error : '',
    notice: isVerifiedOwner ? notice : '',
    detailEpoch,
    materializing: isVerifiedOwner ? materializing : false,
    progress: isVerifiedOwner ? progress : 0,
    applyFilters,
    selectAll,
    cancelSelection,
    revoke,
    invalidateReads,
    setNotice,
    captureTask: () => {
      if (!isScopeValid(scope)) return () => false
      const currentScope = scope
      const a = session.current.capture()
      const b = tasks.current.capture()
      return () => isScopeValid(currentScope) && a() && b()
    },
    refresh: () => {
      if (!isScopeValid(scope)) return
      invalidateReads()
      setRefresh(v => v + 1)
    },
    setOffset: (value: number) => {
      if (!isScopeValid(scope)) return
      reads.current.invalidate()
      setOffsetState(value)
    },
    setLimit: (value: number) => {
      if (!isScopeValid(scope)) return
      reads.current.invalidate()
      setLimitState(value)
      setOffsetState(0)
    },
    toggle: (names: string[], checked: boolean) => {
      if (!isScopeValid(scope)) return
      cancelSelection()
      setSelected(s => toggleSelection(s, names, checked))
    },
    clearSelection: () => {
      if (!isScopeValid(scope)) return
      cancelSelection()
      setSelected(new Set())
    },
  }
}

export type CredentialController = ReturnType<typeof useCredentials>
