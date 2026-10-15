import { StrictMode, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/auth'
import { getSessionSnapshot, setSessionToken } from '@/auth/session'
import { useLogStream } from './useLogStream'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
}

const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}</AuthProvider>
const strictModeWrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <AuthProvider>{children}</AuthProvider>
  </StrictMode>
)

beforeEach(() => {
  FakeSocket.instances = []
  window.localStorage.clear()
  setSessionToken('synthetic-session')
  document.head.innerHTML = '<meta name="gcli-service-base" content="/prefix/">'
  vi.stubEnv('VITE_UI_FIXTURES', 'false')
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('failfast synthetic fetch')))
})

afterEach(() => {
  act(() => setSessionToken(null))
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  window.localStorage.clear()
  document.head.innerHTML = ''
})

it('opens one connection in StrictMode and clears stream on logout', () => {
  const { result, rerender, unmount } = renderHook(useLogStream, { wrapper: strictModeWrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket = FakeSocket.instances[0]
  act(() => socket.onmessage?.({ data: '[INFO] synthetic' } as MessageEvent))
  expect(result.current.lines).toHaveLength(1)
  const oldCallback = socket.onmessage
  act(() => setSessionToken(null))
  rerender()
  expect(result.current.lines).toEqual([])
  expect(socket.close).toHaveBeenCalledTimes(1)
  act(() => oldCallback?.({ data: '[INFO] old event' } as MessageEvent))
  expect(result.current.lines).toEqual([])
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('closes the socket when navigating away and fixture preview opens none', () => {
  const first = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  first.unmount()
  expect(FakeSocket.instances[0].close).toHaveBeenCalledTimes(1)
  vi.stubEnv('VITE_UI_FIXTURES', 'true')
  const preview = renderHook(useLogStream, { wrapper })
  act(() => vi.runOnlyPendingTimers())
  expect(FakeSocket.instances).toHaveLength(1)
  expect(preview.result.current.lines[0].text).toContain('合成预览')
  preview.unmount()
})

it('preserves existing lines on manual stop and prevents reopen or backoff probe on rerender', () => {
  const { result, rerender, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket = FakeSocket.instances[0]
  act(() => socket.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  act(() => {
    socket.onmessage?.({ data: '[INFO] line 1 before stop' } as MessageEvent)
    socket.onmessage?.({ data: '[WARNING] line 2 before stop' } as MessageEvent)
  })
  expect(result.current.lines).toHaveLength(2)
  expect(result.current.lines[0].text).toBe('[INFO] line 1 before stop')
  expect(result.current.lines[1].text).toBe('[WARNING] line 2 before stop')

  // Execute manual stop
  act(() => result.current.stop())
  expect(result.current.state).toBe('stopped')
  expect(result.current.lines).toHaveLength(2)
  expect(socket.close).toHaveBeenCalledWith(1000, 'Page closed')

  // Ordinary rerender while stopped must not reopen connection, trigger backoff, or clear lines
  rerender()
  expect(result.current.state).toBe('stopped')
  expect(result.current.lines).toHaveLength(2)
  expect(FakeSocket.instances).toHaveLength(1)

  // Advancing timers across potential backoff intervals must not open socket or probe
  act(() => vi.advanceTimersByTime(60_000))
  expect(FakeSocket.instances).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)

  unmount()
})

it('explicit reconnect restores connection and receives new logs while retaining previous lines', () => {
  const { result, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  const socket1 = FakeSocket.instances[0]
  act(() => socket1.onopen?.(new Event('open')))
  act(() => socket1.onmessage?.({ data: '[INFO] initial entry' } as MessageEvent))
  expect(result.current.lines).toHaveLength(1)

  // Stop manually
  act(() => result.current.stop())
  expect(result.current.state).toBe('stopped')
  expect(result.current.lines).toHaveLength(1)

  // Explicit reconnect
  act(() => result.current.reconnect())
  expect(result.current.state).toBe('connecting')
  // Lines remain preserved immediately upon reconnect request
  expect(result.current.lines).toHaveLength(1)

  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(2)
  const socket2 = FakeSocket.instances[1]
  act(() => socket2.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  // Deliver new event on socket2
  act(() => socket2.onmessage?.({ data: '[INFO] post-reconnect entry' } as MessageEvent))
  expect(result.current.lines).toHaveLength(2)
  expect(result.current.lines[0].text).toBe('[INFO] initial entry')
  expect(result.current.lines[1].text).toBe('[INFO] post-reconnect entry')

  // clearLocal clears lines without closing socket or changing connected state
  act(() => result.current.clearLocal())
  expect(result.current.lines).toEqual([])
  expect(result.current.state).toBe('connected')
  expect(socket2.close).not.toHaveBeenCalled()

  unmount()
})

it('drops stale frames and retained socket callbacks across session transitions and logout', () => {
  const { result, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket1 = FakeSocket.instances[0]
  act(() => socket1.onopen?.(new Event('open')))
  act(() => socket1.onmessage?.({ data: '[INFO] session 1 line' } as MessageEvent))
  expect(result.current.lines).toHaveLength(1)

  // Retain socket1 callbacks
  const retainedMessage1 = socket1.onmessage
  const retainedClose1 = socket1.onclose
  const retainedOpen1 = socket1.onopen

  // Transition to a new authenticated session
  act(() => setSessionToken('synthetic-session-token-2'))
  expect(result.current.lines).toEqual([])
  expect(socket1.close).toHaveBeenCalledTimes(1)

  // Invoking retained callbacks from old session must be inert
  act(() => retainedMessage1?.({ data: '[INFO] stale msg from session 1' } as MessageEvent))
  expect(result.current.lines).toEqual([])
  act(() => retainedOpen1?.(new Event('open')))
  act(() => retainedClose1?.({ code: 1006 } as CloseEvent))

  // Advance timer to let new session's connection open
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(2)
  const socket2 = FakeSocket.instances[1]
  act(() => socket2.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  // Stale message from socket1 still has no effect on socket2
  act(() => retainedMessage1?.({ data: '[INFO] zombie from session 1' } as MessageEvent))
  expect(result.current.lines).toEqual([])

  // Socket2 receives genuine line
  act(() => socket2.onmessage?.({ data: '[INFO] session 2 line' } as MessageEvent))
  expect(result.current.lines).toHaveLength(1)
  expect(result.current.lines[0].text).toBe('[INFO] session 2 line')

  // Logout completely
  const retainedMessage2 = socket2.onmessage
  act(() => setSessionToken(null))
  expect(result.current.lines).toEqual([])
  expect(result.current.state).toBe('stopped')
  expect(socket2.close).toHaveBeenCalledTimes(1)

  // Retained callback from socket2 after logout is dropped
  act(() => retainedMessage2?.({ data: '[INFO] late msg after logout' } as MessageEvent))
  expect(result.current.lines).toEqual([])

  // Unmount hook and ensure callbacks do not throw or schedule timers
  unmount()
  act(() => retainedMessage2?.({ data: '[INFO] late msg after unmount' } as MessageEvent))
  expect(vi.getTimerCount()).toBe(0)
})

it('resets manual stop state upon authenticating a new session', () => {
  const { result, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket1 = FakeSocket.instances[0]
  act(() => socket1.onopen?.(new Event('open')))

  // Manually stop session 1
  act(() => result.current.stop())
  expect(result.current.state).toBe('stopped')

  // Advance time: still stopped
  act(() => vi.advanceTimersByTime(10_000))
  expect(FakeSocket.instances).toHaveLength(1)

  // Switch to new session: manual stop state resets
  act(() => setSessionToken('synthetic-session-fresh'))
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(2)
  const socket2 = FakeSocket.instances[1]
  act(() => socket2.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  unmount()
})

it('handles abnormal socket closure with 401 panel auth probe failure without retry loop', async () => {
  const fetchMock = vi.fn().mockImplementation(() => {
    return Promise.resolve(
      Response.json({ detail: '密码错误' }, { status: 401 })
    )
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket = FakeSocket.instances[0]
  act(() => socket.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  // Simulate abnormal disconnect (code 1006)
  await act(async () => {
    socket.onclose?.({ code: 1006 } as CloseEvent)
    await Promise.resolve()
  })

  // Because probe returned 401 panel auth failure, the shared client invalidated the session
  expect(getSessionSnapshot().token).toBeNull()
  expect(result.current.state).toBe('stopped')

  // No retry or reopen scheduled
  act(() => vi.advanceTimersByTime(60_000))
  expect(FakeSocket.instances).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)

  unmount()
})

it('retries with bounded backoff on abnormal close when auth probe succeeds', async () => {
  const fetchMock = vi.fn().mockImplementation(() => {
    return Promise.resolve(
      Response.json({ antigravity: { configured: true } })
    )
  })
  vi.stubGlobal('fetch', fetchMock)

  const { result, unmount } = renderHook(useLogStream, { wrapper })
  act(() => vi.advanceTimersByTime(0))
  expect(FakeSocket.instances).toHaveLength(1)
  const socket1 = FakeSocket.instances[0]
  act(() => socket1.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  // Simulate abnormal disconnect (code 1006)
  await act(async () => {
    socket1.onclose?.({ code: 1006 } as CloseEvent)
    await Promise.resolve()
  })

  // Auth probe succeeds, state switches to reconnecting
  expect(result.current.state).toBe('reconnecting')
  expect(fetchMock).toHaveBeenCalled()

  // First backoff is 1000ms (1000 * 2^0)
  act(() => vi.advanceTimersByTime(1000))
  expect(FakeSocket.instances).toHaveLength(2)
  const socket2 = FakeSocket.instances[1]
  act(() => socket2.onopen?.(new Event('open')))
  expect(result.current.state).toBe('connected')

  unmount()
})
