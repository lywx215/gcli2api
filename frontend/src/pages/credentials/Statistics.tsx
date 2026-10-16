import { useState } from 'react'
import type { PanelMode } from '@/domain/panel'
import { count, object, CAP_BY_MODE, type CredentialPage } from './model'
import { Button } from '@/components/ui/button'

const number = (v: unknown) => count(v) ?? '不可用'

export function Statistics({ page, mode = 'antigravity' }: { page: CredentialPage; mode?: PanelMode }) {
  const [expanded, setExpanded] = useState(false)
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
    <section aria-label="凭证统计" className="rounded-lg border bg-card p-2 text-card-foreground shadow-sm">
      {/* 紧凑单行状态胶囊条 (KPI Ribbon) */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span>总凭证: <strong className="font-semibold tabular-nums text-foreground">{number(page.stats.total)}</strong></span>
          <span>启用: <strong className="font-semibold tabular-nums text-success">{number(page.stats.normal)}</strong></span>
          <span>禁用: <strong className="font-semibold tabular-nums text-muted-foreground">{number(page.stats.disabled)}</strong></span>
          <span>冷却中: <strong className="font-semibold tabular-nums text-warning">{number(page.stats.in_cooldown)}</strong></span>
          {isAg && (
            <span>额度受限: <strong className="font-semibold tabular-nums text-warning">{number(page.stats.quota_restricted)}</strong></span>
          )}
          <span>匹配: <strong className="font-semibold tabular-nums text-foreground">{number(page.total)}</strong></span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls="credentials-statistics-detail"
          onClick={() => setExpanded(curr => !curr)}
          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? '收起详细指标 ▲' : `全部指标 (${cards.length}项) ▼`}
        </Button>
      </div>

      {/* 展开全部11项指标卡片与权限汇总 */}
      {expanded && (
        <div id="credentials-statistics-detail" className="mt-2 space-y-2 border-t pt-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {cards.map(([label, value]) => (
              <div className="rounded-md border bg-secondary/30 p-2 text-card-foreground" key={label}>
                <p className="truncate text-[11px] text-muted-foreground" title={label}>{label}</p>
                <p className="mt-0.5 text-base font-semibold tabular-nums">{number(value)}</p>
              </div>
            ))}
          </div>
          {isAg && (
            <div className="rounded-md border bg-secondary/20 p-2.5 text-xs text-muted-foreground leading-relaxed">
              权限汇总：基础筛选后 {number(page.familySummary.total)} 项（跨全部分页，尚未应用版本权限筛选）。
              {['claude-opus-5-5', 'claude-opus-4-6'].map(name => (
                <p key={name}>
                  {name}：目录支持 {number(object(family[name]).supported)} / 暂不可用 {number(object(family[name]).unavailable)} / 待确认 {number(object(family[name]).unknown)}
                </p>
              ))}
              目录支持不代表剩余额度或已验证生成。
            </div>
          )}
        </div>
      )}
    </section>
  )
}
