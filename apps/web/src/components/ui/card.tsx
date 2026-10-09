import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card border border-line bg-surface p-5 shadow-card sm:p-6", className)} {...rest} />;
}
