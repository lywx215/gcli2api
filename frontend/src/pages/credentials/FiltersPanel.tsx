import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CAP, type Capabilities, type Filters } from './model'
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
export function FilterSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: [string, string][]; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="grid gap-1 text-sm">{label}<select className={selectClass} aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(([v, title]) => <option key={v} value={v}>{title}</option>)}</select></label>
}
export function FiltersPanel({ filters, caps, onApply }: { filters: Filters; caps: Capabilities; onApply: (next: Filters) => void }) {
  const [draft, setDraft] = useState(filters)
  useEffect(() => setDraft(filters), [filters])
  const update = (key: keyof Filters) => (value: string) => setDraft(d => ({ ...d, [key]: value }))
  return <form className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4" onSubmit={e => { e.preventDefault(); onApply(draft) }}>
    <label className="grid gap-1 text-sm sm:col-span-2">搜索文件名或已保存邮箱<Input aria-label="搜索文件名或已保存邮箱" value={draft.search} maxLength={255} disabled={!caps.has(CAP.search)} onChange={e => update('search')(e.target.value)} placeholder="搜索不会触发邮箱补全" /></label>
    <FilterSelect label="状态" value={draft.status} onChange={update('status')} options={[["all", "全部状态"], ["enabled", "启用"], ["disabled", "禁用"], ...(caps.has(CAP.permanent) ? [["permanent_disabled", "永久禁用"] as [string, string]] : [])]} />
    <FilterSelect label="订阅等级" value={draft.tier} onChange={update('tier')} options={[["all", "全部等级"], ["free", "Free"], ["pro", "Pro"], ["ultra", "Ultra"]]} />
    <FilterSelect label="错误分组" value={draft.error} onChange={update('error')} options={[["all", "全部错误"], ["none", "无错误"], ["403", "403 全部"], ["403_tos_violation", "403 封禁"], ["403_subscription_required", "403 赋权"], ["403_other", "403 其他"], ["429", "429"], ["401", "401"]]} />
    <FilterSelect label="额度组" value={draft.group} disabled={!caps.has(CAP.group)} onChange={update('group')} options={[["all", "全部额度"], ["any_restricted", "任意组受限"], ["all_unrestricted", "全部组未受限"], ["gemini_restricted", "Gemini 受限"], ["gemini_unrestricted", "Gemini 未受限"], ["claude_gpt_restricted", "Claude / GPT 受限"], ["claude_gpt_unrestricted", "Claude / GPT 未受限"]]} />
    <FilterSelect label="权限版本" value={draft.family} disabled={!caps.has(CAP.family)} onChange={update('family')} options={[["claude-opus-5-5", "Opus 5.5"], ["claude-opus-4-6", "Opus 4.6"]]} />
    <FilterSelect label="版本权限" value={draft.access} disabled={!caps.has(CAP.family)} onChange={update('access')} options={[["all", "全部权限"], ["supported", "目录支持"], ["unavailable", "暂不可用"], ["unknown", "待确认 / 已过期"]]} />
    <label className="grid gap-1 text-sm">备注筛选<Input aria-label="备注筛选" disabled={!caps.has(CAP.remark)} maxLength={64} value={draft.remark === '__all__' ? '' : draft.remark} onChange={e => update('remark')(e.target.value || '__all__')} placeholder="全部备注" /></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!caps.has(CAP.remark)} checked={draft.remark === ''} onChange={e => update('remark')(e.target.checked ? '' : '__all__')} />仅无备注</label>
    <div className="flex items-end"><Button type="submit">应用筛选</Button></div>
    <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-4">灰色选项表示服务未声明能力。筛选变化会取消进行中的集合读取并清除选择。</p>
  </form>
}
