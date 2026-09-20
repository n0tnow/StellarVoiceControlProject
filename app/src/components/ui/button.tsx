import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, MouseEvent } from "react";

import { cn } from "@/lib/utils";
import { playSfx } from "@/lib/sfx";

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
        /* The notch palette: the same near-white primary and white-alpha
           outline the onboarding uses on its black card, for surfaces that
           belong to the notch itself (wallet unlock, approval) rather than to
           the cockpit's sky-blue token set. */
        notch: "bg-notch-text text-black hover:bg-white",
        notchOutline: "border border-white/15 text-notch-text hover:bg-white/5",
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
    VariantProps<typeof buttonVariants> {
  /**
   * Whether the shared `press` cue plays on click. Defaults to `true`. Set to
   * `false` on high-frequency refresh/reload controls and diagnostic harnesses,
   * where a cue per click reads as machine-gun rather than confirmation.
   * Destructive (`variant="danger"`) controls are always silent regardless —
   * a cheerful tap on an irreversible action reads wrong.
   */
  sound?: boolean;
}

export function Button({
  className,
  variant,
  size,
  type = "button",
  onClick,
  sound = true,
  ...props
}: ButtonProps) {
  // Every button in the app shares this one cue: a shared `press` here beats
  // each of the ~16 call sites remembering to wire its own. It is suppressed
  // for `danger` and opt-out (`sound={false}`) call sites; the caller's own
  // `onClick` still runs either way.
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (sound && variant !== "danger") playSfx("press");
    onClick?.(event);
  };
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      onClick={handleClick}
      {...props}
    />
  );
}

export { buttonVariants };