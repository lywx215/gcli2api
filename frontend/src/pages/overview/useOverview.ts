import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/auth'
import { loadOverview } from './api'
import type { OverviewData } from './types'

export function useOverview() {
  const { authenticated, sessionEpoch } = useAuth()
  const epoch = useRef(sessionEpoch)
  epoch.current = sessionEpoch
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ epoch: number; data: OverviewData | null; loading: boolean }>({ epoch: sessionEpoch, data: null, loading: true })
  useEffect(() => {
    if (!authenticated) return
    const controller = new AbortController()
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    async function read() {
      if (disposed) return
      if (!document.hidden) {
        setState(previous => ({ epoch: sessionEpoch, data: previous.epoch === sessionEpoch ? previous.data : null, loading: true }))
        try {
          const data = await loadOverview(controller.signal)
          if (!disposed && epoch.current === sessionEpoch) setState({ epoch: sessionEpoch, data, loading: false })
        } catch { /* Aborted reads never replace the current session. */ }
      }
      if (!disposed && epoch.current === sessionEpoch) timer = setTimeout(read, 30_000)
    }
    void read()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [authenticated, sessionEpoch, revision])
  return { data: authenticated && state.epoch === sessionEpoch ? state.data : null, loading: state.loading, refresh: () => setRevision(value => value + 1) }
}
