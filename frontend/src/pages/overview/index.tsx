import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePanelChannel } from '@/app/channels'
import {
  getSessionSnapshot,
  getSessionValidationSnapshot,
  registerSessionCleanup,
  subscribeSessionValidation,
  type SessionValidationSnapshot,
} from '@/auth/session'
import { getPanelChannelSnapshot, registerChannelCleanup, type PanelMode } from '@/domain/panel'
import { StatisticsTables, displayCount, displayRate } from './StatisticsTables'
import { useOverview } from './useOverview'
import { getOverviewApiAddresses, getOverviewSuccessRate, type NodeVersion } from './nodeInfo'

export const supportedPanelModes: readonly PanelMode[] = Object.freeze(['antigravity', 'geminicli'] as const)

function formatNodeVersionMeta(version: NodeVersion) {
  const isUsable = (val?: string) =>
    typeof val === 'string' && val.trim().length > 0 && val.trim().toLowerCase() !== 'unknown'

  const sourceRef = isUsable(version.source_ref) ? version.source_ref!.trim() : '未知'
  const fullHash = isUsable(version.full_hash) ? version.full_hash!.trim() : '未知'
  const commitDate = isUsable(version.commit_date)
    ? version.commit_date!.trim()
    : isUsable(version.date)
    ? version.date!.trim()
    : '未知'
  const message = isUsable(version.message) ? version.message!.trim() : '未知'

  return { sourceRef, fullHash, commitDate, message }
}

function isValidSafeUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (!trimmed || trimmed !== raw) return false
  if (/[\x00-\x1f\x7f\s]/.test(raw)) return false
  if (raw.includes('@') || raw.includes('?') || raw.includes('#')) return false

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.username || parsed.password) return false
    if (parsed.search || parsed.hash) return false
    if (!parsed.hostname) return false
    return true
  } catch {
    return false
  }
}

function formatQuotaExpiry(expiry: number | null | undefined): string {
  if (expiry == null) return '不可用'
  if (expiry === 0) return '未记录即将到期的保护'
  if (!Number.isFinite(expiry) || expiry < 0) return '不可用'
  try {
    return new Date(expiry * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return '不可用'
  }
}

type ClipboardOwner = {
  readonly mode: PanelMode
  readonly channelEpoch: number
  readonly sessionEpoch: number
  readonly validation: SessionValidationSnapshot
}

type FallbackItem = {
  readonly id: string
  readonly url: string
  readonly owner: ClipboardOwner
}

function getLiveVerifiedOwner(): ClipboardOwner | null {
  const channel = getPanelChannelSnapshot()
  const session = getSessionSnapshot()
  const validation = getSessionValidationSnapshot()

  if (
    validation.sessionEpoch !== session.sessionEpoch ||
    validation.status !== 'verified' ||
    session.token === null
  ) {
    return null
  }

  return Object.freeze({
    mode: channel.mode,
    channelEpoch: channel.channelEpoch,
    sessionEpoch: session.sessionEpoch,
    validation,
  })
}

function isClipboardOwnerCurrent(owner: ClipboardOwner | null): boolean {
  if (!owner) return false
  const channel = getPanelChannelSnapshot()
  const session = getSessionSnapshot()
  const validation = getSessionValidationSnapshot()

  return (
    owner.mode === channel.mode &&
    owner.channelEpoch === channel.channelEpoch &&
    owner.sessionEpoch === session.sessionEpoch &&
    owner.validation === validation &&
    validation.sessionEpoch === session.sessionEpoch &&
    validation.status === 'verified' &&
    session.token !== null
  )
}

export default function OverviewPage() {
  const { mode, channelEpoch } = usePanelChannel()
  const { data, loading, refresh, nodeData, nodeLoading, refreshNode } = useOverview(mode)
  const validation = useSyncExternalStore(
    subscribeSessionValidation,
    getSessionValidationSnapshot,
    getSessionValidationSnapshot
  )

  const channelLabel = mode === 'geminicli' ? 'Gemini CLI' : 'Antigravity'
  const apiAddresses = useMemo(() => getOverviewApiAddresses(mode), [mode])

  const [copyStatus, setCopyStatus] = useState<{ id: string; text: string } | null>(null)
  const [fallback, setFallback] = useState<FallbackItem | null>(null)
  const [versionDetailsOpen, setVersionDetailsOpen] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef<boolean>(true)

  const capturedOwner = useMemo<ClipboardOwner | null>(() => {
    const live = getLiveVerifiedOwner()
    if (
      !live ||
      live.mode !== mode ||
      live.channelEpoch !== channelEpoch
    ) {
      return null
    }
    return live
  }, [mode, channelEpoch, validation])

  const activeFallback = useMemo(() => {
    if (!fallback) return null
    if (!capturedOwner || !isClipboardOwnerCurrent(fallback.owner)) return null
    if (
      fallback.owner.mode !== capturedOwner.mode ||
      fallback.owner.channelEpoch !== capturedOwner.channelEpoch ||
      fallback.owner.sessionEpoch !== capturedOwner.sessionEpoch ||
      fallback.owner.validation !== capturedOwner.validation
    ) {
      return null
    }
    return fallback
  }, [fallback, capturedOwner])

  useEffect(() => {
    setCopyStatus(null)
    setFallback(null)
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
  }, [mode, channelEpoch])

  useEffect(() => {
    isMountedRef.current = true
    const unregisterChannel = registerChannelCleanup(() => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
      if (isMountedRef.current) {
        setCopyStatus(null)
        setFallback(null)
      }
    })
    return () => {
      isMountedRef.current = false
      unregisterChannel()
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const unregisterSession = registerSessionCleanup(() => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
      if (isMountedRef.current) {
        setCopyStatus(null)
        setFallback(null)
      }
    })
    return () => {
      unregisterSession()
    }
  }, [])

  useEffect(() => {
    const unregisterValidation = subscribeSessionValidation(() => {
      const currentValidation = getSessionValidationSnapshot()
      const currentSession = getSessionSnapshot()
      const isVerified =
        currentValidation.sessionEpoch === currentSession.sessionEpoch &&
        currentValidation.status === 'verified' &&
        currentSession.token !== null

      if (!isVerified) {
        if (copyTimerRef.current) {
          clearTimeout(copyTimerRef.current)
          copyTimerRef.current = null
        }
        if (isMountedRef.current) {
          setCopyStatus(null)
          setFallback(null)
        }
      }
    })
    return () => {
      unregisterValidation()
    }
  }, [])

  const handleCopy = useCallback(
    (id: string, url: string) => {
      if (!isValidSafeUrl(url)) {
        return
      }

      if (!capturedOwner || !isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
        return
      }

      const executionOwner = capturedOwner

      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
          return
        }
        setFallback({ id, url, owner: executionOwner })
        setCopyStatus({ id, text: '复制失败' })
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
            return
          }
          setCopyStatus(null)
          copyTimerRef.current = null
        }, 2000)
        return
      }

      try {
        navigator.clipboard.writeText(url).then(
          () => {
            if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
              return
            }
            setFallback(null)
            setCopyStatus({ id, text: '已复制' })
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
            copyTimerRef.current = setTimeout(() => {
              if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
                return
              }
              setCopyStatus(null)
              copyTimerRef.current = null
            }, 2000)
          },
          () => {
            if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
              return
            }
            setFallback({ id, url, owner: executionOwner })
            setCopyStatus({ id, text: '复制失败' })
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
            copyTimerRef.current = setTimeout(() => {
              if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
                return
              }
              setCopyStatus(null)
              copyTimerRef.current = null
            }, 2000)
          }
        )
      } catch {
        if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
          return
        }
        setFallback({ id, url, owner: executionOwner })
        setCopyStatus({ id, text: '复制失败' })
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current || !isClipboardOwnerCurrent(executionOwner)) {
            return
          }
          setCopyStatus(null)
          copyTimerRef.current = null
        }, 2000)
      }
    },
    [capturedOwner]
  )

  const todayStats = data?.today.value
  const todaySuccessRate = todayStats ? getOverviewSuccessRate(todayStats) : null

  const metrics = [
    ['今日逻辑请求', todayStats?.total, 'count'],
    ['成功', todayStats?.success, 'success'],
    ['失败', todayStats?.failure, 'failure'],
    ['成功率', todaySuccessRate, 'rate'],
    ['当前 RPM', data?.models.value?.rpm, 'count'],
  ] as const

  const creds = data?.credentials.value
  const commonCounters = [
    ['全部', creds?.total],
    ['正常', creds?.normal],
    ['禁用', creds?.disabled],
    ['永久禁用', creds?.permanent_disabled],
    ['冷却中', creds?.in_cooldown],
    ['未冷却', creds?.no_cooldown],
  ] as const

  const hasAgQuota =
    mode === 'antigravity' &&
    creds != null &&
    (creds.quota_restricted !== undefined ||
      creds.quota_unrestricted !== undefined ||
      creds.quota_blocked_unknown !== undefined ||
      creds.quota_state_invalid !== undefined ||
      creds.quota_next_expiry !== undefined)

  const agQuotaCounters = hasAgQuota
    ? ([
        ['额度受限', creds?.quota_restricted],
        ['额度不受限', creds?.quota_unrestricted],
        ['未知受阻', creds?.quota_blocked_unknown],
        ['状态异常', creds?.quota_state_invalid],
      ] as const)
    : []

  return (
    <section className="w-full max-w-[1720px] min-w-0 space-y-3 md:space-y-3.5 text-sm text-foreground" aria-label={`${channelLabel} 概览`} aria-busy={loading}>
      <header className="flex flex-wrap items-center justify-between gap-2.5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">概览</h1>
          <p className="text-xs text-muted-foreground">
            {channelLabel} · logical requests · 每日按北京时间结算{data?.today.value?.date ? ` · ${data.today.value.date}` : ''}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="h-8 px-2.5 text-xs">
          刷新统计
        </Button>
      </header>

      {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true' && (
        <p className="rounded-md border border-border bg-info-bg p-2.5 text-xs text-info">
          合成预览数据，未读取后端。
        </p>
      )}

      {loading && !data && (
        <p role="status" className="text-xs text-muted-foreground">正在读取统计…</p>
      )}

      {data?.today.issue && (
        <p role="status" className="rounded-md border border-border bg-info-bg p-2.5 text-xs text-info">
          {data.today.issue}
        </p>
      )}

      {/* 顶层节点版本信息单行高密度状态条 */}
      <div className="rounded-lg border border-border/80 bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 min-w-0">
            <span className="font-semibold text-foreground">节点版本</span>
            {nodeLoading && !nodeData ? (
              <span role="status">正在读取节点信息…</span>
            ) : nodeData?.version.issue ? (
              <span role="status" className="text-destructive">{nodeData.version.issue}</span>
            ) : nodeData?.version.value ? (
              <>
                <span className="font-semibold text-foreground">
                  {nodeData.version.value.display_version || nodeData.version.value.version || '不可用'}
                </span>
                {(() => {
                  const meta = formatNodeVersionMeta(nodeData.version.value)
                  const shortHash = meta.fullHash.length > 8 ? meta.fullHash.slice(0, 8) : meta.fullHash
                  return (
                    <>
                      <span className="text-border">·</span>
                      <span>Ref: <span className="text-foreground">{meta.sourceRef}</span></span>
                      <span className="text-border">·</span>
                      <span className="font-mono" title={meta.fullHash}>Hash: <span className="text-foreground">{shortHash}</span></span>
                      <span className="text-border">·</span>
                      <span>{meta.commitDate}</span>
                      {meta.message !== '未知' && (
                        <>
                          <span className="text-border hidden md:inline">·</span>
                          <span className="hidden md:inline truncate max-w-[240px] lg:max-w-md" title={meta.message}>
                            {meta.message}
                          </span>
                        </>
                      )}
                    </>
                  )
                })()}
              </>
            ) : (
              <span>版本信息不可用</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {nodeData?.version.value && (
              <button
                type="button"
                onClick={() => setVersionDetailsOpen((prev) => !prev)}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
                aria-expanded={versionDetailsOpen}
                aria-label="切换节点版本详情"
              >
                {versionDetailsOpen ? '收起详情' : '版本详情'}
              </button>
            )}
            {refreshNode && (
              <Button
                variant="ghost"
                size="xs"
                onClick={refreshNode}
                disabled={nodeLoading}
                className="h-6 px-1.5 text-[11px]"
                aria-label="刷新节点信息"
              >
                刷新
              </Button>
            )}
          </div>
        </div>

        {versionDetailsOpen && nodeData?.version.value && (
          <div className="mt-2 border-t border-border/60 pt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs text-muted-foreground">
            {(() => {
              const meta = formatNodeVersionMeta(nodeData.version.value)
              return (
                <>
                  <div>
                    <span className="font-medium text-foreground">版本来源：</span>
                    <span>{meta.sourceRef}</span>
                  </div>
                  <div>
                    <span className="font-medium text-foreground">完整 Hash：</span>
                    <span className="font-mono break-all">{meta.fullHash}</span>
                  </div>
                  <div>
                    <span className="font-medium text-foreground">提交日期：</span>
                    <span>{meta.commitDate}</span>
                  </div>
                  <div>
                    <span className="font-medium text-foreground">提交信息：</span>
                    <span className="break-words whitespace-pre-wrap">{meta.message}</span>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </div>

      {/* 核心指标卡片（成功率、请求数、RPM）高度 72px，4-6 列自适应网格 */}
      <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
        {metrics.map(([label, value, type]) => {
          const formatted = type === 'rate' ? displayRate(value) : displayCount(value)
          const colorClass =
            value == null
              ? 'text-muted-foreground'
              : type === 'success'
                ? 'text-success'
                : type === 'failure'
                  ? 'text-destructive'
                  : 'text-foreground'
          return (
            <Card key={label} className="h-[72px] p-2.5 flex flex-col justify-between min-w-0">
              <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
              <span className={`text-xl font-bold tabular-nums leading-tight ${colorClass}`}>
                {formatted}
              </span>
            </Card>
          )
        })}
      </div>

      {/* 服务地址与代码助手端点：双列栅格，28px 按钮，整洁折叠手动复制回退栏 */}
      <Card className="min-w-0">
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-sm font-semibold">服务地址与端点</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            根据当前通道模式提供兼容的 API 基础端点与代码助手配置
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2.5 p-3 pt-0">
          <details className="group text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground hover:underline flex items-center gap-1.5 py-0.5">
              <span>使用说明</span>
              <span className="text-[11px] text-muted-foreground font-normal">(点击展开配置指引)</span>
            </summary>
            <div className="mt-1.5 rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
              <ul className="list-disc pl-4 space-y-0.5">
                <li>选择当前通道模式并选用客户端兼容的协议（OpenAI、Claude 或 Gemini）。</li>
                <li>复制下方展示的完整基础地址（保留服务根路径前缀），填入客户端的 API 基础地址（Base URL）配置。</li>
                <li>在客户端配置对应的 API 认证凭据，并选用该服务实际支持的模型。</li>
              </ul>
            </div>
          </details>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {/* 代码助手端点 */}
            <div className="rounded-lg border border-border bg-card p-2.5 space-y-1.5 transition-colors">
              <div className="flex items-center justify-between gap-2 min-h-[32px]">
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-semibold text-foreground block">代码助手端点</span>
                  {nodeLoading && !nodeData ? (
                    <p role="status" className="text-[11px] text-muted-foreground">正在读取代码助手端点…</p>
                  ) : nodeData?.codeAssistEndpoint.issue ? (
                    <p role="status" className="text-[11px] text-destructive">{nodeData.codeAssistEndpoint.issue}</p>
                  ) : nodeData?.codeAssistEndpoint.value ? (
                    <code className="block truncate text-[11px] text-muted-foreground font-mono" title={nodeData.codeAssistEndpoint.value}>
                      {nodeData.codeAssistEndpoint.value}
                    </code>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">代码助手端点不可用</p>
                  )}
                </div>
                {nodeData?.codeAssistEndpoint?.value && isValidSafeUrl(nodeData.codeAssistEndpoint.value) && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => handleCopy('code-assist', nodeData.codeAssistEndpoint.value!)}
                      aria-label="复制代码助手端点"
                    >
                      复制
                    </Button>
                    <Button asChild variant="outline" size="xs">
                      <a
                        href={nodeData.codeAssistEndpoint.value}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="打开代码助手端点"
                      >
                        打开
                      </a>
                    </Button>
                  </div>
                )}
              </div>
              {copyStatus?.id === 'code-assist' && (
                <span role="status" className="block text-[11px] text-muted-foreground">
                  {copyStatus.text}
                </span>
              )}
              {isValidSafeUrl(nodeData?.codeAssistEndpoint?.value ?? '') &&
                activeFallback?.id === 'code-assist' && (
                  <div className="space-y-1 border-t border-border/60 pt-1.5">
                    <label
                      htmlFor="manual-copy-code-assist"
                      className="block text-[11px] font-medium text-foreground"
                    >
                      代码助手端点（手动复制）
                    </label>
                    <input
                      id="manual-copy-code-assist"
                      type="text"
                      readOnly
                      value={activeFallback.url}
                      onFocus={(e) => e.currentTarget.select()}
                      onClick={(e) => e.currentTarget.select()}
                      className="w-full h-7 rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label="代码助手端点（手动复制）"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      剪贴板不可用，请全选上方端点并手动复制。
                    </p>
                  </div>
                )}
            </div>

            {/* 服务地址列表 */}
            {apiAddresses.issue ? (
              <div className="rounded-lg border border-border p-2.5">
                <p role="status" className="text-xs text-destructive">{apiAddresses.issue}</p>
              </div>
            ) : !apiAddresses.value || apiAddresses.value.length === 0 ? (
              <div className="rounded-lg border border-border p-2.5">
                <p className="text-xs text-muted-foreground">服务地址不可用</p>
              </div>
            ) : (
              apiAddresses.value.map((item) => {
                const isValid = isValidSafeUrl(item.url)
                const isFallbackActive = isValid && activeFallback?.id === item.id
                return (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border bg-card p-2.5 space-y-1.5 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 min-h-[32px]">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold text-foreground block">{item.label} 服务地址</span>
                        <code className="block truncate text-[11px] text-muted-foreground font-mono" title={item.url}>
                          {item.url}
                        </code>
                      </div>
                      {isValid && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => handleCopy(item.id, item.url)}
                            aria-label={`复制 ${item.label} 服务地址`}
                          >
                            复制
                          </Button>
                          <Button asChild variant="outline" size="xs">
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`打开 ${item.label} 服务地址`}
                            >
                              打开
                            </a>
                          </Button>
                        </div>
                      )}
                    </div>
                    {copyStatus?.id === item.id && (
                      <span role="status" className="block text-[11px] text-muted-foreground">
                        {copyStatus.text}
                      </span>
                    )}
                    {isFallbackActive && (
                      <div className="space-y-1 border-t border-border/60 pt-1.5">
                        <label
                          htmlFor={`manual-copy-${item.id}`}
                          className="block text-[11px] font-medium text-foreground"
                        >
                          {item.label} 服务地址（手动复制）
                        </label>
                        <input
                          id={`manual-copy-${item.id}`}
                          type="text"
                          readOnly
                          value={activeFallback.url}
                          onFocus={(e) => e.currentTarget.select()}
                          onClick={(e) => e.currentTarget.select()}
                          className="w-full h-7 rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          aria-label={`${item.label} 服务地址（手动复制）`}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          剪贴板不可用，请全选上方地址并手动复制。
                        </p>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </CardContent>
      </Card>

      {/* 凭证摘要计数器与 AG 额度冷却组：行距由 gap-8 调整为 gap-4，内边距紧凑 */}
      <Card>
        <CardHeader className="p-3 pb-1.5">
          <CardTitle className="text-sm font-semibold">凭证摘要</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {data?.credentials.issue ? (
            <p role="status" className="text-xs text-destructive">{data.credentials.issue}</p>
          ) : (
            <div className="space-y-2.5">
              <dl className="flex flex-wrap gap-4 sm:gap-6">
                {commonCounters.map(([label, value]) => (
                  <div key={label} className="min-w-[64px]">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-bold tabular-nums text-foreground">{displayCount(value)}</dd>
                  </div>
                ))}
              </dl>
              {hasAgQuota && (
                <div className="border-t border-border/70 pt-2">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">额度与冷却组</p>
                  <dl className="flex flex-wrap gap-4 sm:gap-6">
                    {agQuotaCounters.map(([label, value]) => (
                      <div key={label} className="min-w-[64px]">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="text-lg font-bold tabular-nums text-foreground">{displayCount(value)}</dd>
                      </div>
                    ))}
                    <div>
                      <dt className="text-xs text-muted-foreground">下次额度重置</dt>
                      <dd className="text-lg font-bold tabular-nums text-foreground">{formatQuotaExpiry(creds?.quota_next_expiry)}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            状态由后端摘要提供；正常状态不代表额度或模型权限已验证。
          </p>
        </CardContent>
      </Card>

      {/* 统计报表 */}
      <StatisticsTables data={data} />

      <p className="text-xs text-muted-foreground">
        可见页面每 30 秒刷新。统计请求分别读取，不保证同一时刻快照；不支持或缺失的数据标记为不可用。
      </p>
    </section>
  )
}
