"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { InlineError } from "@/components/ui/states";
import { ApiClientError, fetchRequests } from "@/lib/api-client";
import { DECISION_INFO, TONE_CLASS, type RequestCounts, type RequestSummary } from "@/lib/reschedule-types";

const TABS = [
  { id: "all", label: "All" },
  { id: "needs_person", label: "Needs a person" },
  { id: "waiting", label: "Waiting for parent" },
  { id: "done", label: "Done" },
] as const;

const ago = (iso: string): string => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export interface RequestFeedProps {
  initial: { requests: RequestSummary[]; counts: RequestCounts };
  /** Change this to make the feed reload (e.g. after a run finishes). */
  refreshKey?: number;
  /** Request to mark as the one just sent. */
  highlightId?: string | null;
}

export function RequestFeed({ initial, refreshKey = 0, highlightId = null }: RequestFeedProps) {
  const [filter, setFilter] = useState<(typeof TABS)[number]["id"]>("all");
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [first, setFirst] = useState(true);

  useEffect(() => {
    // The server already rendered the first view; only reload when the filter or refresh key changes.
    if (first && filter === "all" && refreshKey === 0) return setFirst(false);
    setFirst(false);
    let alive = true;
    fetchRequests(filter)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof ApiClientError ? e.message : "We couldn't load the requests."));
    return () => void (alive = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, refreshKey]);

  return (
    <section aria-labelledby="feed-title" data-testid="request-feed">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="feed-title" className="text-xl font-extrabold">Requests</h2>
        <div role="group" aria-label="Filter requests" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" aria-pressed={filter === t.id} onClick={() => setFilter(t.id)} data-testid={`filter-${t.id}`}
              className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", filter === t.id ? "bg-accent-strong text-white" : "bg-surface text-ink ring-1 ring-line hover:bg-accent-soft")}
            >
              {t.label} <span className="tabular-nums opacity-80">{data.counts[t.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mt-3"><InlineError>{error}</InlineError></div> : null}

      {data.requests.length === 0 ? (
        <p className="mt-4 rounded-card border border-dashed border-line bg-surface p-6 text-center text-muted">Nothing here yet. Send a message above to see the agents at work.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {data.requests.map((r) => {
            const info = DECISION_INFO[r.decision ?? "working"];
            return (
              <li key={r.id} data-testid="request-row" data-decision={r.decision ?? "working"} className={cn(r.id === highlightId && "bg-accent-soft/60")}>
                <Link href={`/reschedules/${r.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent-soft/40">
                  <span className={cn("shrink-0 rounded-full px-3 py-1 text-sm font-bold", TONE_CLASS[info.tone])}>{info.label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{r.learner.displayName.split(" ")[0]}&apos;s class <span className="font-normal text-muted">· {r.guardian.name}</span></span>
                    <span className="block truncate text-sm text-muted">
                      {r.moved ? `${r.moved.from.parentLocal} → ${r.moved.to.parentLocal}` : (r.reason ?? r.understood ?? "Being worked on…")}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-muted">{ago(r.createdAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
