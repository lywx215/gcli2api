import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatisticsTables, displayCount } from './StatisticsTables'
import { useOverview } from './useOverview'

export default function OverviewPage() {
  const { data, loading, refresh } = useOverview()
  const metrics = [
    ['今日逻辑请求', data?.today.value?.total], ['成功', data?.today.value?.success],
    ['失败', data?.today.value?.failure], ['当前 RPM', data?.models.value?.rpm],
  ] as const
  return <section className="space-y-6 text-sm text-foreground" aria-label="Antigravity 概览" aria-busy={loading}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold text-foreground">概览</h1><p className="text-[13px] text-muted-foreground">Antigravity · logical requests · 每日按北京时间结算{data?.today.value?.date ? ` · ${data.today.value.date}` : ''}</p></div><Button variant="outline" onClick={refresh} disabled={loading}>刷新统计</Button></header>
    {import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true' && <p className="rounded-xl border border-border bg-info-bg p-3 text-[13px] text-info">合成预览数据，未读取后端。</p>}
    {loading && !data && <p role="status" className="text-muted-foreground">正在读取统计…</p>}
    {data?.today.issue && <p role="status" className="rounded-xl border border-border bg-info-bg p-3 text-info">{data.today.issue}</p>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{metrics.map(([label, value], index) => <Card key={label}><CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className={`text-3xl font-semibold tabular-nums ${value == null ? 'text-muted-foreground' : index === 1 ? 'text-success' : index === 2 ? 'text-destructive' : 'text-foreground'}`}>{displayCount(value)}</CardContent></Card>)}</div>
    <Card><CardHeader><CardTitle>凭证摘要</CardTitle></CardHeader><CardContent>{data?.credentials.issue ? <p className="text-muted-foreground">{data.credentials.issue}</p> : <dl className="flex flex-wrap gap-8">{([['全部', data?.credentials.value?.total], ['正常', data?.credentials.value?.normal], ['禁用', data?.credentials.value?.disabled]] as const).map(([label, value]) => <div key={label}><dt className="text-[13px] text-muted-foreground">{label}</dt><dd className="text-xl font-semibold tabular-nums">{displayCount(value)}</dd></div>)}</dl>}<p className="mt-3 text-[13px] text-muted-foreground">状态由后端摘要提供；正常状态不代表额度或模型权限已验证。</p></CardContent></Card>
    <StatisticsTables data={data} />
    <p className="text-[13px] text-muted-foreground">可见页面每 30 秒刷新。统计请求分别读取，不保证同一时刻快照；不支持或缺失的数据标记为不可用。</p>
  </section>
}
