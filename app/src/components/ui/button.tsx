import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui-style button, vendored by hand so the skeleton has no generated
 * dependency. `npx shadcn@latest add <component>` works from `app/`
 * (`components.json` is present) and will overwrite this file with the canonical
 * version if the team prefers.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap",
    "transition-colors outline-none",
    "focus-visible:ring-2 focus-visible:ring-polaris-accent/60",
    "disabled:pointer-events-none disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-polaris-accent-strong text-slate-950 hover:bg-polaris-accent",
        secondary: "bg-white/10 text-polaris-text hover:bg-white/15",
        outline: "border border-polaris-line text-polaris-text hover:bg-white/5",
        ghost: "text-polaris-muted hover:bg-white/5 hover:text-polaris-text",
        danger: "bg-polaris-danger/90 text-slate-950 hover:bg-polaris-danger",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };