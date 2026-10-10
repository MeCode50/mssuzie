"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ArrowRightIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { ApiClientError, approveTime, declineRequest, retryRun } from "@/lib/api-client";
import { DECISION_INFO, KIND_LABEL, ROLE_LABEL, TONE_CLASS, type RequestDetail } from "@/lib/reschedule-types";
import { utcToWallTime, wallTimeToUtc } from "@/lib/zone-time";

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");
const fieldClass = "mt-1.5 block w-full rounded-xl border border-field bg-surface px-4 text-base placeholder:text-muted";

function When({ label, parent, tutor, strong }: { label: string; parent: string; tutor: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-2xl p-4", strong ? "bg-ok-bg" : "bg-idle-bg")}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-bold" data-testid={`when-${label.toLowerCase()}`}>{parent}</p>
      <p className="text-sm text-muted">{tutor}</p>
    </div>
  );
}

export interface OutcomeCardProps {
  detail: RequestDetail;
  /** Called after Ops change something, so the page can reload the request. */
  onChanged: () => void;
}

/** What happened to a request: the decision, before and after in both zones, messages sent, and what Ops can do next. */
export function OutcomeCard({ detail, onChanged }: OutcomeCardProps) {
  const info = DECISION_INFO[detail.decision ?? "working"];
  const noteId = useId();
  const timeId = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState(() => (detail.requested ? utcToWallTime(new Date(detail.requested.startsAt), detail.guardian.timezone) : ""));
  const [notice, setNotice] = useState<string | null>(null);

  async function run(key: string, work: () => Promise<{ problems: { step: string; error: string }[] } | unknown>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = (await work()) as { problems?: { step: string; error: string }[] };
      if (res?.problems?.length) setNotice(`Done, but ${res.problems.map((p) => p.error).join(" ")}`);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  }

  const pickedUtc = picked ? wallTimeToUtc(picked, detail.guardian.timezone) : null;
  const needsRetry = detail.runStatus === "partial" || detail.runStatus === "failed";

  return (
    <Card data-testid="outcome-card" data-decision={detail.decision ?? "working"} aria-labelledby="outcome-title">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="outcome-title" className="text-lg font-extrabold">Outcome</h2>
        <span data-testid="decision-badge" className={cn("rounded-full px-3 py-1 text-sm font-bold", TONE_CLASS[info.tone])}>{info.label}</span>
      </div>
      <p className="mt-2 text-muted">{info.blurb}</p>
      {detail.reason ? <p data-testid="decision-reason" className="mt-3 rounded-2xl bg-idle-bg p-4 font-semibold">{detail.reason}</p> : null}
      {detail.understood ? <p className="mt-3 text-sm text-muted"><span className="font-semibold text-ink">What we understood:</span> {detail.understood}</p> : null}

      {detail.moved ? (
        <div className="mt-5" data-testid="before-after">
          <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <When label="Before" parent={detail.moved.from.parentLocal} tutor={`Tutor: ${detail.moved.from.tutorLocal}`} />
            <ArrowRightIcon className="mx-auto hidden size-6 text-muted sm:block" />
            <When label="After" parent={detail.moved.to.parentLocal} tutor={`Tutor: ${detail.moved.to.tutorLocal}`} strong />
          </div>
          <p className="mt-2 text-xs text-muted">Top line is the parent&apos;s time ({detail.guardian.timezone}); below it, the tutor&apos;s ({detail.tutor.timezone}).</p>
          {detail.booking && !detail.booking.calendarSynced ? <p role="status" className="mt-3 rounded-xl bg-warn-bg px-4 py-2 text-sm font-semibold text-warn">The calendar hasn&apos;t been updated yet.</p> : null}
        </div>
      ) : detail.requested ? (
        <div className="mt-5"><When label="Asked for" parent={detail.requested.parentLocal} tutor={`Tutor: ${detail.requested.tutorLocal}`} /></div>
      ) : null}

      {detail.options.length > 0 && detail.decision === "proposed" ? (
        <div className="mt-5">
          <h3 className="font-bold">Times offered to the parent</h3>
          <ul className="mt-2 space-y-2" data-testid="options">
            {detail.options.map((o) => (
              <li key={o.startsAt} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line p-3">
                <div>
                  <p className="font-semibold">{o.parentLocal}</p>
                  <p className="text-sm text-muted">Tutor: {o.tutorLocal}</p>
                </div>
                {detail.canChooseTime ? (
                  <Button size="sm" variant="secondary" loading={busy === `pick-${o.startsAt}`} disabled={busy !== null} onClick={() => run(`pick-${o.startsAt}`, () => approveTime(detail.id, o.startsAt))}>Choose this time</Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">The parent has a link for each time. Whichever is used first wins; the others stop working.</p>
        </div>
      ) : null}

      {detail.canChooseTime && detail.decision === "escalated" ? (
        <div className="mt-5 rounded-2xl border border-line p-4">
          <h3 className="font-bold">Choose a time yourself</h3>
          <label htmlFor={timeId} className="mt-2 block text-sm font-semibold">New time ({detail.guardian.timezone})</label>
          <input id={timeId} type="datetime-local" value={picked} onChange={(e) => setPicked(e.target.value)} className={cn(fieldClass, "min-h-11 max-w-xs")} />
          <p className="mt-1 text-sm text-muted">{pickedUtc ? "We check the tutor's hours and clashes before moving anything." : picked ? "That time doesn't exist in this time zone (clocks change). Pick another." : "Pick a date and time."}</p>
          <Button className="mt-3" size="sm" disabled={!pickedUtc || busy !== null} loading={busy === "pick"} onClick={() => pickedUtc && run("pick", () => approveTime(detail.id, pickedUtc.toISOString()))}>Move the class to this time</Button>
        </div>
      ) : null}

      {detail.canSettle ? (
        <div className="mt-5 rounded-2xl border border-line p-4">
          <h3 className="font-bold">Decline with a note</h3>
          <label htmlFor={noteId} className="mt-2 block text-sm font-semibold">What should the parent know?</label>
          <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Daniel is away that week, so we can't move this class." className={cn(fieldClass, "py-3")} />
          <Button className="mt-3" size="sm" variant="danger" disabled={note.trim().length < 3 || busy !== null} loading={busy === "decline"} onClick={() => run("decline", () => declineRequest(detail.id, note))}>Decline and tell the parent</Button>
        </div>
      ) : null}

      {needsRetry && detail.runId ? (
        <div className="mt-5">
          <Button size="sm" variant="secondary" loading={busy === "retry"} disabled={busy !== null} onClick={() => run("retry", () => retryRun(detail.runId!))}>Retry the steps that need attention</Button>
        </div>
      ) : null}

      {error ? <div className="mt-4"><InlineError>{error}</InlineError></div> : null}
      {notice ? <p role="status" className="mt-4 rounded-xl bg-warn-bg px-4 py-2 text-sm font-semibold text-warn">{notice}</p> : null}

      {detail.notifications.length > 0 ? (
        <div className="mt-6">
          <h3 className="font-bold">Messages</h3>
          <ul className="mt-2 space-y-2" data-testid="messages">
            {detail.notifications.map((n) => (
              <li key={n.id} className="rounded-2xl border border-line">
                <details>
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 px-4 py-2">
                    <span className="font-semibold">{ROLE_LABEL[n.role] ?? n.role}: {KIND_LABEL[n.kind] ?? n.kind}</span>
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", n.status === "failed" ? TONE_CLASS.bad : n.status === "sent" ? TONE_CLASS.ok : TONE_CLASS.idle)}>
                      {n.status === "dry_run" ? "Recorded (not sent)" : n.status === "sent" ? (n.to ? "Sent" : "In app") : "Failed"}
                    </span>
                  </summary>
                  <div className="space-y-2 px-4 pb-4 text-sm">
                    {n.to ? <p className="text-muted">To {n.to}{n.intendedFor ? ` (meant for ${n.intendedFor}; held back because demo mode only emails allowed addresses)` : ""}</p> : null}
                    <p className="font-semibold">{n.subject}</p>
                    <pre className="whitespace-pre-wrap font-sans leading-relaxed">{n.body}</pre>
                    {n.error ? <p className="font-semibold text-bad">{n.error}</p> : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
