import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendLog, logLevel, MAX_CHARACTERS, MAX_LINES, startLogStream } from './stream'
import type { LogLine, Socket } from './stream'
function mockSocket(): Socket { return { onopen: null, onmessage: null, onerror: null, onclose: null, close: vi.fn() } }
function close(socket: Socket, code: number) { socket.onclose?.call(socket as WebSocket, { code } as CloseEvent) }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
describe('bounded plain-text log stream', () => {
  it('bounds both line count and characters, preserving text as text', () => {
    let lines: LogLine[] = []
    for (let index = 0; index < 1100; index++) lines = appendLog(lines, '[INFO] <script>synthetic</script>', index)
    expect(lines).toHaveLength(MAX_LINES)
    expect(lines[0].id).toBe(100)
    for (let index = 0; index < 50; index++) lines = appendLog(lines, 'x'.repeat(20_000), 2000 + index)
    expect(lines.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(MAX_CHARACTERS)
    expect(lines.at(-1)?.text).toContain('已截断')
    expect(logLevel('[WARN] synthetic')).toBe('WARNING')
    expect(logLevel('ordinary text')).toBe('UNKNOWN')
  })
  it('avoids a StrictMode probe connection and disposes the single active socket', () => {
    const socket = mockSocket(), factory = vi.fn(() => socket), onLine = vi.fn(), onState = vi.fn()
    const options = { url: () => 'ws://example.invalid/prefix/logs/stream', socket: factory, onLine, onState }
    startLogStream(options)()
    const stop = startLogStream(options)
    vi.advanceTimersByTime(0)
    expect(factory).toHaveBeenCalledTimes(1)
    socket.onmessage?.call(socket as WebSocket, { data: '<b>plain</b>' } as MessageEvent)
    expect(onLine).toHaveBeenCalledWith('<b>plain</b>')
    stop()
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(socket.onmessage).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reconnects with a bounded backoff and stops after five attempts', () => {
    const sockets: Socket[] = [], onState = vi.fn()
    const stop = startLogStream({ url: () => 'ws://example.invalid', socket: () => { const socket = mockSocket(); sockets.push(socket); return socket }, onLine: vi.fn(), onState })
    vi.advanceTimersByTime(0)
    for (let index = 0; index < 6; index++) { close(sockets[index], 1006); vi.runOnlyPendingTimers() }
    expect(sockets).toHaveLength(6)
    expect(onState).toHaveBeenLastCalledWith('stopped')
    stop()
  })
  it('checks opaque handshake auth and never reconnects after confirmed rejection', async () => {
    const socket = mockSocket(), factory = vi.fn(() => socket), onState = vi.fn(), canRetry = vi.fn().mockResolvedValue(false)
    const stop = startLogStream({ url: () => 'ws://example.invalid', socket: factory, onLine: vi.fn(), onState, canRetry })
    vi.advanceTimersByTime(0); close(socket, 1006)
    await Promise.resolve()
    expect(canRetry).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenLastCalledWith('rejected')
    vi.runAllTimers()
    expect(factory).toHaveBeenCalledTimes(1)
    stop()
  })
  it('aborts an in-flight auth check on leaving and ignores its late result', async () => {
    const socket = mockSocket(), factory = vi.fn(() => socket), onState = vi.fn()
    let resolve!: (value: boolean) => void, signal!: AbortSignal
    const stop = startLogStream({ url: () => 'ws://example.invalid', socket: factory, onLine: vi.fn(), onState, canRetry: input => { signal = input; return new Promise(done => { resolve = done }) } })
    vi.advanceTimersByTime(0); close(socket, 1006); stop()
    expect(signal.aborted).toBe(true)
    resolve(true); await Promise.resolve(); vi.runAllTimers()
    expect(factory).toHaveBeenCalledTimes(1)
  })
  it('does not retry explicit connection-limit rejection', () => {
    const socket = mockSocket(), onState = vi.fn()
    const stop = startLogStream({ url: () => 'ws://example.invalid', socket: () => socket, onLine: vi.fn(), onState })
    vi.advanceTimersByTime(0); close(socket, 1008)
    expect(onState).toHaveBeenLastCalledWith('rejected')
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })
})
