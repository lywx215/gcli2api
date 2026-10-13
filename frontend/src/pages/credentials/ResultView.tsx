import { Badge } from '@/components/ui/badge'
import { QuotaStateBadge } from './StatusBadges'
import { manualResult, object, count, familyStatus, type RecordValue } from './model'
export type ManualResult = ReturnType<typeof manualResult>
export function ManualResultView({ result }: { result: ManualResult }) {
  return <section className="grid gap-2 rounded-xl border bg-card p-3 text-sm text-card-foreground" aria-label="人工操作结果"><p className={result.success ? 'font-medium text-success' : 'font-medium text-warning'}>上游操作：{result.success ? '成功' : '未成功 / 未确认'} · HTTP {result.httpStatus} · 上游 HTTP {result.upstreamStatus ?? '未知'}</p>{result.verifiedReply !== null && <p className={result.verifiedReply ? 'text-success' : 'text-destructive'}>固定回复校验：{result.verifiedReply ? '通过' : '未通过'}</p>}<p>状态写回独立于上游结果：</p>{result.updates.length ? result.updates.map(u => <div key={u.name}><Badge variant={u.status === 'applied' ? 'success' : u.status === 'failed' ? 'destructive' : u.status === 'pending' ? 'warning' : 'info'}>{u.name}：{u.status}</Badge></div>) : <p>未提供写回状态</p>}<Evidence data={result.data} /><div className="max-h-48 overflow-auto">{Object.entries(object(result.data.models)).map(([name, raw]) => { const m = object(raw); return <p key={name} className="break-all">{name}：剩余 {typeof m.remaining === 'number' ? m.remaining : '未知'} · 重置 {typeof m.resetTime === 'string' ? m.resetTime : '未知'}</p> })}</div></section>
}
export function Evidence({ data }: { data: RecordValue }) {
  return <div className="grid gap-2 text-[13px]"><div><QuotaStateBadge data={data} group="gemini-shared" label="Gemini" /></div><div><QuotaStateBadge data={data} group="claude-gpt-shared" label="Claude / GPT" /></div><p>Opus 5.5：{familyStatus(data.model_access_families, 'claude-opus-5-5')}；Opus 4.6：{familyStatus(data.model_access_families, 'claude-opus-4-6')}</p><p className="text-muted-foreground">目录支持有效期为 12 小时；权限、额度与生成验证分别判断。</p></div>
}
export function ErrorSummary({ data }: { data: RecordValue }) {
  const codes = Array.isArray(data.error_codes) ? data.error_codes.filter(c => typeof c === 'number' || typeof c === 'string') : null
  return <div className="text-sm"><p>错误码：{codes ? codes.join('、') || '无已记录错误' : '不可用'}</p>{Object.entries(object(data.error_classifications)).map(([code, value]) => <p key={code}>分类 {code}：{typeof value === 'string' ? value : '已记录，无法识别'}</p>)}<p className="text-[13px] text-muted-foreground">仅显示错误分类，不回显完整上游正文。</p></div>
}
export function CycleStatistics({ data }: { data: RecordValue }) {
  return <div className="text-[13px] text-muted-foreground"><p>累计成功：{count(data.success_count) ?? '不可用'} · 失败：{count(data.failure_count) ?? '不可用'}</p>{['cycle_stats', 'last_cycle_stats'].map(key => <div key={key}><p>{key === 'cycle_stats' ? '当前周期' : '上个周期'}</p>{Object.entries(object(data[key])).map(([family, raw]) => <p key={family}>{family}：{Object.entries(object(raw)).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join(' / ') || '不可用'}</p>)}</div>)}</div>
}
