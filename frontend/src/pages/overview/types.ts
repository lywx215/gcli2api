export type Counts = { success: number | null; failure: number | null; total: number | null }
export type DailyStats = Counts & { date: string }
export type ModelStats = Counts & { name: string; rpm: number | null }
export type Observation<T> = { value: T | null; issue: string | null }
export type OverviewData = {
  today: Observation<DailyStats>
  recent: Observation<DailyStats[]>
  models: Observation<{ items: ModelStats[]; rpm: number | null }>
  credentials: Observation<{ total: number | null; normal: number | null; disabled: number | null }>
}
