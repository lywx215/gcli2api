export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'UNKNOWN'
export type LogLine = { id: number; text: string; level: LogLevel }
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'stopped' | 'rejected'
export const MAX_LINES = 1000
export const MAX_CHARACTERS = 256_000
const MAX_LINE = 8192
export function logLevel(text: string): LogLevel {
  const match = text.match(/(?:^|[\s[|])(DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL)(?=[\s\]|:]|$)/i)
  if (!match) return 'UNKNOWN'
  return match[1].toUpperCase() === 'WARN' ? 'WARNING' : match[1].toUpperCase() as LogLevel
}
export function appendLog(lines: LogLine[], text: string, id: number): LogLine[] {
  const bounded = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 12)}…[已截断]` : text
  const next = [...lines, { id, text: bounded, level: logLevel(bounded) }].slice(-MAX_LINES)
  let size = next.reduce((sum, line) => sum + line.text.length, 0), start = 0
  while (size > MAX_CHARACTERS && start < next.length) size -= next[start++].text.length
  return next.slice(start)
}

export type Socket = Pick<WebSocket, 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'close'>
export type StreamOptions = {
  url: () => string
  socket?: (url: string) => Socket
  onLine: (text: string) => void
  onState: (state: ConnectionState) => void
  canRetry?: (signal: AbortSignal) => Promise<boolean>
}
// One socket per page lifecycle. Deferred initial connect lets StrictMode cleanup
// cancel its probe mount before a handshake is started.
export function startLogStream(options: StreamOptions): () => void {
  let disposed = false, current: Socket | null = null, attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelProbe: (() => void) | undefined
  const scheduleRetry = () => {
    if (disposed) return
    if (attempts >= 5) { options.onState('stopped'); return }
    options.onState('reconnecting')
    timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 16_000))
  }
  const connect = () => {
    if (disposed) return
    options.onState(attempts ? 'reconnecting' : 'connecting')
    let socket: Socket
    try { socket = (options.socket ?? (url => new WebSocket(url)))(options.url()) }
    catch { scheduleRetry(); return }
    current = socket
    socket.onopen = () => { if (!disposed && current === socket) options.onState('connected') }
    socket.onmessage = event => { if (!disposed && current === socket && typeof event.data === 'string') options.onLine(event.data) }
    socket.onerror = () => { /* Browser does not expose handshake HTTP status. onclose drives bounded retries. */ }
    socket.onclose = event => {
      if (disposed || current !== socket) return
      current = null
      if ([1000, 1008, 4001, 4003, 4401, 4403].includes(event.code)) {
        options.onState(event.code === 1000 ? 'stopped' : 'rejected')
        return
      }
      if (event.code === 1006 && options.canRetry) {
        options.onState('reconnecting')
        const probeController = new AbortController()
        let settled = false
        const finish = (allowed: boolean) => {
          if (disposed || settled) return
          settled = true
          clearTimeout(probeTimeout)
          cancelProbe = undefined
          if (allowed) scheduleRetry()
          else options.onState('rejected')
        }
        // A hung HTTP check must not hold the page in a stale connected state or
        // prevent bounded reconnects. Abort transport, but also ignore promises
        // that do not honor cancellation and settle after the deadline.
        const probeTimeout = setTimeout(() => { finish(true); probeController.abort() }, 5000)
        cancelProbe = () => { settled = true; clearTimeout(probeTimeout); probeController.abort() }
        try { void options.canRetry(probeController.signal).then(finish, () => finish(true)) }
        catch { finish(true) }
      } else scheduleRetry()
    }
  }
  timer = setTimeout(connect, 0)
  return () => {
    disposed = true
    cancelProbe?.()
    clearTimeout(timer)
    if (current) {
      current.onopen = current.onmessage = current.onerror = current.onclose = null
      current.close(1000, 'Page closed')
      current = null
    }
  }
}
