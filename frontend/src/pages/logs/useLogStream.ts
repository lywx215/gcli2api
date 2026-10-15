import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { getSessionSnapshot, registerSessionCleanup } from '@/auth/session'
import { canRetryLogConnection, logStreamUrl } from './api'
import { appendLog, startLogStream } from './stream'
import type { ConnectionState, LogLine } from './stream'

export function useLogStream() {
  const { authenticated, token, sessionEpoch } = useAuth()
  const epoch = useRef(sessionEpoch)
  epoch.current = sessionEpoch
  const authenticatedRef = useRef(authenticated)
  authenticatedRef.current = authenticated
  const mountedRef = useRef(true)

  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ epoch: number; lines: LogLine[]; state: ConnectionState }>({
    epoch: sessionEpoch,
    lines: [],
    state: 'connecting',
  })
  const disposerRef = useRef<(() => void) | null>(null)
  const manualStoppedRef = useRef(false)
  const generationRef = useRef(0)
  const sequenceRef = useRef(0)
  const lastSessionRef = useRef(sessionEpoch)

  if (lastSessionRef.current !== sessionEpoch) {
    lastSessionRef.current = sessionEpoch
    manualStoppedRef.current = false
    sequenceRef.current = 0
  }

  useEffect(() => {
    mountedRef.current = true
    const unregister = registerSessionCleanup(() => {
      generationRef.current++
      if (disposerRef.current) {
        disposerRef.current()
        disposerRef.current = null
      }
      setSnapshot(previous => ({ ...previous, lines: [], state: 'stopped' }))
    })
    return () => {
      mountedRef.current = false
      unregister()
    }
  }, [])

  const stop = useCallback(() => {
    if (!mountedRef.current || !authenticated || !authenticatedRef.current || epoch.current !== sessionEpoch) {
      return
    }
    manualStoppedRef.current = true
    generationRef.current++
    if (disposerRef.current) {
      disposerRef.current()
      disposerRef.current = null
    }
    setSnapshot(previous => (previous.epoch === sessionEpoch ? { ...previous, state: 'stopped' } : previous))
  }, [authenticated, sessionEpoch])

  const reconnect = useCallback(() => {
    if (!mountedRef.current || !authenticated || !authenticatedRef.current || epoch.current !== sessionEpoch) {
      return
    }
    generationRef.current++
    if (disposerRef.current) {
      disposerRef.current()
      disposerRef.current = null
    }
    manualStoppedRef.current = false
    setRevision(value => value + 1)
  }, [authenticated, sessionEpoch])

  const clearLocal = useCallback(() => {
    if (!mountedRef.current || !authenticated || !authenticatedRef.current || epoch.current !== sessionEpoch) {
      return
    }
    setSnapshot(previous => (previous.epoch === sessionEpoch ? { ...previous, lines: [] } : previous))
  }, [authenticated, sessionEpoch])

  useEffect(() => {
    if (epoch.current !== sessionEpoch) {
      manualStoppedRef.current = false
      epoch.current = sessionEpoch
      sequenceRef.current = 0
    }
    if (manualStoppedRef.current) {
      setSnapshot(previous => (previous.state === 'stopped' && previous.epoch === sessionEpoch ? previous : {
        epoch: sessionEpoch,
        lines: previous.epoch === sessionEpoch ? previous.lines : [],
        state: 'stopped',
      }))
      return
    }
    setSnapshot(previous => ({
      epoch: sessionEpoch,
      lines: previous.epoch === sessionEpoch ? previous.lines : [],
      state: 'connecting',
    }))
    if (!authenticated || !token) {
      setSnapshot({ epoch: sessionEpoch, lines: [], state: 'stopped' })
      return
    }
    if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
      setSnapshot({ epoch: sessionEpoch, state: 'stopped', lines: [
        { id: 0, level: 'INFO', text: '[INFO] 合成预览：未连接服务器日志。' },
        { id: 1, level: 'WARNING', text: '[WARNING] example.invalid 的模拟任务等待处理。' },
      ] })
      return
    }
    const generation = ++generationRef.current
    const streamEpoch = sessionEpoch
    const disposer = startLogStream({
      url: () => logStreamUrl(token),
      canRetry: canRetryLogConnection,
      onLine: text => {
        if (getSessionSnapshot().sessionEpoch !== streamEpoch) {
          return
        }
        if (generation === generationRef.current && epoch.current === streamEpoch && !manualStoppedRef.current) {
          setSnapshot(previous => (previous.epoch === streamEpoch ? {
            ...previous,
            lines: appendLog(previous.lines, text, sequenceRef.current++),
          } : previous))
        }
      },
      onState: state => {
        if (getSessionSnapshot().sessionEpoch !== streamEpoch) {
          return
        }
        if (generation === generationRef.current && epoch.current === streamEpoch && !manualStoppedRef.current) {
          setSnapshot(previous => (previous.epoch === streamEpoch ? { ...previous, state } : previous))
        }
      },
    })
    disposerRef.current = disposer
    return () => {
      generationRef.current++
      disposerRef.current?.()
      disposerRef.current = null
    }
  }, [authenticated, token, sessionEpoch, revision])

  return {
    lines: authenticated && snapshot.epoch === sessionEpoch ? snapshot.lines : [],
    state: authenticated && snapshot.epoch === sessionEpoch ? snapshot.state : ('stopped' as ConnectionState),
    reconnect,
    clearLocal,
    stop,
  }
}
