import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-strong text-white hover:bg-[#9a4315] disabled:bg-[#d9b9a4]",
  secondary: "bg-surface text-ink border border-field hover:bg-accent-soft disabled:text-muted",
  ghost: "text-accent-strong hover:bg-accent-soft disabled:text-muted",
  danger: "bg-bad text-white hover:bg-[#8a1913] disabled:bg-[#e3b3b0]",
};

const SIZES: Record<Size, string> = { md: "min-h-11 px-5 text-base", sm: "min-h-9 px-3.5 text-sm" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

/** 44px minimum touch target (WCAG 2.5.8); shows a spinner and stays announced as busy while loading. */
export function Button({ variant = "primary", size = "md", loading = false, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors",
        "disabled:cursor-not-allowed", VARIANTS[variant], SIZES[size], className,
      )}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
    />
  );
}
