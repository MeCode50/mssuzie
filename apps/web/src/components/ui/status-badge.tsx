import { cn } from "./cn";
import { AlertIcon, CheckIcon, DotIcon } from "./icons";

export type LearnerStatus = "on_track" | "watch" | "at_risk";

const CONFIG = {
  on_track: { label: "On track", classes: "bg-ok-bg text-ok", Icon: CheckIcon },
  watch: { label: "Watch", classes: "bg-warn-bg text-warn", Icon: AlertIcon },
  at_risk: { label: "At risk", classes: "bg-bad-bg text-bad", Icon: DotIcon },
} as const;

/** Colour is never the only signal: every status also has an icon and a word. */
export function StatusBadge({ status, className }: { status: LearnerStatus; className?: string }) {
  const { label, classes, Icon } = CONFIG[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold", classes, className)}>
      <Icon className="size-4" />
      {label}
    </span>
  );
}
