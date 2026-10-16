import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/domain/shared'
import { clearServerLogs, downloadLogs, saveLogBlob } from './api'
import { LogViewer } from './LogViewer'
import { useLogStream } from './useLogStream'
import type { LogLevel } from './stream'

const stateLabels = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '退避重连中',
  stopped: '已停止',
  rejected: '连接被拒绝，请检查登录状态或连接数量',
}

export default function LogsPage() {
  const { authenticated, sessionEpoch } = useAuth()
  const { lines, state, reconnect, clearLocal, stop } = useLogStream()
  const [level, setLevel] = useState<LogLevel | 'ALL'>('ALL')
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const active = useRef(true)
  const epoch = useRef(sessionEpoch)
  epoch.current = sessionEpoch

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    setNotice('')
    setBusy(false)
    setConfirmClear(false)
    setSearch('')
  }, [sessionEpoch])

  async function action(kind: 'clear' | 'download') {
    if (busy || !authenticated) return
    const captured = sessionEpoch
    setBusy(true)
    setNotice('')
    try {
      if (kind === 'clear') {
        await clearServerLogs()
        if (active.current && epoch.current === captured) {
          clearLocal()
          setNotice('服务器已确认清空日志。')
        }
      } else {
        const blob = await downloadLogs()
        if (active.current && epoch.current === captured) {
          saveLogBlob(blob)
          setNotice('日志下载已准备。')
        }
      }
    } catch (error) {
      if (active.current && epoch.current === captured) {
        setNotice(
          error instanceof ApiError && error.status < 500
            ? error.status === 404
              ? '日志不存在或为空。'
              : '服务器拒绝操作，请检查登录状态。'
            : kind === 'clear'
            ? '清空结果未知，请观察当前日志；不会自动重试。'
            : '下载失败，请稍后手动重试。'
        )
      }
    } finally {
      if (active.current && epoch.current === captured) {
        setBusy(false)
        setConfirmClear(false)
      }
    }
  }

  const visible = lines.filter(
    line =>
      (level === 'ALL' || line.level === level) &&
      line.text.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <section
      className="flex flex-col h-[calc(100vh-4.75rem)] md:h-[calc(100vh-5rem)] w-full max-w-[1720px] min-w-0 space-y-2 text-foreground"
      aria-label="运行日志"
    >
      {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true' && (
        <p className="shrink-0 rounded-md border border-border bg-info-bg px-3 py-1 text-xs text-info">
          合成预览；清空与下载只作用于模拟数据，未连接服务器。
        </p>
      )}

      {/* 扁平化单行 36px 紧凑工具栏 */}
      <header
        className="shrink-0 min-w-0 flex min-h-9 flex-wrap items-center gap-1.5 md:gap-2 rounded-lg border border-border bg-card px-2.5 py-1 shadow-control"
        aria-label="日志控制栏"
      >
        <h1 className="text-xs md:text-sm font-semibold text-foreground shrink-0 select-none mr-0.5">
          日志
        </h1>

        {/* 连接状态彩色微胶囊 */}
        <div
          role="status"
          aria-label={stateLabels[state]}
          title={stateLabels[state]}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium shrink-0 select-none",
            state === 'connected' && "border-success/30 bg-success-bg text-success",
            state === 'connecting' && "border-info/30 bg-info-bg text-info",
            state === 'reconnecting' && "border-warning/30 bg-warning-bg text-warning",
            state === 'stopped' && "border-border bg-secondary text-muted-foreground",
            state === 'rejected' && "border-destructive/30 bg-destructive-bg text-destructive"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full shrink-0",
              state === 'connected' && "bg-success",
              state === 'connecting' && "bg-info animate-pulse",
              state === 'reconnecting' && "bg-warning animate-pulse",
              state === 'stopped' && "bg-muted-foreground",
              state === 'rejected' && "bg-destructive"
            )}
            aria-hidden="true"
          />
          <span className="truncate max-w-[120px]">{stateLabels[state]}</span>
        </div>

        <div className="h-4 w-px bg-border shrink-0 hidden sm:block" aria-hidden="true" />

        {/* 等级筛选 */}
        <label className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 select-none">
          <span className="hidden lg:inline">等级</span>
          <select
            aria-label="日志等级"
            className="h-7 rounded border border-input bg-control-background px-1.5 text-xs text-foreground shadow-control ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100"
            value={level}
            onChange={event => setLevel(event.target.value as LogLevel | 'ALL')}
          >
            <option value="ALL">全部等级</option>
            {(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL', 'UNKNOWN'] as const).map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>

        {/* 文本筛选 */}
        <div className="relative flex items-center min-w-0">
          <Input
            aria-label="文本筛选"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="仅筛选本地缓存"
            className="h-7 w-28 sm:w-36 lg:w-44 max-w-full min-w-0 px-2 text-xs"
          />
        </div>

        {/* 跟随滚动 */}
        <label className="flex h-7 items-center gap-1.5 text-xs text-foreground cursor-pointer select-none shrink-0 whitespace-nowrap">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 shrink-0 rounded border-input accent-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-100"
            checked={follow}
            onChange={event => setFollow(event.target.checked)}
          />
          跟随滚动
        </label>

        <div className="h-4 w-px bg-border shrink-0 hidden md:block" aria-hidden="true" />

        {/* 操作按钮组 */}
        <div className="flex flex-wrap items-center gap-1 md:gap-1.5 min-w-0">
          <Button
            size="xs"
            variant="outline"
            onClick={stop}
            disabled={!authenticated || state === 'stopped' || state === 'rejected'}
          >
            停止实时日志
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={reconnect}
            disabled={!authenticated || state === 'connecting' || state === 'connected'}
          >
            重新连接
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !authenticated}
            onClick={() => void action('download')}
          >
            下载服务器日志
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={clearLocal}
          >
            清空本地显示
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={busy || !authenticated}
            onClick={() => setConfirmClear(true)}
          >
            清空服务器日志
          </Button>
        </div>

        {/* 日志行数统计 */}
        <span className="text-[11px] tabular-nums text-muted-foreground shrink-0 select-none ml-auto">
          显示 {visible.length} / 缓存 {lines.length} 条
        </span>
      </header>

      {/* 内嵌轻量级清空服务器日志警示条 */}
      {confirmClear && (
        <div
          className="shrink-0 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-bg px-3 py-1.5 text-xs text-destructive"
          role="group"
          aria-label="确认清空服务器日志"
        >
          <span className="font-medium">
            清空会删除服务器当前日志内容，影响其他查看者，无法撤销。
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => void action('clear')}
            >
              确认清空
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmClear(false)}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 反馈提示 */}
      {notice && (
        <div
          role="status"
          className="shrink-0 flex items-center justify-between rounded-md border border-info/30 bg-info-bg px-3 py-1 text-xs text-info"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice('')}
            className="ml-2 text-xs hover:opacity-75 focus-visible:outline-none"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {/* 终端查看器 */}
      <LogViewer lines={visible} follow={follow} />

      <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">
        连接时读取后端最近 50 行。本地最多保留 1000 条且总字符数不超过 256,000，过长行截断；等级为客户端识别。断线可能遗漏或重复日志，不提供无损恢复。服务端最多允许 3 个查看连接，本页只建立 1 个。
      </p>
    </section>
  )
}
