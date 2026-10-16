import { ApiError, requestJson } from '@/api/client'
import {
  capturePanelScope,
  getPanelChannelSnapshot,
  isPanelScopeCurrent,
  type PanelMode,
  type PanelScope,
} from '@/domain/panel'
import { getSessionSnapshot } from '@/auth/session'
import type {
  EmailItem,
  EmailJobObservation,
  EmailSnapshot,
  EmailState,
  ImportApi,
  ImportItem,
  ImportItemFailureReason,
  ImportRequestContext,
  ImportResult,
  ItemReceipt,
  ItemStatus,
  OAuthReceipt,
  ProjectOption,
  ProjectPrompt,
  TokenInput,
  UploadByteProgress,
  UploadProgressPhase,
} from './types'

export type {
  EmailJobObservation,
  ImportApi,
  ImportItemFailureReason,
  ImportItemReceipt,
  ImportRequestContext,
  ItemReceipt,
  OAuthReceipt,
  UploadByteProgress,
  UploadProgressPhase,
} from './types'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const label = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.length <= 250 ? value : fallback

const emailStates: EmailState[] = [
  'queued',
  'running',
  'settlement_pending',
  'success',
  'failed',
  'skipped',
  'superseded',
  'unknown',
]

function isStrictBasename(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length > 250) return false
  const trimmed = name.trim()
  if (!trimmed || trimmed !== name) return false
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  return true
}

function isControlFree(value: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(value)
}

function isValidProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 250 &&
    id.trim() === id &&
    isControlFree(id)
  )
}

function sanitizeProjectName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 250 || !isControlFree(name)) {
    return null
  }
  return trimmed
}

function hasSafeResponseCapability(caps: ReadonlySet<string>, mode: PanelMode): boolean {
  return caps.has(`${mode}.oauth.safe_response`)
}

function hasOwn(obj: unknown, key: string): boolean {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
}

function sanitizeReceiptString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > 250) return undefined
  if (value.trim() !== value) return undefined
  if (!isControlFree(value)) return undefined
  return value
}

function sanitizeDetectedAt(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isSafeInteger(value)) return undefined
  if (value < 0) return undefined
  if (value > 8640000000000) return undefined
  return value
}

function assertActive(mode: PanelMode, scope: PanelScope, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (mode !== scope.mode) {
    throw new Error('请求模式与作用域不一致。')
  }
  const currentSessionEpoch = getSessionSnapshot().sessionEpoch
  if (!isPanelScopeCurrent(scope, currentSessionEpoch)) {
    throw new DOMException('作用域已变更，请重新读取。', 'AbortError')
  }
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function cloneFixtureResult(result: ImportResult, mode: PanelMode): ImportResult {
  const confirmed = Array.isArray(result.confirmedFilenames)
    ? Array.from(new Set(result.confirmedFilenames.filter(isStrictBasename)))
    : undefined
  return {
    outcome: result.outcome,
    items: result.items.map(item => ({
      ...item,
      ...(item.receipt ? { receipt: { ...item.receipt } } : {}),
    })),
    warnings: result.warnings,
    ...(mode === 'antigravity' && result.jobId ? { jobId: result.jobId } : {}),
    ...(confirmed && confirmed.length > 0 ? { confirmedFilenames: confirmed } : {}),
  }
}

function projectSafeOAuthCompletion(raw: Record<string, unknown>, mode: PanelMode): ImportResult {
  if (raw.success !== true) {
    throw new Error('OAuth completion failed')
  }
  if (raw.mode !== mode) {
    throw new Error('OAuth completion mode mismatch')
  }
  if (!isStrictBasename(raw.filename)) {
    throw new Error('Invalid filename in OAuth response')
  }
  if (typeof raw.auto_detected_project !== 'boolean') {
    throw new Error('Invalid auto_detected_project in OAuth response')
  }

  const warnings = Array.isArray(raw.warnings) ? raw.warnings.length : 0

  let jobId: string | undefined = undefined
  if (mode === 'antigravity') {
    const emailEnrichment = record(raw.email_enrichment)
    const rawJobId = emailEnrichment.job_id
    if (typeof rawJobId === 'string' && /^[0-9a-f]{32}$/.test(rawJobId)) {
      jobId = rawJobId
    }
  }

  const tierRawId = typeof raw.tier_raw_id === 'string' ? raw.tier_raw_id : null
  const tierRawName = typeof raw.tier_raw_name === 'string' ? raw.tier_raw_name : null
  const tierDetectedAt = typeof raw.tier_detected_at === 'number' && Number.isInteger(raw.tier_detected_at)
    ? raw.tier_detected_at
    : null
  const tierDetectionStatus = typeof raw.tier_detection_status === 'string' ? raw.tier_detection_status : null

  const oauthReceipt: OAuthReceipt = {
    success: true,
    mode,
    filename: raw.filename,
    project_id: typeof raw.project_id === 'string' ? raw.project_id : null,
    subscription_tier: typeof raw.subscription_tier === 'string' ? raw.subscription_tier : null,
    auto_detected_project: raw.auto_detected_project,
    ...(mode === 'geminicli'
      ? {
          tier_raw_id: tierRawId,
          tier_raw_name: tierRawName,
          tier_detected_at: tierDetectedAt,
          tier_detection_status: tierDetectionStatus,
        }
      : {}),
  }

  return {
    outcome: 'success',
    items: [{ label: raw.filename, status: 'success' }],
    warnings,
    ...(jobId ? { jobId } : {}),
    oauthReceipt,
    confirmedFilenames: [raw.filename],
  }
}

export function classifyFailureReason(
  errorCode: unknown,
  errorMsg: unknown,
): ImportItemFailureReason | undefined {
  if (typeof errorCode === 'string') {
    if (errorCode === 'credential_exchange_failed') return 'credential_exchange_failed'
    if (errorCode === 'credential_store_failed') return 'credential_store_failed'
    if (errorCode === 'credential_import_failed') return 'credential_import_failed'
  }
  if (typeof errorMsg === 'string') {
    const trimmed = errorMsg.trim()
    if (
      trimmed === '授权无效或网络异常' ||
      trimmed.startsWith('refresh_token 无效或网络异常') ||
      trimmed.startsWith('refresh_token 换 access_token 失败')
    ) {
      return 'credential_exchange_failed'
    }
    if (
      trimmed === '凭证存储失败，请稍后重试' ||
      trimmed.startsWith('凭证存储失败')
    ) {
      return 'credential_store_failed'
    }
    if (
      trimmed === '凭证添加失败' ||
      trimmed === '批量凭证添加失败' ||
      trimmed === '凭证处理失败' ||
      trimmed.startsWith('批量添加第') ||
      trimmed.startsWith('添加失败') ||
      trimmed.startsWith('处理失败')
    ) {
      return 'credential_import_failed'
    }
  }
  return undefined
}

export function normalizeResult(value: unknown, oauth = false, mode?: PanelMode): ImportResult {
  const data = record(value)

  if (typeof data.mode === 'string') {
    if (mode && data.mode !== mode) {
      throw new Error('Response mode mismatch')
    }
    if (data.mode !== 'antigravity' && data.mode !== 'geminicli') {
      throw new Error('Response mode mismatch')
    }
  }

  if (Array.isArray(data.results)) {
    for (const r of data.results) {
      const rowObj = record(r)
      if (typeof rowObj.mode === 'string') {
        if (mode && rowObj.mode !== mode) {
          throw new Error('Response mode mismatch')
        }
        if (rowObj.mode !== 'antigravity' && rowObj.mode !== 'geminicli') {
          throw new Error('Response mode mismatch')
        }
      }
    }
  }

  const rows = Array.isArray(data.results) ? data.results : [data]
  const items: ImportItem[] = rows.map((raw, index) => {
    const row = record(raw)
    const isSuccess =
      row.status === 'success' ||
      row.success === true
    const isFailed =
      row.status === 'error' ||
      row.status === 'failed' ||
      row.success === false ||
      row.error != null ||
      row.error_code != null

    const status: ItemStatus =
      isSuccess && isFailed
        ? 'unknown'
        : isSuccess
          ? 'success'
          : isFailed
            ? 'failed'
            : 'unknown'

    const hasOwnFilename =
      hasOwn(row, 'filename') &&
      typeof row.filename === 'string' &&
      row.filename.length <= 250 &&
      isStrictBasename(row.filename)

    const fallbackLabel = oauth ? 'OAuth 凭证' : `第 ${index + 1} 项`
    const rawFilename = row.filename
    const itemLabel = hasOwnFilename ? (rawFilename as string) : fallbackLabel

    let receipt: ItemReceipt | undefined = undefined
    if (!oauth && status === 'success' && hasOwnFilename) {
      const candidate: ItemReceipt = {}

      if (hasOwn(row, 'project_id')) {
        const val = sanitizeReceiptString(row.project_id)
        if (val !== undefined) {
          candidate.project_id = val
        }
      }

      if (hasOwn(row, 'subscription_tier')) {
        const val = sanitizeReceiptString(row.subscription_tier)
        if (val !== undefined) {
          candidate.subscription_tier = val
        }
      }

      const rowMode =
        (hasOwn(row, 'mode') && typeof row.mode === 'string' ? row.mode : undefined) ??
        (hasOwn(data, 'mode') && typeof data.mode === 'string' ? data.mode : undefined) ??
        mode
      const isGcli = rowMode === 'geminicli'

      if (isGcli) {
        if (hasOwn(row, 'tier_raw_id')) {
          const val = sanitizeReceiptString(row.tier_raw_id)
          if (val !== undefined) {
            candidate.tier_raw_id = val
          }
        }

        if (hasOwn(row, 'tier_raw_name')) {
          const val = sanitizeReceiptString(row.tier_raw_name)
          if (val !== undefined) {
            candidate.tier_raw_name = val
          }
        }

        if (hasOwn(row, 'tier_detection_status')) {
          const val = sanitizeReceiptString(row.tier_detection_status)
          if (val !== undefined) {
            candidate.tier_detection_status = val
          }
        }

        if (hasOwn(row, 'tier_detected_at')) {
          const val = sanitizeDetectedAt(row.tier_detected_at)
          if (val !== undefined) {
            candidate.tier_detected_at = val
          }
        }
      }

      if (Object.keys(candidate).length > 0) {
        receipt = candidate
      }
    }

    let failureReason: ImportItemFailureReason | undefined = undefined
    if (status === 'failed') {
      failureReason = classifyFailureReason(
        row.error_code,
        row.error ?? row.message ?? row.detail,
      )
    }

    return {
      label: itemLabel,
      status,
      ...(receipt ? { receipt } : {}),
      ...(failureReason ? { failureReason } : {}),
    }
  })

  const successCount = items.filter(item => item.status === 'success').length
  const failedCount = items.filter(item => item.status === 'failed').length
  const rowCount = items.length
  const isEmpty = rowCount === 0 || (Array.isArray(data.results) && data.results.length === 0)

  const aggUploaded =
    typeof data.uploaded_count === 'number' && Number.isInteger(data.uploaded_count) && data.uploaded_count >= 0
      ? data.uploaded_count
      : undefined
  const aggSuccess =
    typeof data.success_count === 'number' && Number.isInteger(data.success_count) && data.success_count >= 0
      ? data.success_count
      : aggUploaded

  const aggFailed =
    typeof data.failed_count === 'number' && Number.isInteger(data.failed_count) && data.failed_count >= 0
      ? data.failed_count
      : typeof data.failure_count === 'number' && Number.isInteger(data.failure_count) && data.failure_count >= 0
        ? data.failure_count
        : undefined

  const aggTotal =
    typeof data.total_count === 'number' && Number.isInteger(data.total_count) && data.total_count >= 0
      ? data.total_count
      : typeof data.total === 'number' && Number.isInteger(data.total) && data.total >= 0
        ? data.total
        : undefined

  const isZeroTotal = aggTotal === 0

  let hasContradiction = false

  if (aggSuccess !== undefined) {
    if (aggSuccess !== successCount || aggSuccess > rowCount) {
      hasContradiction = true
    }
  }

  if (aggFailed !== undefined) {
    if (aggFailed !== failedCount || aggFailed > rowCount) {
      hasContradiction = true
    }
  }

  if (aggTotal !== undefined) {
    if (aggTotal !== rowCount) {
      hasContradiction = true
    }
  }

  if (aggSuccess !== undefined && aggFailed !== undefined) {
    if (aggSuccess + aggFailed > rowCount) {
      hasContradiction = true
    }
    if (aggTotal !== undefined && aggSuccess + aggFailed !== aggTotal) {
      hasContradiction = true
    }
  }

  if (isZeroTotal && (rowCount > 0 || successCount > 0)) {
    hasContradiction = true
  }

  let outcome: 'success' | 'partial' | 'failed' | 'unknown' = 'unknown'
  if (successCount > 0 && failedCount > 0) {
    outcome = 'partial'
  } else if (
    rowCount > 0 &&
    successCount === rowCount &&
    !hasContradiction &&
    !isZeroTotal &&
    !isEmpty
  ) {
    outcome = 'success'
  } else if (rowCount > 0 && failedCount === rowCount && !hasContradiction) {
    outcome = 'failed'
  } else {
    outcome = 'unknown'
  }

  const isConsistent = !hasContradiction && !isZeroTotal && !isEmpty
  const confirmedFilenames: string[] = []
  const seenFilenames = new Set<string>()

  if (isConsistent) {
    for (let i = 0; i < rows.length; i++) {
      const row = record(rows[i])
      const item = items[i]
      if (item.status === 'success') {
        const rawFilename = row.filename
        if (hasOwn(row, 'filename') && typeof rawFilename === 'string' && isStrictBasename(rawFilename)) {
          if (!seenFilenames.has(rawFilename)) {
            seenFilenames.add(rawFilename)
            confirmedFilenames.push(rawFilename)
          }
        }
      }
    }
  }

  const rawJobId = record(data.email_enrichment).job_id
  const jobId = mode === 'geminicli'
    ? undefined
    : typeof rawJobId === 'string' && (mode === 'antigravity' ? /^[0-9a-f]{32}$/.test(rawJobId) : /^[a-zA-Z0-9_-]{1,128}$/.test(rawJobId))
      ? rawJobId
      : undefined

  const warningListCount = Array.isArray(data.warnings) ? data.warnings.length : 0
  const rowWarningsCount = (Array.isArray(data.results) ? rows : []).reduce<number>(
    (sum, row) => sum + (Array.isArray(record(row).warnings) ? (record(row).warnings as unknown[]).length : 0),
    0,
  )
  const totalWarnings = warningListCount + rowWarningsCount
  const warnings = Number.isSafeInteger(totalWarnings) && totalWarnings >= 0 ? totalWarnings : 0

  return {
    outcome,
    items,
    warnings,
    ...(jobId ? { jobId } : {}),
    ...(confirmedFilenames.length > 0 ? { confirmedFilenames } : {}),
  }
}

export function projectPrompt(error: unknown): ProjectPrompt | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null
  const data = record(error.payload)
  if (data.requires_manual_project_id !== true && data.requires_project_selection !== true) return null

  const manual = data.requires_manual_project_id === true
  const projects = Array.isArray(data.available_projects)
    ? data.available_projects
        .map(p => record(p).project_id)
        .filter((p): p is string => typeof p === 'string' && p.length < 250)
    : []

  let projectOptions: ProjectOption[] | undefined = undefined

  if (Array.isArray(data.available_projects)) {
    const options: ProjectOption[] = []
    const seenIds = new Set<string>()

    for (const raw of data.available_projects) {
      const p = record(raw)
      const rawId = p.project_id
      if (isValidProjectId(rawId) && !seenIds.has(rawId)) {
        seenIds.add(rawId)
        options.push({
          projectId: rawId,
          name: sanitizeProjectName(p.name),
        })
      }
    }

    if (options.length > 0) {
      projectOptions = options
    }
  }

  return {
    manual,
    projects,
    ...(projectOptions ? { projectOptions } : {}),
  }
}

export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return '导入超过服务器资源预算，请缩小文件或拆分批次。此限制与部分成功不同。'
    if (error.status === 401 || error.status === 403) return '认证或授权被拒绝，请检查登录状态与上游授权。'
    if (error.status === 409) return '上传进度观察服务冲突或不可用，请稍后重试。'
    if (error.status < 500) return '服务器拒绝了本次请求，请检查输入后再提交。'
  }
  return '结果未知：请求可能已保存部分凭证。请先到凭证页查看，勿直接重复提交。'
}

function getLegacyAntigravityScope(): PanelScope {
  const channel = getPanelChannelSnapshot()
  if (channel.mode === 'geminicli') {
    throw new Error('当前活动频道为 Gemini CLI，旧接口仅支持 Antigravity。')
  }
  const session = getSessionSnapshot()
  return capturePanelScope(session.sessionEpoch)
}

export function createImportApi(context: ImportRequestContext): ImportApi {
  const boundMode: PanelMode = context.mode
  const boundScope: PanelScope = Object.freeze({
    mode: context.scope.mode,
    channelEpoch: context.scope.channelEpoch,
    sessionEpoch: context.scope.sessionEpoch,
  })
  const boundCapabilities: Set<string> | undefined = context.oauthCapabilities
    ? new Set(context.oauthCapabilities)
    : undefined
  let discoveredCapabilities: Set<string> | undefined = undefined

  return {
    async uploadFiles(
      files: File[],
      signal?: AbortSignal,
      onProgress?: (progress: UploadByteProgress) => void,
    ): Promise<ImportResult> {
      assertActive(boundMode, boundScope, signal)
      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
        const fixture = (await import('./fixtures')).previewResult()
        assertActive(boundMode, boundScope, signal)
        return cloneFixtureResult(fixture, boundMode)
      }

      if (!onProgress) {
        const body = new FormData()
        files.forEach(file => body.append('files', file))
        body.append('mode', boundMode)

        const raw = await requestJson('creds/upload', {
          method: 'POST',
          query: { mode: boundMode },
          body,
          signal,
          scope: boundScope,
        })
        assertActive(boundMode, boundScope, signal)
        return normalizeResult(raw, false, boundMode)
      }

      let progressSupported = false
      let pollIntervalMs = 500
      let ticketTtlSeconds = 900

      const isCurrentActive = (): boolean => {
        if (signal?.aborted) return false
        if (boundMode !== boundScope.mode) return false
        const currentSessionEpoch = getSessionSnapshot().sessionEpoch
        return isPanelScopeCurrent(boundScope, currentSessionEpoch)
      }

      let uploadSettled = false

      const emitProgress = (progress: UploadByteProgress) => {
        if (uploadSettled || !isCurrentActive()) return
        onProgress(progress)
      }

      try {
        const capRes: Record<string, unknown> = await requestJson<Record<string, unknown>>('creds/upload-progress/capabilities', {
          method: 'GET',
          signal,
          scope: boundScope,
        })
        assertActive(boundMode, boundScope, signal)
        if (
          capRes &&
          capRes.capability === 'panel.credentials.upload_progress.v1' &&
          capRes.supported === true &&
          capRes.reason === null &&
          Array.isArray(capRes.modes) &&
          capRes.modes.includes(boundMode) &&
          typeof capRes.poll_interval_ms === 'number' &&
          Number.isSafeInteger(capRes.poll_interval_ms) &&
          capRes.poll_interval_ms === 500 &&
          typeof capRes.ttl_seconds === 'number' &&
          Number.isSafeInteger(capRes.ttl_seconds) &&
          capRes.ttl_seconds === 900
        ) {
          progressSupported = true
          pollIntervalMs = capRes.poll_interval_ms
          ticketTtlSeconds = capRes.ttl_seconds
        }
      } catch (capErr) {
        assertActive(boundMode, boundScope, signal)
        const isAbort =
          signal?.aborted ||
          !isPanelScopeCurrent(boundScope, getSessionSnapshot().sessionEpoch) ||
          (capErr instanceof DOMException && capErr.name === 'AbortError') ||
          (typeof capErr === 'object' && capErr !== null && (capErr as { name?: string }).name === 'AbortError') ||
          (capErr instanceof Error && (capErr.message.includes('作用域已变更') || capErr.message.includes('请求模式与作用域不一致')))
        const isAuth =
          (capErr instanceof ApiError && (capErr.status === 401 || capErr.status === 403)) ||
          (typeof capErr === 'object' && capErr !== null && ((capErr as { status?: unknown }).status === 401 || (capErr as { status?: unknown }).status === 403))
        if (isAbort || isAuth) {
          throw capErr
        }
        progressSupported = false
      }

      let progressId: string | null = null
      let observationDeadline = 0

      if (progressSupported) {
        const ticketRequestStart = monotonicNow()
        observationDeadline = ticketRequestStart + Math.min(900, ticketTtlSeconds) * 1000
        try {
          const ticketRes: Record<string, unknown> = await requestJson<Record<string, unknown>>('creds/upload-progress', {
            method: 'POST',
            query: { mode: boundMode },
            signal,
            scope: boundScope,
          })
          assertActive(boundMode, boundScope, signal)
          const isValidId =
            typeof ticketRes.progress_id === 'string' &&
            /^[0-9a-f]{32}$/.test(ticketRes.progress_id)
          const isValidMode = ticketRes.mode === boundMode
          const isValidReceived =
            typeof ticketRes.received_bytes === 'number' &&
            Number.isSafeInteger(ticketRes.received_bytes) &&
            ticketRes.received_bytes >= 0
          const isValidTotal =
            ticketRes.total_bytes === null ||
            (typeof ticketRes.total_bytes === 'number' &&
              Number.isSafeInteger(ticketRes.total_bytes) &&
              ticketRes.total_bytes >= 0)
          const rawPhase = ticketRes.phase
          const isValidPhase =
            rawPhase === 'receiving' ||
            rawPhase === 'processing' ||
            rawPhase === 'finished' ||
            rawPhase === 'interrupted'
          const isValidHttpStatus =
            ticketRes.http_status === null ||
            (typeof ticketRes.http_status === 'number' &&
              Number.isSafeInteger(ticketRes.http_status) &&
              ticketRes.http_status >= 100 &&
              ticketRes.http_status <= 599)
          const isValidBound = typeof ticketRes.bound === 'boolean'
          const isValidTtl =
            typeof ticketRes.expires_in_seconds === 'number' &&
            Number.isSafeInteger(ticketRes.expires_in_seconds) &&
            ticketRes.expires_in_seconds > 0 &&
            ticketRes.expires_in_seconds <= 900

          if (
            isValidId &&
            isValidMode &&
            isValidReceived &&
            isValidTotal &&
            isValidPhase &&
            isValidHttpStatus &&
            isValidBound &&
            isValidTtl
          ) {
            const ticketResTime = monotonicNow()
            const prospectiveDeadline = ticketResTime + (ticketRes.expires_in_seconds as number) * 1000
            if (prospectiveDeadline < observationDeadline) {
              observationDeadline = prospectiveDeadline
            }

            if (ticketResTime >= observationDeadline) {
              progressId = null
              emitProgress({
                receivedBytes: 0,
                totalBytes: null,
                phase: 'receiving',
                percentage: null,
                available: false,
              })
            } else {
              progressId = ticketRes.progress_id as string
              const rec = ticketRes.received_bytes as number
              const tot = ticketRes.total_bytes as number | null
              const pct =
                tot !== null && tot > 0
                  ? Math.min(100, Math.max(0, Math.floor((rec / tot) * 100)))
                  : null
              emitProgress({
                receivedBytes: rec,
                totalBytes: tot,
                phase: rawPhase as UploadProgressPhase,
                percentage: pct,
                available: true,
              })
            }
          } else {
            progressId = null
            emitProgress({
              receivedBytes: 0,
              totalBytes: null,
              phase: 'receiving',
              percentage: null,
              available: false,
            })
          }
        } catch (ticketErr) {
          assertActive(boundMode, boundScope, signal)
          const isAbort =
            signal?.aborted ||
            !isPanelScopeCurrent(boundScope, getSessionSnapshot().sessionEpoch) ||
            (ticketErr instanceof DOMException && ticketErr.name === 'AbortError') ||
            (typeof ticketErr === 'object' && ticketErr !== null && (ticketErr as { name?: string }).name === 'AbortError') ||
            (ticketErr instanceof Error && (ticketErr.message.includes('作用域已变更') || ticketErr.message.includes('请求模式与作用域不一致')))
          const isAuth =
            (ticketErr instanceof ApiError && (ticketErr.status === 401 || ticketErr.status === 403)) ||
            (typeof ticketErr === 'object' && ticketErr !== null && ((ticketErr as { status?: unknown }).status === 401 || (ticketErr as { status?: unknown }).status === 403))
          if (isAbort || isAuth) {
            throw ticketErr
          }
          emitProgress({
            receivedBytes: 0,
            totalBytes: null,
            phase: 'receiving',
            percentage: null,
            available: false,
          })
          progressId = null
        }
      } else {
        emitProgress({
          receivedBytes: 0,
          totalBytes: null,
          phase: 'receiving',
          percentage: null,
          available: false,
        })
      }

      const body = new FormData()
      files.forEach(file => body.append('files', file))
      body.append('mode', boundMode)

      if (!progressId) {
        assertActive(boundMode, boundScope, signal)
        const raw = await requestJson('creds/upload', {
          method: 'POST',
          query: { mode: boundMode },
          body,
          signal,
          scope: boundScope,
        })
        assertActive(boundMode, boundScope, signal)
        return normalizeResult(raw, false, boundMode)
      }

      const uploadTicketId = progressId
      let observedProgressId: string | null = progressId

      const pollController = new AbortController()

      let observationStopped = false
      let deadlinePublished = false
      let currentDeadline = observationDeadline

      let lastReceived = 0
      let lastTotal: number | null = null
      let lastPct: number | null = null

      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      let waitTimer: ReturnType<typeof setTimeout> | null = null
      let waitAbortListener: (() => void) | null = null
      let forwardAbort: (() => void) | null = null
      let resolveWait: (() => void) | null = null

      const stopObservation = () => {
        if (observationStopped) return
        observationStopped = true

        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }

        if (waitTimer !== null) {
          clearTimeout(waitTimer)
          waitTimer = null
        }

        if (waitAbortListener !== null) {
          pollController.signal.removeEventListener('abort', waitAbortListener)
          waitAbortListener = null
        }

        if (forwardAbort !== null) {
          signal?.removeEventListener('abort', forwardAbort)
          forwardAbort = null
        }

        if (!pollController.signal.aborted) {
          pollController.abort()
        }

        if (resolveWait !== null) {
          const res = resolveWait
          resolveWait = null
          res()
        }

        observedProgressId = null
      }

      const handleDeadline = () => {
        if (deadlinePublished || observationStopped) return
        deadlinePublished = true
        emitProgress({
          receivedBytes: lastReceived,
          totalBytes: lastTotal,
          phase: 'interrupted',
          percentage: lastPct,
          available: false,
        })
        stopObservation()
      }

      forwardAbort = () => {
        stopObservation()
      }
      if (signal?.aborted) {
        stopObservation()
      } else if (!observationStopped) {
        signal?.addEventListener('abort', forwardAbort, { once: true })
      }

      const setupDeadlineTo = (targetDeadline: number) => {
        if (deadlineTimer !== null) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        if (observationStopped) return
        const remaining = targetDeadline - monotonicNow()
        if (remaining <= 0) {
          handleDeadline()
          return
        }
        deadlineTimer = setTimeout(() => {
          deadlineTimer = null
          handleDeadline()
        }, remaining)
      }
      setupDeadlineTo(currentDeadline)

      const pollLoop = async (): Promise<void> => {
        while (!uploadSettled && !observationStopped && !pollController.signal.aborted) {
          if (monotonicNow() >= currentDeadline) {
            handleDeadline()
            break
          }
          try {
            assertActive(boundMode, boundScope, signal)
            if (uploadSettled || observationStopped || pollController.signal.aborted || !observedProgressId) break

            const pollRes: Record<string, unknown> = await requestJson<Record<string, unknown>>(
              `creds/upload-progress/${encodeURIComponent(observedProgressId)}`,
              {
                method: 'GET',
                query: { mode: boundMode },
                signal: pollController.signal,
                scope: boundScope,
              },
            )

            assertActive(boundMode, boundScope, signal)
            if (uploadSettled || observationStopped || pollController.signal.aborted) break

            const isValidId =
              pollRes &&
              typeof pollRes.progress_id === 'string' &&
              pollRes.progress_id === observedProgressId
            const isValidMode = pollRes && pollRes.mode === boundMode
            const isValidReceived =
              pollRes &&
              typeof pollRes.received_bytes === 'number' &&
              Number.isSafeInteger(pollRes.received_bytes) &&
              pollRes.received_bytes >= 0
            const isValidTotal =
              pollRes &&
              (pollRes.total_bytes === null ||
                (typeof pollRes.total_bytes === 'number' &&
                  Number.isSafeInteger(pollRes.total_bytes) &&
                  pollRes.total_bytes >= 0))
            const rawPhase = pollRes?.phase
            const isValidPhase =
              rawPhase === 'receiving' ||
              rawPhase === 'processing' ||
              rawPhase === 'finished' ||
              rawPhase === 'interrupted'
            const isValidHttpStatus =
              pollRes &&
              (pollRes.http_status === null ||
                (typeof pollRes.http_status === 'number' &&
                  Number.isSafeInteger(pollRes.http_status) &&
                  pollRes.http_status >= 100 &&
                  pollRes.http_status <= 599))
            const isValidBound = pollRes && typeof pollRes.bound === 'boolean'
            const isValidTtl =
              pollRes &&
              typeof pollRes.expires_in_seconds === 'number' &&
              Number.isSafeInteger(pollRes.expires_in_seconds) &&
              pollRes.expires_in_seconds >= 0 &&
              pollRes.expires_in_seconds <= 900

            if (
              !isValidId ||
              !isValidMode ||
              !isValidReceived ||
              !isValidTotal ||
              !isValidPhase ||
              !isValidHttpStatus ||
              !isValidBound ||
              !isValidTtl
            ) {
              emitProgress({
                receivedBytes: lastReceived,
                totalBytes: lastTotal,
                phase: 'receiving',
                percentage: lastPct,
                available: false,
              })
              stopObservation()
              break
            }

            const expiresIn = pollRes.expires_in_seconds as number
            if (expiresIn <= 0) {
              emitProgress({
                receivedBytes: lastReceived,
                totalBytes: lastTotal,
                phase: 'interrupted',
                percentage: lastPct,
                available: false,
              })
              stopObservation()
              break
            }

            const prospectiveDeadline = monotonicNow() + expiresIn * 1000
            if (prospectiveDeadline < currentDeadline) {
              currentDeadline = prospectiveDeadline
              setupDeadlineTo(currentDeadline)
            }

            const receivedBytes = pollRes.received_bytes as number
            const totalBytes =
              pollRes.total_bytes !== null && (pollRes.total_bytes as number) > 0
                ? (pollRes.total_bytes as number)
                : null
            const phase: UploadProgressPhase = rawPhase as UploadProgressPhase
            const percentage =
              totalBytes !== null && totalBytes > 0
                ? Math.min(100, Math.max(0, Math.floor((receivedBytes / totalBytes) * 100)))
                : null

            lastReceived = receivedBytes
            lastTotal = totalBytes
            lastPct = percentage

            assertActive(boundMode, boundScope, signal)
            if (uploadSettled || observationStopped || pollController.signal.aborted) break

            emitProgress({
              receivedBytes,
              totalBytes,
              phase,
              percentage,
              available: true,
            })

            if (phase === 'finished' || phase === 'interrupted') {
              stopObservation()
              break
            }
          } catch (pollErr) {
            if (uploadSettled || observationStopped || pollController.signal.aborted) {
              stopObservation()
              break
            }

            const isAbort =
              signal?.aborted ||
              !isPanelScopeCurrent(boundScope, getSessionSnapshot().sessionEpoch) ||
              (pollErr instanceof DOMException && pollErr.name === 'AbortError') ||
              (typeof pollErr === 'object' && pollErr !== null && (pollErr as { name?: string }).name === 'AbortError') ||
              (pollErr instanceof Error && (pollErr.message.includes('作用域已变更') || pollErr.message.includes('请求模式与作用域不一致')))

            if (isAbort) {
              stopObservation()
              throw pollErr
            }

            if (
              pollErr instanceof ApiError &&
              (pollErr.status === 401 || pollErr.status === 403) &&
              pollErr.message.includes('登录已失效')
            ) {
              stopObservation()
              throw pollErr
            }

            emitProgress({
              receivedBytes: lastReceived,
              totalBytes: lastTotal,
              phase: 'receiving',
              percentage: lastPct,
              available: false,
            })
            stopObservation()
            break
          }

          if (!uploadSettled && !observationStopped && !pollController.signal.aborted) {
            await new Promise<void>(resolve => {
              resolveWait = resolve
              waitAbortListener = () => {
                if (waitTimer !== null) {
                  clearTimeout(waitTimer)
                  waitTimer = null
                }
                waitAbortListener = null
                resolveWait = null
                resolve()
              }
              if (pollController.signal.aborted || observationStopped) {
                resolveWait = null
                waitAbortListener = null
                resolve()
                return
              }
              pollController.signal.addEventListener('abort', waitAbortListener, { once: true })
              waitTimer = setTimeout(() => {
                if (waitAbortListener !== null) {
                  pollController.signal.removeEventListener('abort', waitAbortListener)
                  waitAbortListener = null
                }
                waitTimer = null
                resolveWait = null
                resolve()
              }, pollIntervalMs)
            })
          }
        }
      }

      const pollPromise = pollLoop().catch(() => {})

      try {
        assertActive(boundMode, boundScope, signal)
        const isExpiredOrStopped = observationStopped || monotonicNow() >= currentDeadline
        if (isExpiredOrStopped) {
          handleDeadline()
          stopObservation()
          assertActive(boundMode, boundScope, signal)
        }
        const uploadQuery = isExpiredOrStopped
          ? { mode: boundMode }
          : { mode: boundMode, progress_id: uploadTicketId }
        const raw = await requestJson('creds/upload', {
          method: 'POST',
          query: uploadQuery,
          body,
          signal,
          scope: boundScope,
        })
        uploadSettled = true
        stopObservation()
        await pollPromise
        assertActive(boundMode, boundScope, signal)
        return normalizeResult(raw, false, boundMode)
      } catch (uploadErr) {
        uploadSettled = true
        stopObservation()
        await pollPromise
        assertActive(boundMode, boundScope, signal)
        throw uploadErr
      } finally {
        uploadSettled = true
        stopObservation()
      }
    },

    async importTokens(input: TokenInput, signal?: AbortSignal): Promise<ImportResult> {
      assertActive(boundMode, boundScope, signal)
      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
        const fixture = (await import('./fixtures')).previewResult()
        assertActive(boundMode, boundScope, signal)
        return cloneFixtureResult(fixture, boundMode)
      }
      const common = {
        mode: boundMode,
        client_id: input.clientId || undefined,
        client_secret: input.clientSecret || undefined,
      }
      const batch = input.tokens.length > 1
      const body = batch
        ? { ...common, refresh_tokens: input.tokens, filename_prefix: input.filename || undefined }
        : { ...common, refresh_token: input.tokens[0], project_id: input.projectId || undefined, custom_filename: input.filename || undefined }
      const raw = await requestJson(batch ? 'creds/upload-by-refresh-token-batch' : 'creds/upload-by-refresh-token', {
        method: 'POST',
        body,
        signal,
        scope: boundScope,
      })
      assertActive(boundMode, boundScope, signal)
      return normalizeResult(raw, false, boundMode)
    },

    async startOAuth(projectId: string, signal?: AbortSignal): Promise<string> {
      assertActive(boundMode, boundScope, signal)
      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
        assertActive(boundMode, boundScope, signal)
        return ''
      }
      const data = record(await requestJson('auth/start', {
        method: 'POST',
        body: { mode: boundMode, project_id: projectId || undefined },
        signal,
        scope: boundScope,
      }))
      assertActive(boundMode, boundScope, signal)
      if (typeof data.auth_url !== 'string') throw new Error('Invalid authorization response')
      const url = new URL(data.auth_url)
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password) {
        throw new Error('Invalid authorization origin')
      }
      return url.href
    },

    async completeOAuth(callbackUrl: string | null, projectId: string, signal?: AbortSignal): Promise<ImportResult> {
      assertActive(boundMode, boundScope, signal)
      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
        const fixture = (await import('./fixtures')).previewResult()
        assertActive(boundMode, boundScope, signal)
        return cloneFixtureResult(fixture, boundMode)
      }

      let caps = boundCapabilities
      if (!caps) {
        if (!discoveredCapabilities) {
          const statusData = record(await requestJson('creds/status', {
            method: 'GET',
            query: { mode: boundMode, offset: 0, limit: 10 },
            signal,
            scope: boundScope,
          }))
          assertActive(boundMode, boundScope, signal)
          const list = Array.isArray(statusData.panel_capabilities) ? statusData.panel_capabilities : []
          discoveredCapabilities = new Set(list.filter((c): c is string => typeof c === 'string'))
        }
        caps = discoveredCapabilities
      }

      if (!hasSafeResponseCapability(caps, boundMode)) {
        throw new Error('当前服务不支持安全 OAuth 响应。')
      }

      const path = callbackUrl === null ? 'auth/callback' : 'auth/callback-url'
      const body: Record<string, unknown> = {
        mode: boundMode,
        project_id: projectId || undefined,
        include_credentials: false,
      }
      if (callbackUrl !== null) {
        body.callback_url = callbackUrl
      }
      const raw = record(await requestJson(path, {
        method: 'POST',
        body,
        signal,
        scope: boundScope,
      }))
      assertActive(boundMode, boundScope, signal)
      return projectSafeOAuthCompletion(raw, boundMode)
    },

    async readEmailJob(jobId: string, signal?: AbortSignal): Promise<EmailSnapshot> {
      if (boundMode === 'geminicli') {
        throw new Error('Gemini CLI 不支持邮箱任务')
      }
      assertActive(boundMode, boundScope, signal)
      if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
        const fixture = (await import('./fixtures')).previewEmail()
        assertActive(boundMode, boundScope, signal)
        return {
          complete: fixture.complete,
          items: fixture.items.map(item => ({ ...item })),
        }
      }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error('Invalid job')
      const items: EmailItem[] = []
      let complete = false
      let expectedTotal: number | null = null
      const seenFilenames = new Set<string>()
      for (let page = 0; page < 50; page++) {
        assertActive(boundMode, boundScope, signal)
        const data = record(await requestJson(`creds/email-enrichment/${encodeURIComponent(jobId)}`, {
          query: { offset: items.length, limit: 100 },
          signal,
          scope: boundScope,
        }))
        assertActive(boundMode, boundScope, signal)
        if (data.job_id !== jobId || !Array.isArray(data.items) || data.items.length > 100 || !Number.isInteger(data.total) || Number(data.total) < 0 || Number(data.total) > 5000 || items.length + data.items.length > Number(data.total)) {
          throw new Error('Invalid job page')
        }
        const total = Number(data.total)
        if (expectedTotal === null) {
          expectedTotal = total
        } else if (total !== expectedTotal) {
          throw new Error('Job total changed')
        }
        for (const raw of data.items) {
          const item = record(raw)
          if (typeof item.filename !== 'string' || !emailStates.includes(item.status as EmailState)) {
            throw new Error('Invalid job item')
          }
          if (seenFilenames.has(item.filename)) {
            throw new Error('Duplicate filename in job')
          }
          seenFilenames.add(item.filename)
          items.push({
            filename: label(item.filename, '凭证'),
            status: item.status as EmailState,
            email: item.status === 'success' && typeof item.user_email === 'string' ? item.user_email : undefined,
          })
        }
        complete = data.complete === true && data.sealed === true &&
          items.every(item => !['queued', 'running', 'settlement_pending'].includes(item.status))
        if (items.length === total) return { items, complete }
        if (!data.items.length) throw new Error('Incomplete job page')
      }
      throw new Error('Job pagination limit')
    },
  }
}

export async function uploadFiles(
  files: File[],
  signal?: AbortSignal,
  onProgress?: (progress: UploadByteProgress) => void,
): Promise<ImportResult> {
  const scope = getLegacyAntigravityScope()
  const api = createImportApi({ mode: 'antigravity', scope })
  return await api.uploadFiles(files, signal, onProgress)
}

export async function importTokens(input: TokenInput, signal?: AbortSignal): Promise<ImportResult> {
  const scope = getLegacyAntigravityScope()
  const api = createImportApi({ mode: 'antigravity', scope })
  return await api.importTokens(input, signal)
}

export async function startOAuth(projectId: string, signal?: AbortSignal): Promise<string> {
  const scope = getLegacyAntigravityScope()
  const api = createImportApi({ mode: 'antigravity', scope })
  return await api.startOAuth(projectId, signal)
}

export async function completeOAuth(callbackUrl: string | null, projectId: string, signal?: AbortSignal): Promise<ImportResult> {
  const scope = getLegacyAntigravityScope()
  const api = createImportApi({ mode: 'antigravity', scope })
  return await api.completeOAuth(callbackUrl, projectId, signal)
}

export async function readEmailJob(jobId: string, signal?: AbortSignal): Promise<EmailSnapshot> {
  const scope = getLegacyAntigravityScope()
  const api = createImportApi({ mode: 'antigravity', scope })
  return await api.readEmailJob(jobId, signal)
}

export async function readImportCapabilities(
  signal: AbortSignal,
  context: ImportRequestContext,
): Promise<ReadonlySet<string>> {
  const boundMode: PanelMode = context.mode
  const boundScope: PanelScope = Object.freeze({
    mode: context.scope.mode,
    channelEpoch: context.scope.channelEpoch,
    sessionEpoch: context.scope.sessionEpoch,
  })

  assertActive(boundMode, boundScope, signal)

  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
    assertActive(boundMode, boundScope, signal)
    return new Set<string>([`${boundMode}.oauth.safe_response`])
  }

  const statusData = record(
    await requestJson('creds/status', {
      method: 'GET',
      query: { mode: boundMode, offset: 0, limit: 10 },
      signal,
      scope: boundScope,
    }),
  )

  assertActive(boundMode, boundScope, signal)

  const list = Array.isArray(statusData.panel_capabilities) ? statusData.panel_capabilities : []
  return new Set(list.filter((c): c is string => typeof c === 'string'))
}

export async function readEmailJobs(
  jobIds: readonly string[],
  signal: AbortSignal,
  context: ImportRequestContext,
): Promise<readonly EmailJobObservation[]> {
  const boundMode: PanelMode = context.mode
  const boundScope: PanelScope = Object.freeze({
    mode: context.scope.mode,
    channelEpoch: context.scope.channelEpoch,
    sessionEpoch: context.scope.sessionEpoch,
  })
  const boundCaps = context.oauthCapabilities
    ? Object.freeze(Array.from(context.oauthCapabilities))
    : undefined

  assertActive(boundMode, boundScope, signal)

  if (boundMode !== 'antigravity') {
    throw new Error('Gemini CLI 不支持邮箱任务')
  }

  if (!Array.isArray(jobIds)) {
    throw new Error('Invalid job IDs')
  }

  const distinctIds: string[] = []
  const seen = new Set<string>()
  for (const id of jobIds) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) {
      throw new Error('Invalid job ID')
    }
    if (!seen.has(id)) {
      seen.add(id)
      distinctIds.push(id)
    }
  }

  if (distinctIds.length > 128) {
    throw new Error('Too many job IDs')
  }

  if (distinctIds.length === 0) {
    assertActive(boundMode, boundScope, signal)
    return Object.freeze([])
  }

  const api = createImportApi({
    mode: boundMode,
    scope: boundScope,
    oauthCapabilities: boundCaps,
  })

  const observations: EmailJobObservation[] = new Array(distinctIds.length)
  let cursor = 0
  let fatalError: unknown = null

  async function worker(): Promise<void> {
    while (cursor < distinctIds.length) {
      if (fatalError || signal.aborted) {
        return
      }
      const index = cursor++
      const jobId = distinctIds[index]

      try {
        assertActive(boundMode, boundScope, signal)
      } catch (err) {
        if (!fatalError) fatalError = err
        return
      }

      try {
        const snapshot = await api.readEmailJob(jobId, signal)
        assertActive(boundMode, boundScope, signal)
        observations[index] = Object.freeze({
          jobId,
          status: 'observed',
          snapshot,
        })
      } catch (err) {
        const sessionEpoch = getSessionSnapshot().sessionEpoch
        const isStale = !isPanelScopeCurrent(boundScope, sessionEpoch)
        const isAbort =
          signal.aborted ||
          isStale ||
          (err instanceof DOMException && err.name === 'AbortError') ||
          (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError') ||
          (err instanceof Error && (err.message.includes('作用域已变更') || err.message.includes('请求模式与作用域不一致')))

        if (isAbort) {
          if (!fatalError) {
            if (signal.aborted) {
              try {
                signal.throwIfAborted()
              } catch (abortErr) {
                fatalError = abortErr
              }
            } else if (isStale) {
              fatalError = new DOMException('作用域已变更，请重新读取。', 'AbortError')
            } else {
              fatalError = err
            }
          }
          return
        }

        const is404 =
          (err instanceof ApiError && err.status === 404) ||
          (typeof err === 'object' && err !== null && (err as { status?: number }).status === 404)

        if (is404) {
          observations[index] = Object.freeze({
            jobId,
            status: 'expired',
            snapshot: null,
          })
        } else {
          observations[index] = Object.freeze({
            jobId,
            status: 'unavailable',
            snapshot: null,
          })
        }
      }
    }
  }

  const concurrency = Math.min(distinctIds.length, 4)
  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  if (fatalError) {
    throw fatalError
  }

  assertActive(boundMode, boundScope, signal)
  return Object.freeze(observations)
}

