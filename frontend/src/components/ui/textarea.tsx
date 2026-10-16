import * as React from "react"

import { cn } from "@/domain/shared"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      data-shared-control=""
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-control-background px-2.5 py-1.5 text-base md:text-[13px] leading-snug ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
