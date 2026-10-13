import { ApiError, createServiceUrl, requestBlob, requestJson } from '@/api/client'

export function logStreamUrl(token: string): string {
  const url = createServiceUrl('logs/stream', { token })
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
export async function clearServerLogs(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return
  const raw = await requestJson<unknown>('logs/clear', { method: 'POST' })
  if (!raw || typeof raw !== 'object' || ('success' in raw && raw.success === false) || !('message' in raw) || typeof raw.message !== 'string') throw new Error('清空结果未确认，请检查当前日志。')
}
export async function downloadLogs(): Promise<Blob> {
  if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') return new Blob(['[INFO] Synthetic preview only\n'], { type: 'text/plain' })
  const { blob } = await requestBlob('logs/download')
  return blob
}
// WS handshake failures are opaque in browsers. A protected, read-only panel
// endpoint gives the shared client a chance to identify actual panel auth loss.
export async function canRetryLogConnection(signal: AbortSignal): Promise<boolean> {
  try { await requestJson('creds/status', { query: { mode: 'antigravity', offset: 0, limit: 20 }, signal }); return true }
  catch (error) {
    if (signal.aborted) return false
    return !(error instanceof ApiError && [401, 403].includes(error.status))
  }
}
export function saveLogBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'gcli2api-logs.txt'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
