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
  CAP,
  Generation,
  initialFilters,
  materialize,
  supportedFilters,
  toggleSelection,
  type Capabilities,
  type CredentialPage,
  type Filters,
} from './model'

function extractAntigravityDeadlines(page: CredentialPage | null): number[] {
  if (!page) return []
  const deadlines: number[] = []
  const stats = page.stats
  if (stats && typeof stats.quota_next_expiry === 'number') {
    const val = stats.quota_next_expiry
    if (Number.isFinite(val) && val > 0) {
      const ms = val * 1000
      if (Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) && ms <= 8640000000000000) {
        deadlines.push(val)
      }
    }
  }
  if (Array.isArray(page.items)) {
    for (const item of page.items) {
      if (item && typeof item === 'object' && item.quota_groups && typeof item.quota_groups === 'object' && !Array.isArray(item.quota_groups)) {
        for (const grp of Object.values(item.quota_groups as Record<string, unknown>)) {
          if (grp && typeof grp === 'object' && !Array.isArray(grp)) {
            const until = (grp as Record<string, unknown>).cooldownUntil
            if (typeof until === 'number' && Number.isFinite(until) && until > 0) {
              const ms = until * 1000
              if (Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) && ms <= 8640000000000000) {
                deadlines.push(until)
              }
            }
          }
        }
      }
    }
  }
  return deadlines
}

interface ExpiryActor {
  readonly id: number
  disposed: boolean
  generation: number
  timer: ReturnType<typeof setTimeout> | null
  controller: AbortController | null
  inFlight: boolean
  cancel: () => void
}

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
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiryAbortRef = useRef<AbortController | null>(null)
  const expiryInFlightRef = useRef(false)
  const consumedDeadlinesRef = useRef<Set<number>>(new Set())
  const maxConsumedDeadlineRef = useRef<number>(0)
  const lastExpiryReadTimeRef = useRef<number>(0)
  const activeExpiryActorRef = useRef<ExpiryActor | null>(null)
  const actorSeqRef = useRef<number>(0)

  // Scope identity replacement guard
  const [prevScopeKey, setPrevScopeKey] = useState<string | null>(scopeKey)
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey)
    session.current.invalidate()
    reads.current.invalidate()
    tasks.current.invalidate()
    controller.current?.abort()
    controller.current = null
    activeExpiryActorRef.current?.cancel()
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
    expiryAbortRef.current?.abort()
    expiryAbortRef.current = null
    expiryInFlightRef.current = false
    consumedDeadlinesRef.current.clear()
    maxConsumedDeadlineRef.current = 0
    lastExpiryReadTimeRef.current = 0
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
    activeExpiryActorRef.current?.cancel()
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
    expiryAbortRef.current?.abort()
    expiryAbortRef.current = null
    expiryInFlightRef.current = false
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

  const isDeadlineConsumed = (d: number): boolean => {
    return (
      consumedDeadlinesRef.current.has(d) ||
      (maxConsumedDeadlineRef.current > 0 && d <= maxConsumedDeadlineRef.current)
    )
  }

  const markDeadlinesConsumed = (deadlines: number[]) => {
    for (const d of deadlines) {
      consumedDeadlinesRef.current.add(d)
      if (d > maxConsumedDeadlineRef.current) {
        maxConsumedDeadlineRef.current = d
      }
    }
    if (consumedDeadlinesRef.current.size > 200) {
      for (const d of consumedDeadlinesRef.current) {
        if (d <= maxConsumedDeadlineRef.current) {
          consumedDeadlinesRef.current.delete(d)
        }
      }
    }
  }

  useEffect(() => {
    if (mode !== 'antigravity') return
    if (!isVerifiedOwner || !isScopeValid(scope)) return
    if (!capsRef.current.has(CAP.group)) return

    const currentScope = scope
    const capturedOffset = offset
    const capturedLimit = limit
    const capturedFilters = filters

    actorSeqRef.current += 1
    const actorId = actorSeqRef.current

    const actor: ExpiryActor = {
      id: actorId,
      disposed: false,
      generation: 0,
      timer: null,
      controller: null,
      inFlight: false,
      cancel: () => {
        actor.disposed = true
        actor.generation += 1
        if (actor.timer !== null) {
          const t = actor.timer
          clearTimeout(t)
          actor.timer = null
          if (expiryTimerRef.current === t) {
            expiryTimerRef.current = null
          }
        }
        if (actor.controller !== null) {
          const c = actor.controller
          c.abort()
          actor.controller = null
          if (expiryAbortRef.current === c) {
            expiryAbortRef.current = null
          }
        }
        if (actor.inFlight) {
          actor.inFlight = false
          if (activeExpiryActorRef.current === actor) {
            expiryInFlightRef.current = false
          }
        }
        if (activeExpiryActorRef.current === actor) {
          activeExpiryActorRef.current = null
        }
      },
    }

    if (activeExpiryActorRef.current !== null && activeExpiryActorRef.current !== actor) {
      activeExpiryActorRef.current.cancel()
    }
    activeExpiryActorRef.current = actor

    const scheduleFutureWakeup = (unconsumed: number[], nowMs: number) => {
      const future = unconsumed.filter(d => d * 1000 > nowMs)
      if (future.length === 0) return

      const earliestSec = Math.min(...future)
      const delayMs = earliestSec * 1000 - nowMs
      const boundedDelay = Math.min(Math.max(0, delayMs), 2147483647)
      const timerGen = actor.generation
      const timer = setTimeout(() => {
        if (actor.timer === timer) {
          actor.timer = null
        }
        if (expiryTimerRef.current === timer) {
          expiryTimerRef.current = null
        }
        if (actor.disposed || actor.generation !== timerGen) return
        if (!isScopeValid(currentScope)) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        if (activeExpiryActorRef.current !== actor) return
        const currentValid = reads.current.capture()
        const currentActive = session.current.capture()
        if (!currentValid() || !currentActive()) return
        checkAndSchedule()
      }, boundedDelay)
      actor.timer = timer
      expiryTimerRef.current = timer
    }

    const reassessAndScheduleFuture = (capturedGen: number) => {
      if (actor.disposed || actor.generation !== capturedGen) return
      if (!isScopeValid(currentScope)) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (activeExpiryActorRef.current !== actor) return

      if (actor.timer !== null) {
        const t = actor.timer
        clearTimeout(t)
        actor.timer = null
        if (expiryTimerRef.current === t) {
          expiryTimerRef.current = null
        }
      }

      const allDeadlines = extractAntigravityDeadlines(data)
      if (allDeadlines.length === 0) return

      const nowMs = Date.now()
      const unconsumed = allDeadlines.filter(d => !isDeadlineConsumed(d))
      if (unconsumed.length === 0) return

      const due = unconsumed.filter(d => d * 1000 <= nowMs)
      if (due.length > 0) {
        const elapsed = nowMs - lastExpiryReadTimeRef.current
        const boundedThrottleDelay = Math.min(Math.max(0, 15000 - elapsed), 2147483647)
        const timerGen = actor.generation
        const timer = setTimeout(() => {
          if (actor.timer === timer) {
            actor.timer = null
          }
          if (expiryTimerRef.current === timer) {
            expiryTimerRef.current = null
          }
          if (actor.disposed || actor.generation !== timerGen) return
          if (!isScopeValid(currentScope)) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (activeExpiryActorRef.current !== actor) return
          const currentValid = reads.current.capture()
          const currentActive = session.current.capture()
          if (!currentValid() || !currentActive()) return
          checkAndSchedule()
        }, boundedThrottleDelay)
        actor.timer = timer
        expiryTimerRef.current = timer
        return
      }

      scheduleFutureWakeup(unconsumed, nowMs)
    }

    const performExpiryRead = async (dueList: number[]) => {
      if (actor.disposed) return
      if (!isScopeValid(currentScope)) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (activeExpiryActorRef.current !== actor) return
      if (actor.inFlight || expiryInFlightRef.current) return

      const now = Date.now()
      const elapsed = now - lastExpiryReadTimeRef.current
      if (elapsed < 15000) {
        if (actor.timer !== null) {
          const t = actor.timer
          clearTimeout(t)
          actor.timer = null
          if (expiryTimerRef.current === t) {
            expiryTimerRef.current = null
          }
        }
        const throttleGen = actor.generation
        const boundedThrottleDelay = Math.min(Math.max(0, 15000 - elapsed), 2147483647)
        const timer = setTimeout(() => {
          if (actor.timer === timer) {
            actor.timer = null
          }
          if (expiryTimerRef.current === timer) {
            expiryTimerRef.current = null
          }
          if (actor.disposed || actor.generation !== throttleGen) return
          if (!isScopeValid(currentScope)) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (activeExpiryActorRef.current !== actor) return
          const currentValid = reads.current.capture()
          const currentActive = session.current.capture()
          if (!currentValid() || !currentActive()) return
          void performExpiryRead(dueList)
        }, boundedThrottleDelay)
        actor.timer = timer
        expiryTimerRef.current = timer
        return
      }

      const valid = reads.current.capture()
      const active = session.current.capture()
      if (actor.disposed) return
      if (!isScopeValid(currentScope) || !valid() || !active()) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (activeExpiryActorRef.current !== actor) return
      if (actor.inFlight || expiryInFlightRef.current) return

      markDeadlinesConsumed(dueList)
      actor.inFlight = true
      expiryInFlightRef.current = true
      lastExpiryReadTimeRef.current = Date.now()

      const capturedGen = actor.generation
      const c = new AbortController()
      actor.controller = c
      expiryAbortRef.current = c
      const boundApi = createCredentialApi('antigravity', currentScope)

      try {
        const page = await boundApi.list(capturedFilters, capsRef.current, capturedOffset, capturedLimit, c.signal)
        const isCommitValid =
          !actor.disposed &&
          actor.generation === capturedGen &&
          activeExpiryActorRef.current === actor &&
          isScopeValid(currentScope) &&
          valid() &&
          active() &&
          !c.signal.aborted &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden')

        if (!isCommitValid) return
        acceptCapabilities(page.caps)
        if (JSON.stringify(supportedFilters(capturedFilters, capsRef.current, 'antigravity')) !== JSON.stringify(capturedFilters)) return
        setData({ ...page, caps: capsRef.current })
        if (capturedOffset > 0 && !page.items.length && page.total <= capturedOffset) {
          setOffsetState(Math.max(0, Math.ceil(page.total / capturedLimit) - 1) * capturedLimit)
        }
      } catch (e) {
        const isErrorCommitValid =
          !actor.disposed &&
          actor.generation === capturedGen &&
          activeExpiryActorRef.current === actor &&
          isScopeValid(currentScope) &&
          valid() &&
          active() &&
          !c.signal.aborted &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden')

        if (!isErrorCommitValid) return
        if (!revoke(e)) setError(failureMessage(e))
      } finally {
        const isCurrentOwned = actor.controller === c && actor.generation === capturedGen
        if (actor.controller === c) {
          actor.controller = null
        }
        if (expiryAbortRef.current === c) {
          expiryAbortRef.current = null
        }
        if (isCurrentOwned) {
          actor.inFlight = false
          if (activeExpiryActorRef.current === actor) {
            expiryInFlightRef.current = false
          }
        }

        const isSafeOwned =
          !actor.disposed &&
          actor.generation === capturedGen &&
          activeExpiryActorRef.current === actor &&
          isScopeValid(currentScope) &&
          valid() &&
          active() &&
          (typeof document === 'undefined' || document.visibilityState !== 'hidden')

        if (isSafeOwned) {
          reassessAndScheduleFuture(capturedGen)
        }
      }
    }

    const checkAndSchedule = () => {
      if (actor.disposed) return
      if (!isScopeValid(currentScope)) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (activeExpiryActorRef.current !== actor) return

      if (actor.timer !== null) {
        const t = actor.timer
        clearTimeout(t)
        actor.timer = null
        if (expiryTimerRef.current === t) {
          expiryTimerRef.current = null
        }
      }

      const allDeadlines = extractAntigravityDeadlines(data)
      if (allDeadlines.length === 0) return

      const nowMs = Date.now()
      const unconsumed = allDeadlines.filter(d => !isDeadlineConsumed(d))
      if (unconsumed.length === 0) return

      const due = unconsumed.filter(d => d * 1000 <= nowMs)
      if (due.length > 0) {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          void performExpiryRead(due)
        }
        return
      }

      scheduleFutureWakeup(unconsumed, nowMs)
    }

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'hidden') {
        if (actor.timer !== null) {
          const t = actor.timer
          clearTimeout(t)
          actor.timer = null
          if (expiryTimerRef.current === t) {
            expiryTimerRef.current = null
          }
        }
        if (actor.controller !== null) {
          const c = actor.controller
          c.abort()
          actor.controller = null
          if (expiryAbortRef.current === c) {
            expiryAbortRef.current = null
          }
        }
        if (actor.inFlight) {
          actor.inFlight = false
          if (activeExpiryActorRef.current === actor) {
            expiryInFlightRef.current = false
          }
        }
        actor.generation += 1
      } else if (document.visibilityState === 'visible') {
        if (actor.disposed) return
        if (!isScopeValid(currentScope)) return
        if (activeExpiryActorRef.current !== actor) return
        checkAndSchedule()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    checkAndSchedule()

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      actor.cancel()
    }
  }, [data, mode, scopeKey, caps, offset, limit, filters, isVerifiedOwner])

  function applyFilters(next: Filters) {
    if (!isScopeValid(scope)) return
    reads.current.invalidate()
    controller.current?.abort()
    activeExpiryActorRef.current?.cancel()
    clearScope()
    setData(null)
    setFilters(supportedFilters(next, capsRef.current, mode))
    setOffsetState(0)
  }

  function invalidateReads() {
    if (!isScopeValid(scope)) return
    reads.current.invalidate()
    controller.current?.abort()
    activeExpiryActorRef.current?.cancel()
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
      activeExpiryActorRef.current?.cancel()
      setOffsetState(value)
    },
    setLimit: (value: number) => {
      if (!isScopeValid(scope)) return
      reads.current.invalidate()
      activeExpiryActorRef.current?.cancel()
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
