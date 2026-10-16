/**
 * Quota API adapter matching FULL_PARITY_CONTRACT.json.
 *
 * Provides:
 * - Transport via same-origin requestJson client: GET creds/quota-summary/{encodeURIComponent(filename)}?mode={mode}
 * - Capability discovery: ${mode}.quota.summary
 * - Dynamic synthetic fixture preview (DEV && VITE_UI_FIXTURES === 'true' only) with zero network transport
 * - Safe DTO normalization, stripping arbitrary/sensitive fields and allowlisting safe reason codes
 * - Safe error mapping distinguishing 400, 404, 409, 503/504, unknown routes, and upstream failures
 */

import { ApiError, requestJson } from '@/api/client';
import { getSessionSnapshot } from '@/auth/session';
import { isPanelScopeCurrent, type PanelScope } from '@/domain/panel';
import type {
  QuotaBucket,
  QuotaGroup,
  QuotaMode,
  QuotaSource,
  QuotaStatus,
  QuotaSummary,
  QuotaWindow,
} from './types';

export type { PanelScope } from '@/domain/panel';
export type {
  QuotaBucket,
  QuotaGroup,
  QuotaMode,
  QuotaSource,
  QuotaStatus,
  QuotaSummary,
  QuotaWindow,
} from './types';

/** Expected source identifier per QuotaMode */
export const EXPECTED_SOURCE: Record<QuotaMode, QuotaSource> = {
  antigravity: 'antigravity_quota_summary',
  geminicli: 'geminicli_retrieve_user_quota',
};

/** Exact capability string required per QuotaMode */
export const QUOTA_CAPABILITY: Record<QuotaMode, string> = {
  antigravity: 'antigravity.quota.summary',
  geminicli: 'geminicli.quota.summary',
};

/**
 * Return the exact summary capability required for the given mode.
 */
export function getQuotaCapability(mode: QuotaMode): string {
  return QUOTA_CAPABILITY[mode];
}

/**
 * Check whether the quota summary capability is enabled in the provided capability set.
 */
export function isQuotaCapabilitySupported(
  mode: QuotaMode,
  capabilities?: Set<string> | readonly string[],
): boolean {
  if (!capabilities) return false;
  const target = QUOTA_CAPABILITY[mode];
  if (capabilities instanceof Set) {
    return capabilities.has(target);
  }
  if (Array.isArray(capabilities)) {
    return capabilities.includes(target);
  }
  return false;
}

/** Allowed valid QuotaStatus values */
export const VALID_STATUSES: ReadonlySet<QuotaStatus> = new Set<QuotaStatus>([
  'available',
  'partial',
  'unsupported',
  'unknown',
  'error',
]);

/** Allowed valid QuotaWindow values */
export const VALID_WINDOWS: ReadonlySet<QuotaWindow> = new Set<QuotaWindow>([
  '5h',
  'weekly',
  'daily',
  'monthly',
  'unknown',
]);

/**
 * Known stable safe reason codes from frozen backend and fixtures.
 * Any other arbitrary upstream string or detail is stripped to null.
 */
export const KNOWN_SAFE_REASONS: ReadonlySet<string> = new Set<string>([
  'invalid_filename',
  'quota_budget_configuration',
  'credential_not_found',
  'missing_project',
  'upstream_authentication_failed',
  'permission_denied',
  'quota_summary_unsupported',
  'upstream_timeout',
  'rate_limited',
  'upstream_error',
  'invalid_upstream_response',
  'invalid_credential',
  'credential_changed',
  'preparation_failed',
  'quota_timeout',
  'oauth_refresh_failed',
  'transport_error',
  'unrecognized_quota_summary',
  'empty_quota_summary',
  'incomplete_quota_summary',
  'upstream_service_unavailable',
  'credential_quota_unsupported',
  'channel_quota_status_unknown',
  'partial_quota_available',
  'missing_access_token',
]);

/**
 * Preserve reason only when it is a known stable safe code;
 * arbitrary upstream text, errors, or details become null.
 */
export function sanitizeSafeReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (KNOWN_SAFE_REASONS.has(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Parse and normalize a single bucket item.
 * Finite remaining_fraction in 0..1 is preserved (including 0 and 1);
 * missing, non-finite or out-of-range values become null without clamping.
 */
function normalizeBucket(raw: unknown, fallbackId: string): QuotaBucket | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;

  const bucket_id =
    typeof b.bucket_id === 'string' && b.bucket_id.trim()
      ? b.bucket_id.trim()
      : fallbackId;

  const display_name =
    typeof b.display_name === 'string' && b.display_name.trim()
      ? b.display_name.trim()
      : bucket_id;

  const raw_window =
    typeof b.raw_window === 'string' && b.raw_window.trim()
      ? b.raw_window.trim()
      : null;

  const window: QuotaWindow =
    typeof b.window === 'string' && VALID_WINDOWS.has(b.window as QuotaWindow)
      ? (b.window as QuotaWindow)
      : 'unknown';

  let remaining_fraction: number | null = null;
  if (
    typeof b.remaining_fraction === 'number' &&
    Number.isFinite(b.remaining_fraction) &&
    b.remaining_fraction >= 0 &&
    b.remaining_fraction <= 1
  ) {
    remaining_fraction = b.remaining_fraction;
  }

  let reset_at: string | null = null;
  if (
    typeof b.reset_at === 'string' &&
    b.reset_at.length <= 80 &&
    Number.isFinite(Date.parse(b.reset_at))
  ) {
    reset_at = b.reset_at;
  }

  return {
    bucket_id,
    display_name,
    raw_window,
    window,
    remaining_fraction,
    reset_at,
  };
}

/**
 * Parse and normalize a single quota group.
 */
function normalizeGroup(raw: unknown, index: number): QuotaGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;

  const group_id =
    typeof g.group_id === 'string' && g.group_id.trim()
      ? g.group_id.trim()
      : `group-${index + 1}`;

  const display_name =
    typeof g.display_name === 'string' && g.display_name.trim()
      ? g.display_name.trim()
      : group_id;

  const description =
    typeof g.description === 'string' && g.description.trim()
      ? g.description.trim().slice(0, 1000)
      : null;

  const buckets: QuotaBucket[] = [];
  if (Array.isArray(g.buckets)) {
    g.buckets.forEach((item, bIdx) => {
      const parsed = normalizeBucket(item, `${group_id}-bucket-${bIdx + 1}`);
      if (parsed) {
        buckets.push(parsed);
      }
    });
  }

  return {
    group_id,
    display_name,
    description,
    buckets,
  };
}

/**
 * Create a safe fallback QuotaSummary DTO without any raw error/secret details.
 */
export function createSafeFallbackSummary(
  mode: QuotaMode,
  reason: string | null = null,
  status: QuotaStatus = 'error',
): QuotaSummary {
  return {
    status,
    source: EXPECTED_SOURCE[mode],
    captured_at: null,
    upstream_status: null,
    reason: sanitizeSafeReason(reason),
    groups: [],
  };
}

/**
 * Parse any payload into the frozen safe QuotaSummary DTO.
 * Strips unknown top-level and nested fields. Cross-mode or malformed responses
 * safely degrade to an unknown or error result.
 */
export function normalizeQuotaSummary(payload: unknown, mode: QuotaMode): QuotaSummary {
  const expectedSource = EXPECTED_SOURCE[mode];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return createSafeFallbackSummary(mode, 'invalid_upstream_response', 'error');
  }

  const p = payload as Record<string, unknown>;

  // Strict mode/source matching: cross-mode payload is never accepted
  if (p.source !== expectedSource) {
    return createSafeFallbackSummary(mode, 'invalid_upstream_response', 'error');
  }

  const status: QuotaStatus =
    typeof p.status === 'string' && VALID_STATUSES.has(p.status as QuotaStatus)
      ? (p.status as QuotaStatus)
      : 'unknown';

  let captured_at: string | null = null;
  if (
    typeof p.captured_at === 'string' &&
    p.captured_at.length <= 80 &&
    Number.isFinite(Date.parse(p.captured_at))
  ) {
    captured_at = p.captured_at;
  }

  let upstream_status: number | null = null;
  if (typeof p.upstream_status === 'number' && Number.isInteger(p.upstream_status)) {
    upstream_status = p.upstream_status;
  }

  const reason = sanitizeSafeReason(p.reason);

  const groups: QuotaGroup[] = [];
  if (Array.isArray(p.groups)) {
    p.groups.forEach((item, idx) => {
      const g = normalizeGroup(item, idx);
      if (g) {
        groups.push(g);
      }
    });
  }

  return {
    status,
    source: expectedSource,
    captured_at,
    upstream_status,
    reason,
    groups,
  };
}

/**
 * Check if a raw payload matches a safe QuotaSummary DTO and normalize it.
 * Returns null if the payload is not a matching quota DTO (e.g. unknown route 404).
 */
export function tryParseSafeQuotaDto(payload: unknown, mode: QuotaMode): QuotaSummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (obj.source !== EXPECTED_SOURCE[mode]) {
    return null;
  }
  if (typeof obj.status !== 'string' || !VALID_STATUSES.has(obj.status as QuotaStatus)) {
    return null;
  }
  return normalizeQuotaSummary(payload, mode);
}

/**
 * Map safe stable reason codes and upstream status to fixed Chinese display text.
 * Never renders raw server messages or unvetted text.
 */
export function mapSafeStatusReason(
  reason: string | null,
  upstreamStatus: number | null,
): string {
  if (upstreamStatus === 401 || reason === 'upstream_authentication_failed') {
    return '上游渠道身份验证失败。';
  }
  if (upstreamStatus === 403 || reason === 'permission_denied') {
    return '上游渠道权限不足。';
  }
  if (upstreamStatus === 429 || reason === 'rate_limited') {
    return '上游渠道请求频率受限。';
  }
  if (reason === 'credential_not_found') {
    return '凭证文件不存在或已被移除。';
  }
  if (reason === 'invalid_filename') {
    return '凭证文件名无效。';
  }
  if (reason === 'credential_changed') {
    return '凭证已在后台变更，请重新加载。';
  }
  if (
    reason === 'credential_quota_unsupported' ||
    reason === 'quota_summary_unsupported'
  ) {
    return '当前凭证不支持额度查询。';
  }
  if (reason === 'channel_quota_status_unknown') {
    return '渠道额度状态未知。';
  }
  if (reason === 'upstream_service_unavailable') {
    return '上游服务暂时不可用。';
  }
  if (reason === 'upstream_timeout') {
    return '上游渠道响应超时。';
  }
  if (reason === 'quota_timeout') {
    return '额度查询超时，请稍后重试。';
  }
  if (reason === 'invalid_upstream_response') {
    return '上游额度响应格式无效。';
  }
  if (reason === 'empty_quota_summary') {
    return '未获取到任何额度分组信息。';
  }
  if (reason === 'unrecognized_quota_summary') {
    return '无法识别的额度响应格式。';
  }
  if (
    reason === 'incomplete_quota_summary' ||
    reason === 'partial_quota_available'
  ) {
    return '部分额度信息可用。';
  }
  if (reason === 'missing_project') {
    return '凭证缺少项目标识。';
  }
  if (reason === 'invalid_credential') {
    return '凭证数据无效。';
  }
  if (reason === 'preparation_failed') {
    return '额度查询准备失败。';
  }
  if (reason === 'oauth_refresh_failed') {
    return 'OAuth 凭据刷新失败。';
  }
  if (reason === 'transport_error') {
    return '网络传输异常，请稍后重试。';
  }
  if (upstreamStatus) {
    return `上游请求未成功（HTTP ${upstreamStatus}）。`;
  }
  return '额度查询失败。';
}

/**
 * Map errors (ApiError, transport, aborted, malformed) to safe fixed text
 * and an optional matching safe QuotaSummary DTO.
 */
export function mapSafeQuotaError(
  error: unknown,
  mode: QuotaMode,
): { message: string; summary: QuotaSummary | null } {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { message: '请求已取消。', summary: null };
  }
  if ((error as Error)?.name === 'AbortError') {
    return { message: '请求已取消。', summary: null };
  }

  if (error instanceof ApiError) {
    const safeDto = tryParseSafeQuotaDto(error.payload, mode);

    if (error.status === 400) {
      const msg =
        safeDto?.reason === 'invalid_filename'
          ? '凭证文件名无效。'
          : safeDto?.reason === 'invalid_credential'
            ? '凭证数据无效。'
            : '请求参数无效（HTTP 400）。';
      return { message: msg, summary: safeDto };
    }

    if (error.status === 404) {
      if (safeDto && safeDto.reason === 'credential_not_found') {
        return { message: '凭证文件不存在或已被移除。', summary: safeDto };
      }
      // Unknown/missing route HTTP 404 without a matching DTO
      return {
        message: '额度摘要接口未找到（HTTP 404）。',
        summary: createSafeFallbackSummary(mode, 'transport_error'),
      };
    }

    if (error.status === 409) {
      const msg =
        safeDto && safeDto.reason === 'credential_changed'
          ? '凭证已在后台变更，请重新加载。'
          : '凭证版本冲突（HTTP 409）。';
      return { message: msg, summary: safeDto };
    }

    if (error.status === 503 || error.status === 504) {
      return {
        message: '额度服务暂时不可用，请稍后手动重试。',
        summary:
          safeDto ?? createSafeFallbackSummary(mode, 'upstream_service_unavailable'),
      };
    }

    if (safeDto) {
      const msg = mapSafeStatusReason(safeDto.reason, safeDto.upstream_status);
      return { message: msg, summary: safeDto };
    }

    return {
      message: `请求未完成（HTTP ${error.status}）。`,
      summary: createSafeFallbackSummary(mode, 'transport_error'),
    };
  }

  if (error instanceof SyntaxError) {
    return {
      message: '额度响应格式无效。',
      summary: createSafeFallbackSummary(mode, 'invalid_upstream_response'),
    };
  }

  return {
    message: '网络连接异常，请稍后手动重试。',
    summary: createSafeFallbackSummary(mode, 'transport_error'),
  };
}

/**
 * Primary quota adapter fetch function.
 * Accepts explicit filename, mode, optional AbortSignal, and optional ownerScope.
 *
 * In synthetic preview mode (DEV && VITE_UI_FIXTURES === 'true'), dynamically imports
 * `./fixtures` before any network activity and returns synthetic scenarios.
 * Otherwise issues GET creds/quota-summary/{encodeURIComponent(filename)}?mode={mode}.
 */
export async function fetchQuotaSummary(
  filename: string,
  mode: QuotaMode,
  signal?: AbortSignal,
  ownerScope?: PanelScope,
): Promise<QuotaSummary> {
  const copiedScope: PanelScope | undefined = ownerScope
    ? Object.freeze({
        mode: ownerScope.mode,
        channelEpoch: ownerScope.channelEpoch,
        sessionEpoch: ownerScope.sessionEpoch,
      })
    : undefined;

  const initialSessionEpoch = getSessionSnapshot().sessionEpoch;

  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    const currentSessionEpoch = getSessionSnapshot().sessionEpoch;
    if (copiedScope) {
      if (mode !== copiedScope.mode) {
        throw new Error('请求模式与作用域不一致。');
      }
      if (!isPanelScopeCurrent(copiedScope, currentSessionEpoch)) {
        throw new DOMException('作用域已变更，请重新读取。', 'AbortError');
      }
    } else {
      if (currentSessionEpoch !== initialSessionEpoch) {
        throw new DOMException('会话已变更，请重新读取。', 'AbortError');
      }
    }
  };

  assertCurrent();

  // Synthetic preview branch: strictly guarded by both DEV and VITE_UI_FIXTURES
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
    assertCurrent();

    // Dynamic fixture import inside the guard only
    const { quotaFixture } = await import('./fixtures');

    assertCurrent();
    const fixtureData = quotaFixture(filename, mode);
    assertCurrent();
    return normalizeQuotaSummary(fixtureData, mode);
  }

  // Real transport via current same-origin request client
  assertCurrent();
  const path = `creds/quota-summary/${encodeURIComponent(filename)}`;
  const response = await requestJson<unknown>(path, {
    method: 'GET',
    query: { mode },
    signal,
    scope: copiedScope,
  });

  assertCurrent();
  return normalizeQuotaSummary(response, mode);
}

/** Exported quota API namespace for P1C integration */
export const quotaApi = {
  fetchSummary: fetchQuotaSummary,
  getCapability: getQuotaCapability,
  isSupported: isQuotaCapabilitySupported,
  normalizeSummary: normalizeQuotaSummary,
  mapSafeError: mapSafeQuotaError,
  mapSafeReason: mapSafeStatusReason,
};
