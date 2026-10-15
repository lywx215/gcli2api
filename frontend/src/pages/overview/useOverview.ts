import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSession,
  subscribeSessionValidation,
  type SessionValidationStatus,
} from '@/auth/session'
import {
  capturePanelScope,
  getPanelChannelSnapshot,
  isPanelMode,
  isPanelScopeCurrent,
  registerChannelCleanup,
  subscribeCredentialChanges,
  subscribePanelChannel,
  type CredentialChange,
  type PanelChannelSnapshot,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { loadOverview } from './api'
import { loadNodeInfo, type NodeOverviewData } from './nodeInfo'
import type { OverviewData } from './types'

export type OverviewOwner = {
  readonly mode: PanelMode
  readonly channelEpoch: number
  readonly sessionEpoch: number
}

function createOwner(
  mode: PanelMode,
  channelEpoch: number,
  sessionEpoch: number,
): OverviewOwner {
  return Object.freeze({
    mode,
    channelEpoch,
    sessionEpoch,
  })
}

function isSameOwner(
  a: OverviewOwner | null | undefined,
  b: OverviewOwner | null | undefined,
): boolean {
  if (!a || !b) return false
  return (
    a.mode === b.mode &&
    a.channelEpoch === b.channelEpoch &&
    a.sessionEpoch === b.sessionEpoch
  )
}

function isOwnerLive(
  owner: OverviewOwner | null | undefined,
  authAuthenticated?: boolean,
  authSessionEpoch?: number,
): boolean {
  if (!owner) return false
  if (!isPanelMode(owner.mode)) return false

  const liveChannel = getPanelChannelSnapshot()
  const liveSession = getSessionSnapshot()
  const liveValidation = getSessionValidationSnapshot()

  if (
    owner.mode !== liveChannel.mode ||
    owner.channelEpoch !== liveChannel.channelEpoch
  ) {
    return false
  }

  if (owner.sessionEpoch !== liveSession.sessionEpoch) {
    return false
  }

  if (
    liveValidation.sessionEpoch !== liveSession.sessionEpoch ||
    liveValidation.status !== 'verified' ||
    liveSession.token === null
  ) {
    return false
  }

  if (authAuthenticated !== undefined && !authAuthenticated) {
    return false
  }
  if (authSessionEpoch !== undefined && authSessionEpoch !== liveSession.sessionEpoch) {
    return false
  }

  return true
}

export type UseOverviewResult = {
  data: OverviewData | null
  loading: boolean
  refresh: () => void
  mode?: PanelMode
  channelEpoch?: number
  sessionEpoch?: number
  nodeData?: NodeOverviewData | null
  nodeLoading?: boolean
  refreshNode?: () => void
}

export function useOverview(mode: PanelMode = 'antigravity'): UseOverviewResult {
  const { authenticated, sessionEpoch: authSessionEpoch } = useAuth()
  const [channelSnapshot, setChannelSnapshot] = useState<PanelChannelSnapshot>(getPanelChannelSnapshot)
  const [sessionEpoch, setSessionEpoch] = useState<number>(() => getSessionSnapshot().sessionEpoch)
  const [, setValidationStatus] = useState<SessionValidationStatus>(() => getSessionValidationSnapshot().status)
  const [, setValidationEpoch] = useState<number>(() => getSessionValidationSnapshot().sessionEpoch)

  useEffect(() => {
    return subscribePanelChannel(() => {
      setChannelSnapshot(getPanelChannelSnapshot())
    })
  }, [])

  useEffect(() => {
    return subscribeSession(() => {
      setSessionEpoch(getSessionSnapshot().sessionEpoch)
    })
  }, [])

  useEffect(() => {
    return subscribeSessionValidation(() => {
      const snap = getSessionValidationSnapshot()
      setValidationEpoch(snap.sessionEpoch)
      setValidationStatus(snap.status)
    })
  }, [])

  const validMode = isPanelMode(mode) ? mode : null
  const liveChannel = getPanelChannelSnapshot()
  const liveSession = getSessionSnapshot()
  const liveValidation = getSessionValidationSnapshot()

  const liveScope = capturePanelScope(liveSession.sessionEpoch)

  const isVerifiedSession = Boolean(
    authenticated &&
    authSessionEpoch === liveSession.sessionEpoch &&
    liveValidation.sessionEpoch === liveSession.sessionEpoch &&
    liveValidation.status === 'verified' &&
    liveSession.token !== null,
  )

  const isMatching = Boolean(
    validMode !== null &&
    validMode === liveScope.mode &&
    validMode === channelSnapshot.mode &&
    channelSnapshot.mode === liveChannel.mode &&
    channelSnapshot.channelEpoch === liveChannel.channelEpoch &&
    sessionEpoch === liveSession.sessionEpoch &&
    isPanelScopeCurrent(liveScope, liveSession.sessionEpoch) &&
    isVerifiedSession,
  )

  const capturedOwner: OverviewOwner | null = useMemo(
    () =>
      isMatching && validMode !== null
        ? createOwner(validMode, channelSnapshot.channelEpoch, sessionEpoch)
        : null,
    [isMatching, validMode, channelSnapshot.channelEpoch, sessionEpoch],
  )

  const [statsData, setStatsData] = useState<OverviewData | null>(null)
  const [statsLoading, setStatsLoading] = useState<boolean>(true)

  const statsControllerRef = useRef<AbortController | null>(null)
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statsAttemptRef = useRef<number>(0)
  const statsInFlightRef = useRef<boolean>(false)
  const statsDirtyRef = useRef<boolean>(false)
  const statsOwnerRef = useRef<OverviewOwner | null>(null)

  const executeStatsReadRef = useRef<() => void>(() => {})
  const executeStatsOwnerRef = useRef<OverviewOwner | null>(null)

  const [nodeData, setNodeData] = useState<NodeOverviewData | null>(null)
  const [nodeLoading, setNodeLoading] = useState<boolean>(false)

  const nodeControllerRef = useRef<AbortController | null>(null)
  const nodeAttemptRef = useRef<number>(0)
  const nodeLoadedSessionRef = useRef<number | null>(null)
  const nodeOwnerRef = useRef<OverviewOwner | null>(null)

  const executeNodeReadRef = useRef<() => void>(() => {})
  const executeNodeOwnerRef = useRef<OverviewOwner | null>(null)

  const cleanupStats = useCallback((staleForOwner?: OverviewOwner) => {
    if (staleForOwner && statsOwnerRef.current) {
      if (
        statsOwnerRef.current.channelEpoch > staleForOwner.channelEpoch ||
        statsOwnerRef.current.sessionEpoch > staleForOwner.sessionEpoch
      ) {
        return
      }
    }

    statsAttemptRef.current++

    if (statsTimerRef.current) {
      clearTimeout(statsTimerRef.current)
      statsTimerRef.current = null
    }
    statsInFlightRef.current = false
    statsDirtyRef.current = false
    executeStatsReadRef.current = () => {}
    executeStatsOwnerRef.current = null

    if (statsControllerRef.current) {
      const ctrl = statsControllerRef.current
      statsControllerRef.current = null
      ctrl.abort()
    }

    if (!staleForOwner || (statsOwnerRef.current && isSameOwner(statsOwnerRef.current, staleForOwner))) {
      statsOwnerRef.current = null
    }

    setStatsData(null)
    setStatsLoading(false)
  }, [])

  const cleanupNode = useCallback((staleForOwner?: OverviewOwner, clearSessionData = false) => {
    if (staleForOwner && nodeOwnerRef.current) {
      if (
        nodeOwnerRef.current.channelEpoch > staleForOwner.channelEpoch ||
        nodeOwnerRef.current.sessionEpoch > staleForOwner.sessionEpoch
      ) {
        return
      }
    }

    nodeAttemptRef.current++

    executeNodeReadRef.current = () => {}
    executeNodeOwnerRef.current = null

    if (nodeControllerRef.current) {
      const ctrl = nodeControllerRef.current
      nodeControllerRef.current = null
      ctrl.abort()
    }

    if (!staleForOwner || (nodeOwnerRef.current && isSameOwner(nodeOwnerRef.current, staleForOwner))) {
      nodeOwnerRef.current = null
    }

    setNodeLoading(false)

    if (clearSessionData) {
      nodeLoadedSessionRef.current = null
      setNodeData(null)
    }
  }, [])

  useEffect(() => {
    const unregisterChannel = registerChannelCleanup(() => {
      cleanupStats()
      cleanupNode(undefined, false)
    })
    const unregisterSession = registerSessionCleanup(() => {
      cleanupStats()
      cleanupNode(undefined, true)
    })
    const unregisterValidation = subscribeSessionValidation(() => {
      const liveSes = getSessionSnapshot()
      const liveVal = getSessionValidationSnapshot()
      if (
        liveVal.sessionEpoch !== liveSes.sessionEpoch ||
        liveVal.status !== 'verified' ||
        liveSes.token === null
      ) {
        cleanupStats()
        cleanupNode(undefined, true)
      }
    })

    return () => {
      unregisterChannel()
      unregisterSession()
      unregisterValidation()
    }
  }, [cleanupStats, cleanupNode])

  useEffect(() => {
    if (!isMatching || validMode === null || !capturedOwner) {
      cleanupStats()
      return
    }

    let disposed = false
    const owner = capturedOwner
    const targetMode = owner.mode
    const targetSessionEpoch = owner.sessionEpoch
    const targetScope: PanelScope = capturePanelScope(targetSessionEpoch)

    statsOwnerRef.current = owner
    setStatsData(null)
    setStatsLoading(true)

    function checkLiveGuard(attempt: number, signal?: AbortSignal): boolean {
      if (disposed) return false
      if (signal?.aborted) return false
      if (statsAttemptRef.current !== attempt) return false

      const curOwner = statsOwnerRef.current
      if (!curOwner || !isSameOwner(curOwner, owner)) return false

      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return false
      if (!isPanelScopeCurrent(targetScope, getSessionSnapshot().sessionEpoch)) return false

      return true
    }

    function scheduleNext(delay: number) {
      if (disposed) return
      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
      if (statsTimerRef.current) {
        clearTimeout(statsTimerRef.current)
        statsTimerRef.current = null
      }
      statsTimerRef.current = setTimeout(() => {
        statsTimerRef.current = null
        if (disposed) return
        if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
        if (!statsOwnerRef.current || !isSameOwner(statsOwnerRef.current, owner)) return
        if (document.hidden) {
          statsDirtyRef.current = true
          return
        }
        void read()
      }, delay)
    }

    async function read() {
      if (disposed) return
      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
      if (statsInFlightRef.current) {
        statsDirtyRef.current = true
        return
      }
      if (document.hidden) {
        statsDirtyRef.current = true
        return
      }

      statsInFlightRef.current = true
      statsDirtyRef.current = false

      const attempt = ++statsAttemptRef.current
      statsOwnerRef.current = owner

      statsControllerRef.current?.abort()
      const controller = new AbortController()
      statsControllerRef.current = controller

      if (!checkLiveGuard(attempt, controller.signal)) {
        return
      }
      setStatsLoading(true)

      if (!checkLiveGuard(attempt, controller.signal)) {
        return
      }

      try {
        const data = await loadOverview(controller.signal, {
          mode: targetMode,
          scope: targetScope,
        })
        if (checkLiveGuard(attempt, controller.signal)) {
          setStatsData(data)
          if (checkLiveGuard(attempt, controller.signal)) {
            setStatsLoading(false)
          }
        }
      } catch {
        if (checkLiveGuard(attempt, controller.signal)) {
          setStatsLoading(false)
        }
      } finally {
        if (checkLiveGuard(attempt, controller.signal)) {
          statsInFlightRef.current = false
          if (statsDirtyRef.current) {
            statsDirtyRef.current = false
            scheduleNext(0)
          } else {
            scheduleNext(30_000)
          }
        }
      }
    }

    executeStatsReadRef.current = () => {
      void read()
    }
    executeStatsOwnerRef.current = owner

    const onVisibilityChange = () => {
      if (disposed) return
      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
      if (!statsOwnerRef.current || !isSameOwner(statsOwnerRef.current, owner)) return

      if (!document.hidden && statsDirtyRef.current && !statsInFlightRef.current) {
        statsDirtyRef.current = false
        if (statsTimerRef.current) {
          clearTimeout(statsTimerRef.current)
          statsTimerRef.current = null
        }
        void read()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const unsubscribeCreds = subscribeCredentialChanges((change: CredentialChange) => {
      if (disposed) return
      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
      if (!statsOwnerRef.current || !isSameOwner(statsOwnerRef.current, owner)) return

      if (change.mode !== targetMode || change.sessionEpoch !== targetSessionEpoch) {
        return
      }

      if (statsInFlightRef.current) {
        statsDirtyRef.current = true
      } else {
        if (statsTimerRef.current) {
          clearTimeout(statsTimerRef.current)
          statsTimerRef.current = null
        }
        if (!document.hidden) {
          void read()
        } else {
          statsDirtyRef.current = true
        }
      }
    })

    void read()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribeCreds()
      cleanupStats(owner)
    }
  }, [
    isMatching,
    validMode,
    channelSnapshot.channelEpoch,
    channelSnapshot.mode,
    sessionEpoch,
    authenticated,
    authSessionEpoch,
    capturedOwner,
    cleanupStats,
  ])

  useEffect(() => {
    if (!isMatching || validMode === null || !capturedOwner) {
      cleanupNode(undefined, false)
      return
    }

    let disposed = false
    const owner = capturedOwner
    const targetSessionEpoch = owner.sessionEpoch
    nodeOwnerRef.current = owner

    async function readNode() {
      if (disposed) return
      if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return
      if (!isMatching) return

      nodeControllerRef.current?.abort()
      const controller = new AbortController()
      nodeControllerRef.current = controller
      const attempt = ++nodeAttemptRef.current

      function checkNodeGuard(): boolean {
        if (disposed) return false
        if (controller.signal.aborted) return false
        if (nodeAttemptRef.current !== attempt) return false
        if (!nodeOwnerRef.current || !isSameOwner(nodeOwnerRef.current, owner)) return false
        if (!isOwnerLive(owner, authenticated, authSessionEpoch)) return false
        return true
      }

      if (!checkNodeGuard()) return
      setNodeLoading(true)

      if (!checkNodeGuard()) return

      try {
        const data = await loadNodeInfo(controller.signal)
        if (checkNodeGuard()) {
          setNodeData(data)
          nodeLoadedSessionRef.current = targetSessionEpoch
          setNodeLoading(false)
        }
      } catch {
        if (checkNodeGuard()) {
          setNodeLoading(false)
        }
      } finally {
        if (checkNodeGuard()) {
          if (nodeControllerRef.current === controller) {
            nodeControllerRef.current = null
          }
        }
      }
    }

    executeNodeReadRef.current = () => {
      void readNode()
    }
    executeNodeOwnerRef.current = owner

    if (nodeLoadedSessionRef.current !== targetSessionEpoch) {
      void readNode()
    }

    return () => {
      disposed = true
      cleanupNode(owner, false)
    }
  }, [
    isMatching,
    validMode,
    channelSnapshot.channelEpoch,
    channelSnapshot.mode,
    sessionEpoch,
    authenticated,
    authSessionEpoch,
    capturedOwner,
    cleanupNode,
  ])

  const refresh = useCallback(() => {
    if (!capturedOwner) return
    if (!isOwnerLive(capturedOwner, authenticated, authSessionEpoch)) return
    if (validMode !== capturedOwner.mode) return

    const execOwner = executeStatsOwnerRef.current
    if (!execOwner || !isSameOwner(execOwner, capturedOwner)) return

    if (statsInFlightRef.current) {
      statsDirtyRef.current = true
    } else {
      if (statsTimerRef.current) {
        clearTimeout(statsTimerRef.current)
        statsTimerRef.current = null
      }
      if (!document.hidden) {
        executeStatsReadRef.current()
      } else {
        statsDirtyRef.current = true
      }
    }
  }, [
    capturedOwner?.mode,
    capturedOwner?.channelEpoch,
    capturedOwner?.sessionEpoch,
    validMode,
    authenticated,
    authSessionEpoch,
  ])

  const refreshNode = useCallback(() => {
    if (!capturedOwner) return
    if (!isOwnerLive(capturedOwner, authenticated, authSessionEpoch)) return
    if (validMode !== capturedOwner.mode) return

    const execOwner = executeNodeOwnerRef.current
    if (!execOwner || !isSameOwner(execOwner, capturedOwner)) return

    executeNodeReadRef.current()
  }, [
    capturedOwner?.mode,
    capturedOwner?.channelEpoch,
    capturedOwner?.sessionEpoch,
    validMode,
    authenticated,
    authSessionEpoch,
  ])

  const returnMode: PanelMode | undefined =
    validMode !== null && validMode === channelSnapshot.mode ? validMode : undefined

  return {
    data: isMatching ? statsData : null,
    loading: isMatching ? statsLoading : false,
    refresh,
    mode: returnMode,
    channelEpoch: channelSnapshot.channelEpoch,
    sessionEpoch,
    nodeData: isMatching ? nodeData : null,
    nodeLoading: isMatching ? nodeLoading : false,
    refreshNode,
  }
}
