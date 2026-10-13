import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { OverviewData } from './types'

export const displayCount = (value: number | null | undefined) => value == null ? '不可用' : value.toLocaleString('zh-CN')
const cell = 'px-3 py-2 text-right tabular-nums'
export function StatisticsTables({ data }: { data: OverviewData | null }) {
  return <div className="grid gap-4 xl:grid-cols-2">
    <Card className="min-w-0"><CardHeader><CardTitle>模型家族 · 今日</CardTitle></CardHeader><CardContent>
      {data?.models.issue ? <p role="status" className="text-muted-foreground">{data.models.issue}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">北京时间今日逻辑请求，按后端模型家族分组</caption><thead><tr><th className="text-left">模型家族</th>{['成功', '失败', '总计', 'RPM'].map(label => <th className={cell} key={label}>{label}</th>)}</tr></thead><tbody>
        {data?.models.value?.items.map(row => <tr className="border-t" key={row.name}><th className="max-w-48 break-words py-2 text-left font-normal">{row.name}</th>{[row.success, row.failure, row.total, row.rpm].map((value, index) => <td className={cell} key={index}>{displayCount(value)}</td>)}</tr>)}
      </tbody></table>{data?.models.value?.items.length === 0 && <p className="py-4 text-muted-foreground">后端未返回模型记录。</p>}</div>}
    </CardContent></Card>
    <Card className="min-w-0"><CardHeader><CardTitle>近期每日请求</CardTitle></CardHeader><CardContent>
      {data?.recent.issue ? <p role="status" className="text-muted-foreground">{data.recent.issue}</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">后端返回的最近七天记录，不为缺失日期补零</caption><thead><tr><th className="text-left">日期（北京时间）</th>{['成功', '失败', '总计'].map(label => <th className={cell} key={label}>{label}</th>)}</tr></thead><tbody>{data?.recent.value?.map((row, index) => <tr className="border-t" key={`${row.date}-${index}`}><th className="py-2 text-left font-normal">{row.date || '未知'}</th>{[row.success, row.failure, row.total].map((value, column) => <td className={cell} key={column}>{displayCount(value)}</td>)}</tr>)}</tbody></table>{data?.recent.value?.length === 0 && <p className="py-4 text-muted-foreground">暂无记录；缺失日期不代表零次请求。</p>}</div>}
    </CardContent></Card>
  </div>
}
