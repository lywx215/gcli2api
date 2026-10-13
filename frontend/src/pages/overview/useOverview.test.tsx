import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useOverview } from './useOverview'
import { loadOverview } from './api'
import { overviewFixture } from './fixtures'
const auth = vi.hoisted(() => ({ authenticated: true, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
vi.mock('./api', () => ({ loadOverview: vi.fn() }))
beforeEach(() => { auth.authenticated = true; auth.sessionEpoch = 1; vi.useFakeTimers(); vi.mocked(loadOverview).mockReset() })
afterEach(() => { vi.useRealTimers() })
it('drops an old response after a new login even when transport ignores abort', async () => {
  let oldResolve!: (value: typeof overviewFixture) => void
  vi.mocked(loadOverview).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve })).mockResolvedValueOnce(overviewFixture)
  const { result, rerender, unmount } = renderHook(useOverview)
  auth.sessionEpoch = 2
  rerender()
  await act(async () => {})
  expect(result.current.data?.today.value?.total).toBe(132)
  await act(async () => { oldResolve({ ...overviewFixture, today: { value: { date: 'old', total: 999, success: 999, failure: 0 }, issue: null } }) })
  expect(result.current.data?.today.value?.total).toBe(132)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('clears visible data on logout and cancels polling on unmount', async () => {
  vi.mocked(loadOverview).mockResolvedValue(overviewFixture)
  const { result, rerender, unmount } = renderHook(useOverview)
  await act(async () => {})
  auth.authenticated = false; auth.sessionEpoch++
  rerender()
  expect(result.current.data).toBeNull()
  unmount()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(loadOverview).toHaveBeenCalledTimes(1)
})
