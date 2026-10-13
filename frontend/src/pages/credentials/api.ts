import { ApiError, requestBlob, requestJson } from '@/api/client'
import { aggregate, CAP, listQuery, manualResult, object, parsePage, count, type Capabilities, type Filters, type Outcome } from './model'
export const fixtureMode = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true'
const mode = { mode: 'antigravity' }
class BatchResultError extends Error {}
export const api = {
  async list(filters: Filters, caps: Capabilities, offset: number, limit: number, signal?: AbortSignal) {
    if (fixtureMode) {
      const { fixturePage } = await import('./fixtures')
      return fixturePage(filters, offset, limit)
    }
    return parsePage(await requestJson('creds/status', { query: listQuery(filters, caps, offset, limit), signal }))
  },
  async action(names: string[], action: string, remark?: string): Promise<Outcome> {
    if (fixtureMode) return aggregate({ success_count: names.length, total_count: names.length }, names.length)
    if (remark !== undefined) {
      const d = object(await requestJson(`creds/remark/${encodeURIComponent(names[0])}`, { method: 'POST', query: mode, body: { remark } }))
      return singleResult(d, typeof d.remark === 'string' && d.remark === remark.trim())
    }
    if (names.length === 1) {
      const d = object(await requestJson('creds/action', { method: 'POST', query: mode, body: { filename: names[0], action } }))
      return singleResult(d, typeof d.message === 'string' && !d.error)
    }
    return aggregate(await requestJson('creds/batch-action', { method: 'POST', query: mode, body: { filenames: names, action } }), names.length)
  },
  async errors(filename: string, signal?: AbortSignal) {
    if (fixtureMode) return { error_codes: [403], error_classifications: { '403': 'subscription_required' } }
    return object(await requestJson(`creds/errors/${encodeURIComponent(filename)}`, { query: mode, signal }))
  },
  async manual(filename: string, operation: 'quota' | 'test' | 'verify-project', model?: string) {
    if (fixtureMode) return manualResult({ success: false, status_code: 200, verified_reply: false, state_update: { quota: { status: 'pending' } } })
    try {
      return manualResult(await requestJson(`creds/${operation}/${encodeURIComponent(filename)}`, { method: operation === 'quota' ? 'GET' : 'POST', query: { ...mode, ...(operation === 'test' && model ? { model } : {}) } }))
    } catch (e) {
      if (e instanceof ApiError) return manualResult(e.payload, e.status)
      throw e
    }
  },
  async quotaBatch(names: string[]) {
    if (names.length > 10) throw new Error('每批最多 10 项')
    if (fixtureMode) return names.map(filename => ({ filename, ...manualResult({ success: true, state_update: { quota: { status: 'applied' } } }) }))
    const d = object(await requestJson('creds/batch-refresh-cooldown', { method: 'POST', query: mode, body: { filenames: names } }))
    if (!Array.isArray(d.results)) throw new BatchResultError('批量额度结果缺失，结果未知')
    const returned = d.results.map(row => object(row).filename)
    if (returned.length !== names.length || new Set(returned).size !== names.length || returned.some(name => typeof name !== 'string' || !names.includes(name))) throw new BatchResultError('批量额度标识不一致，结果未知；停止后续批次')
    return names.map(filename => { const raw = d.results as unknown[]; const row = raw.find(r => object(r).filename === filename); return { filename, ...manualResult(row, count(object(row).status_code) ?? 200) } })
  },
  async download(names: string[]) {
    assertToolLimit(names)
    if (fixtureMode) return { blob: new Blob(['synthetic preview']), selected: names.length, missing: 0 }
    const { blob, response } = await requestBlob('creds/download-selected', { method: 'POST', query: mode, body: { filenames: names } })
    const headerCount = (name: string) => { const v = response.headers.get(name); return v !== null && /^\d+$/.test(v) ? count(Number(v)) : null }
    return { blob, selected: headerCount('X-Selected-Count'), missing: headerCount('X-Missing-Count') }
  },
  async emails(names: string[]) {
    assertToolLimit(names)
    const d = fixtureMode ? { emails: ['preview@example.invalid'], matched_count: names.length, missing_count: 0 } : object(await requestJson('creds/copy-emails', { method: 'POST', query: mode, body: { filenames: names } }))
    if (!Array.isArray(d.emails) || !d.emails.every(v => typeof v === 'string')) throw new Error('邮箱响应格式不完整')
    return { emails: d.emails as string[], matched: count(d.matched_count), missing: count(d.missing_count) }
  },
}
function singleResult(d: Record<string, unknown>, confirmed: boolean): Outcome {
  const rejected = d.success === false || !!d.error
  return { kind: rejected ? 'rejected' : confirmed ? 'success' : 'unknown', succeeded: rejected ? 0 : confirmed ? 1 : null, failed: rejected ? 1 : confirmed ? 0 : null, total: 1, message: rejected ? '服务端拒绝该操作。' : confirmed ? '操作成功。' : '结果未知，请重新读取状态。' }
}
function assertToolLimit(names: string[]) { if (!names.length || names.length > 100) throw new Error('下载与复制邮箱仅支持 1–100 项，请减少选择。') }
export function withdrawnCapability(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 501) return null
  const p = object(error.payload)
  return p.error_code === 'capability_unavailable' && Object.values(CAP).includes(p.capability as never) ? String(p.capability) : null
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
