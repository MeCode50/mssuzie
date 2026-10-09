"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ArrowRightIcon, ClockIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { AGENT_INFO, failedAgents, formatClock, formatUsd, type AgentId, type TraceState } from "@/lib/trace";
import { AgentCard } from "./agent-card";
import type { Connection } from "./use-run-stream";
import { useNow } from "./use-now";

const Connector = ({ caption }: { caption?: string }) => (
  <li aria-hidden={caption ? undefined : true} className="flex flex-col items-center py-1.5 list-none">
    <span className="h-4 w-px border-l-2 border-dashed border-field/50" />
    {caption ? <span className="my-1 rounded-full bg-accent-soft px-3 py-0.5 text-xs font-semibold text-accent-strong">{caption}</span> : null}
    {caption ? <span className="h-3 w-px border-l-2 border-dashed border-field/50" /> : null}
  </li>
);

export interface TracePanelProps {
  state: TraceState;
  connection: Connection;
  /** The run being traced; null before a run has started. */
  runId: string | null;
  onRetry: () => void;
  retrying: boolean;
  /** Reload the page (offered when the live connection is lost). */
  onReload?: () => void;
}

/** What a screen reader hears as agents finish (polite, so it never interrupts). */
function announce(prev: TraceState | null, next: TraceState): string | null {
  if (!prev) return null;
  for (const id of Object.keys(next.agents) as AgentId[]) {
    const a = next.agents[id];
    const before = prev.agents[id];
    if (a.status === before.status) continue;
    const name = AGENT_INFO[id].name;
    if (a.status === "running") return `${name} started.`;
    if (a.status === "done") return `${name} finished. ${a.summary ?? ""}`;
    if (a.status === "failed") return `${name} needs attention. ${a.error ?? ""}`;
  }
  if (!prev.done && next.done) return next.runStatus === "completed" ? "All steps finished. Results are ready." : "The run finished with problems.";
  return null;
}

export function TracePanel({ state, connection, runId, onRetry, retrying, onReload }: TracePanelProps) {
  const active = connection === "connecting" || connection === "live" || connection === "reconnecting";
  const now = useNow(active && !state.done);
  const failed = failedAgents(state);

  // Run clock from the server's start time (so it is right when opened mid-run); stops when finished.
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : null;
  const endMs = state.finishedAt ? Date.parse(state.finishedAt) : null;
  const elapsed = startedMs === null ? 0 : (endMs ?? (state.done ? startedMs : now)) - startedMs;

  const [message, setMessage] = useState("");
  const previous = useRef<TraceState | null>(null);
  useEffect(() => {
    const text = announce(previous.current, state);
    if (text) setMessage(text);
    previous.current = state;
  }, [state]);

  const idle = connection === "idle";
  const card = (id: AgentId) => (
    <AgentCard key={id} agent={state.agents[id]} now={now} retrying={retrying} onRetry={state.agents[id].status === "failed" ? onRetry : undefined} />
  );

  return (
    <section aria-labelledby="trace-title" data-testid="trace-panel" data-run-status={state.runStatus ?? "none"} className="rounded-card border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="trace-title" className="text-lg font-extrabold">Live analysis</h2>
          <p className="text-sm text-muted">
            {idle ? "Your results will appear here as each step finishes." : "Watch each step as it works. Nothing is ever sent to a family automatically."}
          </p>
        </div>
        <dl className="flex gap-5 text-right">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Run time</dt>
            <dd data-testid="run-timer" className="flex items-center justify-end gap-1.5 text-xl font-extrabold tabular-nums">
              <ClockIcon className="size-4 text-muted" />
              {formatClock(elapsed)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Cost so far</dt>
            <dd data-testid="run-cost" className="text-xl font-extrabold tabular-nums">{formatUsd(state.totalCostUsd)}</dd>
          </div>
        </dl>
      </div>

      {connection === "reconnecting" && (
        <p role="status" className="mt-4 rounded-xl bg-warn-bg px-4 py-2 text-sm font-semibold text-warn">Connection hiccup. Reconnecting and picking up where we left off…</p>
      )}
      {connection === "expired" && (
        <div className="mt-4"><InlineError action={<Link href="/login" className="font-bold underline">Sign in again</Link>}>Your session has ended, so we can&apos;t show live updates.</InlineError></div>
      )}
      {connection === "lost" && (
        <div className="mt-4"><InlineError action={onReload ? <Button size="sm" variant="secondary" onClick={onReload}>Reload</Button> : undefined}>We lost the live connection. Your run keeps going in the background.</InlineError></div>
      )}

      <ol aria-label="Analysis steps" className={cn("mt-5 space-y-0", idle && "opacity-80")}>
        {card("privacy_guard")}
        <Connector />
        {card("session_analyst")}
        <Connector caption="These two run at the same time" />
        <li className="list-none">
          <ol className="grid gap-3 sm:grid-cols-2">
            {card("progress_monitor")}
            {card("learning_planner")}
          </ol>
        </li>
        <Connector />
        {card("parent_reporter")}
      </ol>

      {state.done && (
        <div
          data-testid="trace-outcome"
          className={cn(
            "mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4",
            state.runStatus === "completed" ? "bg-ok-bg text-ok" : state.runStatus === "partial" ? "bg-warn-bg text-warn" : "bg-bad-bg text-bad",
          )}
        >
          <p className="font-bold">
            {state.runStatus === "completed" && `All done in ${formatClock(elapsed)}. The parent update is a draft for ops to review.`}
            {state.runStatus === "partial" && `Finished with some steps missing: ${failed.map((id) => AGENT_INFO[id].name).join(", ") || "see above"}. You can retry them.`}
            {state.runStatus === "failed" && "This run couldn't finish. You can retry the step that needs attention."}
          </p>
          {runId && state.runStatus !== "failed" ? (
            <Link href={`/runs/${runId}`} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent-strong px-5 font-semibold text-white hover:bg-[#9a4315]">
              View full results <ArrowRightIcon className="size-4" />
            </Link>
          ) : null}
        </div>
      )}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{message}</div>
    </section>
  );
}
