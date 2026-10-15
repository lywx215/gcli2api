import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getServiceBase } from '@/api/client'
import { useAuth } from '@/auth'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  subscribeSessionValidation,
} from '@/auth/session'
import { usePanelChannel } from '@/app/channels'
import {
  isPanelScopeCurrent,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  actionFailure,
  createCredentialApi,
  failureMessage,
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
import { ManualResultView, type ManualResult } from './ResultView'
import { useQuotaSummary } from './quota/useQuotaSummary'
import { QuotaCard } from './quota/QuotaCard'
import { QuotaDialog } from './quota/QuotaDialog'

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

export default function CredentialsPage() {
  const { authenticated, sessionEpoch } = useAuth()
  const { mode, channelEpoch } = usePanelChannel()
  const valSnap = useSyncExternalStore(subscribeSessionValidation, getSessionValidationSnapshot)
  const isVerified = authenticated && valSnap.status === 'verified' && valSnap.sessionEpoch === sessionEpoch
  const incarnation = isVerified ? getValidationIncarnation(valSnap) : 0

  // Unmounting removes body-portaled dialogs as well as all credential state.
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

  const capturedValidationSnapshot = useRef(getSessionValidationSnapshot())
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
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [batch, setBatch] = useState<{ filename: string; result: ManualResult }[]>([])
  const [batchRunning, setBatchRunning] = useState(false)
  const stop = useRef(false)
  const workspace = useRef<HTMLElement | null>(null)
  const listTitle = useRef<HTMLHeadingElement | null>(null)
  const focusReturn = useRef<DetailTrigger>('desktop-detail')
  const detailSerial = useRef(0)
  const [detailId, setDetailId] = useState(0)
  const [mobilePanels, setMobilePanels] = useState<MobilePanels>({ statistics: false, filters: false, bulk: false })

  // View mode local state: 'table' | 'cards', defaulting to 'table'
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table')

  // Quota summary hook: options-object overload with mode and ownerScope
  const quota = useQuotaSummary({
    mode,
    sessionEpoch,
    detailEpoch: c.detailEpoch,
    capabilities: c.caps,
    ownerScope,
  })

  // Quota dialog identity & serial guards
  const quotaRef = useRef(quota)
  quotaRef.current = quota
  const currentQuotaTargetRef = useRef<string | null>(null)
  const quotaSerial = useRef(0)
  const [quotaDialogSerial, setQuotaDialogSerial] = useState(0)
  const [quotaDialogFilename, setQuotaDialogFilename] = useState<string | null>(null)
  const quotaFocusReturn = useRef<DetailTrigger>('desktop-quota')
  const activeDetailOpeningRef = useRef<{ id: number; filename: string } | null>(null)
  const detailFocusRestoredRef = useRef(0)
  const quotaFocusRestoredRef = useRef(0)

  // Synchronous invalidation on validation change while mounted
  useEffect(() => {
    const unsubValidation = subscribeSessionValidation(() => {
      if (!isOwnerActive()) {
        activeDetailOpeningRef.current = null
        setDetail(null)
        setResult('')
        setBatch([])
        setBusy(false)
        setBatchRunning(false)
        stop.current = true
        currentQuotaTargetRef.current = null
        quotaSerial.current++
        setQuotaDialogSerial(0)
        setQuotaDialogFilename(null)
        quotaRef.current.clear()
      }
    })
    return unsubValidation
  }, [isOwnerActive])

  // DetailEpoch reset: clears detail, batch, busy, and quota dialog/target state
  useEffect(() => {
    activeDetailOpeningRef.current = null
    setDetail(null)
    setResult('')
    setBatch([])
    setBusy(false)
    setBatchRunning(false)
    stop.current = true
    currentQuotaTargetRef.current = null
    quotaSerial.current++
    setQuotaDialogSerial(0)
    setQuotaDialogFilename(null)
    prevItemsRef.current = null
  }, [c.detailEpoch])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      stop.current = true
      activeDetailOpeningRef.current = null
    }
  }, [])

  // Keep open detail fresh if current page data updates
  useEffect(() => {
    if (detail && c.data) {
      const fresh = c.data.items.find(r => r.filename === detail.filename)
      if (fresh) setDetail(fresh)
    }
  }, [c.data, detail])

  // Paging transition disposal: offset/limit change
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

  // Completed list result row removal: clear only disappeared rows
  const prevItemsRef = useRef<string[] | null>(null)
  useEffect(() => {
    if (c.data?.items) {
      const currentFilenames = c.data.items.map(r => r.filename)
      if (prevItemsRef.current !== null) {
        const currentSet = new Set(currentFilenames)
        const disappeared = prevItemsRef.current.filter(fn => !currentSet.has(fn))
        // Do not call clear([]) when there are no disappeared rows!
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
    if (!isOwnerActive()) return
    if (currentQuotaTargetRef.current) {
      const prev = currentQuotaTargetRef.current
      currentQuotaTargetRef.current = null
      quotaSerial.current++
      setQuotaDialogSerial(0)
      setQuotaDialogFilename(null)
      quotaRef.current.close(prev)
    }
    const row = c.data?.items.find(r => r.filename === filename)
    if (row) {
      focusReturn.current = trigger
      const nextId = ++detailSerial.current
      activeDetailOpeningRef.current = { id: nextId, filename }
      setDetailId(nextId)
      setDetail(row)
    }
  }

  function openQuota(filename: string, trigger: DetailTrigger) {
    if (!isOwnerActive()) return
    detailSerial.current++
    activeDetailOpeningRef.current = null
    if (detail) {
      setDetail(null)
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
    if (!isOwnerActive() || busy || !names.length) return
    const valid = c.captureTask()
    const guard = () => isOwnerActive() && valid()
    setBusy(true)
    setResult('')
    c.invalidateReads()
    try {
      const outcome = await ownedApi.action(names, name, remark)
      if (guard()) {
        setResult(`${outcome.kind === 'partial' ? '部分成功：' : outcome.kind === 'unknown' ? '结果未知：' : ''}${outcome.message}`)
        return outcome
      }
    } catch (e) {
      if (guard()) {
        const outcome = actionFailure(e, names.length)
        c.revoke(e)
        setResult(outcome.message)
        return outcome
      }
    } finally {
      if (guard()) {
        setBusy(false)
        c.refresh()
      }
    }
  }

  async function selectedTool(kind: 'download' | 'emails') {
    if (!isOwnerActive()) return
    const names = [...c.selected]
    if (!selectedToolsAllowed(c.selected) || busy) return
    const valid = c.captureTask()
    const guard = () => isOwnerActive() && valid()
    setBusy(true)
    setResult('')
    try {
      if (kind === 'download') {
        const data = await ownedApi.download(names)
        if (!guard()) return
        const url = URL.createObjectURL(data.blob)
        const a = document.createElement('a')
        a.href = url
        a.download = mode === 'geminicli' ? 'geminicli-selected.zip' : 'antigravity-selected.zip'
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        if (guard()) {
          setResult(`下载已生成：打包 ${data.selected ?? '未知'} 项，缺失 ${data.missing ?? '未知'} 项。`)
        }
      } else {
        const data = await ownedApi.emails(names)
        if (!guard()) return
        await navigator.clipboard.writeText(data.emails.join('\n'))
        if (guard()) {
          setResult(`已复制 ${data.emails.length} 个去重邮箱；匹配 ${data.matched ?? '未知'} 项，缺失 ${data.missing ?? '未知'} 项。`)
        }
      }
    } catch (e) {
      if (guard()) setResult(failureMessage(e))
    } finally {
      if (guard()) setBusy(false)
    }
  }

  async function batchQuota() {
    if (!isOwnerActive() || busy || !c.selected.size) return
    const names = [...c.selected]
    const valid = c.captureTask()
    const guard = () => isOwnerActive() && valid()
    stop.current = false
    setBusy(true)
    setBatchRunning(true)
    setBatch([])
    setResult('')
    c.invalidateReads()
    let completed = 0
    try {
      for (let i = 0; i < names.length && guard() && !stop.current; i += 10) {
        const rows = await ownedApi.quotaBatch(names.slice(i, i + 10))
        if (!guard()) break
        completed += rows.length
        setBatch(previous => [...previous, ...rows.map(row => ({ filename: row.filename, result: row }))])
      }
      if (guard()) {
        setResult(`${stop.current ? '已停止后续批次' : '批量额度检测完成'}：已返回 ${completed}/${names.length} 项。已执行的操作不会回滚。`)
      }
    } catch (e) {
      if (guard()) {
        c.revoke(e)
        setResult(`${failureMessage(e, true)} 已返回 ${completed}/${names.length} 项，其余未确认。`)
      }
    } finally {
      if (guard()) {
        setBusy(false)
        setBatchRunning(false)
        c.refresh()
      }
    }
  }

  const blocked = busy || c.materializing
  const noSelection = blocked || !c.selected.size

  return (
    <section
      ref={workspace}
      className="min-w-0 space-y-5"
      aria-label={mode === 'geminicli' ? 'Gemini CLI 凭证' : 'Antigravity 凭证'}
      aria-busy={busy || c.loading}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 ref={listTitle} tabIndex={-1} className="text-2xl font-semibold">
            {mode === 'geminicli' ? 'Gemini CLI 凭证' : 'Antigravity 凭证'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">筛选、跨页选择与凭证状态管理</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label="视图模式"
            className="inline-flex rounded-lg border bg-secondary p-1"
          >
            <Button
              type="button"
              role="radio"
              aria-checked={viewMode === 'table'}
              variant={viewMode === 'table' ? 'default' : 'ghost'}
              size="sm"
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
              size="sm"
              disabled={busy}
              onClick={() => setViewMode('cards')}
            >
              额度卡片
            </Button>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => { if (isOwnerActive()) c.refresh() }}>
            重新读取
          </Button>
        </div>
      </header>
      {fixtureMode && <p role="status" className="rounded-xl border bg-info-bg p-3 text-[13px] text-info">开发模式合成预览。操作结果为模拟数据，不代表后端已执行。</p>}
      <MobileControls
        total={c.data?.total}
        selected={c.selected.size}
        panels={mobilePanels}
        toggle={panel => setMobilePanels(current => ({ ...current, [panel]: !current[panel] }))}
      />
      <div id={mobilePanelIds.statistics} className={mobilePanels.statistics ? 'block' : 'hidden md:block'}>
        {c.data && <Statistics page={c.data} mode={mode} />}
      </div>
      <fieldset id={mobilePanelIds.filters} className={mobilePanels.filters ? 'block' : 'hidden md:block'} disabled={busy}>
        <legend className="sr-only">凭证筛选</legend>
        <FiltersPanel
          filters={c.filters}
          caps={c.caps}
          mode={mode}
          onApply={next => { if (isOwnerActive()) c.applyFilters(next) }}
        />
      </fieldset>
      <section
        id={mobilePanelIds.bulk}
        className={`space-y-3 rounded-xl border bg-card p-4 text-card-foreground ${mobilePanels.bulk ? 'block' : 'hidden md:block'}`}
        aria-label="批量操作"
      >
        <div className="flex flex-wrap items-center gap-2">
          <strong className="mr-2 text-sm">已跨页选择 {c.selected.size} 项</strong>
          <Button
            variant="outline"
            disabled={blocked || !c.data?.items.length}
            onClick={() => { if (isOwnerActive() && c.data?.items.length) c.toggle(c.data.items.map(r => r.filename), true) }}
          >
            选择当前页
          </Button>
          <Button
            variant="outline"
            disabled={blocked || !c.data?.total}
            onClick={() => { if (isOwnerActive() && c.data?.total) void c.selectAll() }}
          >
            读取并选择全部匹配
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => { if (isOwnerActive()) c.clearSelection() }}
          >
            清除选择
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={noSelection} onClick={() => void action([...c.selected], 'enable')}>
            批量启用
          </Button>
          <Button variant="outline" disabled={noSelection} onClick={() => void action([...c.selected], 'disable')}>
            批量禁用
          </Button>
          <ConfirmAction
            label="批量永久禁用"
            disabled={noSelection || !c.caps.has(modeCaps.permanent)}
            description={`对已物化集合中的 ${c.selected.size} 个凭证永久禁用；可能部分成功。`}
            onConfirm={() => void action([...c.selected], 'permanent_disable')}
          />
          <ConfirmAction
            label="批量删除"
            disabled={noSelection}
            description={`删除已物化集合中的 ${c.selected.size} 个凭证。此操作不可由页面撤销，可能部分成功。`}
            onConfirm={() => void action([...c.selected], 'delete')}
          />
          {mode === 'antigravity' && (
            <>
              <ConfirmAction
                label="批量开启信用额度"
                disabled={noSelection || !c.caps.has(CAP.credit)}
                description="对选中凭证开启信用额度并清除模型冷却，可能部分成功。"
                onConfirm={() => void action([...c.selected], 'enable_credit')}
              />
              <ConfirmAction
                label="批量关闭信用额度"
                disabled={noSelection || !c.caps.has(CAP.credit)}
                description="对选中凭证关闭信用额度并清除模型冷却，可能部分成功。"
                onConfirm={() => void action([...c.selected], 'disable_credit')}
              />
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={blocked || !selectedToolsAllowed(c.selected)}
            onClick={() => void selectedTool('download')}
          >
            下载选中
          </Button>
          <Button
            variant="outline"
            disabled={blocked || !selectedToolsAllowed(c.selected)}
            onClick={() => void selectedTool('emails')}
          >
            复制邮箱
          </Button>
          <ConfirmAction
            label="批量刷新额度"
            disabled={noSelection}
            description={`将为 ${c.selected.size} 个凭证访问上游并同步额度与权限，每批最多 10 项；可停止后续批次，已执行动作不回滚。`}
            onConfirm={() => void batchQuota()}
          />
        </div>
        <p className="text-[13px] text-muted-foreground">全部匹配按每页 1000 项读取并保存文件名；读取期间列表可能变化，不保证原子快照。</p>
      </section>
      {c.materializing && (
        <div className="flex items-center gap-3">
          <p role="status" className="text-[13px] text-info">正在物化文件集合，已读取 {c.progress} 项…</p>
          <Button variant="outline" onClick={() => { if (isOwnerActive()) c.cancelSelection() }}>取消读取</Button>
        </div>
      )}
      {batchRunning && (
        <Button variant="outline" onClick={() => { stop.current = true; setResult('停止请求已记录；当前批次完成后停止，不会回滚。') }}>
          停止后续批次
        </Button>
      )}
      {c.selected.size > 100 && (
        <p className="text-[13px] text-warning">下载和复制邮箱最多 100 项，请减少选择。其他批量动作仍可使用当前集合。</p>
      )}
      {c.notice && <p role="status" className="text-sm text-muted-foreground">{c.notice}</p>}
      {result && <p role="status" className="rounded-xl border bg-info-bg p-3 text-sm text-info">{result}</p>}
      {c.error && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive-bg p-4 text-destructive">
          {c.error}
          <Button variant="outline" className="ml-3" onClick={() => { if (isOwnerActive()) c.refresh() }}>
            重试读取
          </Button>
        </div>
      )}
      {c.loading && (
        <div role="status" aria-label="正在加载列表" className="grid gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {!c.loading && c.data && !c.data.items.length && (
        <p className="rounded-xl border bg-card p-8 text-center text-muted-foreground">
          {c.data.stats.total === 0 ? '尚无凭证，请前往导入页面。' : '没有匹配的凭证，请调整筛选。'}
        </p>
      )}
      {c.data && !!c.data.items.length && (
        viewMode === 'table' ? (
          <CredentialTable
            rows={c.data.items}
            selected={c.selected}
            toggle={(names, checked) => { if (isOwnerActive()) c.toggle(names, checked) }}
            open={open}
            disabled={blocked}
            openQuota={openQuota}
            quotaCapabilityEnabled={quota.capabilityEnabled}
            mode={mode}
          />
        ) : (
          <div className="grid grid-cols-1 min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {c.data.items.map(row => {
              const itemState = quota.getState(row.filename)
              const isSelected = c.selected.has(row.filename)
              return (
                <div
                  key={row.filename}
                  data-state={isSelected ? 'selected' : undefined}
                  className="min-w-0 flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors data-[state=selected]:border-primary/50 data-[state=selected]:bg-selected"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 max-w-full">
                      <Checkbox
                        aria-label={`选择 ${row.filename}`}
                        disabled={blocked}
                        checked={isSelected}
                        onCheckedChange={v => { if (isOwnerActive()) c.toggle([row.filename], v === true) }}
                      />
                      <span className="truncate text-sm font-medium" title={row.filename}>
                        {row.filename}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked}
                        data-credential-filename={row.filename}
                        data-credential-trigger="card-detail"
                        onClick={() => open(row.filename, 'card-detail')}
                      >
                        详情与操作
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked || !quota.capabilityEnabled}
                        title={!quota.capabilityEnabled ? '当前服务未启用额度查询能力' : undefined}
                        data-credential-filename={row.filename}
                        data-credential-trigger="card-quota"
                        onClick={() => openQuota(row.filename, 'card-quota')}
                      >
                        查看额度
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
                      if (isOwnerActive()) {
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
      <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="分页">
        <label className="flex items-center gap-2 text-sm">
          每页
          <select
            aria-label="每页数量"
            value={c.limit}
            disabled={blocked}
            className="rounded-md border border-input bg-popover p-2 text-base leading-5 md:text-sm disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed"
            onChange={e => { if (isOwnerActive()) c.setLimit(Number(e.target.value)) }}
          >
            {[10, 20, 25, 50, 100, 200, 500, 1000].map(n => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="text-sm text-muted-foreground">
          第 {Math.floor(c.offset / c.limit) + 1} 页 · 匹配 {c.data?.total ?? '未知'} 项
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={blocked || c.loading || c.offset === 0}
            onClick={() => { if (isOwnerActive()) c.setOffset(Math.max(0, c.offset - c.limit)) }}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            disabled={blocked || c.loading || !c.data?.hasMore}
            onClick={() => { if (isOwnerActive()) c.setOffset(c.offset + c.limit) }}
          >
            下一页
          </Button>
        </div>
      </nav>
      {batch.length > 0 && (
        <section className="grid gap-3" aria-label="批量额度逐项结果">
          {batch.map(item => (
            <details className="rounded-xl border bg-card p-3 text-card-foreground" key={item.filename}>
              <summary className="break-all text-sm font-medium">
                {item.filename} · {item.result.success ? '上游成功' : '未成功 / 未确认'} · 写回 {item.result.updates.map(u => u.status).join(' / ') || '未知'}
              </summary>
              <ManualResultView result={item.result} mode={mode} />
            </details>
          ))}
        </section>
      )}
      {!fixtureMode && (
        <p className="text-sm text-muted-foreground">
          {mode === 'geminicli' ? '高级工具请前往 ' : '手动获取邮箱、批量模型检测及风险检测继续使用 '}
          <a className="underline underline-offset-4" href={legacy.href}>
            {mode === 'geminicli' ? '旧控制面板' : '旧 AG 面板高级工具'}
          </a>
          。
        </p>
      )}
      {detail && (() => {
        const openingId = detailId
        const openingFilename = detail.filename
        const openingTrigger = focusReturn.current

        const isOpeningActive = () =>
          isOwnerActive() &&
          activeDetailOpeningRef.current !== null &&
          activeDetailOpeningRef.current.id === openingId &&
          activeDetailOpeningRef.current.filename === openingFilename

        const isOpeningAdmissible = (filename?: string) =>
          isOpeningActive() && (filename === undefined || filename === openingFilename)

        const ownerBoundErrors = async (filename: string, signal?: AbortSignal): Promise<RecordValue> => {
          const taskToken = c.captureTask()
          const check = () => isOpeningAdmissible(filename) && taskToken()
          if (!check()) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          try {
            const val = await ownedApi.errors(filename, signal)
            if (!check()) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            return val
          } catch (err) {
            if (!check()) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            throw err
          }
        }

        const ownerBoundManual = async (
          filename: string,
          operation: 'quota' | 'test' | 'verify-project',
          model?: string,
          signal?: AbortSignal
        ): Promise<ManualResult> => {
          const taskToken = c.captureTask()
          const check = () => isOpeningAdmissible(filename) && taskToken()
          if (!check()) {
            throw new DOMException('操作已取消。', 'AbortError')
          }
          try {
            const val = await ownedApi.manual(filename, operation, model, signal)
            if (!check()) {
              throw new DOMException('操作已取消。', 'AbortError')
            }
            return val
          } catch (err) {
            if (!check()) {
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
          const taskToken = c.captureTask()
          const guard = () => isOpeningAdmissible() && taskToken()
          if (!guard() || busy || !names.length) return
          setBusy(true)
          setResult('')
          c.invalidateReads()
          try {
            const outcome = await ownedApi.action(names, actionName, remark)
            if (guard()) {
              setResult(`${outcome.kind === 'partial' ? '部分成功：' : outcome.kind === 'unknown' ? '结果未知：' : ''}${outcome.message}`)
              return outcome
            }
          } catch (e) {
            if (guard()) {
              const outcome = actionFailure(e, names.length)
              c.revoke(e)
              setResult(outcome.message)
              return outcome
            }
          } finally {
            if (guard()) {
              setBusy(false)
              c.refresh()
            }
          }
        }

        return (
          <CredentialDetail
            key={`${detail.filename}:${c.detailEpoch}:${detailId}`}
            row={detail}
            caps={c.caps}
            close={() => {
              if (isOpeningActive()) {
                activeDetailOpeningRef.current = null
                setDetail(null)
                setBusy(false)
              }
            }}
            restoreFocus={() => {
              if (
                isOwnerActive() &&
                detailSerial.current === openingId &&
                detailFocusRestoredRef.current !== openingId
              ) {
                detailFocusRestoredRef.current = openingId
                restoreCredentialFocus(workspace.current, openingFilename, openingTrigger, listTitle.current)
              }
            }}
            busy={busy}
            action={detailAction}
            beforeManual={() => {
              if (isOpeningActive() && c.captureTask()()) {
                setBusy(true)
                c.invalidateReads()
              }
            }}
            afterManual={() => {
              if (isOpeningActive() && c.captureTask()()) {
                setBusy(false)
                c.refresh()
              }
            }}
            captureTask={() => {
              const boundTask = c.captureTask()
              return () => isOpeningActive() && boundTask()
            }}
            revoke={e => (isOpeningActive() && c.captureTask()() ? c.revoke(e) : false)}
            mode={mode}
            credentialApi={detailApi}
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
