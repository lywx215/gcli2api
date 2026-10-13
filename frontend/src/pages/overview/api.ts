import { requestJson } from '@/api/client'
import type { Counts, DailyStats, Observation, OverviewData } from './types'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
function counts(raw: Record<string, unknown>, suffix = ''): Counts {
  return { success: count(raw[`success${suffix}`]), failure: count(raw[`failure${suffix}`]), total: count(raw[`total${suffix}`]) }
}
function unavailable(raw: Record<string, unknown>): string | null {
  if (raw.note || raw.error || raw.success === false) return '后端报告此统计不可用'
  if (raw.metric !== undefined && raw.metric !== 'logical_requests') return '统计口径不受支持'
  return null
}
function daily(value: unknown): DailyStats {
  const raw = record(value)
  return { ...counts(raw, '_count'), date: typeof raw.date === 'string' ? raw.date : '' }
}
export function normalizeToday(value: unknown): OverviewData['today'] {
  const raw = record(value), issue = unavailable(raw)
  if (issue) return { value: null, issue }
  if (!raw.date || !['success_count', 'failure_count', 'total_count'].some(key => count(raw[key]) !== null)) return { value: null, issue: '统计数据不可用' }
  return { value: daily(raw), issue: null }
}
export function normalizeRecent(value: unknown): OverviewData['recent'] {
  const raw = record(value), issue = unavailable(raw)
  if (issue) return { value: null, issue }
  // Existing unsupported-backend response has since:null and no rows.
  if (!Array.isArray(raw.items) || (raw.items.length === 0 && raw.since === null)) return { value: null, issue: '近期统计不可用' }
  return { value: raw.items.map(daily), issue: null }
}
export function normalizeModels(value: unknown): OverviewData['models'] {
  const raw = record(value), issue = unavailable(raw)
  if (issue) return { value: null, issue }
  if (!raw.by_family || typeof raw.by_family !== 'object' || Array.isArray(raw.by_family)) return { value: null, issue: '模型统计不可用' }
  return { value: { items: Object.entries(record(raw.by_family)).map(([name, row]) => ({ name, ...counts(record(row)), rpm: count(record(row).rpm) })), rpm: count(record(raw.totals).rpm) }, issue: null }
}
export function normalizeCredentials(value: unknown): OverviewData['credentials'] {
  const raw = record(value), stats = record(raw.stats)
  if (raw.error || raw.success === false || !raw.stats) return { value: null, issue: '凭证摘要不可用' }
  return { value: { total: count(stats.total), normal: count(stats.normal), disabled: count(stats.disabled) }, issue: null }
}
async function observe<T>(path: string, normalize: (raw: unknown) => Observation<T>, signal: AbortSignal, query = {}): Promise<Observation<T>> {
  try { return normalize(await requestJson(path, { signal, query: { mode: 'antigravity', ...query } })) }
  catch (error) { if (signal.aborted) throw error; return { value: null, issue: '读取失败，可手动刷新' } }
}
export async function loadOverview(signal: AbortSignal): Promise<OverviewData> {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return (await import('./fixtures')).overviewFixture
  const [today, recent, models, credentials] = await Promise.all([
    observe('creds/stats-today', normalizeToday, signal),
    observe('creds/stats-recent', normalizeRecent, signal, { days: 7 }),
    observe('creds/stats-today-by-model', normalizeModels, signal),
    observe('creds/status', normalizeCredentials, signal, { offset: 0, limit: 20 }),
  ])
  return { today, recent, models, credentials }
}
