import { useEffect, useRef, useState } from 'react'
import type { PanelMode } from '@/domain/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CAP_BY_MODE, initialFilters, type Capabilities, type Filters } from './model'

const selectClass = 'h-9 w-full rounded-md border border-input bg-popover px-3 text-base leading-5 md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground disabled:border-border disabled:cursor-not-allowed'

const AG_TIER_OPTIONS: [string, string][] = [
  ['all', '全部等级'],
  ['free', 'Free'],
  ['pro', 'Pro'],
  ['ultra', 'Ultra'],
]

const GCLI_TIER_OPTIONS: [string, string][] = [
  ['all', '全部'],
  ['code_assist_standard', 'Code Assist Standard'],
  ['code_assist_enterprise', 'Code Assist Enterprise'],
  ['free', 'Free'],
  ['pro', 'Pro'],
  ['ultra', 'Ultra'],
  ['unknown', 'Unknown'],
]

const GCLI_PREVIEW_OPTIONS: [string, string][] = [
  ['all', '全部'],
  ['preview', '支持'],
  ['no_preview', '不支持'],
]

const GCLI_COOLDOWN_OPTIONS: [string, string][] = [
  ['all', '全部'],
  ['in_cooldown', 'CD中'],
  ['pro_no_cooldown', 'Pro系列未冷却'],
  ['flash_no_cooldown', 'Flash系列未冷却'],
  ['no_cooldown', '未CD'],
]

const AG_TIERS = new Set(['all', 'free', 'pro', 'ultra'])
const GCLI_TIERS = new Set(['all', 'code_assist_standard', 'code_assist_enterprise', 'free', 'pro', 'ultra', 'unknown'])
const GCLI_PREVIEW_VALUES = new Set(['all', 'preview', 'no_preview'])
const GCLI_COOLDOWN_VALUES = new Set(['all', 'in_cooldown', 'pro_no_cooldown', 'flash_no_cooldown', 'no_cooldown'])

export function normalizeFilters(f: Filters, mode: PanelMode = 'antigravity', caps: Capabilities): Filters {
  const isGcli = mode === 'geminicli'
  const cap = CAP_BY_MODE[mode]

  const search = caps.has(cap.search) ? (f.search || '') : ''
  const status = (!caps.has(cap.permanent) && f.status === 'permanent_disabled') ? 'all' : (f.status || 'all')
  const error = f.error || 'all'
  const remark = caps.has(cap.remark) ? (f.remark ?? '__all__') : '__all__'

  if (isGcli) {
    const tier = GCLI_TIERS.has(f.tier) ? f.tier : 'all'
    const preview = GCLI_PREVIEW_VALUES.has(f.preview || '') ? (f.preview as string) : 'all'
    const cooldown = GCLI_COOLDOWN_VALUES.has(f.cooldown || '') ? (f.cooldown as string) : 'all'

    return {
      search,
      status,
      error,
      tier,
      group: initialFilters.group,
      family: initialFilters.family,
      access: initialFilters.access,
      remark,
      preview,
      cooldown,
    }
  }

  const agCap = CAP_BY_MODE.antigravity
  const tier = AG_TIERS.has(f.tier) ? f.tier : 'all'
  const group = caps.has(agCap.group) ? (f.group || 'all') : 'all'
  const family = caps.has(agCap.family) ? (f.family || initialFilters.family) : initialFilters.family
  const access = caps.has(agCap.family) ? (f.access || 'all') : 'all'

  return {
    search,
    status,
    error,
    tier,
    group,
    family,
    access,
    remark,
  }
}

export function FilterSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: [string, string][]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm font-medium">{label}<select className={selectClass} aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(([v, title]) => <option key={v} value={v}>{title}</option>)}</select></label>
}

export function FiltersPanel({ filters, caps, mode = 'antigravity', onApply }: { filters: Filters; caps: Capabilities; mode?: PanelMode; onApply: (next: Filters) => void }) {
  const [draft, setDraft] = useState<Filters>(() => normalizeFilters(filters, mode, caps))
  const prevFiltersRef = useRef(filters)
  const prevModeRef = useRef(mode)

  useEffect(() => {
    const filtersChanged = prevFiltersRef.current !== filters
    const modeChanged = prevModeRef.current !== mode
    prevFiltersRef.current = filters
    prevModeRef.current = mode

    setDraft(currentDraft => {
      const source = (filtersChanged || modeChanged) ? filters : currentDraft
      return normalizeFilters(source, mode, caps)
    })
  }, [filters, mode, caps])

  const isGcli = mode === 'geminicli'
  const cap = CAP_BY_MODE[mode]
  const update = (key: keyof Filters) => (value: string) => setDraft(d => ({ ...d, [key]: value }))

  return <form className="grid gap-3 rounded-xl border bg-card p-4 text-card-foreground sm:grid-cols-2 xl:grid-cols-4" onSubmit={e => { e.preventDefault(); const next = normalizeFilters(draft, mode, caps); setDraft(next); onApply(next) }}>
    <label className="grid gap-1 text-sm font-medium sm:col-span-2">搜索文件名或已保存邮箱<Input aria-label="搜索文件名或已保存邮箱" value={draft.search} maxLength={255} disabled={!caps.has(cap.search)} onChange={e => update('search')(e.target.value)} placeholder="搜索不会触发邮箱补全" /></label>
    <FilterSelect label="状态" value={draft.status} onChange={update('status')} options={[["all", "全部状态"], ["enabled", "启用"], ["disabled", "禁用"], ...(caps.has(cap.permanent) ? [["permanent_disabled", "永久禁用"] as [string, string]] : [])]} />
    <FilterSelect label="订阅等级" value={draft.tier} onChange={update('tier')} options={isGcli ? GCLI_TIER_OPTIONS : AG_TIER_OPTIONS} />
    <FilterSelect label="错误分组" value={draft.error} onChange={update('error')} options={[["all", "全部错误"], ["none", "无错误"], ["403", "403 全部"], ["403_tos_violation", "403 封禁"], ["403_subscription_required", "403 赋权"], ["403_other", "403 其他"], ["429", "429"], ["401", "401"], ["400", "400"], ["500", "500"]]} />
    {isGcli ? (
      <>
        <FilterSelect label="Preview" value={draft.preview || 'all'} onChange={update('preview')} options={GCLI_PREVIEW_OPTIONS} />
        <FilterSelect label="CD" value={draft.cooldown || 'all'} onChange={update('cooldown')} options={GCLI_COOLDOWN_OPTIONS} />
      </>
    ) : (
      <>
        <FilterSelect label="额度组" value={draft.group} disabled={!caps.has(CAP_BY_MODE.antigravity.group)} onChange={update('group')} options={[["all", "全部额度"], ["any_restricted", "任意组受限"], ["all_unrestricted", "全部组未受限"], ["gemini_restricted", "Gemini 受限"], ["gemini_unrestricted", "Gemini 未受限"], ["claude_gpt_restricted", "Claude / GPT 受限"], ["claude_gpt_unrestricted", "Claude / GPT 未受限"]]} />
        <FilterSelect label="权限版本" value={draft.family} disabled={!caps.has(CAP_BY_MODE.antigravity.family)} onChange={update('family')} options={[["claude-opus-5-5", "Opus 5.5"], ["claude-opus-4-6", "Opus 4.6"]]} />
        <FilterSelect label="版本权限" value={draft.access} disabled={!caps.has(CAP_BY_MODE.antigravity.family)} onChange={update('access')} options={[["all", "全部权限"], ["supported", "目录支持"], ["unavailable", "暂不可用"], ["unknown", "待确认 / 已过期"]]} />
      </>
    )}
    <label className="grid gap-1 text-sm font-medium">备注筛选<Input aria-label="备注筛选" disabled={!caps.has(cap.remark)} maxLength={64} value={draft.remark === '__all__' ? '' : draft.remark} onChange={e => update('remark')(e.target.value || '__all__')} placeholder="全部备注" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" disabled={!caps.has(cap.remark)} checked={draft.remark === ''} onChange={e => update('remark')(e.target.checked ? '' : '__all__')} />仅无备注</label>
    <div className="flex items-end"><Button type="submit">应用筛选</Button></div>
    <p className="text-[13px] text-muted-foreground sm:col-span-2 xl:col-span-4">灰色选项表示服务未声明能力。筛选变化会取消进行中的集合读取并清除选择。</p>
  </form>
}
