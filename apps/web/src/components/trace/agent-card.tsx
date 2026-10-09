import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CheckIcon, CrossIcon, MinusIcon, RefreshIcon } from "@/components/ui/icons";
import { AGENT_INFO, formatDuration, formatUsd, type AgentView } from "@/lib/trace";

const STATUS = {
  waiting: { label: "Waiting", card: "border-line bg-idle-bg/60", chip: "bg-idle-bg text-idle" },
  running: { label: "Working", card: "border-accent bg-accent-soft", chip: "bg-surface text-accent-strong" },
  done: { label: "Done", card: "border-ok/30 bg-ok-bg", chip: "bg-surface text-ok" },
  failed: { label: "Needs attention", card: "border-bad/40 bg-bad-bg", chip: "bg-surface text-bad" },
  skipped: { label: "Skipped", card: "border-line bg-idle-bg/60", chip: "bg-idle-bg text-idle" },
} as const;

function StatusIcon({ status }: { status: AgentView["status"] }) {
  const base = "grid size-9 shrink-0 place-items-center rounded-full";
  switch (status) {
    case "running":
      return (
        <span className={cn(base, "bg-surface")} aria-hidden="true">
          <span className="size-3.5 animate-pulse-soft rounded-full bg-accent" />
        </span>
      );
    case "done":
      return <span className={cn(base, "bg-ok text-white")} aria-hidden="true"><CheckIcon className="size-5" /></span>;
    case "failed":
      return <span className={cn(base, "bg-bad text-white")} aria-hidden="true"><CrossIcon className="size-5" /></span>;
    case "skipped":
      return <span className={cn(base, "bg-idle-bg text-idle")} aria-hidden="true"><MinusIcon className="size-5" /></span>;
    default:
      return <span className={cn(base, "border-2 border-dashed border-field/60 bg-surface")} aria-hidden="true" />;
  }
}

export interface AgentCardProps {
  agent: AgentView;
  now: number;
  onRetry?: () => void;
  retrying?: boolean;
}

/** One agent: grey while waiting, pulsing while working, green with a one-line summary when done, red with Retry on failure. */
export function AgentCard({ agent, now, onRetry, retrying }: AgentCardProps) {
  const info = AGENT_INFO[agent.id];
  const s = STATUS[agent.status];
  const seconds = agent.startedAtMs ? Math.max(0, (now - agent.startedAtMs) / 1000) : 0;
  return (
    <li
      data-testid={`agent-${agent.id}`}
      data-status={agent.status}
      className={cn("rounded-2xl border p-4 transition-colors duration-300", s.card)}
    >
      <div className="flex items-start gap-3">
        <StatusIcon status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold">{info.name}</h3>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", s.chip)}>
              {s.label}
              {agent.attempt > 1 ? ` · attempt ${agent.attempt}` : ""}
            </span>
          </div>

          {agent.status === "waiting" && <p className="mt-1 text-sm text-muted">{info.idle}</p>}
          {agent.status === "running" && (
            <p className="mt-1 text-sm text-ink">
              {info.working} <span className="tabular-nums text-muted">{seconds.toFixed(0)}s</span>
            </p>
          )}
          {agent.status === "done" && <p className="mt-1 text-sm font-semibold text-ink">{agent.summary ?? "Finished."}</p>}
          {agent.status === "skipped" && <p className="mt-1 text-sm text-muted">{agent.error ?? "Skipped because an earlier step needs attention."}</p>}
          {agent.status === "failed" && (
            <>
              <p className="mt-1 text-sm font-semibold text-bad">{agent.error}</p>
              {onRetry ? (
                <Button size="sm" variant="secondary" icon={<RefreshIcon className="size-4" />} loading={retrying} onClick={onRetry} className="mt-3">
                  Retry
                </Button>
              ) : null}
            </>
          )}

          {(agent.status === "done" || agent.status === "failed") && agent.durationMs !== null && (
            <p className="mt-2 text-xs tabular-nums text-muted">
              {formatDuration(agent.durationMs)} · {(agent.tokens ?? 0).toLocaleString("en-US")} tokens · {formatUsd(agent.costUsd ?? 0)}
              {agent.model ? ` · ${agent.model}` : ""}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
