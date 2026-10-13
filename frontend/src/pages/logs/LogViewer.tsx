import { useEffect, useRef } from 'react'
import type { LogLine } from './stream'

export function LogViewer({ lines, follow }: { lines: LogLine[]; follow: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => { if (follow && container.current) container.current.scrollTop = container.current.scrollHeight }, [lines, follow])
  return <div ref={container} tabIndex={0} aria-label="日志文本" className="h-[min(60vh,40rem)] min-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    {lines.length ? lines.map(line => <pre className="whitespace-pre-wrap break-all" key={line.id}>{line.text}</pre>) : <p className="font-sans text-sm text-muted-foreground">暂无符合筛选的日志。</p>}
  </div>
}
