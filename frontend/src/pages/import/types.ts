export type ItemStatus = 'success' | 'failed' | 'unknown'
export type ImportItem = { label: string; status: ItemStatus }
export type ImportResult = { outcome: 'success' | 'partial' | 'failed' | 'unknown'; items: ImportItem[]; warnings: number; jobId?: string }
export type ProjectPrompt = { manual: boolean; projects: string[] }
export type EmailState = 'queued' | 'running' | 'settlement_pending' | 'success' | 'failed' | 'skipped' | 'superseded' | 'unknown'
export type EmailItem = { filename: string; status: EmailState; email?: string }
export type EmailSnapshot = { items: EmailItem[]; complete: boolean }
export type TokenInput = { tokens: string[]; clientId: string; clientSecret: string; projectId: string; filename: string }
