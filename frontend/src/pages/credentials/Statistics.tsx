import type { PanelMode } from '@/domain/panel'
import { count, object, CAP_BY_MODE, type CredentialPage } from './model'

const number = (v: unknown) => count(v) ?? '不可用'

export function Statistics({ page, mode = 'antigravity' }: { page: CredentialPage; mode?: PanelMode }) {
  const isAg = mode === 'antigravity'
  const family = object(page.familySummary.family_counts)
  const permCap = CAP_BY_MODE[mode].permanent
  const permValue = page.caps.has(permCap) ? page.stats.permanent_disabled : null

  const cards: [string, unknown][] = [
    ['全局凭证', page.stats.total],
    ['全局启用', page.stats.normal],
    ['全局禁用', page.stats.disabled],
    ['全局永久禁用', permValue],
    ['筛选后匹配', page.total],
    ['冷却中', page.stats.in_cooldown],
    ['无冷却', page.stats.no_cooldown],
  ]

  if (isAg) {
    cards.push(
      ['额度受限', page.stats.quota_restricted],
      ['额度未受限', page.stats.quota_unrestricted],
      ['未知拦截', page.stats.quota_blocked_unknown],
      ['状态异常', page.stats.quota_state_invalid],
    )
  }

  return (
    <section aria-label="凭证统计" className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {cards.map(([label, value]) => (
          <div className="rounded-xl border bg-card p-4 text-card-foreground" key={label}>
            <p className="text-[13px] text-muted-foreground">{label}</p>
            <p className="mt-1 text-[24px] font-semibold tabular-nums">{number(value)}</p>
          </div>
        ))}
      </div>
      {isAg && (
        <div className="rounded-xl border bg-card p-3 text-[13px] text-muted-foreground">
          权限汇总：基础筛选后 {number(page.familySummary.total)} 项（跨全部分页，尚未应用版本权限筛选）。
          {['claude-opus-5-5', 'claude-opus-4-6'].map(name => (
            <p key={name}>
              {name}：目录支持 {number(object(family[name]).supported)} / 暂不可用 {number(object(family[name]).unavailable)} / 待确认 {number(object(family[name]).unknown)}
            </p>
          ))}
          目录支持不代表剩余额度或已验证生成。
        </div>
      )}
    </section>
  )
}
