import { useEffect, useRef, useState } from 'react'
import { getServiceBase } from '@/api/client'
import { useAuth } from '@/auth'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, failureMessage, fixtureMode } from './api'
import { CAP, selectedToolsAllowed, type Credential } from './model'
import { useCredentials } from './useCredentials'
import { FiltersPanel } from './FiltersPanel'
import { CredentialTable } from './CredentialTable'
import { CredentialDetail } from './CredentialDetail'
import { ConfirmAction } from './ConfirmAction'
import { Statistics } from './Statistics'
import { MobileControls, mobilePanelIds, type MobilePanels } from './MobileControls'
import { ManualResultView, type ManualResult } from './ResultView'
export default function CredentialsPage() {
  const { authenticated, sessionEpoch } = useAuth()
  // Unmounting removes body-portaled dialogs as well as all credential state.
  return authenticated ? <CredentialWorkspace key={sessionEpoch} /> : <p className="text-muted-foreground">请登录后查看凭证。</p>
}
export function CredentialWorkspace() {
  const legacy = new URL(getServiceBase()); legacy.hash = 'antigravity-manage'
  const c = useCredentials(); const [detail, setDetail] = useState<Credential | null>(null)
  const [busy, setBusy] = useState(false); const [result, setResult] = useState('')
  const [batch, setBatch] = useState<{ filename: string; result: ManualResult }[]>([])
  const [batchRunning, setBatchRunning] = useState(false); const stop = useRef(false)
  const focusReturn = useRef<HTMLElement | null>(null)
  const [mobilePanels, setMobilePanels] = useState<MobilePanels>({ statistics: false, filters: false, bulk: false })
  useEffect(() => { setDetail(null); setResult(''); setBatch([]); setBusy(false); setBatchRunning(false); stop.current = true }, [c.detailEpoch])
  useEffect(() => () => { stop.current = true }, [])
  useEffect(() => { if (detail && c.data) { const fresh = c.data.items.find(r => r.filename === detail.filename); if (fresh) setDetail(fresh) } }, [c.data])
  function open(filename: string) { const row = c.data?.items.find(r => r.filename === filename); if (row) { focusReturn.current = document.activeElement as HTMLElement; setDetail(row) } }
  function close() { setDetail(null); queueMicrotask(() => focusReturn.current?.focus()) }
  async function action(names: string[], name: string, remark?: string) {
    if (busy || !names.length) return
    const valid = c.captureTask(); setBusy(true); setResult(''); c.invalidateReads()
    try { const outcome = await api.action(names, name, remark); if (valid()) { setResult(`${outcome.kind === 'partial' ? '部分成功：' : outcome.kind === 'unknown' ? '结果未知：' : ''}${outcome.message}`); if (name === 'delete' && outcome.kind === 'success') setDetail(null) } }
    catch (e) { if (valid()) { c.revoke(e); setResult(failureMessage(e, true)) } }
    finally { if (valid()) { setBusy(false); c.refresh() } }
  }
  async function selectedTool(kind: 'download' | 'emails') {
    const names = [...c.selected]; if (!selectedToolsAllowed(c.selected) || busy) return
    const valid = c.captureTask(); setBusy(true); setResult('')
    try {
      if (kind === 'download') {
        const data = await api.download(names); if (!valid()) return
        const url = URL.createObjectURL(data.blob); const a = document.createElement('a'); a.href = url; a.download = 'antigravity-selected.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
        setResult(`下载已生成：打包 ${data.selected ?? '未知'} 项，缺失 ${data.missing ?? '未知'} 项。`)
      } else {
        const data = await api.emails(names); if (!valid()) return
        await navigator.clipboard.writeText(data.emails.join('\n')); if (valid()) setResult(`已复制 ${data.emails.length} 个去重邮箱；匹配 ${data.matched ?? '未知'} 项，缺失 ${data.missing ?? '未知'} 项。`)
      }
    } catch (e) { if (valid()) setResult(failureMessage(e)) }
    finally { if (valid()) setBusy(false) }
  }
  async function batchQuota() {
    if (busy || !c.selected.size) return
    const names = [...c.selected]; const valid = c.captureTask(); stop.current = false; setBusy(true); setBatchRunning(true); setBatch([]); setResult(''); c.invalidateReads()
    let completed = 0
    try {
      for (let i = 0; i < names.length && valid() && !stop.current; i += 10) {
        const rows = await api.quotaBatch(names.slice(i, i + 10)); if (!valid()) break
        completed += rows.length; setBatch(previous => [...previous, ...rows.map(row => ({ filename: row.filename, result: row }))])
      }
      if (valid()) setResult(`${stop.current ? '已停止后续批次' : '批量额度检测完成'}：已返回 ${completed}/${names.length} 项。已执行的操作不会回滚。`)
    } catch (e) { if (valid()) { c.revoke(e); setResult(`${failureMessage(e, true)} 已返回 ${completed}/${names.length} 项，其余未确认。`) } }
    finally { if (valid()) { setBusy(false); setBatchRunning(false); c.refresh() } }
  }
  const blocked = busy || c.materializing; const noSelection = blocked || !c.selected.size
  return <section className="min-w-0 space-y-5" aria-label="Antigravity 凭证" aria-busy={busy || c.loading}><header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Antigravity 凭证</h1><p className="mt-1 text-sm text-muted-foreground">筛选、跨页选择与凭证状态管理</p></div><Button variant="outline" disabled={busy} onClick={c.refresh}>重新读取</Button></header>
    {fixtureMode && <p role="status" className="rounded-lg border p-3 text-sm">开发模式合成预览。操作结果为模拟数据，不代表后端已执行。</p>}
    <MobileControls total={c.data?.total} selected={c.selected.size} panels={mobilePanels} toggle={panel => setMobilePanels(current => ({ ...current, [panel]: !current[panel] }))} />
    <div id={mobilePanelIds.statistics} className={mobilePanels.statistics ? 'block' : 'hidden md:block'}>{c.data && <Statistics page={c.data} />}</div>
    <fieldset id={mobilePanelIds.filters} className={mobilePanels.filters ? 'block' : 'hidden md:block'} disabled={busy}><legend className="sr-only">凭证筛选</legend><FiltersPanel filters={c.filters} caps={c.caps} onApply={c.applyFilters} /></fieldset>
    <section id={mobilePanelIds.bulk} className={`space-y-3 rounded-xl border bg-card p-4 ${mobilePanels.bulk ? 'block' : 'hidden md:block'}`} aria-label="批量操作"><div className="flex flex-wrap items-center gap-2"><strong className="mr-2 text-sm">已跨页选择 {c.selected.size} 项</strong><Button variant="outline" disabled={blocked || !c.data?.items.length} onClick={() => c.toggle(c.data!.items.map(r => r.filename), true)}>选择当前页</Button><Button variant="outline" disabled={blocked || !c.data?.total} onClick={() => void c.selectAll()}>读取并选择全部匹配</Button><Button variant="ghost" disabled={busy} onClick={c.clearSelection}>清除选择</Button></div>
    <div className="flex flex-wrap gap-2"><Button disabled={noSelection} onClick={() => void action([...c.selected], 'enable')}>批量启用</Button><Button variant="outline" disabled={noSelection} onClick={() => void action([...c.selected], 'disable')}>批量禁用</Button><ConfirmAction label="批量永久禁用" disabled={noSelection || !c.caps.has(CAP.permanent)} description={`对已物化集合中的 ${c.selected.size} 个凭证永久禁用；可能部分成功。`} onConfirm={() => void action([...c.selected], 'permanent_disable')} /><ConfirmAction label="批量删除" disabled={noSelection} description={`删除已物化集合中的 ${c.selected.size} 个凭证。此操作不可由页面撤销，可能部分成功。`} onConfirm={() => void action([...c.selected], 'delete')} /><ConfirmAction label="批量开启信用额度" disabled={noSelection || !c.caps.has(CAP.credit)} description="对选中凭证开启信用额度并清除模型冷却，可能部分成功。" onConfirm={() => void action([...c.selected], 'enable_credit')} /><ConfirmAction label="批量关闭信用额度" disabled={noSelection || !c.caps.has(CAP.credit)} description="对选中凭证关闭信用额度并清除模型冷却，可能部分成功。" onConfirm={() => void action([...c.selected], 'disable_credit')} /></div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={blocked || !selectedToolsAllowed(c.selected)} onClick={() => void selectedTool('download')}>下载选中</Button><Button variant="outline" disabled={blocked || !selectedToolsAllowed(c.selected)} onClick={() => void selectedTool('emails')}>复制邮箱</Button><ConfirmAction label="批量刷新额度" disabled={noSelection} description={`将为 ${c.selected.size} 个凭证访问上游并同步额度与权限，每批最多 10 项；可停止后续批次，已执行动作不回滚。`} onConfirm={() => void batchQuota()} /></div>
    <p className="text-xs text-muted-foreground">全部匹配按每页 1000 项读取并保存文件名；读取期间列表可能变化，不保证原子快照。</p></section>
    {c.materializing && <div className="flex items-center gap-3"><p role="status">正在物化文件集合，已读取 {c.progress} 项…</p><Button variant="outline" onClick={c.cancelSelection}>取消读取</Button></div>}
    {batchRunning && <Button variant="outline" onClick={() => { stop.current = true; setResult('停止请求已记录；当前批次完成后停止，不会回滚。') }}>停止后续批次</Button>}
    {c.selected.size > 100 && <p className="text-sm text-muted-foreground">下载和复制邮箱最多 100 项，请减少选择。其他批量动作仍可使用当前集合。</p>}
    {c.notice && <p role="status" className="text-sm text-muted-foreground">{c.notice}</p>}{result && <p role="status" className="rounded-lg border p-3 text-sm">{result}</p>}{c.error && <div role="alert" className="rounded-lg border border-destructive p-4 text-destructive">{c.error}<Button variant="outline" className="ml-3" onClick={c.refresh}>重试读取</Button></div>}
    {c.loading && <div role="status" aria-label="正在加载列表" className="grid gap-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-32 w-full" /></div>}
    {!c.loading && c.data && !c.data.items.length && <p className="rounded-xl border p-8 text-center text-muted-foreground">{c.data.stats.total === 0 ? '尚无凭证，请前往导入页面。' : '没有匹配的凭证，请调整筛选。'}</p>}
    {c.data && !!c.data.items.length && <CredentialTable rows={c.data.items} selected={c.selected} toggle={c.toggle} open={open} disabled={blocked} />}
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="分页"><label className="flex items-center gap-2 text-sm">每页<select aria-label="每页数量" value={c.limit} disabled={blocked} className="rounded-md border bg-background p-2" onChange={e => c.setLimit(Number(e.target.value))}>{[20, 25, 50, 100, 200, 500, 1000].map(n => <option key={n}>{n}</option>)}</select></label><span className="text-sm text-muted-foreground">第 {Math.floor(c.offset / c.limit) + 1} 页 · 匹配 {c.data?.total ?? '未知'} 项</span><div className="flex gap-2"><Button variant="outline" disabled={blocked || c.loading || c.offset === 0} onClick={() => c.setOffset(Math.max(0, c.offset - c.limit))}>上一页</Button><Button variant="outline" disabled={blocked || c.loading || !c.data?.hasMore} onClick={() => c.setOffset(c.offset + c.limit)}>下一页</Button></div></nav>
    {batch.length > 0 && <section className="grid gap-3" aria-label="批量额度逐项结果">{batch.map(item => <details className="rounded-lg border p-3" key={item.filename}><summary className="break-all text-sm">{item.filename} · {item.result.success ? '上游成功' : '未成功 / 未确认'} · 写回 {item.result.updates.map(u => u.status).join(' / ') || '未知'}</summary><ManualResultView result={item.result} /></details>)}</section>}
    {!fixtureMode && <p className="text-sm text-muted-foreground">手动获取邮箱、批量模型检测及风险检测继续使用 <a className="underline underline-offset-4" href={legacy.href}>旧 AG 面板高级工具</a>。</p>}
    {detail && <CredentialDetail key={`${detail.filename}:${c.detailEpoch}`} row={detail} caps={c.caps} close={close} busy={busy} action={action} beforeManual={() => { setBusy(true); c.invalidateReads() }} afterManual={() => { setBusy(false); c.refresh() }} captureTask={c.captureTask} revoke={c.revoke} />}
  </section>
}
