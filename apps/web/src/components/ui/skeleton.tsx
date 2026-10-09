import { cn } from "./cn";

/** Placeholder block shown while content loads. Hidden from screen readers; the page announces loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse-soft rounded-xl bg-line", className)} />;
}
