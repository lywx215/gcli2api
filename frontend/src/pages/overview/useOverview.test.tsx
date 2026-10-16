import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/auth'
import { setSessionToken } from '@/auth/session'
import { __commitPanelChannel } from '@/domain/panel'
import { useOverview } from './useOverview'
import { loadOverview } from './api'
import { loadNodeInfo, type NodeOverviewData } from './nodeInfo'
import { overviewFixture } from './fixtures'

vi.mock('./api', () => ({ loadOverview: vi.fn() }))
vi.mock('./nodeInfo', () => ({ loadNodeInfo: vi.fn() }))

const syntheticNodeInfo: NodeOverviewData = {
  version: { value: null, issue: null },
  codeAssistEndpoint: { value: null, issue: null },
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
)

beforeEach(() => {
  vi.useFakeTimers()
  __commitPanelChannel('antigravity')
  setSessionToken('session-token-1')
  vi.mocked(loadOverview).mockReset()
  vi.mocked(loadNodeInfo).mockReset()
  vi.mocked(loadNodeInfo).mockResolvedValue(syntheticNodeInfo)
})

afterEach(() => {
  vi.useRealTimers()
})

it('drops an old response after a new login even when transport ignores abort', async () => {
  let oldResolve!: (value: typeof overviewFixture) => void
  vi.mocked(loadOverview)
    .mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve }))
    .mockResolvedValueOnce(overviewFixture)

  const { result, unmount } = renderHook(() => useOverview('antigravity'), { wrapper })
  act(() => {
    setSessionToken('session-token-2')
  })
  await act(async () => {})
  expect(result.current.data?.today.value?.total).toBe(132)
  await act(async () => {
    oldResolve({
      ...overviewFixture,
      today: { value: { date: 'old', total: 999, success: 999, failure: 0 }, issue: null },
    })
  })
  expect(result.current.data?.today.value?.total).toBe(132)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('clears visible data on logout and cancels polling on unmount', async () => {
  vi.mocked(loadOverview).mockResolvedValue(overviewFixture)
  const { result, unmount } = renderHook(() => useOverview('antigravity'), { wrapper })
  await act(async () => {})
  expect(result.current.data?.today.value?.total).toBe(132)
  act(() => {
    setSessionToken(null)
  })
  expect(result.current.data).toBeNull()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(loadOverview).toHaveBeenCalledTimes(1)
})

