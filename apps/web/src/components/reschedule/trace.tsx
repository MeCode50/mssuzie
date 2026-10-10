"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CheckIcon, ClockIcon, CrossIcon, MinusIcon, RefreshIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { useNow } from "@/components/trace/use-now";
import type { Connection } from "@/components/trace/use-run-stream";
import { describeTool, failedRAgents, RAGENT_IDS, RAGENT_INFO, type RAgentId, type RAgentView, type RTraceState } from "@/lib/reschedule-trace";
import { formatClock, formatDuration, formatUsd } from "@/lib/trace";

const STATUS = {
  waiting: { label: "Waiting", card: "border-line bg-idle-bg/60", chip: "bg-idle-bg text-idle" },
  running: { label: "Working", card: "border-accent bg-accent-soft", chip: "bg-surface text-accent-strong" },
  done: { label: "Done", card: "border-ok/30 bg-ok-bg", chip: "bg-surface text-ok" },
  failed: { label: "Needs attention", card: "border-bad/40 bg-bad-bg", chip: "bg-surface text-bad" },
  skipped: { label: "Not needed", card: "border-line bg-idle-bg/60", chip: "bg-idle-bg text-idle" },
} as const;

function Dot({ status }: { status: RAgentView["status"] }) {
  const base = "grid size-9 shrink-0 place-items-center rounded-full";
  if (status === "running") return <span className={cn(base, "bg-surface")} aria-hidden="true"><span className="size-3.5 animate-pulse-soft rounded-full bg-accent" /></span>;
  if (status === "done") return <span className={cn(base, "bg-ok text-white")} aria-hidden="true"><CheckIcon className="size-5" /></span>;
  if (status === "failed") return <span className={cn(base, "bg-bad text-white")} aria-hidden="true"><CrossIcon className="size-5" /></span>;
  if (status === "skipped") return <span className={cn(base, "bg-idle-bg text-idle")} aria-hidden="true"><MinusIcon className="size-5" /></span>;
  return <span className={cn(base, "border-2 border-dashed border-field/60 bg-surface")} aria-hidden="true" />;
}

function ToolRow({ tool }: { tool: RAgentView["tools"][number] }) {
  return (
    <li data-testid={`tool-${tool.name}`} data-status={tool.status} className="flex items-start gap-2 rounded-xl bg-surface/80 px-3 py-2 text-sm">
      <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", tool.status === "running" ? "animate-pulse-soft bg-accent" : tool.status === "done" ? "bg-ok" : "bg-bad")} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{describeTool(tool.name, tool.input)}</p>
        {tool.summary ? <p className="text-muted">{tool.summary}{tool.durationMs !== null ? ` · ${formatDuration(tool.durationMs)}` : ""}</p> : tool.status === "running" ? <p className="text-muted">Looking…</p> : null}
      </div>
    </li>
  );
}

function AgentRow({ agent, now, onRetry, retrying }: { agent: RAgentView; now: number; onRetry?: () => void; retrying: boolean }) {
  const info = RAGENT_INFO[agent.id];
  const s = STATUS[agent.status];
  const seconds = agent.startedAtMs ? Math.max(0, (now - agent.startedAtMs) / 1000) : 0;
  return (
    <li data-testid={`ragent-${agent.id}`} data-status={agent.status} className={cn("rounded-2xl border p-4 transition-colors duration-300", s.card)}>
      <div className="flex items-start gap-3">
        <Dot status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold">{info.name}</h3>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", s.chip)}>{s.label}{agent.attempt > 1 ? ` · attempt ${agent.attempt}` : ""}</span>
          </div>
          {agent.status === "waiting" && <p className="mt-1 text-sm text-muted">{info.idle}</p>}
          {agent.status === "running" && <p className="mt-1 text-sm">{info.working} <span className="tabular-nums text-muted">{seconds.toFixed(0)}s</span></p>}
          {agent.status === "done" && <p className="mt-1 text-sm font-semibold">{agent.summary ?? "Finished."}</p>}
          {agent.status === "skipped" && <p className="mt-1 text-sm text-muted">{agent.error ?? "Not needed for this request."}</p>}
          {agent.status === "failed" && (
            <>
              <p className="mt-1 text-sm font-semibold text-bad">{agent.error}</p>
              {onRetry ? <Button size="sm" variant="secondary" icon={<RefreshIcon className="size-4" />} loading={retrying} onClick={onRetry} className="mt-3">Retry</Button> : null}
            </>
          )}
          {agent.tools.length > 0 && (
            <ul aria-label={`${info.name} tool calls`} className="mt-3 space-y-1.5 border-l-2 border-dashed border-field/40 pl-3">
              {agent.tools.map((t) => <ToolRow key={t.seq} tool={t} />)}
            </ul>
          )}
          {(agent.status === "done" || agent.status === "failed") && agent.durationMs !== null && (
            <p className="mt-2 text-xs tabular-nums text-muted">
              {formatDuration(agent.durationMs)}{agent.tokens ? ` · ${agent.tokens.toLocaleString("en-US")} tokens · ${formatUsd(agent.costUsd ?? 0)}` : ""}{agent.model ? ` · ${agent.model}` : ""}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export interface RescheduleTraceProps {
  state: RTraceState;
  connection: Connection;
  onRetry: () => void;
  retrying: boolean;
  onReload?: () => void;
  /** Shown above the steps when there is nothing to trace yet. */
  idleText?: string;
}

function announce(prev: RTraceState | null, next: RTraceState): string | null {
  if (!prev) return null;
  for (const id of RAGENT_IDS) {
    const a = next.agents[id];
    if (a.status === prev.agents[id].status) continue;
    const name = RAGENT_INFO[id].name;
    if (a.status === "running") return `${name} started.`;
    if (a.status === "done") return `${name} finished. ${a.summary ?? ""}`;
    if (a.status === "failed") return `${name} needs attention. ${a.error ?? ""}`;
  }
  return !prev.done && next.done ? "The request has been handled." : null;
}

export function RescheduleTrace({ state, connection, onRetry, retrying, onReload, idleText }: RescheduleTraceProps) {
  const active = connection === "connecting" || connection === "live" || connection === "reconnecting";
  const now = useNow(active && !state.done);
  const idle = connection === "idle";
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : null;
  const endMs = state.finishedAt ? Date.parse(state.finishedAt) : null;
  const elapsed = startedMs === null ? 0 : (endMs ?? (state.done ? startedMs : now)) - startedMs;
  const failed = failedRAgents(state);

  const [message, setMessage] = useState("");
  const previous = useRef<RTraceState | null>(null);
  useEffect(() => {
    const text = announce(previous.current, state);
    if (text) setMessage(text);
    previous.current = state;
  }, [state]);

  return (
    <section aria-labelledby="rtrace-title" data-testid="reschedule-trace" data-run-status={state.runStatus ?? "none"} className="rounded-card border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="rtrace-title" className="text-lg font-extrabold">What the agents are doing</h2>
          <p className="text-sm text-muted">{idle ? (idleText ?? "Send a message and watch each step as it works.") : "Each step appears as it works. Calendar and emails only change once the rules allow it."}</p>
        </div>
        <dl className="flex gap-5 text-right">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Run time</dt>
            <dd data-testid="run-timer" className="flex items-center justify-end gap-1.5 text-xl font-extrabold tabular-nums"><ClockIcon className="size-4 text-muted" />{formatClock(elapsed)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Cost</dt>
            <dd data-testid="run-cost" className="text-xl font-extrabold tabular-nums">{formatUsd(state.totalCostUsd)}</dd>
          </div>
        </dl>
      </div>

      {connection === "reconnecting" && <p role="status" className="mt-4 rounded-xl bg-warn-bg px-4 py-2 text-sm font-semibold text-warn">Connection hiccup. Reconnecting and picking up where we left off…</p>}
      {connection === "expired" && <div className="mt-4"><InlineError action={<Link href="/login" className="font-bold underline">Sign in again</Link>}>Your session has ended, so we can&apos;t show live updates.</InlineError></div>}
      {connection === "lost" && <div className="mt-4"><InlineError action={onReload ? <Button size="sm" variant="secondary" onClick={onReload}>Reload</Button> : undefined}>We lost the live connection. The request keeps going in the background.</InlineError></div>}

      <ol aria-label="Steps" className={cn("mt-5 space-y-2", idle && "opacity-80")}>
        {RAGENT_IDS.map((id: RAgentId) => (
          <AgentRow key={id} agent={state.agents[id]} now={now} retrying={retrying} onRetry={state.agents[id].status === "failed" ? onRetry : undefined} />
        ))}
      </ol>
      {state.done && state.runStatus !== "completed" && (
        <p data-testid="trace-problem" className="mt-4 rounded-2xl bg-warn-bg p-4 text-sm font-semibold text-warn">
          {failed.length > 0 ? `Some steps need attention: ${failed.map((id) => RAGENT_INFO[id].name).join(", ")}. The request itself is safe; you can retry them.` : "This run didn't finish cleanly."}
        </p>
      )}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</div>
    </section>
  );
}
