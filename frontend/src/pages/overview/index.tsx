import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePanelChannel } from '@/app/channels'
import { getSessionSnapshot, getSessionValidationSnapshot } from '@/auth/session'
import { getPanelChannelSnapshot, registerChannelCleanup, type PanelMode } from '@/domain/panel'
import { StatisticsTables, displayCount, displayRate } from './StatisticsTables'
import { useOverview } from './useOverview'
import { getOverviewApiAddresses, getOverviewSuccessRate } from './nodeInfo'

export const supportedPanelModes: readonly PanelMode[] = Object.freeze(['antigravity', 'geminicli'] as const)

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
    validation.sessionEpoch === session.sessionEpoch &&
    validation.status === 'verified' &&
    session.token !== null
  )
}

export default function OverviewPage() {
  const { mode, channelEpoch } = usePanelChannel()
  const { data, loading, refresh, nodeData, nodeLoading, refreshNode } = useOverview(mode)

  const channelLabel = mode === 'geminicli' ? 'Gemini CLI' : 'Antigravity'
  const apiAddresses = useMemo(() => getOverviewApiAddresses(mode), [mode])

  const [copyStatus, setCopyStatus] = useState<{ id: string; text: string } | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef<boolean>(true)

  const liveOwner = getLiveVerifiedOwner()
  const capturedOwner = useMemo<ClipboardOwner | null>(() => {
    if (
      !liveOwner ||
      liveOwner.mode !== mode ||
      liveOwner.channelEpoch !== channelEpoch
    ) {
      return null
    }
    return liveOwner
  }, [mode, channelEpoch, liveOwner?.mode, liveOwner?.channelEpoch, liveOwner?.sessionEpoch])

  useEffect(() => {
    setCopyStatus(null)
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
  }, [mode, channelEpoch])

  useEffect(() => {
    isMountedRef.current = true
    const unregister = registerChannelCleanup(() => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
      if (isMountedRef.current) {
        setCopyStatus(null)
      }
    })
    return () => {
      isMountedRef.current = false
      unregister()
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
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

      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
          return
        }
        setCopyStatus({ id, text: '复制失败' })
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
        copyTimerRef.current = setTimeout(() => {
          if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
            return
          }
          setCopyStatus(null)
          copyTimerRef.current = null
        }, 2000)
        return
      }

      navigator.clipboard.writeText(url).then(
        () => {
          if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
            return
          }
          setCopyStatus({ id, text: '已复制' })
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => {
            if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
              return
            }
            setCopyStatus(null)
            copyTimerRef.current = null
          }, 2000)
        },
        () => {
          if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
            return
          }
          setCopyStatus({ id, text: '复制失败' })
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => {
            if (!isMountedRef.current || !isClipboardOwnerCurrent(capturedOwner)) {
              return
            }
            setCopyStatus(null)
            copyTimerRef.current = null
          }, 2000)
        }
      )
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
                <div className="mt-1 text-sm">
                  <span className="font-semibold text-foreground">
                    {nodeData.version.value.display_version || nodeData.version.value.version || '不可用'}
                  </span>
                  {nodeData.version.value.commit_date && (
                    <span className="ml-2 text-[13px] text-muted-foreground">
                      ({nodeData.version.value.commit_date})
                    </span>
                  )}
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
          <CardContent>
            {apiAddresses.issue ? (
              <p role="status" className="text-[13px] text-muted-foreground">{apiAddresses.issue}</p>
            ) : !apiAddresses.value || apiAddresses.value.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">服务地址不可用</p>
            ) : (
              <div className="space-y-3">
                {apiAddresses.value.map(item => {
                  const isValid = isValidSafeUrl(item.url)
                  return (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
                    >
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
