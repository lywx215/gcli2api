import type { PanelMode, PanelScope } from '@/domain/panel'

export type ItemStatus = 'success' | 'failed' | 'unknown'

export type ItemReceipt = {
  project_id?: string
  subscription_tier?: string
  tier_raw_id?: string
  tier_raw_name?: string
  tier_detected_at?: number
  tier_detection_status?: string
}

export type ImportItemReceipt = ItemReceipt

export type ImportItem = {
  label: string
  status: ItemStatus
  receipt?: ItemReceipt
}

export type OAuthReceipt = {
  success: true
  mode: PanelMode
  filename: string
  project_id: string | null
  subscription_tier: string | null
  auto_detected_project: boolean
  tier_raw_id?: string | null
  tier_raw_name?: string | null
  tier_detected_at?: number | null
  tier_detection_status?: string | null
}

export type ImportResult = {
  outcome: 'success' | 'partial' | 'failed' | 'unknown'
  items: ImportItem[]
  warnings: number
  jobId?: string
  oauthReceipt?: OAuthReceipt
  confirmedFilenames?: string[]
}

export type ProjectOption = { projectId: string; name: string | null }
export type ProjectPrompt = {
  manual: boolean
  projects: string[]
  projectOptions?: ProjectOption[]
}
export type EmailState = 'queued' | 'running' | 'settlement_pending' | 'success' | 'failed' | 'skipped' | 'superseded' | 'unknown'
export type EmailItem = { filename: string; status: EmailState; email?: string }
export type EmailSnapshot = { items: EmailItem[]; complete: boolean }
export type EmailJobObservation = {
  jobId: string
  status: 'observed' | 'expired' | 'unavailable'
  snapshot: EmailSnapshot | null
}
export type TokenInput = { tokens: string[]; clientId: string; clientSecret: string; projectId: string; filename: string }

export type ImportRequestContext = {
  mode: PanelMode
  scope: PanelScope
  oauthCapabilities?: ReadonlySet<string> | readonly string[]
}

export type ImportApi = {
  uploadFiles: (files: File[], signal?: AbortSignal) => Promise<ImportResult>
  importTokens: (input: TokenInput, signal?: AbortSignal) => Promise<ImportResult>
  startOAuth: (projectId: string, signal?: AbortSignal) => Promise<string>
  completeOAuth: (callbackUrl: string | null, projectId: string, signal?: AbortSignal) => Promise<ImportResult>
  readEmailJob: (jobId: string, signal?: AbortSignal) => Promise<EmailSnapshot>
}
