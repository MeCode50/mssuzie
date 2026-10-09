"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TracePanel } from "@/components/trace/trace-panel";
import { useRunStream } from "@/components/trace/use-run-stream";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { CheckIcon, CopyIcon, RefreshIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { approveParentUpdate, ApiClientError, retryRun } from "@/lib/api-client";
import { AGENT_IDS, AGENT_INFO, formatDuration, formatUsd, type AgentId } from "@/lib/trace";
import type { serializeRun } from "@/lib/runs";

export type RunData = Awaited<ReturnType<typeof serializeRun>>;

const dateOnly = (iso: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
const stamp = (d: string | Date) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(d)) + " UTC";
const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");

const RUN_LABEL: Record<string, { text: string; classes: string }> = {
  completed: { text: "Completed", classes: "bg-ok-bg text-ok" },
  partial: { text: "Finished with steps missing", classes: "bg-warn-bg text-warn" },
  failed: { text: "Couldn't finish", classes: "bg-bad-bg text-bad" },
  queued: { text: "Waiting to start", classes: "bg-idle-bg text-idle" },
  running: { text: "Running", classes: "bg-accent-soft text-accent-strong" },
};

function ParentUpdateTab({ data, isOps, onChanged }: { data: RunData; isOps: boolean; onChanged: () => void }) {
  const update = data.parentUpdate;
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!update) {
    return <Card><p className="font-semibold">No draft yet.</p><p className="mt-1 text-muted">The Parent Reporter step hasn&apos;t produced a draft. If it needs attention, use Retry above.</p></Card>;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(update!.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Couldn't copy automatically. Please select the text and copy it.");
    }
  }
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await approveParentUpdate(update!.id);
      onChanged();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="update-status" className={cn("rounded-full px-3 py-1 text-sm font-bold", update.status === "approved" ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn")}>
          {update.status === "approved" ? `Approved ${update.approvedAt ? stamp(update.approvedAt) : ""}` : "Draft: not sent"}
        </span>
        <p className="text-sm text-muted">Nothing is sent automatically. Approving marks it ready for a person to send.</p>
      </div>
      <Card className="bg-cream"><p data-testid="update-body" className="whitespace-pre-wrap text-base leading-relaxed">{update.body}</p></Card>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        {isOps && update.status === "draft" ? <Button loading={busy} onClick={approve} data-testid="approve-button">Approve</Button> : null}
        {!isOps && update.status === "draft" ? <p className="text-sm text-muted">Only the MsSuzie ops team can approve updates.</p> : null}
        <span className="sr-only" role="status" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
      </div>
    </div>
  );
}

function StatusTab({ data }: { data: RunData }) {
  const m = data.results.monitor;
  if (!m) return <Card><p className="font-semibold">No progress check yet.</p><p className="mt-1 text-muted">The Progress Monitor step hasn&apos;t finished. Use Retry above if it needs attention.</p></Card>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={m.status} className="text-base" />
        {data.alert ? <span className="rounded-full bg-bad-bg px-3 py-1 text-sm font-bold text-bad">Refund-risk alert {data.alert.status}</span> : null}
      </div>
      <Card>
        <h3 className="font-bold">Why</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">{m.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <h3 className="mt-5 font-bold">Suggested next step</h3>
        <p className="mt-1">{m.suggestedIntervention}</p>
      </Card>
      {data.results.analysis ? (
        <Card>
          <h3 className="font-bold">Skills seen this session</h3>
          <ul className="mt-3 space-y-3">
            {data.results.analysis.skills.map((s) => (
              <li key={s.skill}>
                <div className="flex items-center justify-between gap-3"><span className="font-semibold">{s.skill}</span><span className="tabular-nums text-muted">{Math.round(s.mastery * 100)}%</span></div>
                <div className="mt-1 h-2 rounded-full bg-idle-bg" role="img" aria-label={`${Math.round(s.mastery * 100)} percent mastery`}><div className="h-2 rounded-full bg-accent-strong" style={{ width: `${Math.round(s.mastery * 100)}%` }} /></div>
                <p className="mt-1 text-sm text-muted">&ldquo;{s.evidence}&rdquo;</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function PlanTab({ data }: { data: RunData }) {
  const plan = data.results.plan;
  if (!plan) return <Card><p className="font-semibold">No plan yet.</p><p className="mt-1 text-muted">The Learning Planner step hasn&apos;t finished. Use Retry above if it needs attention.</p></Card>;
  return (
    <div className="space-y-4">
      <p className="max-w-prose">{plan.summary}</p>
      <ol className="space-y-3">
        {plan.sessions.map((s, i) => (
          <li key={`${s.date}-${i}`}>
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-bold">{dateOnly(s.date)} <span className="font-semibold text-muted">· {s.durationMin} min</span></h3>
                <span className="rounded-full bg-accent-soft px-3 py-0.5 text-sm font-semibold text-accent-strong">{s.focusSkill}</span>
              </div>
              <p className="mt-2"><span className="font-semibold">Goal:</span> {s.goal}</p>
              <p className="mt-1 text-sm text-muted">{s.reason}</p>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PrivacyTab({ data }: { data: RunData }) {
  const p = data.results.privacy;
  if (!p) return <Card><p className="font-semibold">No privacy log yet.</p><p className="mt-1 text-muted">The Privacy Guard step hasn&apos;t finished.</p></Card>;
  const total = p.log.reduce((n, e) => n + e.occurrences, 0);
  return (
    <div className="space-y-4">
      <p className="max-w-prose text-muted">Before any AI saw the notes, <strong className="text-ink">{total}</strong> personal detail{total === 1 ? " was" : "s were"} replaced with placeholders. The originals are encrypted and deleted after 30 days.</p>
      <Card className="bg-cream"><h3 className="font-bold">What the AI saw</h3><p data-testid="redacted-notes" className="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">{p.redactedNotes}</p></Card>
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Placeholders used</caption>
          <thead className="bg-idle-bg text-idle"><tr><th className="px-4 py-2 font-bold">Placeholder</th><th className="px-4 py-2 font-bold">Kind</th><th className="px-4 py-2 font-bold">Found by</th><th className="px-4 py-2 text-right font-bold">Times</th></tr></thead>
          <tbody>
            {p.log.map((e) => (
              <tr key={e.token} className="border-t border-line"><td className="px-4 py-2 font-mono">{e.token}</td><td className="px-4 py-2">{e.category.toLowerCase()}</td><td className="px-4 py-2">{e.source === "code" ? "Exact match" : "AI check"}</td><td className="px-4 py-2 text-right tabular-nums">{e.occurrences}</td></tr>
            ))}
            {p.log.length === 0 ? <tr><td colSpan={4} className="px-4 py-3 text-muted">Nothing needed replacing.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentTable({ data }: { data: RunData }) {
  const rows = AGENT_IDS.map((id) => ({ id, a: data.agents[id] as { status: string; attempt?: number; durationMs?: number; tokensIn?: number; tokensOut?: number; costUsd?: number; model?: string | null } }));
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-left text-sm" data-testid="agent-table">
        <caption className="sr-only">Per-agent time, tokens and cost</caption>
        <thead className="bg-idle-bg text-idle"><tr><th className="px-4 py-2 font-bold">Agent</th><th className="px-4 py-2 font-bold">Status</th><th className="px-4 py-2 text-right font-bold">Time</th><th className="px-4 py-2 text-right font-bold">Tokens</th><th className="px-4 py-2 text-right font-bold">Cost</th></tr></thead>
        <tbody>
          {rows.map(({ id, a }) => (
            <tr key={id} className="border-t border-line">
              <td className="px-4 py-2 font-semibold">{AGENT_INFO[id as AgentId].name}{(a.attempt ?? 1) > 1 ? <span className="ml-1 text-muted">(attempt {a.attempt})</span> : null}</td>
              <td className="px-4 py-2 capitalize">{a.status}</td>
              <td className="px-4 py-2 text-right tabular-nums">{a.durationMs !== undefined ? formatDuration(a.durationMs) : "-"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{a.tokensIn !== undefined ? ((a.tokensIn ?? 0) + (a.tokensOut ?? 0)).toLocaleString("en-US") : "-"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{a.costUsd !== undefined ? formatUsd(a.costUsd) : "-"}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-line bg-cream font-bold"><td className="px-4 py-2" colSpan={3}>Whole run</td><td className="px-4 py-2 text-right tabular-nums">{data.run.totalTokens.toLocaleString("en-US")}</td><td className="px-4 py-2 text-right tabular-nums">{formatUsd(data.run.costUsd)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export function RunView({ data, isOps }: { data: RunData; isOps: boolean }) {
  const router = useRouter();
  const live = data.run.status === "queued" || data.run.status === "running";
  const [following, setFollowing] = useState(live);
  const { state, connection, restart } = useRunStream(following ? data.run.id : null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsRetry = data.run.status === "partial" || data.run.status === "failed";
  const label = RUN_LABEL[data.run.status] ?? RUN_LABEL.running!;

  // When the live run finishes, pull the final results from the server, then tuck the live panel away:
  // the results below replace it. (Kept for a moment so people see the "all done" confirmation.)
  useEffect(() => {
    if (!following || !state.done) return;
    router.refresh();
    const id = setTimeout(() => setFollowing(false), 2500);
    return () => clearTimeout(id);
  }, [following, state.done, router]);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      await retryRun(data.run.id);
      setFollowing(true);
      restart();
      router.refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/sessions/new?learner=${data.run.learner.id}`} className="text-sm font-semibold text-accent-strong hover:underline">← New session for {data.run.learner.displayName.split(" ")[0]}</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{data.run.learner.displayName}</h1>
          <span data-testid="run-status" className={cn("rounded-full px-3 py-1 text-sm font-bold", label.classes)}>{label.text}</span>
        </div>
        <p className="mt-1 text-muted">Session on {stamp(data.run.heldAt)}</p>
      </div>

      {error ? <InlineError>{error}</InlineError> : null}
      {needsRetry && !following ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-warn-bg p-4 text-warn" data-testid="retry-banner">
          <p className="font-bold">{data.run.status === "failed" ? "This run couldn't finish." : "Some steps need attention."} Retrying re-runs only the steps that failed.</p>
          <Button variant="secondary" icon={<RefreshIcon className="size-4" />} loading={retrying} onClick={retry}>Retry failed steps</Button>
        </div>
      ) : null}

      {following ? <TracePanel state={state} connection={connection} runId={null} onRetry={retry} retrying={retrying} onReload={() => router.refresh()} /> : null}

      <Tabs
        tabs={[
          { id: "update", label: "Parent update", content: <ParentUpdateTab data={data} isOps={isOps} onChanged={() => router.refresh()} /> },
          { id: "status", label: "Progress status", content: <StatusTab data={data} /> },
          { id: "plan", label: "Learning plan", content: <PlanTab data={data} /> },
          { id: "privacy", label: "Privacy log", content: <PrivacyTab data={data} /> },
        ]}
      />

      <section aria-labelledby="agents-title">
        <h2 id="agents-title" className="mb-3 text-lg font-extrabold">Time, tokens and cost</h2>
        <AgentTable data={data} />
      </section>
    </div>
  );
}
