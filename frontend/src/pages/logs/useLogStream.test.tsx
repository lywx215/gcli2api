import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLogStream } from './useLogStream'
const auth = vi.hoisted(() => ({ authenticated: true, token: 'synthetic-session' as string | null, sessionEpoch: 1 }))
vi.mock('@/auth', () => ({ useAuth: () => auth }))
class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
}
beforeEach(() => {
  FakeSocket.instances = []
  auth.authenticated = true; auth.token = 'synthetic-session'; auth.sessionEpoch = 1
  document.head.innerHTML = '<meta name="gcli-service-base" content="/prefix/">'
  vi.stubEnv('VITE_UI_FIXTURES', 'false'); vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => vi.useRealTimers())
it('opens one connection in StrictMode and clears stream on logout', () => {
  const { result, rerender, unmount } = renderHook(useLogStream, { wrapper: StrictMode })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket = FakeSocket.instances[0]
  act(() => socket.onmessage?.({ data: '[INFO] synthetic' } as MessageEvent))
  expect(result.current.lines).toHaveLength(1)
  const oldCallback = socket.onmessage
  auth.authenticated = false; auth.token = null; auth.sessionEpoch++
  rerender()
  expect(result.current.lines).toEqual([])
  expect(socket.close).toHaveBeenCalledTimes(1)
  act(() => oldCallback?.({ data: '[INFO] old event' } as MessageEvent))
  expect(result.current.lines).toEqual([])
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
it('closes the socket when navigating away and fixture preview opens none', () => {
  const first = renderHook(useLogStream)
  act(() => vi.advanceTimersByTime(0))
  first.unmount()
  expect(FakeSocket.instances[0].close).toHaveBeenCalledTimes(1)
  vi.stubEnv('VITE_UI_FIXTURES', 'true')
  const preview = renderHook(useLogStream)
  act(() => vi.runOnlyPendingTimers())
  expect(FakeSocket.instances).toHaveLength(1)
  expect(preview.result.current.lines[0].text).toContain('合成预览')
  preview.unmount()
})
