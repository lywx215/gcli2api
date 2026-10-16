import type { QuotaMode, QuotaSummary } from './types'
import { QuotaCard } from './QuotaCard'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export interface QuotaDialogProps {
  open: boolean
  filename: string | null
  summary: QuotaSummary | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  disabled?: boolean
  mode?: QuotaMode
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}

export function QuotaDialog({
  open,
  filename,
  summary,
  loading,
  error,
  onRefresh,
  disabled = false,
  mode = 'antigravity',
  onOpenChange,
  onCloseAutoFocus,
}: QuotaDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-[calc(100%-1.5rem)] sm:max-w-xl max-h-[85vh] overflow-y-auto overflow-x-hidden p-4 sm:p-6"
      >
        <DialogHeader>
          <DialogTitle className="break-all text-base sm:text-lg font-semibold">
            {filename ? `凭证额度：${filename}` : '凭证额度'}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {mode === 'geminicli' ? 'Gemini CLI' : 'Antigravity'} 额度摘要。仅展示可用限额与重置时间，不包含私密凭据。
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div
            role="status"
            className="rounded-lg border border-destructive/30 bg-destructive-bg p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {filename && (
          <div className="min-w-0">
            <QuotaCard
              filename={filename}
              mode={mode}
              summary={summary}
              loading={loading}
              onRefresh={onRefresh}
              disabled={disabled}
            />
          </div>
        )}

        <DialogFooter className="mt-2 sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
