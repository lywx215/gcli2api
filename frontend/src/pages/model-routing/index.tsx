import { Plus, RotateCcw, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useModelRouting } from './hooks';
import { affectedRows, display, issueText, object, rowChannel } from './types';
import type { RoutingChannel } from './types';
import { RouteTable } from './components/RouteTable';
import { Comparison } from './components/Comparison';
import { useRoutingExitGuard } from './components/ExitGuard';

const labels = { antigravity: 'Antigravity', geminicli: 'Gemini CLI' };
export default function ModelRoutingPage() {
  const page = useModelRouting();
  const guard = useRoutingExitGuard(page.protect, page.discard);
  const activeRows = page.rows.filter(row => rowChannel(row) === page.channel);
  const uneditable = page.rows.map((row, index) => ({ row, index })).filter(({ row }) => !rowChannel(row));
  const example = activeRows.find(object);
  function channelIssues(channel: RoutingChannel) {
    return page.issues.filter(issue => issue.channel === channel || affectedRows(issue).some(index => rowChannel(page.rows[index]) === channel) || (!issue.channel && !affectedRows(issue).length)).length;
  }
  return <div id="routing-content" tabIndex={-1} className="mx-auto max-w-7xl space-y-6">
    <header className="space-y-2"><h1 className="text-2xl font-semibold text-foreground">模型路由</h1><p className="text-xs leading-5 text-muted-foreground">管理模型公开名称与目标名称。切换渠道保留草稿，保存会提交两个渠道的完整路由表。</p></header>
    <p role="status" aria-live="polite" className="text-sm text-info">{page.status}</p>
    {page.ready && !page.supported && <p role="alert" className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-sm text-warning">当前接口未声明完整双渠道路由编辑能力。配置只读展示，请确认服务能力后重新读取。</p>}
    {page.unknown && <p role="alert" className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-sm text-warning">尚有未确认的提交。请手动读回对照，再明确选择采用观察值或继续编辑；不会自动重试保存。</p>}
    {page.recovery && !page.repairing && <section className="space-y-3 rounded-lg border border-warning/30 bg-warning-bg p-4 text-warning" aria-label="配置修复"><p>配置暂时不可读取。读取失败可能由损坏配置或存储故障引起。空表修复将覆盖两个渠道的完整表，请先确认是否需要修复。</p><Button variant="outline" disabled={!!page.busy} onClick={event => guard.ask('确认建立空表修复草稿？', '当前完整配置无法读取。保存空表或新建路由会替换两个渠道的全部配置。此操作仅先建立本页草稿，仍需您手动保存。', page.startRepair, event.currentTarget)}>用空表重新编辑修复</Button></section>}
    {page.repairing && <p role="alert" className="rounded-lg border border-warning/30 bg-warning-bg p-3 text-sm text-warning">正在编辑空表修复草稿。保存将替换两个渠道的全部配置。</p>}
    <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <Card className="min-w-0 text-card-foreground"><Tabs value={page.channel} onValueChange={value => page.setChannel(value as RoutingChannel)}><CardHeader className="gap-4">
        <TabsList className="w-full sm:w-auto">{(['antigravity', 'geminicli'] as const).map(channel => <TabsTrigger key={channel} value={channel} className="flex-1" aria-label={`${labels[channel]}${channelIssues(channel) ? `，${channelIssues(channel)} 个错误` : ''}`}>{labels[channel]}{channelIssues(channel) > 0 && <Badge variant="destructive" className="ml-2">{channelIssues(channel)}</Badge>}</TabsTrigger>)}</TabsList>
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><CardTitle>{labels[page.channel]} 路由</CardTitle><Badge variant="secondary">{activeRows.length} 条</Badge></div><Button variant="outline" disabled={!page.editable} onClick={page.addRow}><Plus className="mr-2 size-4" />新增路由</Button></div>
      </CardHeader><TabsContent value={page.channel}><CardContent className="space-y-5">
        <section id="routing-diagnostics" tabIndex={-1} aria-label="路由校验问题" className="space-y-2">{page.issues.length > 0 && <><p role="alert" className="rounded-lg border border-destructive/30 bg-destructive-bg p-3 text-sm text-destructive">完整表共有 {page.issues.length} 个校验问题。行号按两个渠道的完整表计算，草稿均保留。</p>{page.issues.filter(issue => !affectedRows(issue).length).map((issue, index) => <p key={index} className="text-sm text-destructive">{issueText(issue)}</p>)}</>}</section>
        {uneditable.length > 0 && <section aria-label="历史无效行" className="space-y-3 rounded-lg border border-warning/30 bg-warning-bg p-4 text-warning"><p className="text-sm">以下历史行无法按已知渠道编辑，仍包含在完整表中。修复需要明确删除，再重新添加。</p>{uneditable.map(({ index }) => <div key={index} className="flex flex-wrap items-center justify-between gap-2"><span>第 {index + 1} 行：渠道或结构无效</span><Button variant="outline" size="sm" disabled={!page.editable} onClick={() => page.removeRow(index)}>删除第 {index + 1} 行</Button></div>)}</section>}
        {page.ready && activeRows.length === 0 ? <div className="rounded-lg border border-dashed bg-popover p-8 text-center"><p className="font-medium">该渠道暂无路由</p><p className="mt-2 text-xs leading-5 text-muted-foreground">使用“新增路由”添加草稿，保存完整表后生效。</p></div> : <RouteTable routes={page.rows} channel={page.channel} issues={page.issues} disabled={!page.editable} onChange={page.changeRow} onRemove={page.removeRow} focusRequest={page.focusRequest} />}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className={page.unknown || page.dirty ? 'text-xs leading-5 text-warning' : 'text-xs leading-5 text-muted-foreground'}>{page.unknown ? '提交待核对' : page.dirty ? '有未保存修改' : '未修改'} · 完整表 {page.rows.length} 条</p><div className="flex flex-wrap gap-2"><Button id="routing-read" variant="outline" disabled={!!page.busy || !page.auth.authenticated} onClick={() => void page.read(!page.ready)}><RotateCcw className="mr-2 size-4" />重新读取并对照</Button><Button disabled={!page.editable || !page.dirty || page.unknown} onClick={event => page.repairing ? guard.ask('确认保存空表修复？', '将用当前草稿替换两个渠道的完整配置。即使为空表也会发送保存。请确认后继续。', () => void page.save(), event.currentTarget) : void page.save()}><Save className="mr-2 size-4" />保存全部路由</Button></div></div>
        {page.observed && <Comparison observed={page.observed} sent={page.sent} draft={page.rows} disabled={!!page.busy} adopt={() => guard.ask('放弃草稿并采用观察值？', '两个渠道的当前草稿和本次结果跟踪将清除，页面会采用刚读回的完整表。不会向服务器写入，也不会撤销已发送的操作。', page.adoptObserved)} retain={() => guard.ask('结束核对并保留草稿？', '保留当前两个渠道的草稿，按您的选择结束本次结果跟踪。读回本身不保证早先提交未生效，后续保存仍需手动操作。', page.retainAfterComparison)} />}
      </CardContent></TabsContent></Tabs></Card>
      <div className="min-w-0 space-y-4"><Card><CardHeader><CardTitle>请求与响应身份</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p>当前渠道：{labels[page.channel]}</p><pre className="overflow-x-auto rounded-lg border bg-popover p-3 text-xs text-info">{`请求 model: ${example ? display(example.public_name) : '公开名称'}\n响应 model: ${example ? display(example.public_name) : '公开名称'}`}</pre><p className="text-xs leading-5 text-muted-foreground">公开名称与目标名称分开展示；响应身份保留客户端请求名称。名称兼容性和入口冲突以服务端校验为准。</p></CardContent></Card><Card><CardHeader><CardTitle>保存与核对</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p>切换渠道只切换视图，两个渠道和历史字段继续保留。页面不会调用模型。</p><p className="text-xs leading-5 text-muted-foreground">草稿只存在当前页面内存。退出登录、切换会话或确认离开后清除；刷新和关闭浏览器前请先处理草稿。</p><p className="text-xs leading-5 text-muted-foreground">全表保存遵循现有接口，最后一次成功写入生效。重新读取只能观察当时的配置。</p></CardContent></Card></div>
    </div>
    {guard.dialog}
  </div>;
}
