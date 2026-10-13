import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { EmailSnapshot, ImportResult } from './types'
const outcomes = { success: '全部成功', partial: '部分成功', failed: '导入失败', unknown: '结果未知' }
const states = { success: '成功', failed: '失败', unknown: '未知', queued: '排队中', running: '获取中', settlement_pending: '等待保存确认', skipped: '已跳过', superseded: '已被新任务替代' }
const outcomeColors = { success: 'text-success', partial: 'text-warning', failed: 'text-destructive', unknown: 'text-warning' }
const stateVariants = { success: 'success', failed: 'destructive', unknown: 'warning', queued: 'info', running: 'info', settlement_pending: 'warning', skipped: 'info', superseded: 'info' } as const
export function ImportResults({ result }: { result: ImportResult }) {
  return <Card><CardHeader><CardTitle className={outcomeColors[result.outcome]}>{outcomes[result.outcome]}</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-foreground">成功 {result.items.filter(item => item.status === 'success').length} / {result.items.length} 项</p>
    {result.warnings > 0 && <p role="status" className="text-sm text-warning">有 {result.warnings} 条导入警告。凭证保存与邮箱补全分别处理，请检查下方补全状态及凭证页。</p>}
    <ul className="divide-y divide-border">{result.items.map((item, index) => <li className="flex justify-between gap-4 py-2 break-all text-sm text-foreground" key={index}><span>{item.label}</span><Badge className="shrink-0 self-start" variant={stateVariants[item.status]}>{states[item.status]}</Badge></li>)}</ul>
  </CardContent></Card>
}
export function EmailResults({ snapshot }: { snapshot: EmailSnapshot }) {
  return <ul className="divide-y divide-border">{snapshot.items.map((item, index) => <li className="py-2 text-sm text-foreground" key={index}><span className="break-all">{item.filename}</span> · <Badge className="align-middle" variant={stateVariants[item.status]}>{states[item.status]}</Badge>{item.email && <span className="block text-xs leading-5 text-muted-foreground">{item.email}</span>}</li>)}</ul>
}
