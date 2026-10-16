import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { clearServerLogs, downloadLogs, saveLogBlob } from './api'
import { LogViewer } from './LogViewer'
import { useLogStream } from './useLogStream'
import type { LogLevel } from './stream'

const stateLabels = { connecting: '连接中', connected: '已连接', reconnecting: '退避重连中', stopped: '已停止', rejected: '连接被拒绝，请检查登录状态或连接数量' }
export default function LogsPage() {
  const { authenticated, sessionEpoch } = useAuth()
  const { lines, state, reconnect, clearLocal, stop } = useLogStream()
  const [level, setLevel] = useState<LogLevel | 'ALL'>('ALL')
  const [search, setSearch] = useState(''), [follow, setFollow] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const active = useRef(true), epoch = useRef(sessionEpoch)
  epoch.current = sessionEpoch
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setNotice(''); setBusy(false); setConfirmClear(false); setSearch('') }, [sessionEpoch])
  async function action(kind: 'clear' | 'download') {
    if (busy || !authenticated) return
    const captured = sessionEpoch
    setBusy(true); setNotice('')
    try {
      if (kind === 'clear') {
        await clearServerLogs()
        if (active.current && epoch.current === captured) { clearLocal(); setNotice('服务器已确认清空日志。') }
      } else {
        const blob = await downloadLogs()
        if (active.current && epoch.current === captured) { saveLogBlob(blob); setNotice('日志下载已准备。') }
      }
    } catch (error) {
      if (active.current && epoch.current === captured) setNotice(error instanceof ApiError && error.status < 500 ? (error.status === 404 ? '日志不存在或为空。' : '服务器拒绝操作，请检查登录状态。') : kind === 'clear' ? '清空结果未知，请观察当前日志；不会自动重试。' : '下载失败，请稍后手动重试。')
    } finally { if (active.current && epoch.current === captured) { setBusy(false); setConfirmClear(false) } }
  }
  const visible = lines.filter(line => (level === 'ALL' || line.level === level) && line.text.toLowerCase().includes(search.toLowerCase()))
  return <section className="space-y-5 text-foreground" aria-label="运行日志">
    {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true' && <p className="rounded-lg border border-border bg-info-bg p-3 text-xs leading-5 text-info">合成预览；清空与下载只作用于模拟数据，未连接服务器。</p>}
    <header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold text-foreground">日志</h1><p className={`mt-1 text-xs leading-5 ${({ connecting: 'text-info', connected: 'text-success', reconnecting: 'text-warning', stopped: 'text-info', rejected: 'text-destructive' })[state]}`} role="status">{stateLabels[state]}</p></div><div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={stop} disabled={!authenticated || state === 'stopped' || state === 'rejected'}>停止实时日志</Button><Button variant="outline" onClick={reconnect} disabled={!authenticated || state === 'connecting' || state === 'connected'}>重新连接</Button></div></header>
    <Card><CardContent className="space-y-4 pt-6"><div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm">等级<select className="block h-9 rounded-md border border-input bg-control-background px-3 text-base text-foreground shadow-control ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 md:text-sm" value={level} onChange={event => setLevel(event.target.value as LogLevel | 'ALL')}><option value="ALL">全部等级</option>{(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL', 'UNKNOWN'] as const).map(value => <option key={value}>{value}</option>)}</select></label><label className="min-w-48 flex-1 space-y-1 text-sm">文本筛选<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="仅筛选本地缓存" /></label><label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 rounded border-input accent-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-100" checked={follow} onChange={event => setFollow(event.target.checked)} />跟随滚动</label></div>
      <LogViewer lines={visible} follow={follow} />
      <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={busy || !authenticated} onClick={() => void action('download')}>下载服务器日志</Button><Button variant="outline" onClick={clearLocal}>清空本地显示</Button><Button variant="destructive" disabled={busy || !authenticated} onClick={() => setConfirmClear(true)}>清空服务器日志</Button><span className="text-xs leading-5 text-muted-foreground">显示 {visible.length} / 缓存 {lines.length} 条</span></div>
      {confirmClear && <div className="space-y-3 rounded-lg border border-destructive bg-destructive-bg p-4 text-destructive" role="group" aria-label="确认清空服务器日志"><p>清空会删除服务器当前日志内容，影响其他查看者，无法撤销。</p><div className="flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => void action('clear')}>确认清空</Button><Button variant="outline" disabled={busy} onClick={() => setConfirmClear(false)}>取消</Button></div></div>}
      {notice && <p role="status" className="rounded-lg bg-info-bg text-info">{notice}</p>}
    </CardContent></Card>
    <p className="text-xs leading-5 text-muted-foreground">连接时读取后端最近 50 行。本地最多保留 1000 条且总字符数不超过 256,000，过长行截断；等级为客户端识别。断线可能遗漏或重复日志，不提供无损恢复。服务端最多允许 3 个查看连接，本页只建立 1 个。</p>
  </section>
}
