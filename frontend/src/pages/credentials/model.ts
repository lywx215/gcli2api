import type { PanelMode } from '@/domain/panel'
import type { Query } from '@/domain/shared'

export type RecordValue = Record<string, unknown>
export const object = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {}
export const count = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
export const text = (v: unknown, fallback = '不可用'): string => typeof v === 'string' ? v : fallback
export const CAP = { search: 'antigravity.credentials.search', group: 'antigravity.cooldown.group_filter', family: 'antigravity.model_access.family_filter', permanent: 'antigravity.credentials.permanent_disabled', remark: 'antigravity.credentials.remark', credit: 'antigravity.credentials.credit_mode' } as const
export const CAP_BY_MODE = {
  antigravity: CAP,
  geminicli: {
    search: 'geminicli.credentials.search',
    permanent: 'geminicli.credentials.permanent_disabled',
    remark: 'geminicli.credentials.remark',
  },
} as const
export type Capabilities = Set<string>
export const capabilities = (v: unknown): Capabilities => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
export interface Credential extends RecordValue { filename: string }
export interface CredentialPage { items: Credential[]; total: number; hasMore: boolean; caps: Capabilities; stats: RecordValue; familySummary: RecordValue }
function parseStats(raw: unknown, mode: PanelMode): RecordValue {
  const src = object(raw)
  const result: RecordValue = {}
  const commonKeys = [
    'total',
    'normal',
    'disabled',
    'permanent_disabled',
    'in_cooldown',
    'no_cooldown',
  ] as const
  for (const key of commonKeys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const c = count(src[key])
      if (c !== null) {
        result[key] = c === 0 ? 0 : c
      }
    }
  }
  if (mode === 'antigravity') {
    const agCountKeys = [
      'quota_restricted',
      'quota_unrestricted',
      'quota_blocked_unknown',
      'quota_state_invalid',
    ] as const
    for (const key of agCountKeys) {
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        const c = count(src[key])
        if (c !== null) {
          result[key] = c === 0 ? 0 : c
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(src, 'quota_next_expiry')) {
      const val = src.quota_next_expiry
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        result.quota_next_expiry = val === 0 ? 0 : val
      }
    }
  }
  return result
}
export function parsePage(v: unknown, mode: PanelMode = 'antigravity'): CredentialPage {
  const d = object(v)
  if (Object.prototype.hasOwnProperty.call(d, 'mode') && d.mode !== mode) throw new Error('渠道模式不匹配')
  if (!Array.isArray(d.items) || count(d.total) === null) throw new Error('列表响应格式不完整')
  const items = d.items.map(v => { const r = object(v); if (typeof r.filename !== 'string' || !r.filename) throw new Error('缺少稳定凭证标识'); return r as Credential })
  return { items, total: d.total as number, hasMore: d.has_more === true, caps: capabilities(d.panel_capabilities), stats: parseStats(d.stats, mode), familySummary: object(d.model_access_summary) }
}
export interface Filters {
  search: string
  status: string
  error: string
  tier: string
  group: string
  family: string
  access: string
  remark: string
  preview?: string
  cooldown?: string
}
export const initialFilters: Filters = { search: '', status: 'all', error: 'all', tier: 'all', group: 'all', family: 'claude-opus-5-5', access: 'all', remark: '__all__' }
export function supportedFilters(f: Filters, caps: Capabilities, mode: PanelMode = 'antigravity'): Filters {
  if (mode === 'geminicli') {
    const cap = CAP_BY_MODE.geminicli
    return {
      ...f,
      search: caps.has(cap.search) ? f.search : '',
      remark: caps.has(cap.remark) ? f.remark : '__all__',
      status: !caps.has(cap.permanent) && f.status === 'permanent_disabled' ? 'all' : f.status,
      preview: f.preview || 'all',
      cooldown: f.cooldown || 'all',
    }
  }
  const cap = CAP_BY_MODE.antigravity
  return {
    ...f,
    search: caps.has(cap.search) ? f.search : '',
    group: caps.has(cap.group) ? f.group : 'all',
    family: caps.has(cap.family) ? f.family : initialFilters.family,
    access: caps.has(cap.family) ? f.access : 'all',
    remark: caps.has(cap.remark) ? f.remark : '__all__',
    status: !caps.has(cap.permanent) && f.status === 'permanent_disabled' ? 'all' : f.status,
    ...(f.cooldown !== undefined ? { cooldown: caps.has(cap.group) ? f.cooldown : 'all' } : {}),
  }
}
export function listQuery(filters: Filters, caps: Capabilities, offset: number, limit: number, mode: PanelMode = 'antigravity'): Query {
  const f = supportedFilters(filters, caps, mode)
  if (mode === 'geminicli') {
    const cap = CAP_BY_MODE.geminicli
    return {
      mode: 'geminicli',
      offset,
      limit,
      status_filter: f.status,
      error_code_filter: f.error,
      tier_filter: f.tier,
      preview_filter: f.preview || 'all',
      cooldown_filter: f.cooldown || 'all',
      ...(caps.has(cap.remark) ? { remark_filter: f.remark } : {}),
      ...(caps.has(cap.search) ? { search: f.search } : {}),
    }
  }
  const cap = CAP_BY_MODE.antigravity
  const cooldownVal = (typeof f.cooldown === 'string' && f.cooldown.length > 0) ? f.cooldown : f.group
  return {
    mode: 'antigravity',
    offset,
    limit,
    status_filter: f.status,
    error_code_filter: f.error,
    tier_filter: f.tier,
    ...(caps.has(cap.remark) ? { remark_filter: f.remark } : {}),
    ...(caps.has(cap.search) ? { search: f.search } : {}),
    ...(caps.has(cap.group) ? { cooldown_filter: cooldownVal } : {}),
    ...(caps.has(cap.family) ? { model_access_family: f.family, model_access_filter: f.access } : {}),
  }
}
export function credentialStatus(r: Credential) {
  if (r.permanent_disabled === true) return '永久禁用'
  const base = r.disabled === true ? '已禁用' : r.disabled === false ? '已启用' : '启用状态未知'
  return r.permanent_disabled === false ? base : `${base} · 永久状态未知`
}
export function familyStatus(v: unknown, family: string) {
  const entry = object(object(v)[family]); const now = Date.now() / 1000
  if (entry.state === 'supported' && typeof entry.checked_at === 'number' && entry.checked_at <= now && now < entry.checked_at + 43200) return '目录支持'
  return entry.state === 'unavailable' ? '暂不可用' : '待确认'
}
export function quotaState(d: RecordValue, group: string, now = Date.now() / 1000) {
  const p = object(object(d.quota_groups)[group]); const r = object(object(d.quota_group_states)[group])
  const until = typeof p.cooldownUntil === 'number' && Number.isFinite(p.cooldownUntil) && p.cooldownUntil >= 0 ? p.cooldownUntil : null
  const blocked = r.state === 'blocked_unknown' || p.blockedUnknown === true; const manualOverride = r.state === 'manual_override'
  const full = typeof p.restricted === 'boolean' && typeof p.blockedUnknown === 'boolean' && until !== null
  const conflict = (manualOverride && p.blockedUnknown === true) || (r.state === 'blocked_unknown' && full && p.blockedUnknown === false) || (full && p.restricted === false && (blocked || (until !== null && until > now)))
  const malformed = ['quota_groups', 'quota_group_states'].some(k => k in d && (d[k] === null || typeof d[k] !== 'object' || Array.isArray(d[k]))) || ('cooldownUntil' in p && until === null) || ('state' in r && !['blocked_unknown', 'manual_override'].includes(String(r.state)))
  const invalid = d.quota_state_invalid === true || conflict || malformed; const known = invalid || blocked || full || (until !== null && until > now)
  return { invalid, known, restricted: invalid || blocked || (until !== null && until > now) || p.restricted === true ? true : known ? false : null, blockedUnknown: blocked, manualOverride, cooldownUntil: until }
}
export function quotaText(d: RecordValue, group: string) {
  const s = quotaState(d, group)
  const parts = [s.invalid ? '状态异常，受限' : s.blockedUnknown ? '受限，恢复时间未知' : s.restricted === true ? '受限，等待状态更新' : s.known ? '未受限' : '状态不可用']
  if (s.cooldownUntil !== null && s.cooldownUntil > Date.now() / 1000) parts.push(`冷却至 ${new Date(s.cooldownUntil * 1000).toLocaleString()}`)
  if (s.manualOverride) parts.push('人工解除异常拦截，计时冷却仍有效')
  return parts.join('；')
}
export type Outcome = { kind: 'success' | 'partial' | 'rejected' | 'unknown'; succeeded: number | null; failed: number | null; total: number; message: string }
export function aggregate(v: unknown, expected: number): Outcome {
  const d = object(v); const succeeded = count(d.success_count); const total = count(d.total_count)
  if (succeeded === null || total !== expected || succeeded > expected) return { kind: 'unknown', succeeded: null, failed: null, total: expected, message: '结果不完整，请重新读取状态；请勿盲目重试。' }
  const failed = expected - succeeded
  if ((d.success === false && succeeded === expected) || (Array.isArray(d.errors) && d.errors.length > failed)) return { kind: 'unknown', succeeded, failed, total: expected, message: '结果计数冲突，请重新读取状态。' }
  return { kind: succeeded === expected ? 'success' : succeeded ? 'partial' : 'rejected', succeeded, failed, total: expected, message: `成功 ${succeeded} / ${expected}，失败 ${failed}。` }
}
export function manualResult(v: unknown, httpStatus = 200) {
  const d = object(v)
  const updates = Object.entries(object(d.state_update)).map(([name, v]) => ({ name, status: ['applied', 'pending', 'skipped', 'failed'].includes(String(object(v).status)) ? String(object(v).status) : 'unknown' }))
  return { data: d, success: httpStatus >= 200 && httpStatus < 300 && d.success === true && d.verified_reply !== false && !d.error && (count(d.status_code) === null || (d.status_code as number) < 400), httpStatus, upstreamStatus: count(d.upstream_status), verifiedReply: typeof d.verified_reply === 'boolean' ? d.verified_reply : null, updates }
}
export class Generation { private value = 0; invalidate() { return ++this.value }; capture() { const value = this.value; return () => value === this.value } }
export function toggleSelection(selected: Set<string>, names: string[], checked: boolean) { const next = new Set(selected); names.forEach(n => checked ? next.add(n) : next.delete(n)); return next }
export const selectedToolsAllowed = (s: Set<string>) => s.size > 0 && s.size <= 100
export async function materialize(load: (offset: number, limit: number) => Promise<CredentialPage>, valid: () => boolean, progress: (count: number) => void) {
  const names = new Set<string>(); let offset = 0
  while (valid()) { const page = await load(offset, 1000); if (!valid()) return null; page.items.forEach(r => names.add(r.filename)); progress(names.size); if (!page.hasMore) return names; if (!page.items.length) throw new Error('分页没有前进'); offset += 1000 }
  return null
}
