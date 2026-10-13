import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import LogsPage from './index'
import { clearServerLogs, downloadLogs, saveLogBlob } from './api'
const auth = vi.hoisted(() => ({ authenticated: true, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
vi.mock('./useLogStream', () => ({ useLogStream: () => ({ lines: [{ id: 0, level: 'INFO', text: '[INFO] <script>synthetic</script>' }, { id: 1, level: 'ERROR', text: '[ERROR] synthetic failure' }], state: 'connected', reconnect: vi.fn(), clearLocal: vi.fn() }) }))
vi.mock('./api', () => ({ clearServerLogs: vi.fn(), downloadLogs: vi.fn(), saveLogBlob: vi.fn() }))
beforeEach(() => { vi.clearAllMocks(); auth.authenticated = true; auth.sessionEpoch = 1; vi.stubEnv('VITE_UI_FIXTURES', 'false') })
it('renders plain text safely and filters locally without a request', () => {
  render(<LogsPage />)
  expect(screen.getByText('[INFO] <script>synthetic</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ERROR' } })
  expect(screen.queryByText('[INFO] <script>synthetic</script>')).toBeNull()
  expect(clearServerLogs).not.toHaveBeenCalled()
  expect(downloadLogs).not.toHaveBeenCalled()
})
it('requires explicit clear confirmation and preserves unknown-result feedback', async () => {
  vi.mocked(clearServerLogs).mockRejectedValue(new Error('synthetic disconnect'))
  render(<LogsPage />)
  fireEvent.click(screen.getByRole('button', { name: '清空服务器日志' }))
  expect(clearServerLogs).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认清空' }))
  await screen.findByText('清空结果未知，请观察当前日志；不会自动重试。')
  expect(clearServerLogs).toHaveBeenCalledTimes(1)
})
it('does not start a late download after logout', async () => {
  let resolve!: (blob: Blob) => void
  vi.mocked(downloadLogs).mockReturnValue(new Promise(done => { resolve = done }))
  const { rerender } = render(<LogsPage />)
  fireEvent.click(screen.getByRole('button', { name: '下载服务器日志' }))
  auth.authenticated = false; auth.sessionEpoch++
  rerender(<LogsPage />)
  resolve(new Blob(['synthetic']))
  await waitFor(() => expect(screen.getByRole('button', { name: '下载服务器日志' })).toBeDisabled())
  expect(saveLogBlob).not.toHaveBeenCalled()
})
