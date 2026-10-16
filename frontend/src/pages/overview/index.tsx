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
    typeof val === 'string' && val.trim().length > 0 && val.trim().toLowerCase() !== 'unknown';

  const sourceRef = isUsable(version.source_ref) ? version.source_ref!.trim() : '未知';
  const fullHash = isUsable(version.full_hash) ? version.full_hash!.trim() : '未知';
  const commitDate = isUsable(version.commit_date)
    ? version.commit_date!.trim()
    : isUsable(version.date)
    ? version.date!.trim()
    : '未知';
  const message = isUsable(version.message) ? version.message!.trim() : '未知';

  return { sourceRef, fullHash, commitDate, message };
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
    <section className="space-y-6 text-sm text-foreground" aria-label={`${channelLabel} 概览`} aria-busy={loading}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">概览</h1>
          <p className="text-[13px] text-muted-foreground">
            {channelLabel} · logical requests · 每日按北京时间结算{data?.today.value?.date ? ` · ${data.today.value.date}` : ''}
          </p>
        </div>
        <Button variant="outline" onClick={refresh} disabled={loading}>
          刷新统计
        </Button>
      </header>

      {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true' && (
        <p className="rounded-xl border border-border bg-info-bg p-3 text-[13px] text-info">
          合成预览数据，未读取后端。
        </p>
      )}

      {loading && !data && (
        <p role="status" className="text-muted-foreground">正在读取统计…</p>
      )}

      {data?.today.issue && (
        <p role="status" className="rounded-xl border border-border bg-info-bg p-3 text-info">
          {data.today.issue}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
            <Card key={label}>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent className={`text-3xl font-semibold tabular-nums ${colorClass}`}>
                {formatted}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <div>
              <CardTitle>节点与端点</CardTitle>
              <CardDescription className="text-[13px] text-muted-foreground">节点版本与代码助手配置</CardDescription>
            </div>
            {refreshNode && (
              <Button variant="outline" size="sm" onClick={refreshNode} disabled={nodeLoading}>
                刷新节点信息
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {nodeLoading && !nodeData && (
              <p role="status" className="text-[13px] text-muted-foreground">正在读取节点信息…</p>
            )}
            <div>
              <p className="text-[13px] font-medium text-foreground">节点版本</p>
              {nodeData?.version.issue ? (
                <p role="status" className="text-[13px] text-muted-foreground">{nodeData.version.issue}</p>
              ) : nodeData?.version.value ? (
                <div className="mt-1 text-sm space-y-1.5">
                  <div className="font-semibold text-foreground">
                    {nodeData.version.value.display_version || nodeData.version.value.version || '不可用'}
                  </div>
                  {(() => {
                    const meta = formatNodeVersionMeta(nodeData.version.value);
                    return (
                      <div className="rounded border border-border/60 bg-muted/40 p-2.5 text-xs space-y-1 text-muted-foreground">
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
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">版本信息不可用</p>
              )}
            </div>
            <div>
              <p className="text-[13px] font-medium text-foreground">代码助手端点</p>
              {nodeData?.codeAssistEndpoint.issue ? (
                <p role="status" className="text-[13px] text-muted-foreground">{nodeData.codeAssistEndpoint.issue}</p>
              ) : nodeData?.codeAssistEndpoint.value ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="rounded bg-secondary/80 px-2 py-0.5 text-xs text-foreground">
                    {nodeData.codeAssistEndpoint.value}
                  </code>
                  {isValidSafeUrl(nodeData.codeAssistEndpoint.value) && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopy('code-assist', nodeData.codeAssistEndpoint.value!)}
                        aria-label="复制代码助手端点"
                      >
                        复制
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={nodeData.codeAssistEndpoint.value}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="打开代码助手端点"
                        >
                          打开
                        </a>
                      </Button>
                      {copyStatus?.id === 'code-assist' && (
                        <span role="status" className="text-[13px] text-muted-foreground">
                          {copyStatus.text}
                        </span>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">代码助手端点不可用</p>
              )}
              {isValidSafeUrl(nodeData?.codeAssistEndpoint?.value ?? '') &&
                activeFallback?.id === 'code-assist' && (
                  <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                    <label
                      htmlFor="manual-copy-code-assist"
                      className="block text-xs font-medium text-foreground"
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
                      className="w-full rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label="代码助手端点（手动复制）"
                    />
                    <p className="text-[12px] text-muted-foreground">
                      剪贴板不可用，请全选上方端点并手动复制。
                    </p>
                  </div>
                )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>服务地址</CardTitle>
            <CardDescription className="text-[13px] text-muted-foreground">
              根据当前通道模式提供兼容的 API 基础端点
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground">使用说明</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>选择当前通道模式并选用客户端兼容的协议（OpenAI、Claude 或 Gemini）。</li>
                <li>复制下方展示的完整基础地址（保留服务根路径前缀），填入客户端的 API 基础地址（Base URL）配置。</li>
                <li>在客户端配置对应的 API 认证凭据，并选用该服务实际支持的模型。</li>
              </ul>
            </div>

            {apiAddresses.issue ? (
              <p role="status" className="text-[13px] text-muted-foreground">{apiAddresses.issue}</p>
            ) : !apiAddresses.value || apiAddresses.value.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">服务地址不可用</p>
            ) : (
              <div className="space-y-3">
                {apiAddresses.value.map(item => {
                  const isValid = isValidSafeUrl(item.url)
                  const isFallbackActive = isValid && activeFallback?.id === item.id
                  return (
                    <div
                      key={item.id}
                      className="rounded-lg border border-border p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-foreground">{item.label}</p>
                          <code className="break-all text-xs text-muted-foreground">{item.url}</code>
                        </div>
                        {isValid && (
                          <div className="flex items-center gap-2 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCopy(item.id, item.url)}
                              aria-label={`复制 ${item.label} 服务地址`}
                            >
                              复制
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`打开 ${item.label} 服务地址`}
                              >
                                打开
                              </a>
                            </Button>
                            {copyStatus?.id === item.id && (
                              <span role="status" className="text-[13px] text-muted-foreground">
                                {copyStatus.text}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {isFallbackActive && (
                        <div className="space-y-1 border-t border-border/60 pt-2">
                          <label
                            htmlFor={`manual-copy-${item.id}`}
                            className="block text-xs font-medium text-foreground"
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
                            className="w-full rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            aria-label={`${item.label} 服务地址（手动复制）`}
                          />
                          <p className="text-[12px] text-muted-foreground">
                            剪贴板不可用，请全选上方地址并手动复制。
                          </p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>凭证摘要</CardTitle>
        </CardHeader>
        <CardContent>
          {data?.credentials.issue ? (
            <p role="status" className="text-muted-foreground">{data.credentials.issue}</p>
          ) : (
            <div className="space-y-4">
              <dl className="flex flex-wrap gap-8">
                {commonCounters.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-[13px] text-muted-foreground">{label}</dt>
                    <dd className="text-xl font-semibold tabular-nums">{displayCount(value)}</dd>
                  </div>
                ))}
              </dl>
              {hasAgQuota && (
                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">额度与冷却组</p>
                  <dl className="flex flex-wrap gap-8">
                    {agQuotaCounters.map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-[13px] text-muted-foreground">{label}</dt>
                        <dd className="text-xl font-semibold tabular-nums">{displayCount(value)}</dd>
                      </div>
                    ))}
                    <div>
                      <dt className="text-[13px] text-muted-foreground">下次额度重置</dt>
                      <dd className="text-xl font-semibold tabular-nums">{formatQuotaExpiry(creds?.quota_next_expiry)}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          )}
          <p className="mt-3 text-[13px] text-muted-foreground">
            状态由后端摘要提供；正常状态不代表额度或模型权限已验证。
          </p>
        </CardContent>
      </Card>

      <StatisticsTables data={data} />
      <p className="text-[13px] text-muted-foreground">
        可见页面每 30 秒刷新。统计请求分别读取，不保证同一时刻快照；不支持或缺失的数据标记为不可用。
      </p>
    </section>
  )
}
