"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { InlineError } from "@/components/ui/states";
import { apiFetch, ApiClientError } from "@/lib/api-client";

interface AlertRow {
  id: string;
  severity: "low" | "medium" | "high";
  status: "open" | "resolved";
  createdAt: string;
  reason: string;
  intervention: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  learner: { id: string; displayName: string; tutorName: string };
}

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");

export function AlertsView() {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ alerts: AlertRow[]; openCount: number }>(`/api/alerts?status=${status}`);
      setRows(d.alerts);
      setOpenCount(d.openCount);
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [status]);
  useEffect(() => void load(), [load]);

  async function resolve(id: string) {
    setBusy(id);
    try {
      await apiFetch(`/api/alerts/${id}/resolve`, { method: "POST", json: { note: notes[id] ?? "" } });
      await load();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Alerts</h1>
      <p className="mt-1 text-muted">Learners who may need a call or a change of plan.</p>
      <div role="group" aria-label="Filter alerts" className="mt-4 flex gap-1.5">
        {(["open", "resolved"] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => { setRows(null); setStatus(s); }} className={cn("min-h-9 rounded-full px-3.5 text-sm font-semibold", status === s ? "bg-accent-strong text-white" : "bg-surface ring-1 ring-line hover:bg-accent-soft")}>
            {s === "open" ? `Open (${openCount})` : "Resolved"}
          </button>
        ))}
      </div>
      {error ? <div className="mt-4"><InlineError>{error}</InlineError></div> : null}
      {rows === null ? <p className="mt-4 text-muted">Loading…</p> : rows.length === 0 ? (
        <p className="mt-4 rounded-card border border-dashed border-line bg-surface p-6 text-center text-muted">{status === "open" ? "No open alerts. Nothing needs attention right now." : "No resolved alerts yet."}</p>
      ) : (
        <ul className="mt-4 space-y-4" data-testid="alerts">
          {rows.map((a) => (
            <li key={a.id} className="rounded-card border border-line bg-surface p-5 shadow-card" data-testid="alert" data-severity={a.severity}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full px-3 py-1 text-sm font-bold", a.severity === "high" ? "bg-bad-bg text-bad" : a.severity === "medium" ? "bg-warn-bg text-warn" : "bg-idle-bg text-idle")}>{a.severity[0]!.toUpperCase() + a.severity.slice(1)}</span>
                <Link href={`/learners/${a.learner.id}`} className="text-lg font-extrabold underline-offset-2 hover:underline">{a.learner.displayName}</Link>
                <span className="text-sm text-muted">Tutor {a.learner.tutorName}</span>
              </div>
              <p className="mt-3 font-semibold">{a.reason}</p>
              <p className="mt-1 text-muted">Suggested: {a.intervention}</p>
              {a.status === "open" ? (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <label className="min-w-64 flex-1 text-sm font-semibold">What was done?
                    <input value={notes[a.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} className="mt-1 block min-h-11 w-full rounded-xl border border-field bg-surface px-3 font-normal" maxLength={1000} />
                  </label>
                  <Button size="sm" variant="secondary" loading={busy === a.id} disabled={!(notes[a.id] ?? "").trim() || busy !== null} onClick={() => resolve(a.id)}>Mark resolved</Button>
                </div>
              ) : <p className="mt-3 text-sm text-muted">Resolved{a.resolutionNote ? `: ${a.resolutionNote}` : ""}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
