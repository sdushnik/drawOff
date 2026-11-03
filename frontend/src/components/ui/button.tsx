import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground border-2 border-ink shadow-sticker-sm hover:-translate-y-0.5 hover:shadow-sticker active:translate-y-0.5 active:shadow-none",
        hero:
          "bg-primary text-primary-foreground border-[2.5px] border-ink shadow-sticker font-display text-base hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-sticker-lg active:translate-x-0.5 active:translate-y-0.5 active:shadow-none",
        sunny:
          "bg-secondary text-secondary-foreground border-2 border-ink shadow-sticker-sm hover:-translate-y-0.5 hover:shadow-sticker active:translate-y-0.5 active:shadow-none",
        teal:
          "bg-accent text-accent-foreground border-2 border-ink shadow-sticker-sm hover:-translate-y-0.5 hover:shadow-sticker active:translate-y-0.5 active:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground border-2 border-ink shadow-sticker-sm hover:-translate-y-0.5",
        outline:
          "border-2 border-ink bg-card text-foreground shadow-sticker-sm hover:-translate-y-0.5 hover:shadow-sticker active:translate-y-0.5 active:shadow-none",
        secondary: "bg-muted text-foreground border-2 border-ink hover:bg-secondary",
        ghost: "hover:bg-muted text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        tool: "border-2 border-ink bg-card text-foreground hover:bg-muted data-[active=true]:bg-ink data-[active=true]:text-paper",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 px-6 text-base",
        xl: "h-14 px-8 text-lg",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
