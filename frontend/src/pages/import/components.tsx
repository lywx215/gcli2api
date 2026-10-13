import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { EmailSnapshot, ImportResult } from './types'
const outcomes = { success: '全部成功', partial: '部分成功', failed: '导入失败', unknown: '结果未知' }
const states = { success: '成功', failed: '失败', unknown: '未知', queued: '排队中', running: '获取中', settlement_pending: '等待保存确认', skipped: '已跳过', superseded: '已被新任务替代' }
export function ImportResults({ result }: { result: ImportResult }) {
  return <Card><CardHeader><CardTitle>{outcomes[result.outcome]}</CardTitle></CardHeader><CardContent className="space-y-3">
    <p>成功 {result.items.filter(item => item.status === 'success').length} / {result.items.length} 项</p>
    {result.warnings > 0 && <p role="status">有 {result.warnings} 条导入警告。凭证保存与邮箱补全分别处理，请检查下方补全状态及凭证页。</p>}
    <ul className="divide-y">{result.items.map((item, index) => <li className="flex justify-between gap-4 py-2 break-all" key={index}><span>{item.label}</span><span className="shrink-0">{states[item.status]}</span></li>)}</ul>
  </CardContent></Card>
}
export function EmailResults({ snapshot }: { snapshot: EmailSnapshot }) {
  return <ul className="divide-y">{snapshot.items.map((item, index) => <li className="py-2 text-sm" key={index}><span className="break-all">{item.filename}</span> · {states[item.status]}{item.email && <span className="block text-muted-foreground">{item.email}</span>}</li>)}</ul>
}
