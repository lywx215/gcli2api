import { requestJson } from '@/api/client'
import { getSessionSnapshot } from '@/auth/session'
import { isPanelMode, isPanelScopeCurrent, type PanelMode, type PanelScope } from '@/domain/panel'
import type { Query } from '@/domain/shared'
import type { Counts, CredentialStats, DailyStats, LoadOverviewOptions, Observation, OverviewData } from './types'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const integerCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null

function counts(raw: Record<string, unknown>, suffix = ''): Counts {
  return { success: count(raw[`success${suffix}`]), failure: count(raw[`failure${suffix}`]), total: count(raw[`total${suffix}`]) }
}

function unavailable(raw: Record<string, unknown>, expectedMode?: PanelMode): string | null {
  if (raw.note || raw.error || raw.success === false) return '后端报告此统计不可用'
  if (raw.metric !== undefined && raw.metric !== 'logical_requests') return '统计口径不受支持'
  if (expectedMode && typeof raw.mode === 'string' && raw.mode !== expectedMode) return '统计数据不可用'
  if (raw.by_mode != null) return '统计数据不可用'
  return null
}

function daily(value: unknown): DailyStats {
  const raw = record(value)
  return { ...counts(raw, '_count'), date: typeof raw.date === 'string' ? raw.date : '' }
}

export function normalizeToday(value: unknown, expectedMode?: PanelMode): OverviewData['today'] {
  const raw = record(value), issue = unavailable(raw, expectedMode)
  if (issue) return { value: null, issue }
  if (typeof raw.date !== 'string' || !raw.date || !['success_count', 'failure_count', 'total_count'].some(key => count(raw[key]) !== null)) {
    return { value: null, issue: '统计数据不可用' }
  }
  return { value: daily(raw), issue: null }
}

export function normalizeRecent(value: unknown, expectedMode?: PanelMode): OverviewData['recent'] {
  const raw = record(value), issue = unavailable(raw, expectedMode)
  if (issue) return { value: null, issue }
  // Existing unsupported-backend response has since:null and no rows.
  if (!Array.isArray(raw.items) || (raw.items.length === 0 && raw.since === null)) {
    return { value: null, issue: '近期统计不可用' }
  }
  return { value: raw.items.map(daily), issue: null }
}

export function normalizeModels(value: unknown, expectedMode?: PanelMode): OverviewData['models'] {
  const raw = record(value), issue = unavailable(raw, expectedMode)
  if (issue) return { value: null, issue }
  if (!raw.by_family || typeof raw.by_family !== 'object' || Array.isArray(raw.by_family)) {
    return { value: null, issue: '模型统计不可用' }
  }
  return {
    value: {
      items: Object.entries(record(raw.by_family)).map(([name, row]) => ({
        name,
        ...counts(record(row)),
        rpm: count(record(row).rpm),
      })),
      rpm: count(record(raw.totals).rpm),
    },
    issue: null,
  }
}

export function normalizeCredentials(value: unknown, expectedMode?: PanelMode): OverviewData['credentials'] {
  const raw = record(value)
  if (raw.note || raw.error || raw.success === false || !raw.stats || typeof raw.stats !== 'object' || Array.isArray(raw.stats)) {
    return { value: null, issue: '凭证摘要不可用' }
  }
  if (expectedMode && typeof raw.mode === 'string' && raw.mode !== expectedMode) {
    return { value: null, issue: '凭证摘要不可用' }
  }
  if (raw.by_mode != null) {
    return { value: null, issue: '凭证摘要不可用' }
  }

  const stats = record(raw.stats)
  const result: CredentialStats = {
    total: integerCount(stats.total),
    normal: integerCount(stats.normal),
    disabled: integerCount(stats.disabled),
  }

  const permanentDisabled = integerCount(stats.permanent_disabled)
  if (permanentDisabled !== null) {
    result.permanent_disabled = permanentDisabled
  }

  const inCooldown = integerCount(stats.in_cooldown)
  if (inCooldown !== null) {
    result.in_cooldown = inCooldown
  }

  const noCooldown = integerCount(stats.no_cooldown)
  if (noCooldown !== null) {
    result.no_cooldown = noCooldown
  }

  const isGcli = expectedMode === 'geminicli' || raw.mode === 'geminicli'
  const panelCaps = Array.isArray(raw.panel_capabilities) ? raw.panel_capabilities : []
  const supportsAgQuota = !isGcli && panelCaps.includes('antigravity.cooldown.group_filter')

  if (supportsAgQuota) {
    const quotaRestricted = integerCount(stats.quota_restricted)
    if (quotaRestricted !== null) {
      result.quota_restricted = quotaRestricted
    }

    const quotaUnrestricted = integerCount(stats.quota_unrestricted)
    if (quotaUnrestricted !== null) {
      result.quota_unrestricted = quotaUnrestricted
    }

    const quotaBlockedUnknown = integerCount(stats.quota_blocked_unknown)
    if (quotaBlockedUnknown !== null) {
      result.quota_blocked_unknown = quotaBlockedUnknown
    }

    const quotaStateInvalid = integerCount(stats.quota_state_invalid)
    if (quotaStateInvalid !== null) {
      result.quota_state_invalid = quotaStateInvalid
    }

    if (typeof stats.quota_next_expiry === 'number' && Number.isFinite(stats.quota_next_expiry) && stats.quota_next_expiry >= 0) {
      result.quota_next_expiry = stats.quota_next_expiry
    }
  }

  return { value: result, issue: null }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  if (typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === 'AbortError') return true
  return false
}

function assertScopeAndSignal(signal: AbortSignal, mode: PanelMode, scope?: PanelScope): void {
  if (signal.aborted) {
    if (typeof signal.throwIfAborted === 'function') {
      signal.throwIfAborted()
    }
    throw new DOMException(signal.reason ? String(signal.reason) : '操作已被中止。', 'AbortError')
  }
  if (scope) {
    if (scope.mode !== mode || !isPanelScopeCurrent(scope, getSessionSnapshot().sessionEpoch)) {
      throw new DOMException('作用域已变更，请重新读取。', 'AbortError')
    }
  }
}

async function observe<T>(
  path: string,
  normalize: (raw: unknown) => Observation<T>,
  signal: AbortSignal,
  query: Query = {},
  scope?: PanelScope,
  mode: PanelMode = 'antigravity',
): Promise<Observation<T>> {
  try {
    return normalize(await requestJson(path, { signal, query: { mode, ...query }, scope }))
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    return { value: null, issue: '读取失败，可手动刷新' }
  }
}

export async function loadOverview(
  signal: AbortSignal,
  options?: LoadOverviewOptions,
): Promise<OverviewData> {
  let targetMode: PanelMode = 'antigravity'
  if (options?.mode !== undefined) {
    if (!isPanelMode(options.mode)) {
      throw new TypeError(`Invalid panel mode: ${String(options.mode)}`)
    }
    targetMode = options.mode
  }

  const rawScope = options?.scope
  const frozenScope: PanelScope | undefined = rawScope
    ? Object.freeze({
        mode: rawScope.mode,
        channelEpoch: rawScope.channelEpoch,
        sessionEpoch: rawScope.sessionEpoch,
      })
    : undefined

  assertScopeAndSignal(signal, targetMode, frozenScope)

  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
    if (targetMode === 'geminicli') {
      return {
        today: { value: null, issue: '统计数据不可用' },
        recent: { value: null, issue: '近期统计不可用' },
        models: { value: null, issue: '模型统计不可用' },
        credentials: { value: null, issue: '凭证摘要不可用' },
      }
    }
    assertScopeAndSignal(signal, targetMode, frozenScope)
    const { overviewFixture } = await import('./fixtures')
    assertScopeAndSignal(signal, targetMode, frozenScope)
    return overviewFixture
  }

  assertScopeAndSignal(signal, targetMode, frozenScope)
  const [today, recent, models, credentials] = await Promise.all([
    observe('creds/stats-today', raw => normalizeToday(raw, targetMode), signal, {}, frozenScope, targetMode),
    observe('creds/stats-recent', raw => normalizeRecent(raw, targetMode), signal, { days: 7 }, frozenScope, targetMode),
    observe('creds/stats-today-by-model', raw => normalizeModels(raw, targetMode), signal, {}, frozenScope, targetMode),
    observe('creds/status', raw => normalizeCredentials(raw, targetMode), signal, { offset: 0, limit: 20 }, frozenScope, targetMode),
  ])
  assertScopeAndSignal(signal, targetMode, frozenScope)
  return { today, recent, models, credentials }
}
