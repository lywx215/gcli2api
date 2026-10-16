import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getOverviewSuccessRate } from './nodeInfo'
import type { Counts, DailyStats, OverviewData } from './types'

export const displayCount = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '不可用' : value.toLocaleString('zh-CN')

export const displayRate = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '不可用' : `${value.toFixed(1)}%`

const thCell = 'h-7 sm:h-[30px] px-2 sm:px-2.5 py-0 text-right text-xs font-medium text-muted-foreground tabular-nums align-middle'
const tdCell = 'h-[30px] sm:h-[32px] px-2 sm:px-2.5 py-0 text-right text-xs tabular-nums align-middle'

export type RecentSummary = Counts & {
  rowCount: number
}

export function computeRecentSummary(rows: DailyStats[] | null | undefined): RecentSummary {
  if (!rows || rows.length === 0) {
    return { success: null, failure: null, total: null, rowCount: 0 }
  }
  const hasIncompleteSuccess = rows.some(r => typeof r.success !== 'number' || !Number.isFinite(r.success))
  const hasIncompleteFailure = rows.some(r => typeof r.failure !== 'number' || !Number.isFinite(r.failure))
  const hasIncompleteTotal = rows.some(r => typeof r.total !== 'number' || !Number.isFinite(r.total))

  return {
    success: hasIncompleteSuccess ? null : rows.reduce((acc, r) => acc + (r.success as number), 0),
    failure: hasIncompleteFailure ? null : rows.reduce((acc, r) => acc + (r.failure as number), 0),
    total: hasIncompleteTotal ? null : rows.reduce((acc, r) => acc + (r.total as number), 0),
    rowCount: rows.length,
  }
}

export function StatisticsTables({ data }: { data: OverviewData | null }) {
  const recentRows = data?.recent.value
  const recentSummary = computeRecentSummary(recentRows)

  return (
    <div className="grid gap-2.5 xl:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader className="p-2.5 pb-1 sm:p-3 sm:pb-1.5">
          <CardTitle className="text-sm font-semibold">模型家族 · 今日</CardTitle>
        </CardHeader>
        <CardContent className="p-2.5 pt-0 sm:p-3 sm:pt-0">
          {data?.models.issue ? (
            <p role="status" className="text-xs text-destructive">{data.models.issue}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg bg-background ring-1 ring-border">
              <table className="w-full text-xs">
                <caption className="sr-only">北京时间今日逻辑请求，按后端模型家族分组</caption>
                <thead>
                  <tr className="h-7 sm:h-[30px] bg-secondary/60">
                    <th className="h-7 sm:h-[30px] px-2 sm:px-2.5 py-0 text-left text-xs font-medium text-muted-foreground align-middle">模型家族</th>
                    {['成功', '失败', '总计', '成功率', 'RPM'].map(label => (
                      <th className={thCell} key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.models.value?.items.map(row => {
                    const rate = getOverviewSuccessRate(row)
                    return (
                      <tr className="h-[30px] sm:h-[32px] border-t border-border hover:bg-secondary/40 transition-colors" key={row.name}>
                        <th className="h-[30px] sm:h-[32px] max-w-48 truncate px-2 sm:px-2.5 py-0 text-left text-xs font-normal align-middle" title={row.name}>{row.name}</th>
                        <td className={`${tdCell} ${row.success == null ? 'text-muted-foreground' : 'text-success'}`}>{displayCount(row.success)}</td>
                        <td className={`${tdCell} ${row.failure == null ? 'text-muted-foreground' : 'text-destructive'}`}>{displayCount(row.failure)}</td>
                        <td className={`${tdCell} ${row.total == null ? 'text-muted-foreground' : 'text-foreground'}`}>{displayCount(row.total)}</td>
                        <td className={`${tdCell} ${rate == null ? 'text-muted-foreground' : 'text-foreground'}`}>{displayRate(rate)}</td>
                        <td className={`${tdCell} ${row.rpm == null ? 'text-muted-foreground' : 'text-foreground'}`}>{displayCount(row.rpm)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {data?.models.value?.items.length === 0 && (
                <p className="py-2.5 px-3 text-xs text-muted-foreground">后端未返回模型记录。</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader className="p-2.5 pb-1 sm:p-3 sm:pb-1.5">
          <CardTitle className="text-sm font-semibold">近期每日请求</CardTitle>
        </CardHeader>
        <CardContent className="p-2.5 pt-0 sm:p-3 sm:pt-0">
          {data?.recent.issue ? (
            <p role="status" className="text-xs text-destructive">{data.recent.issue}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg bg-background ring-1 ring-border">
              <table className="w-full text-xs">
                <caption className="sr-only">后端返回的最近七天记录，不为缺失日期补零</caption>
                <thead>
                  <tr className="h-7 sm:h-[30px] bg-secondary/60">
                    <th className="h-7 sm:h-[30px] px-2 sm:px-2.5 py-0 text-left text-xs font-medium text-muted-foreground align-middle">日期（北京时间）</th>
                    {['成功', '失败', '总计'].map(label => (
                      <th className={thCell} key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentRows?.map((row, index) => (
                    <tr className="h-[30px] sm:h-[32px] border-t border-border hover:bg-secondary/40 transition-colors" key={`${row.date}-${index}`}>
                      <th className="h-[30px] sm:h-[32px] px-2 sm:px-2.5 py-0 text-left text-xs font-normal align-middle">{row.date || '未知'}</th>
                      <td className={`${tdCell} ${row.success == null ? 'text-muted-foreground' : 'text-success'}`}>{displayCount(row.success)}</td>
                      <td className={`${tdCell} ${row.failure == null ? 'text-muted-foreground' : 'text-destructive'}`}>{displayCount(row.failure)}</td>
                      <td className={`${tdCell} ${row.total == null ? 'text-muted-foreground' : 'text-foreground'}`}>{displayCount(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
                {recentRows && recentRows.length > 0 && (
                  <tfoot>
                    <tr className="h-[30px] sm:h-[32px] border-t-2 border-border font-medium bg-secondary/30">
                      <th className="h-[30px] sm:h-[32px] px-2 sm:px-2.5 py-0 text-left text-xs font-medium align-middle">已返回 {recentSummary.rowCount} 天合计</th>
                      <td className={`${tdCell} ${recentSummary.success == null ? 'text-muted-foreground' : 'text-success'}`}>
                        {displayCount(recentSummary.success)}
                      </td>
                      <td className={`${tdCell} ${recentSummary.failure == null ? 'text-muted-foreground' : 'text-destructive'}`}>
                        {displayCount(recentSummary.failure)}
                      </td>
                      <td className={`${tdCell} ${recentSummary.total == null ? 'text-muted-foreground' : 'text-foreground'}`}>
                        {displayCount(recentSummary.total)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
              {recentRows && recentRows.length > 0 && (
                <p className="p-2.5 text-xs text-muted-foreground">
                  汇总仅计算后端实际返回的 {recentSummary.rowCount} 条记录；缺失日期不补零，不代表完整自然周原子总计。
                </p>
              )}
              {recentRows?.length === 0 && (
                <p className="py-2.5 px-3 text-xs text-muted-foreground">暂无记录；缺失日期不代表零次请求。</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
