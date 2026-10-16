import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getServiceBase } from '@/api/client'
import { useAuth } from '@/auth'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from '@/auth/session'
import { usePanelChannel } from '@/app/channels'
import { ConsoleHandshake } from '@/app/ConsoleHandshake'
import {
  isPanelScopeCurrent,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'

export const supportedPanelModes: readonly PanelMode[] = Object.freeze(['antigravity', 'geminicli'] as const)
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  actionFailure,
  createCredentialApi,
  fixtureMode,
} from './api'
import {
  CAP,
  CAP_BY_MODE,
  selectedToolsAllowed,
  type Credential,
  type Outcome,
  type RecordValue,
} from './model'
import { useCredentials } from './useCredentials'
import { FiltersPanel } from './FiltersPanel'
import { CredentialTable } from './CredentialTable'
import { CredentialDetail } from './CredentialDetail'
import { ConfirmAction } from './ConfirmAction'
import { Statistics } from './Statistics'
import { restoreCredentialFocus, type DetailTrigger } from './focus'
import { MobileControls, mobilePanelIds, type MobilePanels } from './MobileControls'
import { type ManualResult } from './ResultView'
import { useQuotaSummary } from './quota/useQuotaSummary'
import { QuotaCard } from './quota/QuotaCard'
import { QuotaDialog } from './quota/QuotaDialog'
import { FilesDialog, type FilesDialogTarget } from './FilesDialog'
import { EmailMaintenance, type EmailMaintenanceTarget } from './EmailMaintenance'
import { CredentialBatchPanel } from './CredentialBatchPanel'

const validationIncarnations = new WeakMap<object, number>()
let nextValidationIncarnation = 1

function getValidationIncarnation(snap: object): number {
  let inc = validationIncarnations.get(snap)
  if (!inc) {
    inc = nextValidationIncarnation++
    validationIncarnations.set(snap, inc)
  }
  return inc
}

interface PageToolSession {
  readonly id: number
  readonly tool: 'files' | 'email' | 'batch'
  readonly target?: FilesDialogTarget | EmailMaintenanceTarget
  readonly filenames?: readonly string[]
  readonly ownerRevision: object
  readonly source: 'page' | 'detail'
  readonly scope: Readonly<PanelScope>
  readonly validation: Readonly<SessionValidationSnapshot>
}

interface PageReservation {
  readonly id: number
  readonly kind: 'tool' | 'manual' | 'action'
  readonly token: object
  readonly tool?: 'files' | 'email' | 'batch'
  readonly target?: FilesDialogTarget | EmailMaintenanceTarget
  readonly filenames?: readonly string[]
  readonly source?: 'page' | 'detail'
  readonly ownerRevision: object
  readonly scope: Readonly<PanelScope>
  readonly validation: Readonly<SessionValidationSnapshot>
  readonly openingId?: number
  readonly openingFilename?: string
  readonly task: () => boolean
  retired: boolean
}

interface DetailOpeningActor {
  readonly id: number
  readonly filename: string
  readonly trigger: DetailTrigger
  readonly detailEpoch: number
  readonly scope: Readonly<PanelScope>
  readonly validation: Readonly<SessionValidationSnapshot>
  readonly ownerRevision: object
  readonly taskSnapshot: () => boolean
  readonly isOpeningActive: () => boolean
  retired: boolean
}

export default function CredentialsPage() {
  const { authenticated, sessionEpoch } = useAuth()
  const { mode, channelEpoch } = usePanelChannel()
  const valSnap = useSyncExternalStore(subscribeSessionValidation, getSessionValidationSnapshot)
  const isVerified = authenticated && valSnap.status === 'verified' && valSnap.sessionEpoch === sessionEpoch
  const incarnation = isVerified ? getValidationIncarnation(valSnap) : 0

  return isVerified ? (
    <CredentialWorkspace
      key={`${sessionEpoch}:${channelEpoch}:${mode}:${incarnation}`}
      mode={mode}
    />
  ) : (
    <p className="text-muted-foreground">请登录后查看凭证。</p>
  )
}

export function CredentialWorkspace({ mode: propMode }: { mode?: PanelMode } = {}) {
  const channel = usePanelChannel()
  const mode: PanelMode = propMode ?? channel.mode
  const channelEpoch = channel.channelEpoch
  const { sessionEpoch } = useAuth()

  const legacy = new URL(getServiceBase())
  legacy.hash = mode === 'geminicli' ? 'manage' : 'antigravity-manage'

  const ownerScope: PanelScope = useMemo(
    () =>
      Object.freeze({
        mode,
        channelEpoch,
        sessionEpoch,
      }),
    [mode, channelEpoch, sessionEpoch]
  )

  const capturedValidationSnapshot = useRef<SessionValidationSnapshot>(getSessionValidationSnapshot())
  const isMountedRef = useRef(true)

  const isOwnerActive = useCallback((): boolean => {
    if (!isMountedRef.current) return false
    const currentSession = getSessionSnapshot()
    if (currentSession.token === null || currentSession.sessionEpoch !== ownerScope.sessionEpoch) {
      return false
    }
    if (!isPanelScopeCurrent(ownerScope, currentSession.sessionEpoch)) {
      return false
    }
    const currentValidation = getSessionValidationSnapshot()
    if (
      currentValidation.sessionEpoch !== ownerScope.sessionEpoch ||
      currentValidation.status !== 'verified' ||
      currentValidation !== capturedValidationSnapshot.current
    ) {
      return false
    }
    return true
  }, [ownerScope])

  const ownedApi = useMemo(() => createCredentialApi(mode, ownerScope), [mode, ownerScope])

  const c = useCredentials(mode)
  const modeCaps = CAP_BY_MODE[mode]

  const [detail, setDetail] = useState<Credential | null>(null)
  const [detailOpening, setDetailOpening] = useState<DetailOpeningActor | null>(null)
  const activeOpeningRef = useRef<DetailOpeningActor | null>(null)
  const detailSerial = useRef(0)
  const focusReturn = useRef<DetailTrigger>('desktop-detail')
  const detailFocusRestoredRef = useRef(0)

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [mobilePanels, setMobilePanels] = useState<MobilePanels>({ statistics: false, filters: false, bulk: false })
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table')

  // Page exclusive reservation and tool session
  const [toolSession, setToolSession] = useState<PageToolSession | null>(null)
  const activeReservationRef = useRef<PageReservation | null>(null)
  const nextToolSerial = useRef(1)
  const detailToolCloseCallbackRef = useRef<(() => void) | null>(null)

  const workspace = useRef<HTMLElement | null>(null)
  const listTitle = useRef<HTMLHeadingElement | null>(null)

  // Quota summary hook
  const quota = useQuotaSummary({
    mode,
    sessionEpoch,
    detailEpoch: c.detailEpoch,
    capabilities: c.caps,
    ownerScope,
  })

  const quotaRef = useRef(quota)
  quotaRef.current = quota
  const currentQuotaTargetRef = useRef<string | null>(null)
  const quotaSerial = useRef(0)
  const [quotaDialogSerial, setQuotaDialogSerial] = useState(0)
  const [quotaDialogFilename, setQuotaDialogFilename] = useState<string | null>(null)
  const quotaFocusReturn = useRef<DetailTrigger>('desktop-quota')
  const quotaFocusRestoredRef = useRef(0)

  function openTool(
    tool: 'files' | 'email' | 'batch',
    targetOrFilenames: FilesDialogTarget | EmailMaintenanceTarget | readonly string[],
    source: 'page' | 'detail' = 'page'
  ): boolean {
    if (!isOwnerActive() || busy || activeReservationRef.current !== null) return false

    const taskSnapshot = c.captureTask()
    if (!taskSnapshot()) return false

    const id = nextToolSerial.current++
    const ownerRevision = Object.freeze({})
    const scopeSnapshot = ownerScope
    const validationSnapshot = capturedValidationSnapshot.current

    let frozenTarget: FilesDialogTarget | EmailMaintenanceTarget | undefined
    let frozenFilenames: readonly string[] | undefined

    if (tool === 'batch') {
      frozenFilenames = Object.freeze([...(targetOrFilenames as readonly string[])])
    } else {
      const t = targetOrFilenames as FilesDialogTarget | EmailMaintenanceTarget
      if (t.kind === 'single') {
        frozenTarget = Object.freeze({ kind: 'single', filename: t.filename })
      } else if (t.kind === 'selection') {
        frozenTarget = Object.freeze({ kind: 'selection', filenames: Object.freeze([...t.filenames]) })
      } else {
        frozenTarget = Object.freeze({ kind: 'channel' })
      }
    }

    const reservation: PageReservation = {
      id,
      kind: 'tool',
      token: Object.freeze({}),
      tool,
      target: frozenTarget,
      filenames: frozenFilenames,
      source,
      ownerRevision,
      scope: scopeSnapshot,
      validation: validationSnapshot,
      openingId: activeOpeningRef.current?.id,
      openingFilename: activeOpeningRef.current?.filename,
      task: taskSnapshot,
      retired: false,
    }

    activeReservationRef.current = reservation

    const session: PageToolSession = {
      id,
      tool,
      target: frozenTarget,
      filenames: frozenFilenames,
      ownerRevision,
      source,
      scope: scopeSnapshot,
      validation: validationSnapshot,
    }

    setToolSession(session)
    return true
  }

  function exitTool(actor?: PageToolSession | PageReservation | number) {
    const current = activeReservationRef.current
    if (!current || current.kind !== 'tool') return
    if (actor !== undefined) {
      const actorId = typeof actor === 'number' ? actor : actor.id
      if (current.id !== actorId) return
    }

    current.retired = true
    activeReservationRef.current = null

    if (current.tool === 'batch') {
      setResult('已退出批量工具；已执行的操作不会回滚。')
    }

    const prevSource = current.source
    setToolSession(null)

    if (prevSource === 'detail') {
      detailToolCloseCallbackRef.current?.()
    }
  }

  const createToolOwnerPredicate = useCallback(
    (res: PageReservation): (() => boolean) => {
      return () => {
        if (!isMountedRef.current) return false
        if (res.retired) return false
        if (activeReservationRef.current !== res) return false
        if (!isOwnerActive()) return false
        if (!res.task()) return false
        if (res.openingId !== undefined) {
          if (
            !activeOpeningRef.current ||
            activeOpeningRef.current.id !== res.openingId ||
            activeOpeningRef.current.retired
          ) {
            return false
          }
        }
        return true
      }
    },
    [isOwnerActive]
  )

  const createToolRefresh = useCallback(
    (res: PageReservation): (() => void) => {
      return () => {
        if (
          isMountedRef.current &&
          !res.retired &&
          activeReservationRef.current === res &&
          isOwnerActive() &&
          res.task()
        ) {
          if (res.openingId !== undefined) {
            if (
              !activeOpeningRef.current ||
              activeOpeningRef.current.id !== res.openingId ||
              activeOpeningRef.current.retired
            ) {
              return
            }
          }
          c.refresh()
        }
      }
    },
    [isOwnerActive, c.refresh]
  )

  const createToolClose = useCallback(
    (res: PageReservation): (() => void) => {
      return () => {
        exitTool(res)
      }
    },
    []
  )

  // Synchronous invalidation on validation change while mounted
  useEffect(() => {
    const unsubValidation = subscribeSessionValidation(() => {
      if (!isOwnerActive()) {
        if (activeOpeningRef.current) {
          activeOpeningRef.current.retired = true
          activeOpeningRef.current = null
        }
        if (activeReservationRef.current) {
          activeReservationRef.current.retired = true
          activeReservationRef.current = null
        }
        setDetailOpening(null)
        setDetail(null)
        setResult('')
        setBusy(false)
        currentQuotaTargetRef.current = null
        quotaSerial.current++
        setQuotaDialogSerial(0)
        setQuotaDialogFilename(null)
        quotaRef.current.clear()
        setToolSession(null)
      }
    })
    return unsubValidation
  }, [isOwnerActive])

  // DetailEpoch reset
  useEffect(() => {
    if (activeOpeningRef.current) {
      activeOpeningRef.current.retired = true
      activeOpeningRef.current = null
    }
    if (activeReservationRef.current) {
      activeReservationRef.current.retired = true
      activeReservationRef.current = null
    }
    setDetailOpening(null)
    setDetail(null)
    setResult('')
    setBusy(false)
    currentQuotaTargetRef.current = null
    quotaSerial.current++
    setQuotaDialogSerial(0)
    setQuotaDialogFilename(null)
    prevItemsRef.current = null
    setToolSession(null)
  }, [c.detailEpoch])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (activeOpeningRef.current) {
        activeOpeningRef.current.retired = true
        activeOpeningRef.current = null
      }
      if (activeReservationRef.current) {
        activeReservationRef.current.retired = true
        activeReservationRef.current = null
      }
      setDetailOpening(null)
      setToolSession(null)
    }
  }, [])

  // Keep open detail fresh if current page data updates
  useEffect(() => {
    if (detail && c.data) {
      const fresh = c.data.items.find(r => r.filename === detail.filename)
      if (fresh) setDetail(fresh)
    }
  }, [c.data, detail])

  // Paging transition disposal
  const prevPagingRef = useRef({ offset: c.offset, limit: c.limit })
  useEffect(() => {
    if (prevPagingRef.current.offset !== c.offset || prevPagingRef.current.limit !== c.limit) {
      prevPagingRef.current = { offset: c.offset, limit: c.limit }
      currentQuotaTargetRef.current = null
      quotaSerial.current++
      setQuotaDialogSerial(0)
      setQuotaDialogFilename(null)
      quotaRef.current.clear()
    }
  }, [c.offset, c.limit])

  // Completed list result row removal
  const prevItemsRef = useRef<string[] | null>(null)
  useEffect(() => {
    if (c.data?.items) {
      const currentFilenames = c.data.items.map(r => r.filename)
      if (prevItemsRef.current !== null) {
        const currentSet = new Set(currentFilenames)
        const disappeared = prevItemsRef.current.filter(fn => !currentSet.has(fn))
        if (disappeared.length > 0) {
          quotaRef.current.clear(disappeared)
          if (currentQuotaTargetRef.current && disappeared.includes(currentQuotaTargetRef.current)) {
            const removed = currentQuotaTargetRef.current
            currentQuotaTargetRef.current = null
            quotaSerial.current++
            setQuotaDialogSerial(0)
            setQuotaDialogFilename(null)
            quotaRef.current.close(removed)
          }
        }
      }
      prevItemsRef.current = currentFilenames
    }
  }, [c.data])

  function open(filename: string, trigger: DetailTrigger) {
    if (!isOwnerActive() || busy || activeReservationRef.current !== null) return
    if (currentQuotaTargetRef.current) {
      const prev = currentQuotaTargetRef.current
      currentQuotaTargetRef.current = null
      quotaSerial.current++
      setQuotaDialogSerial(0)
      setQuotaDialogFilename(null)
      quotaRef.current.close(prev)
    }
    const row = c.data?.items.find(r => r.filename === filename)
    if (!row) return

    if (activeOpeningRef.current) {
      activeOpeningRef.current.retired = true
    }

    focusReturn.current = trigger
    const nextId = ++detailSerial.current
    const taskSnapshot = c.captureTask()
    const ownerRevision = Object.freeze({})
    const scopeSnapshot = ownerScope
    const validationSnapshot = capturedValidationSnapshot.current
    const currentDetailEpoch = c.detailEpoch

    let actor: DetailOpeningActor

    const isOpeningActive = () => {
      if (actor.retired) return false
      if (!isMountedRef.current) return false
      if (activeOpeningRef.current !== actor) return false
      if (c.detailEpoch !== currentDetailEpoch) return false
      if (!isOwnerActive()) return false
      if (!taskSnapshot()) return false
      return true
    }

    actor = {
      id: nextId,
      filename,
      trigger,
      detailEpoch: currentDetailEpoch,
      scope: scopeSnapshot,
      validation: validationSnapshot,
      ownerRevision,
      taskSnapshot,
      isOpeningActive,
      retired: false,
    }

    activeOpeningRef.current = actor
    setDetailOpening(actor)
    setDetail(row)
  }

  function closeDetail(actorToClose?: DetailOpeningActor) {
    const current = activeOpeningRef.current
    if (!current) return
    if (actorToClose && current !== actorToClose) return

    current.retired = true
    activeOpeningRef.current = null
    setDetailOpening(null)
    setDetail(null)

    if (activeReservationRef.current?.source === 'detail') {
      exitTool(activeReservationRef.current)
    }
    if (activeReservationRef.current?.kind === 'manual' && activeReservationRef.current.openingId === current.id) {
      activeReservationRef.current.retired = true
      activeReservationRef.current = null
      setBusy(false)
    }
  }

  function openQuota(filename: string, trigger: DetailTrigger) {
    if (!isOwnerActive() || busy || activeReservationRef.current !== null) return
    if (activeOpeningRef.current) {
      activeOpeningRef.current.retired = true
      activeOpeningRef.current = null
    }
    if (detail) {
      setDetail(null)
      setDetailOpening(null)
      setBusy(false)
    }
    const prev = currentQuotaTargetRef.current
    if (prev && prev !== filename) {
      quotaRef.current.cancel(prev)
      quotaRef.current.close(prev)
    }
    currentQuotaTargetRef.current = filename
    quotaFocusReturn.current = trigger
    const currentSerial = ++quotaSerial.current
    setQuotaDialogSerial(currentSerial)
    setQuotaDialogFilename(filename)
    void quotaRef.current.open(filename)
  }

  function closeQuota(serial: number, filename: string) {
    if (!isOwnerActive()) return
    if (quotaSerial.current !== serial) return
    currentQuotaTargetRef.current = null
    setQuotaDialogSerial(0)
    setQuotaDialogFilename(null)
    quotaRef.current.close(filename)
  }

  function handleQuotaCloseAutoFocus(event: Event, serial: number, filename: string) {
    event.preventDefault()
    if (!isOwnerActive()) return
    if (quotaSerial.current !== serial) return
    if (quotaFocusRestoredRef.current === serial) return
    quotaFocusRestoredRef.current = serial
    restoreCredentialFocus(workspace.current, filename, quotaFocusReturn.current, listTitle.current)
  }

  async function action(names: string[], name: string, remark?: string): Promise<Outcome | undefined> {
    if (!isOwnerActive() || busy || activeReservationRef.current !== null || !names.length) return
    const taskSnapshot = c.captureTask()
    if (!taskSnapshot()) return

    const reservation: PageReservation = {
      id: nextToolSerial.current++,
      kind: 'action',
      token: Object.freeze({}),
      ownerRevision: Object.freeze({}),
      scope: ownerScope,
      validation: capturedValidationSnapshot.current,
      task: taskSnapshot,
      retired: false,
    }

    activeReservationRef.current = reservation
    setBusy(true)
    setResult('')
    c.invalidateReads()
    try {
      const outcome = await ownedApi.action(names, name, remark)
      if (isOwnerActive() && activeReservationRef.current === reservation && taskSnapshot()) {
        setResult(
          `${outcome.kind === 'partial' ? '部分成功：' : outcome.kind === 'unknown' ? '结果未知：' : ''}${outcome.message}`
        )
        return outcome
      }
    } catch (e) {
      if (isOwnerActive() && activeReservationRef.current === reservation && taskSnapshot()) {
        const outcome = actionFailure(e, names.length)
        c.revoke(e)
        setResult(outcome.message)
        return outcome
      }
    } finally {
      if (activeReservationRef.current === reservation) {
        reservation.retired = true
        activeReservationRef.current = null
        setBusy(false)
        if (isOwnerActive()) {
          c.refresh()
        }
      }
    }
  }

  const isToolOpen = toolSession !== null || (activeReservationRef.current !== null && activeReservationRef.current.kind === 'tool')
  const blocked = busy || c.materializing || isToolOpen || activeReservationRef.current !== null
  const noSelection = blocked || !c.selected.size
  const isDockVisible = c.selected.size > 0 || mobilePanels.bulk
  const bulkDockRef = useRef<HTMLElement | null>(null)
  const [dockHeight, setDockHeight] = useState(0)

  useEffect(() => {
    if (!isDockVisible) {
      setDockHeight(0)
      return
    }
    const el = bulkDockRef.current
    if (!el) return
    const update = () => {
      setDockHeight(el.offsetHeight)
    }
    update()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        update()
      })
      observer.observe(el)
    }
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [isDockVisible])

  const renderPagination = (position: 'top' | 'bottom') => (
    <nav
      key={position}
      className="flex flex-wrap items-center justify-between gap-2 text-xs"
      aria-label={position === 'top' ? '顶部分页' : '底部分页'}
      data-pagination={position}
      data-pagination-position={position}
    >
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        每页
        <select
          aria-label="每页数量"
          value={c.limit}
          disabled={blocked}
          className="h-8 rounded-md border border-input bg-control-background px-2 py-0 text-base md:text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed"
          onChange={e => {
            if (isOwnerActive() && activeReservationRef.current === null) c.setLimit(Number(e.target.value))
          }}
        >
          {[10, 20, 25, 50, 100, 200, 500, 1000].map(n => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <span className="text-xs text-muted-foreground">
        第 {Math.floor(c.offset / c.limit) + 1} 页 · 匹配 {c.data?.total ?? '未知'} 项
      </span>
      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || c.loading || c.offset === 0}
          onClick={() => {
            if (isOwnerActive() && activeReservationRef.current === null) c.setOffset(Math.max(0, c.offset - c.limit))
          }}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={blocked || c.loading || !c.data?.hasMore}
          onClick={() => {
            if (isOwnerActive() && activeReservationRef.current === null) c.setOffset(c.offset + c.limit)
          }}
        >
          下一页
        </Button>
      </div>
    </nav>
  )

  return (
    <section
      ref={workspace}
      className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5"
      style={{
        paddingBottom: isDockVisible
          ? `calc(${dockHeight || 64}px + 1rem + env(safe-area-inset-bottom, 0px))`
          : undefined,
      }}
      aria-label={mode === 'geminicli' ? 'Gemini CLI 凭证' : 'Antigravity 凭证'}
      aria-busy={busy || c.loading}
    >
      <ConsoleHandshake active={mode === 'geminicli'} />
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 ref={listTitle} tabIndex={-1} className="text-xl md:text-2xl font-semibold">
            {mode === 'geminicli' ? 'Gemini CLI 凭证' : 'Antigravity 凭证'}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">筛选、跨页选择与凭证状态管理</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label="视图模式"
            className="inline-flex rounded-md border bg-secondary p-0.5"
          >
            <Button
              type="button"
              role="radio"
              aria-checked={viewMode === 'table'}
              variant={viewMode === 'table' ? 'default' : 'ghost'}
              size="xs"
              disabled={busy}
              onClick={() => setViewMode('table')}
            >
              表格
            </Button>
            <Button
              type="button"
              role="radio"
              aria-checked={viewMode === 'cards'}
              variant={viewMode === 'cards' ? 'default' : 'ghost'}
              size="xs"
              disabled={busy}
              onClick={() => setViewMode('cards')}
            >
              额度卡片
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (isOwnerActive()) c.refresh()
            }}
          >
            重新读取
          </Button>
        </div>
      </header>
      {fixtureMode && (
        <p role="status" className="rounded-md border bg-info-bg p-2 text-xs text-info">
          开发模式合成预览。操作结果为模拟数据，不代表后端已执行。
        </p>
      )}
      <MobileControls
        total={c.data?.total}
        selected={c.selected.size}
        panels={mobilePanels}
        toggle={panel => setMobilePanels(current => ({ ...current, [panel]: !current[panel] }))}
      />
      <div id={mobilePanelIds.statistics} className={mobilePanels.statistics ? 'block' : 'hidden md:block'}>
        {c.data && <Statistics page={c.data} mode={mode} />}
      </div>
      <fieldset id={mobilePanelIds.filters} className={mobilePanels.filters ? 'block' : 'hidden md:block'} disabled={blocked}>
        <legend className="sr-only">凭证筛选</legend>
        <FiltersPanel
          filters={c.filters}
          caps={c.caps}
          mode={mode}
          onApply={next => {
            if (isOwnerActive() && activeReservationRef.current === null) c.applyFilters(next)
          }}
        />
      </fieldset>

      {/* 零选择常驻全渠道工具条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={blocked || !c.data?.items.length}
            onClick={() => {
              if (isOwnerActive() && activeReservationRef.current === null && c.data?.items.length) {
                c.toggle(c.data.items.map(r => r.filename), true)
              }
            }}
          >
            选择当前页
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={blocked || !c.data?.total}
            onClick={() => {
              if (isOwnerActive() && activeReservationRef.current === null && c.data?.total) {
                void c.selectAll()
              }
            }}
          >
            读取全部匹配
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={blocked}
            onClick={() => openTool('files', { kind: 'channel' })}
          >
            全渠道文件打包
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={blocked}
            onClick={() => openTool('email', { kind: 'channel' })}
          >
            全渠道邮箱维护
          </Button>
        </div>
        {c.selected.size > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>已跨页选择 <strong className="font-semibold tabular-nums text-foreground">{c.selected.size}</strong> 项</span>
            <Button
              variant="ghost"
              size="xs"
              disabled={blocked}
              onClick={() => {
                if (isOwnerActive() && activeReservationRef.current === null) c.clearSelection()
              }}
              className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              清除选择
            </Button>
          </div>
        )}
      </div>

      {/* 选中时呈现的情境感知浮动批量操作坞 (Contextual Bulk Dock) */}
      {isDockVisible && (
        <aside
          ref={bulkDockRef}
          id={mobilePanelIds.bulk}
          role="region"
          aria-label="批量操作"
          className="fixed bottom-0 left-0 right-0 md:right-[13.5rem] z-40 border-t bg-card/95 backdrop-blur shadow-lg max-h-[35vh] md:max-h-[25vh] overflow-y-auto"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
        >
          <div className="flex w-full max-w-[1752px] px-3 py-2 md:px-4 sm:py-2.5 flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <strong className="text-xs sm:text-sm font-semibold">
                已跨页选择 {c.selected.size} 项
              </strong>
              <Button
                variant="ghost"
                size="xs"
                disabled={blocked}
                onClick={() => {
                  if (isOwnerActive() && activeReservationRef.current === null) c.clearSelection()
                }}
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                清除选择
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                disabled={noSelection}
                onClick={() => void action([...c.selected], 'enable')}
              >
                批量启用
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={noSelection}
                onClick={() => void action([...c.selected], 'disable')}
              >
                批量禁用
              </Button>
              <ConfirmAction
                label="批量永久禁用"
                size="xs"
                disabled={noSelection || !c.caps.has(modeCaps.permanent)}
                description={`对已物化集合中的 ${c.selected.size} 个凭证永久禁用；可能部分成功。`}
                onConfirm={() => void action([...c.selected], 'permanent_disable')}
              />
              <ConfirmAction
                label="批量删除"
                size="xs"
                disabled={noSelection}
                description={`删除已物化集合中的 ${c.selected.size} 个凭证。此操作不可由页面撤销，可能部分成功。`}
                onConfirm={() => void action([...c.selected], 'delete')}
              />
              {mode === 'antigravity' && (
                <>
                  <ConfirmAction
                    label="批量开启信用额度"
                    size="xs"
                    disabled={noSelection || !c.caps.has(CAP.credit)}
                    description="对选中凭证开启信用额度并清除模型冷却，可能部分成功。"
                    onConfirm={() => void action([...c.selected], 'enable_credit')}
                  />
                  <ConfirmAction
                    label="批量关闭信用额度"
                    size="xs"
                    disabled={noSelection || !c.caps.has(CAP.credit)}
                    description="对选中凭证关闭信用额度并清除模型冷却，可能部分成功。"
                    onConfirm={() => void action([...c.selected], 'disable_credit')}
                  />
                </>
              )}
              <Button
                variant="outline"
                size="xs"
                disabled={blocked || !selectedToolsAllowed(c.selected)}
                onClick={() => openTool('files', { kind: 'selection', filenames: [...c.selected] })}
              >
                下载选中
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={blocked || !selectedToolsAllowed(c.selected)}
                onClick={() => openTool('email', { kind: 'selection', filenames: [...c.selected] })}
              >
                复制邮箱
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={noSelection}
                onClick={() => openTool('batch', [...c.selected])}
              >
                批量检测与额度刷新
              </Button>
            </div>
          </div>
        </aside>
      )}

      {toolSession && toolSession.tool === 'files' && activeReservationRef.current?.id === toolSession.id && (() => {
        const toolRes = activeReservationRef.current
        return (
          <FilesDialog
            mode={mode}
            scope={toolSession.scope}
            validation={toolSession.validation}
            ownerRevision={toolSession.ownerRevision}
            isCurrentOwner={createToolOwnerPredicate(toolRes)}
            disabled={false}
            open={true}
            target={toolSession.target as FilesDialogTarget}
            onClose={createToolClose(toolRes)}
          />
        )
      })()}

      {toolSession && toolSession.tool === 'email' && toolSession.source === 'page' && activeReservationRef.current?.id === toolSession.id && (() => {
        const toolRes = activeReservationRef.current
        return (
          <section className="space-y-2.5 rounded-lg border bg-card p-3 text-card-foreground shadow-sm" aria-label="邮箱维护">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-semibold">邮箱维护</h3>
              <Button variant="outline" size="sm" onClick={createToolClose(toolRes)}>
                退出邮箱维护
              </Button>
            </div>
            <EmailMaintenance
              mode={mode}
              scope={toolSession.scope}
              validation={toolSession.validation}
              ownerRevision={toolSession.ownerRevision}
              isCurrentOwner={createToolOwnerPredicate(toolRes)}
              disabled={false}
              target={toolSession.target as EmailMaintenanceTarget}
              onRefresh={createToolRefresh(toolRes)}
            />
          </section>
        )
      })()}

      {toolSession && toolSession.tool === 'batch' && toolSession.source === 'page' && activeReservationRef.current?.id === toolSession.id && (() => {
        const toolRes = activeReservationRef.current
        return (
          <section className="space-y-2.5 rounded-lg border bg-card p-3 text-card-foreground shadow-sm" aria-label="批量检测面板">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-sm font-semibold">批量检测面板</h3>
              <Button variant="outline" size="sm" onClick={createToolClose(toolRes)}>
                退出批量面板
              </Button>
            </div>
            <CredentialBatchPanel
              mode={mode}
              scope={toolSession.scope}
              validation={toolSession.validation}
              ownerRevision={toolSession.ownerRevision}
              isCurrentOwner={createToolOwnerPredicate(toolRes)}
              filenames={toolSession.filenames as readonly string[]}
              disabled={false}
              onRefresh={createToolRefresh(toolRes)}
            />
          </section>
        )
      })()}

      {c.materializing && (
        <div role="status" className="flex items-center gap-2.5 rounded-md border border-info/30 bg-info-bg p-2 text-xs text-info">
          <span className="font-medium">
            正在物化文件集合，已读取 {c.progress} 项…
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              if (isOwnerActive()) c.cancelSelection()
            }}
          >
            取消读取
          </Button>
        </div>
      )}
      {c.selected.size > 100 && (
        <p className="text-xs text-warning">
          下载和复制邮箱最多 100 项，请减少选择。其他批量动作仍可使用当前集合。
        </p>
      )}
      {c.notice && <p role="status" className="text-xs text-muted-foreground">{c.notice}</p>}
      {result && <p role="status" className="rounded-md border bg-info-bg p-2 text-xs text-info">{result}</p>}
      {c.error && (
        <div role="alert" className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive-bg p-2.5 text-xs text-destructive">
          <span>{c.error}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              if (isOwnerActive()) c.refresh()
            }}
          >
            重试读取
          </Button>
        </div>
      )}
      {renderPagination('top')}
      {c.loading && (
        <div role="status" aria-label="正在加载列表" className="grid gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {!c.loading && c.data && !c.data.items.length && (
        <p className="rounded-lg border bg-card p-6 text-center text-xs text-muted-foreground">
          {c.data.stats.total === 0 ? '尚无凭证，请前往导入页面。' : '没有匹配的凭证，请调整筛选。'}
        </p>
      )}
      {c.data && !!c.data.items.length && (
        viewMode === 'table' ? (
          <CredentialTable
            rows={c.data.items}
            selected={c.selected}
            toggle={(names, checked) => {
              if (isOwnerActive() && activeReservationRef.current === null) c.toggle(names, checked)
            }}
            open={open}
            disabled={blocked}
            openQuota={openQuota}
            quotaCapabilityEnabled={quota.capabilityEnabled}
            mode={mode}
          />
        ) : (
          <div className="grid grid-cols-1 min-w-0 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {c.data.items.map(row => {
              const itemState = quota.getState(row.filename)
              const isSelected = c.selected.has(row.filename)
              return (
                <div
                  key={row.filename}
                  data-state={isSelected ? 'selected' : undefined}
                  className="min-w-0 flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors data-[state=selected]:border-primary/50 data-[state=selected]:bg-selected"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 max-w-full">
                      <Checkbox
                        aria-label={`选择 ${row.filename}`}
                        disabled={blocked}
                        checked={isSelected}
                        onCheckedChange={v => {
                          if (isOwnerActive() && activeReservationRef.current === null) c.toggle([row.filename], v === true)
                        }}
                      />
                      <span className="truncate text-xs font-medium" title={row.filename}>
                        {row.filename}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={blocked}
                        data-credential-filename={row.filename}
                        data-credential-trigger="card-detail"
                        onClick={() => open(row.filename, 'card-detail')}
                      >
                        详情与操作
                      </Button>
                    </div>
                  </div>

                  {itemState.error && (
                    <div
                      role="status"
                      className="rounded-md border border-destructive/30 bg-destructive-bg p-2 text-xs text-destructive"
                    >
                      {itemState.error}
                    </div>
                  )}

                  <QuotaCard
                    filename={row.filename}
                    mode={mode}
                    summary={itemState.summary}
                    loading={itemState.loading}
                    onRefresh={() => {
                      if (isOwnerActive() && activeReservationRef.current === null) {
                        void quota.refresh(row.filename)
                      }
                    }}
                    disabled={blocked || !quota.capabilityEnabled}
                  />
                </div>
              )
            })}
          </div>
        )
      )}
      {renderPagination('bottom')}
      {!fixtureMode && (
        <p className="text-sm text-muted-foreground">
          {mode === 'geminicli'
            ? '其他高级管理工具请前往 '
            : '风险检测等其他高级功能继续使用 '}
          <a className="underline underline-offset-4" href={legacy.href}>
            {mode === 'geminicli' ? '旧控制面板' : '旧 AG 面板高级工具'}
          </a>
          。
        </p>
      )}
      {detail && detailOpening && (() => {
        const openingActor = detailOpening

        const ownerBoundErrors = async (filename: string, signal?: AbortSignal): Promise<RecordValue> => {
          if (!isOwnerActive() || !openingActor.isOpeningActive() || (filename && filename !== openingActor.filename)) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          if (busy || activeReservationRef.current !== null) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          if (!openingActor.taskSnapshot()) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          const reservation: PageReservation = {
            id: nextToolSerial.current++,
            kind: 'action',
            token: Object.freeze({}),
            ownerRevision: openingActor.ownerRevision,
            scope: openingActor.scope,
            validation: openingActor.validation,
            openingId: openingActor.id,
            openingFilename: openingActor.filename,
            task: openingActor.taskSnapshot,
            retired: false,
          }
          activeReservationRef.current = reservation
          try {
            const val = await ownedApi.errors(filename, signal)
            if (
              !isOwnerActive() ||
              !openingActor.isOpeningActive() ||
              activeReservationRef.current !== reservation ||
              reservation.retired ||
              !openingActor.taskSnapshot()
            ) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            return val
          } finally {
            if (activeReservationRef.current === reservation) {
              reservation.retired = true
              activeReservationRef.current = null
            }
          }
        }

        const ownerBoundManual = async (
          filename: string,
          operation: 'quota' | 'test' | 'verify-project',
          model?: string,
          signal?: AbortSignal
        ): Promise<ManualResult> => {
          if (!isOwnerActive() || !openingActor.isOpeningActive() || (filename && filename !== openingActor.filename)) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          const current = activeReservationRef.current
          if (!current || current.kind !== 'manual' || current.retired) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          try {
            const val = await ownedApi.manual(filename, operation, model, signal)
            if (
              !isOwnerActive() ||
              !openingActor.isOpeningActive() ||
              activeReservationRef.current !== current ||
              current.retired
            ) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            return val
          } catch (err) {
            if (
              !isOwnerActive() ||
              !openingActor.isOpeningActive() ||
              activeReservationRef.current !== current ||
              current.retired
            ) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            throw err
          }
        }

        const detailApi = {
          ...ownedApi,
          errors: ownerBoundErrors,
          manual: ownerBoundManual,
        }

        const detailAction = async (
          names: string[],
          actionName: string,
          remark?: string
        ): Promise<Outcome | undefined> => {
          if (!openingActor.isOpeningActive() || busy || activeReservationRef.current !== null || !names.length) {
            return
          }
          const reservation: PageReservation = {
            id: nextToolSerial.current++,
            kind: 'action',
            token: Object.freeze({}),
            ownerRevision: openingActor.ownerRevision,
            scope: openingActor.scope,
            validation: openingActor.validation,
            openingId: openingActor.id,
            openingFilename: openingActor.filename,
            task: openingActor.taskSnapshot,
            retired: false,
          }
          activeReservationRef.current = reservation
          setBusy(true)
          setResult('')
          c.invalidateReads()
          try {
            const outcome = await ownedApi.action(names, actionName, remark)
            if (openingActor.isOpeningActive() && activeReservationRef.current === reservation) {
              setResult(
                `${outcome.kind === 'partial' ? '部分成功：' : outcome.kind === 'unknown' ? '结果未知：' : ''}${outcome.message}`
              )
              return outcome
            }
          } catch (e) {
            if (openingActor.isOpeningActive() && activeReservationRef.current === reservation) {
              const outcome = actionFailure(e, names.length)
              c.revoke(e)
              setResult(outcome.message)
              return outcome
            }
          } finally {
            if (activeReservationRef.current === reservation) {
              reservation.retired = true
              activeReservationRef.current = null
              setBusy(false)
              if (openingActor.isOpeningActive()) {
                c.refresh()
              }
            }
          }
        }

        const handleBeforeManual = (token?: object): boolean => {
          if (!isOwnerActive() || !openingActor.isOpeningActive()) return false
          if (busy || activeReservationRef.current !== null) return false
          if (!openingActor.taskSnapshot()) return false
          const opToken = token ?? Object.freeze({})
          const reservation: PageReservation = {
            id: nextToolSerial.current++,
            kind: 'manual',
            token: opToken,
            ownerRevision: openingActor.ownerRevision,
            scope: openingActor.scope,
            validation: openingActor.validation,
            openingId: openingActor.id,
            openingFilename: openingActor.filename,
            task: openingActor.taskSnapshot,
            retired: false,
          }
          activeReservationRef.current = reservation
          setBusy(true)
          c.invalidateReads()
          return true
        }

        const handleAfterManual = (token?: object) => {
          const current = activeReservationRef.current
          if (current && current.kind === 'manual') {
            if (token !== undefined && current.token !== token) {
              return
            }
            current.retired = true
            activeReservationRef.current = null
            setBusy(false)
            if (openingActor.isOpeningActive()) {
              c.refresh()
            }
          }
        }

        const nestedEmailSession =
          toolSession &&
          toolSession.tool === 'email' &&
          toolSession.source === 'detail' &&
          activeReservationRef.current &&
          activeReservationRef.current.id === toolSession.id &&
          !activeReservationRef.current.retired &&
          activeReservationRef.current.openingId === openingActor.id
            ? {
                id: activeReservationRef.current.id,
                ownerRevision: activeReservationRef.current.ownerRevision,
                isCurrentOwner: createToolOwnerPredicate(activeReservationRef.current),
                onClose: createToolClose(activeReservationRef.current),
                onRefresh: createToolRefresh(activeReservationRef.current),
              }
            : null

        return (
          <CredentialDetail
            key={`${detail.filename}:${c.detailEpoch}:${openingActor.id}`}
            row={detail}
            caps={c.caps}
            close={() => closeDetail(openingActor)}
            restoreFocus={() => {
              if (
                isOwnerActive() &&
                detailSerial.current === openingActor.id &&
                detailFocusRestoredRef.current !== openingActor.id
              ) {
                detailFocusRestoredRef.current = openingActor.id
                restoreCredentialFocus(workspace.current, openingActor.filename, openingActor.trigger, listTitle.current)
              }
            }}
            busy={busy}
            action={detailAction}
            beforeManual={handleBeforeManual}
            afterManual={handleAfterManual}
            captureTask={() => openingActor.taskSnapshot}
            revoke={e => (openingActor.isOpeningActive() ? c.revoke(e) : false)}
            mode={mode}
            credentialApi={detailApi}
            scope={openingActor.scope}
            validation={openingActor.validation}
            ownerRevision={openingActor.ownerRevision}
            isCurrentOwner={isOwnerActive}
            isCurrentOpening={openingActor.isOpeningActive}
            onRefresh={() => {
              if (openingActor.isOpeningActive()) c.refresh()
            }}
            toolSessionActive={isToolOpen}
            nestedEmailSession={nestedEmailSession}
            onOpenToolSession={tool => {
              if (openingActor.isOpeningActive()) {
                return openTool(tool, { kind: 'single', filename: openingActor.filename }, 'detail')
              }
              return false
            }}
            onCloseToolSession={() => {
              if (
                activeReservationRef.current?.source === 'detail' &&
                activeReservationRef.current.openingId === openingActor.id
              ) {
                exitTool(activeReservationRef.current)
              }
            }}
          />
        )
      })()}
      {quotaDialogSerial > 0 && quotaDialogFilename && (() => {
        const dialogSerial = quotaDialogSerial
        const dialogFilename = quotaDialogFilename
        const dialogRefresh = quota.refresh

        return (
          <QuotaDialog
            key={`${dialogFilename}:${dialogSerial}`}
            open={quotaDialogSerial > 0}
            filename={quota.activeFilename ?? dialogFilename}
            summary={quota.activeState?.summary ?? null}
            loading={quota.activeState?.loading ?? false}
            error={quota.activeState?.error ?? null}
            mode={mode}
            onRefresh={() => {
              if (
                !isOwnerActive() ||
                quotaSerial.current !== dialogSerial ||
                currentQuotaTargetRef.current !== dialogFilename
              ) {
                return
              }
              void dialogRefresh(dialogFilename)
            }}
            disabled={!quota.capabilityEnabled}
            onOpenChange={isOpen => {
              if (!isOpen) {
                closeQuota(dialogSerial, dialogFilename)
              }
            }}
            onCloseAutoFocus={event => {
              handleQuotaCloseAutoFocus(event, dialogSerial, dialogFilename)
            }}
          />
        )
      })()}
    </section>
  )
}
