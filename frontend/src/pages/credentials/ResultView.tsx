import { Badge } from '@/components/ui/badge'
import type { PanelMode } from '@/domain/panel'
import { QuotaStateBadge } from './StatusBadges'
import { manualResult, object, count, familyStatus, type RecordValue } from './model'
export type ManualResult = ReturnType<typeof manualResult>
const phases: Record<string, string> = {
  preparation: '本地准备', config: '本地配置', worker_queue: '任务排队', request_budget: '请求时限',
  oauth: 'Token 刷新', credential_refresh: 'Token 写回', http_queue: '上游请求排队', google: '上游请求',
  quota: '额度查询', quota_sync: '额度状态写回', model_access: '目录权限写回', settlement: '状态结算',
  project: '项目检验', generation: '模型请求',
}
const quotaErrors: Record<string, string> = {
  quota_timeout: '当前阶段超时；已开始的操作可能尚未结算，请重新读取状态；请勿盲目重试。',
  quota_queue_full: '额度查询队列已满，本次请求未能排入队列。',
  quota_shutdown: '服务正在停止，当前操作结果需重新读取状态确认。',
  quota_cancelled: '额度查询已取消；已开始的操作结果需重新读取状态确认。',
  quota_budget_configuration: '本地额度查询时限配置无效，需检查服务配置。',
  quota_failed: '额度查询未完成，请重新读取状态确认。',
}
const updateReasons: Record<string, string> = {
  ...quotaErrors,
  incomplete_quota: '额度信息不完整', invalid_policy: '本地额度状态损坏', credential_changed: '凭证已变化',
  state_conflict: '状态已被其他操作更新', no_recovery_evidence: '没有恢复依据',
  statistics_update_failed: '统计更新失败', state_update_failed: '状态更新失败', invalid_cycle_stats: '周期统计损坏',
  settlement_unconfirmed: '写回结果尚未确认，请重新读取状态；请勿盲目重试。',
  already_settled: '该操作已结算，未重复写回', no_upstream_response: '未取得上游响应',
}
const updateStates: Record<string, string> = { applied: '已更新', pending: '写回结果尚未确认', skipped: '未应用', failed: '更新失败', unknown: '写回状态未知' }
const updateNames = new Set(['credential', 'quota', 'model_access', 'project', 'counts', 'diagnostics', 'disabled', 'cycle_stats', 'statistics', 'gemini-shared', 'claude-gpt-shared', ...Object.keys(phases)])
const agOnlyUpdateKeys = new Set(['gemini-shared', 'claude-gpt-shared', 'model_access', 'catalog', 'credit', 'credit_mode', 'opus', 'claude-opus-5-5', 'claude-opus-4-6'])
function explanation(labels: Record<string, string>, value: unknown, fallback: string) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback
}
function httpStatus(value: unknown) {
  const status = count(value)
  return status !== null && status >= 100 && status <= 599 ? status : null
}
function failureExplanation(result: ManualResult) {
  if ('error_code' in result.data) return explanation(quotaErrors, result.data.error_code, '未识别的结构化错误，请重新读取状态确认；请勿盲目重试。')
  if (result.success) return null
  const status = httpStatus(result.upstreamStatus) ?? httpStatus(result.httpStatus)
  return explanation({ '400': '请求无效', '401': '认证未通过', '403': '权限不足', '404': '请求资源不可用', '408': '请求超时', '429': '请求频率或额度受限' }, String(status), status !== null && status >= 500 ? '服务暂不可用，请重新读取状态确认。' : '未确认有效结果，请重新读取状态；请勿盲目重试。')
}
function remainingPercentage(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return '未知'
  const percent = Number((value * 100).toFixed(2))
  if (value > 0 && percent === 0) return '<0.01%'
  if (value < 1 && percent === 100) return '>99.99%'
  return `${percent}%`
}
function recoveryTime(model: RecordValue) {
  if (model.rolling168h === true) return '恢复时间未知（上游滚动 168h）'
  if (typeof model.resetTimeRaw !== 'string') return '恢复时间未知'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(model.resetTimeRaw)
  if (!match) return '恢复时间未知'
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const offsetHour = Number(match[7] ?? 0); const offsetMinute = Number(match[8] ?? 0)
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  const date = new Date(model.resetTimeRaw)
  if (year < 1000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(date.getTime())) return '恢复时间未知'
  return `${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Shanghai', hourCycle: 'h23' }).format(date)}（北京时间）`
}
export function ManualResultView({ result, mode = 'antigravity' }: { result: ManualResult; mode?: PanelMode }) {
  const failure = failureExplanation(result)
  const updates = mode === 'geminicli' ? result.updates.filter(u => !agOnlyUpdateKeys.has(u.name)) : result.updates
  return <section className="grid gap-2 rounded-xl border bg-card p-3 text-sm text-card-foreground" aria-label="人工操作结果">
    <p className={result.success ? 'font-medium text-success' : 'font-medium text-warning'}>上游操作：{result.success ? '成功' : '未成功 / 未确认'} · HTTP {httpStatus(result.httpStatus) ?? '未知'} · 上游 HTTP {httpStatus(result.upstreamStatus) ?? '未知'}</p>
    {'phase' in result.data && <p>阶段：{explanation(phases, result.data.phase, '请求处理')}</p>}
    {Array.isArray(result.data.phases) && result.data.phases.map((raw, index) => { const event = object(raw); const status = httpStatus(event.upstream_status); return <p key={index} className="text-[13px] text-muted-foreground">{explanation(phases, event.phase, '辅助请求')}：{status === null ? '未取得有效上游 HTTP 状态' : `上游 HTTP ${status}`}</p> })}
    {failure && <p className="text-warning">结果说明：{failure}</p>}
    {result.verifiedReply !== null && <p className={result.verifiedReply ? 'text-success' : 'text-destructive'}>固定回复校验：{result.verifiedReply ? '通过' : '未通过'}</p>}
    <p>状态写回独立于上游结果：</p>
    {updates.length ? updates.map(u => { const update = object(object(result.data.state_update)[u.name]); return <div key={u.name}>
      <Badge variant={u.status === 'applied' ? 'success' : u.status === 'failed' ? 'destructive' : u.status === 'pending' ? 'warning' : 'info'}>{updateNames.has(u.name) ? u.name : '其他状态'}：{u.status}</Badge>
      <p className="mt-1 text-[13px] text-muted-foreground">{updateStates[u.status]}{'reason' in update ? `（${explanation(updateReasons, update.reason, '未提供可识别原因，请重新读取状态确认。')}）` : ''}</p>
    </div> }) : <p>未提供写回状态</p>}
    <Evidence data={result.data} mode={mode} />
    <div className="max-h-48 overflow-auto">{Object.entries(object(result.data.models)).filter(([, raw]) => object(raw).visible !== false).map(([name, raw]) => { const model = object(raw); return <p key={name} className="break-all">{name}：剩余 {remainingPercentage(model.remaining)} · {recoveryTime(model)}</p> })}</div>
  </section>
}
export function Evidence({ data, mode = 'antigravity' }: { data: RecordValue; mode?: PanelMode }) {
  if (mode === 'geminicli') return null
  return <div className="grid gap-2 text-[13px]"><div><QuotaStateBadge data={data} group="gemini-shared" label="Gemini" /></div><div><QuotaStateBadge data={data} group="claude-gpt-shared" label="Claude / GPT" /></div><p>Opus 5.5：{familyStatus(data.model_access_families, 'claude-opus-5-5')}；Opus 4.6：{familyStatus(data.model_access_families, 'claude-opus-4-6')}</p><p className="text-muted-foreground">目录支持有效期为 12 小时；权限、额度与生成验证分别判断。</p></div>
}
export function ErrorSummary({ data }: { data: RecordValue }) {
  const codes = Array.isArray(data.error_codes) ? data.error_codes.filter(c => typeof c === 'number' || typeof c === 'string') : null
  return <div className="text-sm"><p>错误码：{codes ? codes.join('、') || '无已记录错误' : '不可用'}</p>{Object.entries(object(data.error_classifications)).map(([code, value]) => <p key={code}>分类 {code}：{typeof value === 'string' ? value : '已记录，无法识别'}</p>)}<p className="text-[13px] text-muted-foreground">仅显示错误分类，不回显完整上游正文。</p></div>
}
export function CycleStatistics({ data }: { data: RecordValue }) {
  return <div className="text-[13px] text-muted-foreground"><p>累计成功：{count(data.success_count) ?? '不可用'} · 失败：{count(data.failure_count) ?? '不可用'}</p>{['cycle_stats', 'last_cycle_stats'].map(key => { const cycle = object(data[key]); return <div key={key}><p>{key === 'cycle_stats' ? '当前周期' : '上个周期'}</p>{Object.keys(cycle).length > 0 ? ['pro', 'flash', 'other', 'total'].map(k => <p key={k}>{k}：{count(cycle[k]) ?? '不可用'}</p>) : null}</div> })}</div>
}
