import type { PanelMode, PanelScope } from '@/domain/panel'

export type Counts = { success: number | null; failure: number | null; total: number | null }
export type DailyStats = Counts & { date: string }
export type ModelStats = Counts & { name: string; rpm: number | null }
export type Observation<T> = { value: T | null; issue: string | null }

export type CredentialStats = {
  total: number | null
  normal: number | null
  disabled: number | null
  permanent_disabled?: number | null
  in_cooldown?: number | null
  no_cooldown?: number | null
  quota_restricted?: number | null
  quota_unrestricted?: number | null
  quota_blocked_unknown?: number | null
  quota_state_invalid?: number | null
  quota_next_expiry?: number | null
}

export type OverviewData = {
  today: Observation<DailyStats>
  recent: Observation<DailyStats[]>
  models: Observation<{ items: ModelStats[]; rpm: number | null }>
  credentials: Observation<CredentialStats>
}

export type LoadOverviewOptions = {
  mode?: PanelMode
  scope?: PanelScope
}
