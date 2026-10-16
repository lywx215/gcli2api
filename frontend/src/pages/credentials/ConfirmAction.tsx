import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
export function ConfirmAction({
  label,
  description,
  disabled,
  size = 'sm',
  onConfirm,
}: {
  label: string
  description: string
  disabled?: boolean
  size?: 'default' | 'sm' | 'xs'
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size={size} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md rounded-lg p-4 bg-popover text-popover-foreground">
        <AlertDialogHeader className="space-y-1">
          <AlertDialogTitle className="text-base font-semibold">{label}</AlertDialogTitle>
          <AlertDialogDescription className="text-xs text-muted-foreground">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-3 gap-2">
          <AlertDialogCancel className="h-8 px-3 text-xs">取消</AlertDialogCancel>
          <AlertDialogAction className="h-8 px-3 text-xs" onClick={onConfirm}>确认{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
