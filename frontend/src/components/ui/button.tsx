import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/domain/shared"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-100 disabled:bg-secondary disabled:text-muted-foreground aria-disabled:bg-secondary aria-disabled:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-control hover:bg-primary-hover active:bg-primary-active",
        destructive:
          "bg-destructive text-destructive-foreground shadow-control hover:bg-destructive/90 active:bg-destructive",
        outline:
          "border border-input bg-control-background shadow-control hover:bg-hover hover:text-foreground active:bg-selected",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-hover active:bg-selected",
        ghost: "hover:bg-hover hover:text-foreground active:bg-selected",
        link: "text-primary underline-offset-4 hover:text-primary-hover hover:underline active:text-primary-active",
      },
      size: {
        default: "h-9 px-3.5 py-1.5 text-sm",
        sm: "h-8 px-2.5 py-1 text-[13px] rounded-md [&_svg]:size-3.5 gap-1.5",
        xs: "h-7 px-2 py-0.5 text-[12px] rounded [&_svg]:size-3.5 gap-1.5",
        lg: "h-10 px-6 text-sm rounded-md",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8 [&_svg]:size-3.5",
        "icon-xs": "h-7 w-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
