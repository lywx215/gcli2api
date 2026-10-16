import * as React from "react"

import { cn } from "@/domain/shared"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        data-shared-control=""
        className={cn(
          "flex h-8 w-full rounded-md border border-input bg-control-background px-2.5 py-1 text-base md:text-[13px] ring-offset-background file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
