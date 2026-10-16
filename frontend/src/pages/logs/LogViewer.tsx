import { useEffect, useRef } from 'react'
import type { LogLine } from './stream'

export function LogViewer({ lines, follow }: { lines: LogLine[]; follow: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (follow && container.current) {
      container.current.scrollTop = container.current.scrollHeight
    }
  }, [lines, follow])

  return (
    <div
      ref={container}
      tabIndex={0}
      aria-label="日志文本"
      className="flex-1 min-h-[260px] min-w-0 overflow-y-auto rounded-lg border border-border bg-control-background p-2.5 font-mono text-[12px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {lines.length ? (
        lines.map(line => (
          <pre
            className={`whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] ${({
              DEBUG: 'text-muted-foreground',
              INFO: 'text-info',
              WARNING: 'text-warning',
              ERROR: 'text-destructive',
              CRITICAL: 'text-destructive',
              UNKNOWN: 'text-muted-foreground',
            })[line.level]}`}
            key={line.id}
          >
            {line.text}
          </pre>
        ))
      ) : (
        <p className="font-sans text-xs leading-5 text-muted-foreground">暂无符合筛选的日志。</p>
      )}
    </div>
  )
}
