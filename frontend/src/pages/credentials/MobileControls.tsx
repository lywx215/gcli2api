import { Button } from '@/components/ui/button'
export type MobilePanel = 'statistics' | 'filters' | 'bulk'
export type MobilePanels = Record<MobilePanel, boolean>
export const mobilePanelIds: Record<MobilePanel, string> = {
  statistics: 'credentials-statistics-panel',
  filters: 'credentials-filters-panel',
  bulk: 'credentials-bulk-panel',
}
export function MobileControls({ total, selected, panels, toggle }: {
  total: number | undefined
  selected: number
  panels: MobilePanels
  toggle: (panel: MobilePanel) => void
}) {
  return (
    <section className="space-y-2 rounded-xl border bg-card p-3 text-card-foreground md:hidden" aria-label="移动凭证工具">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span>当前匹配 <strong className="font-semibold tabular-nums text-foreground">{total ?? '未知'}</strong> 项</span>
        <span>已选 <strong className="font-semibold tabular-nums text-foreground">{selected}</strong> 项</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {([
          ['statistics', '统计与权限'],
          ['filters', '筛选条件'],
          ['bulk', '批量操作'],
        ] as const).map(([panel, label]) => (
          <Button
            key={panel}
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={panels[panel]}
            aria-controls={mobilePanelIds[panel]}
            onClick={() => toggle(panel)}
          >
            {label}
          </Button>
        ))}
      </div>
    </section>
  )
}
