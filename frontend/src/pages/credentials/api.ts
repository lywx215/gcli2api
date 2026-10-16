import { ApiError, requestBlob, requestJson } from '@/api/client'
import { getSessionSnapshot } from '@/auth/session'
import { isPanelMode, isPanelScopeCurrent, type PanelMode, type PanelScope } from '@/domain/panel'
import {
  aggregate,
  CAP_BY_MODE,
  count,
  listQuery,
  manualResult,
  object,
  parsePage,
  type Capabilities,
  type CredentialPage,
  type Filters,
  type Outcome,
  type RecordValue,
} from './model'

export const fixtureMode = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'

export const KNOWN_ERROR_CODES = Object.freeze([
  'quota_queue_full',
  'quota_budget_configuration',
  'quota_timeout',
  'subscription_required',
  'settlement_unconfirmed',
  'capability_unavailable',
  'rate_limit_exceeded',
  'invalid_argument',
  'permission_denied',
  'internal_error',
  'state_update_failed',
] as const)

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number]

export const SAFE_ERROR_CODE_LABELS: Readonly<Record<KnownErrorCode, string>> = Object.freeze({
  quota_queue_full: '服务端队列繁忙',
  quota_budget_configuration: '额度预算配置异常',
  quota_timeout: '额度查询超时',
  subscription_required: '需要有效订阅',
  settlement_unconfirmed: '额度结算待确认',
  capability_unavailable: '当前服务不支持此能力',
  rate_limit_exceeded: '请求频率超限',
  invalid_argument: '请求参数无效',
  permission_denied: '没有操作权限',
  internal_error: '服务内部异常',
  state_update_failed: '状态更新失败',
})

export const KNOWN_WRITEBACK_REASONS = Object.freeze([
  'settlement_unconfirmed',
  'state_update_failed',
  'quota_timeout',
  'quota_queue_full',
  'quota_budget_configuration',
] as const)

export const SAFE_WRITEBACK_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  settlement_unconfirmed: '额度结算待确认',
  state_update_failed: '状态更新失败',
  quota_timeout: '额度查询超时',
  quota_queue_full: '服务端队列繁忙',
  quota_budget_configuration: '额度预算配置异常',
})

export const KNOWN_OPUS_FAMILIES = Object.freeze([
  'claude-opus-5-5',
  'claude-opus-4-6',
] as const)

export type KnownOpusFamily = (typeof KNOWN_OPUS_FAMILIES)[number]

export const KNOWN_OPUS_REASONS = Object.freeze([
  'directory_supported',
  'directory_missing',
  'generation_succeeded',
  'generation_404',
  'directory_query_failed',
  'directory_timeout',
  'invalid_state',
] as const)

export type KnownOpusReason = (typeof KNOWN_OPUS_REASONS)[number]

export interface SafeOpusFamilyDetails {
  readonly state: 'supported' | 'unavailable' | 'unknown'
  readonly checked_at?: number
  readonly last_attempt_at?: number
  readonly blocked_until?: number
  readonly next_check_at?: number
  readonly reason?: string
  readonly effective_status: 'supported' | 'unavailable' | 'unknown'
}

export interface SafeManualPublicDetails {
  readonly started?: boolean
  readonly error_code?: string
  readonly project_id?: string
  readonly subscription_tier?: string
  readonly credit_amount?: number
  readonly setting_id?: string
  readonly binding_id?: string
  readonly step?: 'create_setting' | 'create_binding'
  readonly cleared?: readonly string[]
  readonly added_cooldown?: readonly string[]
  readonly skipped_no_quota?: readonly string[]
  readonly skipped_unknown?: readonly string[]
  readonly has_pending_writeback?: boolean
  readonly model_access_families?: Readonly<Record<string, SafeOpusFamilyDetails>>
  readonly failure_reason?: string
  readonly safe_failure_reason?: string
  readonly writeback_reason?: string
}

export type SafeManualResult = ReturnType<typeof manualResult> & {
  readonly publicDetails?: SafeManualPublicDetails
}

export function getSafeHttpStatusLabel(status: number): string {
  switch (status) {
    case 400: return '请求参数无效（HTTP 400）'
    case 401: return '登录已失效（HTTP 401）'
    case 403: return '拒绝访问（HTTP 403）'
    case 404: return '资源不存在（HTTP 404）'
    case 409: return '状态冲突（HTTP 409）'
    case 429: return '请求过多（HTTP 429）'
    case 501: return '当前服务不支持此操作（HTTP 501）'
    case 502: return '网关异常（HTTP 502）'
    case 503: return '服务不可用（HTTP 503）'
    case 504: return '网关超时（HTTP 504）'
    default:
      if (status >= 400 && status < 500) return `请求被拒绝（HTTP ${status}）`
      return `服务未完成（HTTP ${status}）`
  }
}

function projectBoundedStringArray(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  if (raw.length === 0) return Object.freeze([])
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return undefined
    const trimmed = item.trim()
    if (trimmed.length === 0 || trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) {
      return undefined
    }
    result.push(trimmed)
    if (result.length >= 100) break
  }
  return Object.freeze(result)
}

function projectSafeOpusFamilies(rawFamilies: unknown, now: number): Readonly<Record<string, SafeOpusFamilyDetails>> | undefined {
  if (!rawFamilies || typeof rawFamilies !== 'object' || Array.isArray(rawFamilies)) return undefined
  const rawFamMap = rawFamilies as Record<string, unknown>
  const resMap: Record<string, SafeOpusFamilyDetails> = {}
  for (const famKey of KNOWN_OPUS_FAMILIES) {
    if (Object.prototype.hasOwnProperty.call(rawFamMap, famKey)) {
      const famVal = rawFamMap[famKey]
      if (famVal && typeof famVal === 'object' && !Array.isArray(famVal)) {
        const famObj = famVal as Record<string, unknown>
        const famHasOwn = (k: string) => Object.prototype.hasOwnProperty.call(famObj, k)

        let state: 'supported' | 'unavailable' | 'unknown' = 'unknown'
        if (famHasOwn('state') && (famObj.state === 'supported' || famObj.state === 'unavailable')) {
          state = famObj.state
        }

        let checkedAt: number | undefined = undefined
        if (
          famHasOwn('checked_at') &&
          typeof famObj.checked_at === 'number' &&
          Number.isFinite(famObj.checked_at) &&
          famObj.checked_at >= 0 &&
          famObj.checked_at <= now
        ) {
          checkedAt = famObj.checked_at
        }

        let lastAttemptAt: number | undefined = undefined
        if (
          famHasOwn('last_attempt_at') &&
          typeof famObj.last_attempt_at === 'number' &&
          Number.isFinite(famObj.last_attempt_at) &&
          famObj.last_attempt_at >= 0 &&
          famObj.last_attempt_at <= now
        ) {
          lastAttemptAt = famObj.last_attempt_at
        }

        let blockedUntil: number | undefined = undefined
        if (
          famHasOwn('blocked_until') &&
          typeof famObj.blocked_until === 'number' &&
          Number.isFinite(famObj.blocked_until) &&
          famObj.blocked_until >= 0 &&
          famObj.blocked_until * 1000 <= 8640000000000000
        ) {
          blockedUntil = famObj.blocked_until
        }

        let nextCheckAt: number | undefined = undefined
        if (
          famHasOwn('next_check_at') &&
          typeof famObj.next_check_at === 'number' &&
          Number.isFinite(famObj.next_check_at) &&
          famObj.next_check_at >= 0 &&
          famObj.next_check_at * 1000 <= 8640000000000000
        ) {
          nextCheckAt = famObj.next_check_at
        }

        let effectiveStatus: 'supported' | 'unavailable' | 'unknown' = 'unknown'
        if (state === 'supported' && checkedAt !== undefined && now < checkedAt + 43200) {
          effectiveStatus = 'supported'
        } else if (state === 'unavailable') {
          effectiveStatus = 'unavailable'
        }

        let reason: string | undefined = undefined
        if (
          famHasOwn('reason') &&
          typeof famObj.reason === 'string' &&
          (KNOWN_OPUS_REASONS as readonly string[]).includes(famObj.reason)
        ) {
          reason = famObj.reason
        }

        resMap[famKey] = Object.freeze({
          state,
          ...(checkedAt !== undefined ? { checked_at: checkedAt } : {}),
          ...(lastAttemptAt !== undefined ? { last_attempt_at: lastAttemptAt } : {}),
          ...(blockedUntil !== undefined ? { blocked_until: blockedUntil } : {}),
          ...(nextCheckAt !== undefined ? { next_check_at: nextCheckAt } : {}),
          ...(reason !== undefined ? { reason } : {}),
          effective_status: effectiveStatus,
        })
      }
    }
  }
  if (Object.keys(resMap).length > 0) {
    return Object.freeze(resMap)
  }
  return undefined
}

const RECOGNIZED_SAFE_FAILURE_LABELS: ReadonlySet<string> = new Set([
  ...Object.values(SAFE_ERROR_CODE_LABELS),
  ...Object.values(SAFE_WRITEBACK_REASON_LABELS),
  '创建 Release Channel Setting 失败',
  '创建 Setting Binding 失败',
  '请求参数无效（HTTP 400）',
  '登录已失效（HTTP 401）',
  '拒绝访问（HTTP 403）',
  '资源不存在（HTTP 404）',
  '状态冲突（HTTP 409）',
  '请求过多（HTTP 429）',
  '当前服务不支持此操作（HTTP 501）',
  '网关异常（HTTP 502）',
  '服务不可用（HTTP 503）',
  '网关超时（HTTP 504）',
])

function isKnownSafeFailureLabel(label: string): boolean {
  if (RECOGNIZED_SAFE_FAILURE_LABELS.has(label)) return true
  const httpMatch = /^请求被拒绝（HTTP (\d{3})）$/.exec(label) || /^服务未完成（HTTP (\d{3})）$/.exec(label)
  if (httpMatch) {
    const code = Number(httpMatch[1])
    return code >= 100 && code <= 599
  }
  return false
}

export function projectManualPublicDetails(value: unknown, httpStatus?: number): SafeManualPublicDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const statusLabel = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)
      ? getSafeHttpStatusLabel(httpStatus)
      : undefined
    return Object.freeze({
      ...(statusLabel ? { failure_reason: statusLabel, safe_failure_reason: statusLabel } : {}),
    })
  }

  const src = value as Record<string, unknown>
  const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(src, k)
  const now = Date.now() / 1000

  let started: boolean | undefined = undefined
  if (hasOwn('started') && typeof src.started === 'boolean') {
    started = src.started
  }

  let errorCode: string | undefined = undefined
  if (hasOwn('error_code') && typeof src.error_code === 'string' && (KNOWN_ERROR_CODES as readonly string[]).includes(src.error_code)) {
    errorCode = src.error_code
  }

  let projectId: string | undefined = undefined
  if (hasOwn('project_id') && typeof src.project_id === 'string') {
    const trimmed = src.project_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      projectId = trimmed
    }
  }

  let subscriptionTier: string | undefined = undefined
  if (hasOwn('subscription_tier') && typeof src.subscription_tier === 'string') {
    const trimmed = src.subscription_tier.trim()
    if (trimmed.length > 0 && trimmed.length <= 100 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      subscriptionTier = trimmed
    }
  }

  let creditAmount: number | undefined = undefined
  if (hasOwn('credit_amount') && typeof src.credit_amount === 'number' && Number.isFinite(src.credit_amount)) {
    creditAmount = src.credit_amount
  }

  let settingId: string | undefined = undefined
  if (hasOwn('setting_id') && typeof src.setting_id === 'string') {
    const trimmed = src.setting_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      settingId = trimmed
    }
  }

  let bindingId: string | undefined = undefined
  if (hasOwn('binding_id') && typeof src.binding_id === 'string') {
    const trimmed = src.binding_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      bindingId = trimmed
    }
  }

  let step: 'create_setting' | 'create_binding' | undefined = undefined
  if (hasOwn('step')) {
    if (src.step === 'create_setting' || src.step === 'create_binding') {
      step = src.step
    }
  }

  let cleared: readonly string[] | undefined = undefined
  if (hasOwn('cleared')) {
    cleared = projectBoundedStringArray(src.cleared)
  }

  let addedCooldown: readonly string[] | undefined = undefined
  if (hasOwn('added_cooldown')) {
    addedCooldown = projectBoundedStringArray(src.added_cooldown)
  } else if (hasOwn('added')) {
    addedCooldown = projectBoundedStringArray(src.added)
  }

  let skippedNoQuota: readonly string[] | undefined = undefined
  if (hasOwn('skipped_no_quota')) {
    skippedNoQuota = projectBoundedStringArray(src.skipped_no_quota)
  }

  let skippedUnknown: readonly string[] | undefined = undefined
  if (hasOwn('skipped_unknown')) {
    skippedUnknown = projectBoundedStringArray(src.skipped_unknown)
  }

  let hasPendingWriteback = false
  let hasStateUpdate = false
  let writebackReason: string | undefined = undefined

  if (hasOwn('state_update') && src.state_update && typeof src.state_update === 'object' && !Array.isArray(src.state_update)) {
    hasStateUpdate = true
    for (const [, phaseVal] of Object.entries(src.state_update as Record<string, unknown>)) {
      if (phaseVal && typeof phaseVal === 'object' && !Array.isArray(phaseVal)) {
        const pObj = phaseVal as Record<string, unknown>
        const pHasOwn = (k: string) => Object.prototype.hasOwnProperty.call(pObj, k)
        if (pHasOwn('status') && pObj.status === 'pending') {
          hasPendingWriteback = true
        }
        if (pHasOwn('reason') && typeof pObj.reason === 'string' && (KNOWN_WRITEBACK_REASONS as readonly string[]).includes(pObj.reason)) {
          writebackReason = pObj.reason
        }
      }
    }
  }

  if (hasOwn('has_pending_writeback') && typeof src.has_pending_writeback === 'boolean' && src.has_pending_writeback) {
    hasPendingWriteback = true
  }

  if (hasOwn('pending') && src.pending === true) {
    hasPendingWriteback = true
  }

  let projectedOpusFamilies: Readonly<Record<string, SafeOpusFamilyDetails>> | undefined = undefined
  if (hasOwn('model_access_families')) {
    projectedOpusFamilies = projectSafeOpusFamilies(src.model_access_families, now)
  }

  let failureReason: string | undefined = undefined
  if (errorCode) {
    failureReason = SAFE_ERROR_CODE_LABELS[errorCode as KnownErrorCode] ?? errorCode
  } else if (step) {
    failureReason = step === 'create_setting' ? '创建 Release Channel Setting 失败' : '创建 Setting Binding 失败'
  } else if (writebackReason) {
    failureReason = SAFE_WRITEBACK_REASON_LABELS[writebackReason] ?? writebackReason
  } else if (httpStatus !== undefined && typeof httpStatus === 'number' && Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) {
    failureReason = getSafeHttpStatusLabel(httpStatus)
  }

  return Object.freeze({
    ...(started !== undefined ? { started } : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(subscriptionTier !== undefined ? { subscription_tier: subscriptionTier } : {}),
    ...(creditAmount !== undefined ? { credit_amount: creditAmount } : {}),
    ...(settingId !== undefined ? { setting_id: settingId } : {}),
    ...(bindingId !== undefined ? { binding_id: bindingId } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(cleared !== undefined ? { cleared } : {}),
    ...(addedCooldown !== undefined ? { added_cooldown: addedCooldown } : {}),
    ...(skippedNoQuota !== undefined ? { skipped_no_quota: skippedNoQuota } : {}),
    ...(skippedUnknown !== undefined ? { skipped_unknown: skippedUnknown } : {}),
    ...(hasStateUpdate || hasPendingWriteback ? { has_pending_writeback: hasPendingWriteback } : {}),
    ...(projectedOpusFamilies !== undefined ? { model_access_families: projectedOpusFamilies } : {}),
    ...(failureReason !== undefined ? { failure_reason: failureReason, safe_failure_reason: failureReason } : {}),
    ...(writebackReason !== undefined ? { writeback_reason: writebackReason } : {}),
  })
}

export function reprojectManualPublicDetails(value: unknown, httpStatus?: number): SafeManualPublicDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const statusLabel = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)
      ? getSafeHttpStatusLabel(httpStatus)
      : undefined
    return Object.freeze({
      ...(statusLabel ? { failure_reason: statusLabel, safe_failure_reason: statusLabel } : {}),
    })
  }

  const src = value as Record<string, unknown>
  const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(src, k)
  const now = Date.now() / 1000

  let started: boolean | undefined = undefined
  if (hasOwn('started') && typeof src.started === 'boolean') {
    started = src.started
  }

  let errorCode: string | undefined = undefined
  if (hasOwn('error_code') && typeof src.error_code === 'string' && (KNOWN_ERROR_CODES as readonly string[]).includes(src.error_code)) {
    errorCode = src.error_code
  }

  let projectId: string | undefined = undefined
  if (hasOwn('project_id') && typeof src.project_id === 'string') {
    const trimmed = src.project_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      projectId = trimmed
    }
  }

  let subscriptionTier: string | undefined = undefined
  if (hasOwn('subscription_tier') && typeof src.subscription_tier === 'string') {
    const trimmed = src.subscription_tier.trim()
    if (trimmed.length > 0 && trimmed.length <= 100 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      subscriptionTier = trimmed
    }
  }

  let creditAmount: number | undefined = undefined
  if (hasOwn('credit_amount') && typeof src.credit_amount === 'number' && Number.isFinite(src.credit_amount)) {
    creditAmount = src.credit_amount
  }

  let settingId: string | undefined = undefined
  if (hasOwn('setting_id') && typeof src.setting_id === 'string') {
    const trimmed = src.setting_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      settingId = trimmed
    }
  }

  let bindingId: string | undefined = undefined
  if (hasOwn('binding_id') && typeof src.binding_id === 'string') {
    const trimmed = src.binding_id.trim()
    if (trimmed.length > 0 && trimmed.length <= 200 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      bindingId = trimmed
    }
  }

  let step: 'create_setting' | 'create_binding' | undefined = undefined
  if (hasOwn('step')) {
    if (src.step === 'create_setting' || src.step === 'create_binding') {
      step = src.step
    }
  }

  let cleared: readonly string[] | undefined = undefined
  if (hasOwn('cleared')) {
    cleared = projectBoundedStringArray(src.cleared)
  }

  let addedCooldown: readonly string[] | undefined = undefined
  if (hasOwn('added_cooldown')) {
    addedCooldown = projectBoundedStringArray(src.added_cooldown)
  } else if (hasOwn('added')) {
    addedCooldown = projectBoundedStringArray(src.added)
  }

  let skippedNoQuota: readonly string[] | undefined = undefined
  if (hasOwn('skipped_no_quota')) {
    skippedNoQuota = projectBoundedStringArray(src.skipped_no_quota)
  }

  let skippedUnknown: readonly string[] | undefined = undefined
  if (hasOwn('skipped_unknown')) {
    skippedUnknown = projectBoundedStringArray(src.skipped_unknown)
  }

  let hasPendingWriteback: boolean | undefined = undefined
  if (hasOwn('has_pending_writeback') && typeof src.has_pending_writeback === 'boolean') {
    hasPendingWriteback = src.has_pending_writeback
  } else if (hasOwn('pending') && src.pending === true) {
    hasPendingWriteback = true
  }

  let writebackReason: string | undefined = undefined
  if (hasOwn('writeback_reason') && typeof src.writeback_reason === 'string' && (KNOWN_WRITEBACK_REASONS as readonly string[]).includes(src.writeback_reason)) {
    writebackReason = src.writeback_reason
  }

  if (hasOwn('state_update') && src.state_update && typeof src.state_update === 'object' && !Array.isArray(src.state_update)) {
    for (const [, phaseVal] of Object.entries(src.state_update as Record<string, unknown>)) {
      if (phaseVal && typeof phaseVal === 'object' && !Array.isArray(phaseVal)) {
        const pObj = phaseVal as Record<string, unknown>
        const pHasOwn = (k: string) => Object.prototype.hasOwnProperty.call(pObj, k)
        if (pHasOwn('status') && pObj.status === 'pending') {
          hasPendingWriteback = true
        }
        if (writebackReason === undefined && pHasOwn('reason') && typeof pObj.reason === 'string' && (KNOWN_WRITEBACK_REASONS as readonly string[]).includes(pObj.reason)) {
          writebackReason = pObj.reason
        }
      }
    }
  }

  let projectedOpusFamilies: Readonly<Record<string, SafeOpusFamilyDetails>> | undefined = undefined
  if (hasOwn('model_access_families')) {
    projectedOpusFamilies = projectSafeOpusFamilies(src.model_access_families, now)
  }

  let failureReason: string | undefined = undefined
  if (errorCode) {
    failureReason = SAFE_ERROR_CODE_LABELS[errorCode as KnownErrorCode] ?? errorCode
  } else if (step) {
    failureReason = step === 'create_setting' ? '创建 Release Channel Setting 失败' : '创建 Setting Binding 失败'
  } else if (writebackReason) {
    failureReason = SAFE_WRITEBACK_REASON_LABELS[writebackReason] ?? writebackReason
  } else if (httpStatus !== undefined && typeof httpStatus === 'number' && Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) {
    failureReason = getSafeHttpStatusLabel(httpStatus)
  } else {
    let incomingLabel: string | undefined = undefined
    if (hasOwn('safe_failure_reason') && typeof src.safe_failure_reason === 'string') {
      incomingLabel = src.safe_failure_reason
    } else if (hasOwn('failure_reason') && typeof src.failure_reason === 'string') {
      incomingLabel = src.failure_reason
    }
    if (incomingLabel !== undefined && isKnownSafeFailureLabel(incomingLabel)) {
      failureReason = incomingLabel
    }
  }

  return Object.freeze({
    ...(started !== undefined ? { started } : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(subscriptionTier !== undefined ? { subscription_tier: subscriptionTier } : {}),
    ...(creditAmount !== undefined ? { credit_amount: creditAmount } : {}),
    ...(settingId !== undefined ? { setting_id: settingId } : {}),
    ...(bindingId !== undefined ? { binding_id: bindingId } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(cleared !== undefined ? { cleared } : {}),
    ...(addedCooldown !== undefined ? { added_cooldown: addedCooldown } : {}),
    ...(skippedNoQuota !== undefined ? { skipped_no_quota: skippedNoQuota } : {}),
    ...(skippedUnknown !== undefined ? { skipped_unknown: skippedUnknown } : {}),
    ...(hasPendingWriteback !== undefined ? { has_pending_writeback: hasPendingWriteback } : {}),
    ...(projectedOpusFamilies !== undefined ? { model_access_families: projectedOpusFamilies } : {}),
    ...(failureReason !== undefined ? { failure_reason: failureReason, safe_failure_reason: failureReason } : {}),
    ...(writebackReason !== undefined ? { writeback_reason: writebackReason } : {}),
  })
}

function isFixtureActive(): boolean {
  return Boolean(fixtureMode || (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'))
}

function sanitizeSecretError(error: unknown): never {
  if ((error instanceof DOMException && error.name === 'AbortError') || (error as { name?: string })?.name === 'AbortError') {
    throw new DOMException('操作已取消。', 'AbortError')
  }
  if (error instanceof ApiError) {
    if (typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
      const status = error.status
      throw new ApiError(
        status,
        null,
        status < 500 ? `请求被拒绝（HTTP ${status}）。` : `请求未完成（HTTP ${status}）。`,
      )
    }
    throw new Error('请求未完成，请稍后重试。')
  }
  if (error instanceof Error) {
    if (error.message === '凭证标识不一致') {
      throw new Error('凭证标识不一致')
    }
    if (error.message === '凭证内容格式无效') {
      throw new Error('凭证内容格式无效')
    }
    if (error.message === '邮箱响应格式无效') {
      throw new Error('邮箱响应格式无效')
    }
    if (error.message === '刷新邮箱响应格式无效') {
      throw new Error('刷新邮箱响应格式无效')
    }
    if (error.message === '凭证去重响应格式无效') {
      throw new Error('凭证去重响应格式无效')
    }
  }
  throw new Error('请求未完成，请稍后重试。')
}

class BatchResultError extends Error {}

export function createCredentialApi(mode: PanelMode, ownerScope?: PanelScope) {
  if (!isPanelMode(mode)) {
    throw new TypeError(`Invalid panel mode: ${String(mode)}`)
  }
  if (ownerScope && ownerScope.mode !== mode) {
    throw new Error('请求模式与作用域不一致。')
  }

  const scope: PanelScope | undefined = ownerScope
    ? Object.freeze({
        mode: ownerScope.mode,
        channelEpoch: ownerScope.channelEpoch,
        sessionEpoch: ownerScope.sessionEpoch,
      })
    : undefined

  const modeQuery = { mode }

  const assertOwnership = (callEpoch?: number, signal?: AbortSignal) => {
    signal?.throwIfAborted?.()
    const currentEpoch = getSessionSnapshot().sessionEpoch
    if (scope) {
      if (!isPanelScopeCurrent(scope, currentEpoch)) {
        throw new DOMException('作用域已变更，请重新读取。', 'AbortError')
      }
    } else if (callEpoch !== undefined && currentEpoch !== callEpoch) {
      throw new DOMException('会话已变更，请重新读取。', 'AbortError')
    }
  }

  return {
    async list(filters: Filters, caps: Capabilities, offset: number, limit: number, signal?: AbortSignal): Promise<CredentialPage> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        const { fixturePage } = await import('./fixtures')
        assertOwnership(callEpoch, signal)
        return fixturePage(filters, offset, limit)
      }
      return parsePage(await requestJson('creds/status', { query: listQuery(filters, caps, offset, limit, mode), signal, scope }), mode)
    },

    async action(names: string[], action: string, remark?: string, signal?: AbortSignal): Promise<Outcome> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return aggregate({ success_count: names.length, total_count: names.length }, names.length)
      }
      if (remark !== undefined) {
        const d = object(await requestJson(`creds/remark/${encodeURIComponent(names[0])}`, { method: 'POST', query: modeQuery, body: { remark }, signal, scope }))
        return singleResult(d, typeof d.remark === 'string' && d.remark === remark.trim())
      }
      if (names.length === 1) {
        const d = object(await requestJson('creds/action', { method: 'POST', query: modeQuery, body: { filename: names[0], action }, signal, scope }))
        return singleResult(d, typeof d.message === 'string' && !d.error)
      }
      return aggregate(await requestJson('creds/batch-action', { method: 'POST', query: modeQuery, body: { filenames: names, action }, signal, scope }), names.length)
    },

    async errors(filename: string, signal?: AbortSignal): Promise<RecordValue> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return { error_codes: [403], error_classifications: { '403': 'subscription_required' } }
      }
      return object(await requestJson(`creds/errors/${encodeURIComponent(filename)}`, { query: modeQuery, signal, scope }))
    },

    async manual(filename: string, operation: 'quota' | 'test' | 'verify-project', model?: string, signal?: AbortSignal): Promise<SafeManualResult> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        const raw = { success: false, status_code: 200, verified_reply: false, state_update: { quota: { status: 'pending' } } }
        return { ...manualResult(raw), publicDetails: projectManualPublicDetails(raw, 200) }
      }
      try {
        const raw = await requestJson(`creds/${operation}/${encodeURIComponent(filename)}`, { method: operation === 'quota' ? 'GET' : 'POST', query: { ...modeQuery, ...(operation === 'test' && model ? { model } : {}) }, signal, scope })
        return { ...manualResult(raw), publicDetails: projectManualPublicDetails(raw, 200) }
      } catch (e) {
        if (e instanceof ApiError) return { ...manualResult(e.payload, e.status), publicDetails: projectManualPublicDetails(e.payload, e.status) }
        throw e
      }
    },

    async quotaBatch(names: string[], signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (names.length > 10) throw new Error('每批最多 10 项')
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return names.map(filename => {
          const raw = { success: true, state_update: { quota: { status: 'applied' } } }
          return { filename, ...manualResult(raw), publicDetails: projectManualPublicDetails(raw, 200) }
        })
      }
      const d = object(await requestJson('creds/batch-refresh-cooldown', { method: 'POST', query: modeQuery, body: { filenames: names }, signal, scope }))
      if (!Array.isArray(d.results)) throw new BatchResultError('批量额度结果缺失，结果未知')
      const returned = d.results.map(row => object(row).filename)
      if (returned.length !== names.length || new Set(returned).size !== names.length || returned.some(name => typeof name !== 'string' || !names.includes(name))) throw new BatchResultError('批量额度标识不一致，结果未知；停止后续批次')
      return names.map(filename => {
        const raw = d.results as unknown[]
        const row = raw.find(r => object(r).filename === filename)
        const statusCode = count(object(row).status_code) ?? 200
        return { filename, ...manualResult(row, statusCode), publicDetails: projectManualPublicDetails(row, statusCode) }
      })
    },

    async download(names: string[], signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      assertToolLimit(names)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return { blob: new Blob(['synthetic preview']), selected: names.length as number | null, missing: 0 as number | null }
      }
      const { blob, response } = await requestBlob('creds/download-selected', { method: 'POST', query: modeQuery, body: { filenames: names }, signal, scope })
      const headerCount = (name: string) => { const v = response.headers.get(name); return v !== null && /^\d+$/.test(v) ? count(Number(v)) : null }
      return { blob, selected: headerCount('X-Selected-Count'), missing: headerCount('X-Missing-Count') }
    },

    async downloadOne(filename: string, signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      const { blob, response } = await requestBlob(`creds/download/${encodeURIComponent(filename)}`, { query: modeQuery, signal, scope })
      assertOwnership(callEpoch, signal)
      return {
        blob,
        httpStatus: response.status,
        contentType: response.headers.get('Content-Type'),
        contentDisposition: response.headers.get('Content-Disposition'),
      }
    },

    async downloadAll(signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      const { blob, response } = await requestBlob('creds/download-all', { query: modeQuery, signal, scope })
      assertOwnership(callEpoch, signal)
      return {
        blob,
        httpStatus: response.status,
        contentType: response.headers.get('Content-Type'),
        contentDisposition: response.headers.get('Content-Disposition'),
      }
    },

    async emails(names: string[], signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      assertToolLimit(names)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return { emails: ['preview@example.invalid'], matched: names.length as number | null, missing: 0 as number | null }
      }
      const d = object(await requestJson('creds/copy-emails', { method: 'POST', query: modeQuery, body: { filenames: names }, signal, scope }))
      if (!Array.isArray(d.emails) || !d.emails.every(v => typeof v === 'string')) throw new Error('邮箱响应格式不完整')
      return { emails: d.emails as string[], matched: count(d.matched_count), missing: count(d.missing_count) }
    },

    /**
     * 读取指定凭证的完整原始内容。
     *
     * 约束与安全要求：
     * - 调用方必须在每次打开前获得用户显式确认（per-open caller confirmation）。
     * - 本适配器自身绝不自动授权展示或持久化保密内容。
     * - 禁止将凭证内容写入 localStorage、sessionStorage、全局缓存或日志。
     * - 调用方须在关闭对话框、切换渠道或会话失效时立即清理明文。
     */
    async readContent(filename: string, signal?: AbortSignal): Promise<{ filename: string; content: Record<string, unknown> }> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (isFixtureActive()) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      try {
        const raw = await requestJson<RecordValue>(`creds/detail/${encodeURIComponent(filename)}`, {
          query: modeQuery,
          signal,
          scope,
        })
        assertOwnership(callEpoch, signal)
        const d = object(raw)
        if (!Object.prototype.hasOwnProperty.call(d, 'filename') || typeof d.filename !== 'string' || d.filename !== filename) {
          throw new Error('凭证标识不一致')
        }
        if (!Object.prototype.hasOwnProperty.call(d, 'content') || !d.content || typeof d.content !== 'object' || Array.isArray(d.content)) {
          throw new Error('凭证内容格式无效')
        }
        const projected = {
          filename: d.filename,
          content: d.content as Record<string, unknown>,
        }
        assertOwnership(callEpoch, signal)
        return projected
      } catch (error) {
        sanitizeSecretError(error)
      }
    },

    /**
     * 单独获取指定凭证绑定的用户邮箱。
     *
     * 约束与安全要求：
     * - 调用方必须按需显式调用，禁止自动批量轮询或持久化。
     * - 本适配器自身绝不自动授权展示。
     * - 调用方须在切换渠道或会话失效时清理状态。
     */
    async fetchEmail(filename: string, signal?: AbortSignal): Promise<{ filename: string; email: string }> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (isFixtureActive()) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      try {
        const raw = await requestJson<RecordValue>(`creds/fetch-email/${encodeURIComponent(filename)}`, {
          method: 'POST',
          query: modeQuery,
          signal,
          scope,
        })
        assertOwnership(callEpoch, signal)
        const d = object(raw)
        if (!Object.prototype.hasOwnProperty.call(d, 'filename') || typeof d.filename !== 'string' || d.filename !== filename) {
          throw new Error('凭证标识不一致')
        }
        if (!Object.prototype.hasOwnProperty.call(d, 'user_email') || typeof d.user_email !== 'string' || d.user_email.length === 0) {
          throw new Error('邮箱响应格式无效')
        }
        const projected = {
          filename: d.filename,
          email: d.user_email,
        }
        assertOwnership(callEpoch, signal)
        return projected
      } catch (error) {
        sanitizeSecretError(error)
      }
    },

    /**
     * 刷新全部凭证的绑定邮箱（全选/全量后台同步）。
     *
     * 约束与安全要求：
     * - 单次显式 POST，无 body，通过 query 传递 mode。
     * - 不包含任何客户端自动重试。
     * - 校验自身拥有的非负安全整数计数器：success_count、skipped_count、total_count。
     * - 派生 failed_count = total_count - success_count - skipped_count。
     * - 过滤所有原始服务端错误字符串、消息或任意展开对象。
     */
    async refreshAllEmails(signal?: AbortSignal): Promise<RefreshAllEmailsResult> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (isFixtureActive()) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      try {
        const raw = await requestJson<RecordValue>('creds/refresh-all-emails', {
          method: 'POST',
          query: modeQuery,
          signal,
          scope,
        })
        assertOwnership(callEpoch, signal)
        const d = object(raw)

        const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(d, k)
        if (!hasOwn('success_count') || !hasOwn('skipped_count') || !hasOwn('total_count')) {
          throw new Error('刷新邮箱响应格式无效')
        }

        const successCount = d.success_count
        const skippedCount = d.skipped_count
        const totalCount = d.total_count

        if (
          typeof successCount !== 'number' ||
          !Number.isSafeInteger(successCount) ||
          successCount < 0 ||
          typeof skippedCount !== 'number' ||
          !Number.isSafeInteger(skippedCount) ||
          skippedCount < 0 ||
          typeof totalCount !== 'number' ||
          !Number.isSafeInteger(totalCount) ||
          totalCount < 0 ||
          successCount + skippedCount > totalCount
        ) {
          throw new Error('刷新邮箱响应格式无效')
        }

        if (!hasOwn('results') || !Array.isArray(d.results)) {
          throw new Error('刷新邮箱响应格式无效')
        }

        if (d.results.length !== totalCount) {
          throw new Error('刷新邮箱响应格式无效')
        }

        let actualSuccessCount = 0
        let actualSkippedCount = 0
        let actualFailedCount = 0
        const results: RefreshEmailResultItem[] = []

        for (const item of d.results) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('刷新邮箱响应格式无效')
          }
          const itemObj = item as Record<string, unknown>
          const itemHasOwn = (k: string) => Object.prototype.hasOwnProperty.call(itemObj, k)
          if (
            !itemHasOwn('filename') ||
            typeof itemObj.filename !== 'string' ||
            itemObj.filename.length === 0
          ) {
            throw new Error('刷新邮箱响应格式无效')
          }
          if (
            !itemHasOwn('success') ||
            typeof itemObj.success !== 'boolean'
          ) {
            throw new Error('刷新邮箱响应格式无效')
          }

          let itemSkipped = false
          if ('skipped' in itemObj) {
            if (!itemHasOwn('skipped') || typeof itemObj.skipped !== 'boolean') {
              throw new Error('刷新邮箱响应格式无效')
            }
            itemSkipped = itemObj.skipped
          }

          if (!itemObj.success && itemSkipped) {
            throw new Error('刷新邮箱响应格式无效')
          }

          if (!itemHasOwn('user_email')) {
            throw new Error('刷新邮箱响应格式无效')
          }

          if (itemObj.success) {
            if (typeof itemObj.user_email !== 'string' || itemObj.user_email.length === 0) {
              throw new Error('刷新邮箱响应格式无效')
            }
          } else {
            if (itemObj.user_email !== null) {
              throw new Error('刷新邮箱响应格式无效')
            }
          }

          if (itemSkipped) {
            actualSkippedCount++
          } else if (itemObj.success) {
            actualSuccessCount++
          } else {
            actualFailedCount++
          }

          const itemEmail = itemObj.user_email as string | null
          results.push({
            filename: itemObj.filename,
            user_email: itemEmail,
            email: itemEmail,
            success: itemObj.success,
            skipped: itemSkipped,
          })
        }

        const failed = totalCount - successCount - skippedCount

        if (
          actualSuccessCount !== successCount ||
          actualSkippedCount !== skippedCount ||
          actualFailedCount !== failed
        ) {
          throw new Error('刷新邮箱响应格式无效')
        }

        const projected: RefreshAllEmailsResult = {
          success_count: successCount,
          skipped_count: skippedCount,
          failed_count: failed,
          failed,
          total_count: totalCount,
          results,
        }
        assertOwnership(callEpoch, signal)
        return projected
      } catch (error) {
        sanitizeSecretError(error)
      }
    },

    /**
     * 按用户邮箱对凭证去重（保留首个，删除后续重复）。
     *
     * 约束与安全要求：
     * - 破坏性全渠道操作，调用方必须在此前获得用户显式确认（per-action caller confirmation）。
     * - 单次显式 POST，无 body，通过 query 传递 mode。
     * - 校验自身拥有的 deleted_count、kept_count、total_count、unique_emails_count、no_email_count。
     * - 严格要求 deleted_count + kept_count === total_count。
     * - 校验 duplicate_groups 各组 duplicate_count 之和严格等于 deleted_count。
     * - 过滤 delete_errors 中的原始异常文本，仅投影 error_count 与 outcome（'success' | 'partial' | 'failed'）。
     */
    async deduplicateByEmail(signal?: AbortSignal): Promise<DeduplicateByEmailResult> {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (isFixtureActive()) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        throw new Error('暂不支持预览数据')
      }
      try {
        const raw = await requestJson<RecordValue>('creds/deduplicate-by-email', {
          method: 'POST',
          query: modeQuery,
          signal,
          scope,
        })
        assertOwnership(callEpoch, signal)
        const d = object(raw)

        const hasOwn = (k: string) => Object.prototype.hasOwnProperty.call(d, k)
        const requiredCounters = [
          'deleted_count',
          'kept_count',
          'total_count',
          'unique_emails_count',
          'no_email_count',
        ] as const

        for (const k of requiredCounters) {
          if (!hasOwn(k)) {
            throw new Error('凭证去重响应格式无效')
          }
        }

        const deletedCount = d.deleted_count
        const keptCount = d.kept_count
        const totalCount = d.total_count
        const uniqueEmailsCount = d.unique_emails_count
        const noEmailCount = d.no_email_count

        for (const val of [deletedCount, keptCount, totalCount, uniqueEmailsCount, noEmailCount]) {
          if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
            throw new Error('凭证去重响应格式无效')
          }
        }

        if (
          (deletedCount as number) + (keptCount as number) !== (totalCount as number) ||
          (uniqueEmailsCount as number) + (noEmailCount as number) > (totalCount as number)
        ) {
          throw new Error('凭证去重响应格式无效')
        }

        if (!hasOwn('duplicate_groups') || !Array.isArray(d.duplicate_groups)) {
          throw new Error('凭证去重响应格式无效')
        }

        let sumDuplicateCount = 0
        const duplicateGroups: DeduplicateDuplicateGroup[] = []

        for (const group of d.duplicate_groups) {
          if (!group || typeof group !== 'object' || Array.isArray(group)) {
            throw new Error('凭证去重响应格式无效')
          }
          const g = group as Record<string, unknown>
          const gHasOwn = (k: string) => Object.prototype.hasOwnProperty.call(g, k)
          if (
            !gHasOwn('email') ||
            typeof g.email !== 'string' ||
            !gHasOwn('kept_file') ||
            typeof g.kept_file !== 'string' ||
            g.kept_file.length === 0 ||
            !gHasOwn('deleted_files') ||
            !Array.isArray(g.deleted_files) ||
            !gHasOwn('duplicate_count') ||
            typeof g.duplicate_count !== 'number' ||
            !Number.isSafeInteger(g.duplicate_count) ||
            g.duplicate_count < 0
          ) {
            throw new Error('凭证去重响应格式无效')
          }

          if (g.deleted_files.some(f => typeof f !== 'string' || f.length === 0)) {
            throw new Error('凭证去重响应格式无效')
          }

          if (g.deleted_files.length !== g.duplicate_count) {
            throw new Error('凭证去重响应格式无效')
          }

          sumDuplicateCount += g.duplicate_count

          duplicateGroups.push({
            email: g.email,
            kept_file: g.kept_file,
            deleted_files: [...g.deleted_files],
            duplicate_count: g.duplicate_count,
          })
        }

        if (sumDuplicateCount !== deletedCount) {
          throw new Error('凭证去重响应格式无效')
        }

        if (!hasOwn('delete_errors') || !Array.isArray(d.delete_errors)) {
          throw new Error('凭证去重响应格式无效')
        }
        if (d.delete_errors.some(e => typeof e !== 'string')) {
          throw new Error('凭证去重响应格式无效')
        }
        const errorCount = d.delete_errors.length

        const outcome: 'success' | 'partial' | 'failed' =
          errorCount > 0
            ? (deletedCount as number) > 0
              ? 'partial'
              : 'failed'
            : 'success'

        const projected: DeduplicateByEmailResult = {
          deleted_count: deletedCount as number,
          kept_count: keptCount as number,
          total_count: totalCount as number,
          unique_emails_count: uniqueEmailsCount as number,
          no_email_count: noEmailCount as number,
          duplicate_groups: duplicateGroups,
          outcome,
          error_count: errorCount,
        }
        assertOwnership(callEpoch, signal)
        return projected
      } catch (error) {
        sanitizeSecretError(error)
      }
    },
  }
}

export interface RefreshEmailResultItem {
  filename: string
  user_email: string | null
  email: string | null
  success: boolean
  skipped: boolean
}

export interface RefreshAllEmailsResult {
  success_count: number
  skipped_count: number
  failed_count: number
  failed: number
  total_count: number
  results: RefreshEmailResultItem[]
}

export interface DeduplicateDuplicateGroup {
  email: string
  kept_file: string
  deleted_files: string[]
  duplicate_count: number
}

export interface DeduplicateByEmailResult {
  deleted_count: number
  kept_count: number
  total_count: number
  unique_emails_count: number
  no_email_count: number
  duplicate_groups: DeduplicateDuplicateGroup[]
  outcome: 'success' | 'partial' | 'failed'
  error_count: number
}

export type CredentialApi = ReturnType<typeof createCredentialApi>

export const api: CredentialApi = createCredentialApi('antigravity')

function singleResult(d: RecordValue, confirmed: boolean): Outcome {
  const rejected = d.success === false || !!d.error
  return {
    kind: rejected ? 'rejected' : confirmed ? 'success' : 'unknown',
    succeeded: rejected ? 0 : confirmed ? 1 : null,
    failed: rejected ? 1 : confirmed ? 0 : null,
    total: 1,
    message: rejected ? '服务端拒绝该操作。' : confirmed ? '操作成功。' : '结果未知，请重新读取状态。',
  }
}

function assertToolLimit(names: string[]) {
  if (!names.length || names.length > 100) throw new Error('下载与复制邮箱仅支持 1–100 项，请减少选择。')
}

export function withdrawnCapability(error: unknown, mode: PanelMode = 'antigravity'): string | null {
  if (!(error instanceof ApiError) || error.status !== 501) return null
  const p = object(error.payload)
  if (p.error_code !== 'capability_unavailable') return null
  const capMap = CAP_BY_MODE[mode] ?? CAP_BY_MODE.antigravity
  return Object.values(capMap).includes(p.capability as never) ? String(p.capability) : null
}

export function failureMessage(error: unknown, write = false) {
  if (error instanceof BatchResultError) return '批量额度结果不完整或标识冲突，操作结果未知；已停止后续批次。'
  if (error instanceof ApiError && error.status === 501) return '当前服务不支持此能力。'
  if (error instanceof ApiError && error.status < 500) return `请求被拒绝（HTTP ${error.status}）。`
  return write ? '连接或服务异常，操作结果未知；请重新读取，勿盲目重试。' : '列表暂不可用，请手动重试。'
}

/** Failed transport cannot prove a write did not happen; expose only safe adapter text. */
export function actionFailure(error: unknown, total: number): Outcome {
  const rejected = error instanceof ApiError && ((error.status >= 400 && error.status < 500) || error.status === 501)
  return { kind: rejected ? 'rejected' : 'unknown', succeeded: rejected ? 0 : null, failed: rejected ? total : null, total, message: failureMessage(error, true) }
}
