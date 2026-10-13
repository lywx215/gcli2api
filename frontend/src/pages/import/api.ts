import { ApiError, requestJson } from '@/api/client'
import type { EmailItem, EmailSnapshot, EmailState, ImportResult, ProjectPrompt, TokenInput } from './types'

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const label = (value: unknown, fallback: string) => typeof value === 'string' && value.length <= 250 ? value : fallback
export function normalizeResult(value: unknown, oauth = false): ImportResult {
  const data = record(value)
  const rows = Array.isArray(data.results) ? data.results : [data]
  const items = rows.map((raw, index) => {
    const row = record(raw)
    const status = row.status === 'error' || row.status === 'failed' || row.success === false || row.error != null
      ? 'failed' : row.status === 'success' || row.success === true || (oauth && typeof row.file_path === 'string') ? 'success' : 'unknown'
    return { label: label(row.filename, oauth ? 'OAuth 凭证' : `第 ${index + 1} 项`), status } as const
  })
  const success = items.filter(item => item.status === 'success').length
  const failed = items.filter(item => item.status === 'failed').length
  const jobId = record(data.email_enrichment).job_id
  return {
    items, outcome: items.length && success === items.length ? 'success' : success && failed ? 'partial' : items.length && failed === items.length ? 'failed' : 'unknown',
    warnings: (Array.isArray(data.warnings) ? data.warnings.length : 0) + (Array.isArray(data.results) ? rows : []).reduce<number>((sum, row) => sum + (Array.isArray(record(row).warnings) ? (record(row).warnings as unknown[]).length : 0), 0),
    jobId: typeof jobId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(jobId) ? jobId : undefined,
  }
}
export function projectPrompt(error: unknown): ProjectPrompt | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null
  const data = record(error.payload)
  if (data.requires_manual_project_id !== true && data.requires_project_selection !== true) return null
  return { manual: data.requires_manual_project_id === true, projects: Array.isArray(data.available_projects) ? data.available_projects.map(p => record(p).project_id).filter((p): p is string => typeof p === 'string' && p.length < 250) : [] }
}
export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return '导入超过服务器资源预算，请缩小文件或拆分批次。此限制与部分成功不同。'
    if (error.status === 401 || error.status === 403) return '认证或授权被拒绝，请检查登录状态与上游授权。'
    if (error.status < 500) return '服务器拒绝了本次请求，请检查输入后再提交。'
  }
  return '结果未知：请求可能已保存部分凭证。请先到凭证页查看，勿直接重复提交。'
}
export async function uploadFiles(files: File[], signal: AbortSignal) {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return (await import('./fixtures')).previewResult()
  const body = new FormData()
  files.forEach(file => body.append('files', file))
  body.append('mode', 'antigravity')
  return normalizeResult(await requestJson('creds/upload', { method: 'POST', query: { mode: 'antigravity' }, body, signal }))
}
export async function importTokens(input: TokenInput, signal: AbortSignal) {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return (await import('./fixtures')).previewResult()
  const common = { mode: 'antigravity', client_id: input.clientId || undefined, client_secret: input.clientSecret || undefined }
  const batch = input.tokens.length > 1
  const body = batch ? { ...common, refresh_tokens: input.tokens, filename_prefix: input.filename || undefined } : { ...common, refresh_token: input.tokens[0], project_id: input.projectId || undefined, custom_filename: input.filename || undefined }
  return normalizeResult(await requestJson(batch ? 'creds/upload-by-refresh-token-batch' : 'creds/upload-by-refresh-token', { method: 'POST', body, signal }))
}
export async function startOAuth(projectId: string, signal: AbortSignal): Promise<string> {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return ''
  const data = record(await requestJson('auth/start', { method: 'POST', body: { mode: 'antigravity', project_id: projectId || undefined }, signal }))
  if (typeof data.auth_url !== 'string') throw new Error('Invalid authorization response')
  const url = new URL(data.auth_url)
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password) throw new Error('Invalid authorization origin')
  return url.href
}
export async function completeOAuth(callbackUrl: string | null, projectId: string, signal: AbortSignal) {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return (await import('./fixtures')).previewResult()
  return normalizeResult(await requestJson(callbackUrl === null ? 'auth/callback' : 'auth/callback-url', { method: 'POST', body: { mode: 'antigravity', project_id: projectId || undefined, ...(callbackUrl === null ? {} : { callback_url: callbackUrl }) }, signal }), true)
}
const emailStates: EmailState[] = ['queued', 'running', 'settlement_pending', 'success', 'failed', 'skipped', 'superseded', 'unknown']
export async function readEmailJob(jobId: string, signal: AbortSignal): Promise<EmailSnapshot> {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return (await import('./fixtures')).previewEmail()
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new Error('Invalid job')
  const items: EmailItem[] = []
  let complete = false
  // Never trust a response-supplied status_url. The shared client applies the service base.
  for (let page = 0; page < 50; page++) {
    const data = record(await requestJson(`creds/email-enrichment/${encodeURIComponent(jobId)}`, { query: { offset: items.length, limit: 100 }, signal }))
    if (data.job_id !== jobId || !Array.isArray(data.items) || data.items.length > 100 || !Number.isInteger(data.total) || Number(data.total) < 0 || Number(data.total) > 5000 || items.length + data.items.length > Number(data.total)) throw new Error('Invalid job page')
    for (const raw of data.items) {
      const item = record(raw)
      if (typeof item.filename !== 'string' || !emailStates.includes(item.status as EmailState)) throw new Error('Invalid job item')
      items.push({ filename: label(item.filename, '凭证'), status: item.status as EmailState, email: item.status === 'success' && typeof item.user_email === 'string' ? item.user_email : undefined })
    }
    // Pages are separate observations: a later terminal response cannot make an
    // earlier materialized active item terminal. Re-read next poll in that case.
    complete = data.complete === true && data.sealed === true &&
      items.every(item => !['queued', 'running', 'settlement_pending'].includes(item.status))
    if (items.length === data.total) return { items, complete }
    if (!data.items.length) throw new Error('Incomplete job page')
  }
  throw new Error('Job pagination limit')
}
