import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError, requestBlob, requestJson } from '@/api/client'
import { canRetryLogConnection, clearServerLogs, downloadLogs, logStreamUrl } from './api'
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), requestBlob: vi.fn(), requestJson: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('VITE_UI_FIXTURES', 'false')
  document.head.innerHTML = '<meta name="gcli-service-base" content="/prefix/">'
})
it('keeps the deployment prefix and encodes the existing query-token protocol', () => {
  const url = new URL(logStreamUrl('synthetic & value'))
  expect(url.pathname).toBe('/prefix/logs/stream')
  expect(url.protocol).toBe('ws:')
  expect(url.searchParams.get('token')).toBe('synthetic & value')
})
it('uses a protected read with a valid page size to detect rejected handshake auth', async () => {
  const signal = new AbortController().signal
  vi.mocked(requestJson).mockRejectedValue(new ApiError(403, { detail: 'Invalid authentication token' }))
  expect(await canRetryLogConnection(signal)).toBe(false)
  expect(requestJson).toHaveBeenCalledWith('creds/status', { query: { mode: 'antigravity', offset: 0, limit: 20 }, signal })
  vi.mocked(requestJson).mockRejectedValue(new Error('synthetic offline'))
  expect(await canRetryLogConnection(signal)).toBe(true)
})
it('uses blob transport and handles clear semantic failures without replay', async () => {
  const blob = new Blob(['synthetic logs'])
  vi.mocked(requestBlob).mockResolvedValue({ blob, response: new Response() })
  expect(await downloadLogs()).toBe(blob)
  expect(requestBlob).toHaveBeenCalledWith('logs/download')
  vi.mocked(requestJson).mockResolvedValue({ success: false, message: 'failed' })
  await expect(clearServerLogs()).rejects.toThrow('未确认')
  expect(requestJson).toHaveBeenCalledTimes(1)
  expect(requestJson).toHaveBeenCalledWith('logs/clear', { method: 'POST' })
})
