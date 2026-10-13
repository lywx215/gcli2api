import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { canRetryLogConnection, logStreamUrl } from './api'
import { appendLog, startLogStream } from './stream'
import type { ConnectionState, LogLine } from './stream'

export function useLogStream() {
  const { authenticated, token, sessionEpoch } = useAuth()
  const epoch = useRef(sessionEpoch)
  epoch.current = sessionEpoch
  const [revision, setRevision] = useState(0)
  const [snapshot, setSnapshot] = useState<{ epoch: number; lines: LogLine[]; state: ConnectionState }>({ epoch: sessionEpoch, lines: [], state: 'connecting' })
  useEffect(() => {
    setSnapshot({ epoch: sessionEpoch, lines: [], state: 'connecting' })
    if (!authenticated || !token) return
    if (import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === 'true') {
      setSnapshot({ epoch: sessionEpoch, state: 'stopped', lines: [
        { id: 0, level: 'INFO', text: '[INFO] 合成预览：未连接服务器日志。' },
        { id: 1, level: 'WARNING', text: '[WARNING] example.invalid 的模拟任务等待处理。' },
      ] })
      return
    }
    let sequence = 0
    return startLogStream({
      url: () => logStreamUrl(token),
      canRetry: canRetryLogConnection,
      onLine: text => { if (epoch.current === sessionEpoch) setSnapshot(previous => ({ ...previous, lines: appendLog(previous.lines, text, sequence++) })) },
      onState: state => { if (epoch.current === sessionEpoch) setSnapshot(previous => ({ ...previous, state })) },
    })
  }, [authenticated, token, sessionEpoch, revision])
  return {
    lines: authenticated && snapshot.epoch === sessionEpoch ? snapshot.lines : [],
    state: authenticated && snapshot.epoch === sessionEpoch ? snapshot.state : 'stopped' as ConnectionState,
    reconnect: () => setRevision(value => value + 1),
    clearLocal: () => setSnapshot(previous => ({ ...previous, lines: [] })),
  }
}
