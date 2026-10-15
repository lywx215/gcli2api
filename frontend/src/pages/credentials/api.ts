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

    async manual(filename: string, operation: 'quota' | 'test' | 'verify-project', model?: string, signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return manualResult({ success: false, status_code: 200, verified_reply: false, state_update: { quota: { status: 'pending' } } })
      }
      try {
        return manualResult(await requestJson(`creds/${operation}/${encodeURIComponent(filename)}`, { method: operation === 'quota' ? 'GET' : 'POST', query: { ...modeQuery, ...(operation === 'test' && model ? { model } : {}) }, signal, scope }))
      } catch (e) {
        if (e instanceof ApiError) return manualResult(e.payload, e.status)
        throw e
      }
    },

    async quotaBatch(names: string[], signal?: AbortSignal) {
      const callEpoch = getSessionSnapshot().sessionEpoch
      assertOwnership(callEpoch, signal)
      if (names.length > 10) throw new Error('每批最多 10 项')
      if (fixtureMode) {
        if (mode === 'geminicli') throw new Error('Gemini CLI 暂不支持预览数据')
        return names.map(filename => ({ filename, ...manualResult({ success: true, state_update: { quota: { status: 'applied' } } }) }))
      }
      const d = object(await requestJson('creds/batch-refresh-cooldown', { method: 'POST', query: modeQuery, body: { filenames: names }, signal, scope }))
      if (!Array.isArray(d.results)) throw new BatchResultError('批量额度结果缺失，结果未知')
      const returned = d.results.map(row => object(row).filename)
      if (returned.length !== names.length || new Set(returned).size !== names.length || returned.some(name => typeof name !== 'string' || !names.includes(name))) throw new BatchResultError('批量额度标识不一致，结果未知；停止后续批次')
      return names.map(filename => { const raw = d.results as unknown[]; const row = raw.find(r => object(r).filename === filename); return { filename, ...manualResult(row, count(object(row).status_code) ?? 200) } })
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
