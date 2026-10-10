"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ArrowRightIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { ApiClientError, fetchRequest, retryRun, sendReschedule } from "@/lib/api-client";
import { examplesFor } from "@/lib/reschedule-examples";
import type { GuardianOption, RequestCounts, RequestDetail, RequestSummary } from "@/lib/reschedule-types";
import { OutcomeCard } from "./outcome-card";
import { RequestFeed } from "./request-feed";
import { RescheduleTrace } from "./trace";
import { useRescheduleStream } from "./use-reschedule-stream";

const MAX = 2000;
const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");
const fieldClass = "mt-1.5 block w-full rounded-xl border border-field bg-surface px-4 text-base placeholder:text-muted disabled:bg-idle-bg disabled:text-muted";

function clockIn(zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date());
}

export interface SimulatorProps {
  guardians: GuardianOption[];
  feed: { requests: RequestSummary[]; counts: RequestCounts };
  initial: { requestId: string; runId: string } | null;
}

export function Simulator({ guardians, feed, initial }: SimulatorProps) {
  const parentId = useId();
  const messageId = useId();
  const [guardianId, setGuardianId] = useState("");
  const [message, setMessage] = useState("");
  const [current, setCurrent] = useState<{ requestId: string; runId: string } | null>(initial);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const { state, connection, restart, reset } = useRescheduleStream(current?.runId ?? null);

  const guardian = guardians.find((g) => g.id === guardianId) ?? null;
  const examples = guardian ? examplesFor(guardian) : [];
  const running = current !== null && !state.done && connection !== "expired" && connection !== "lost";
  const trimmed = message.trim();
  const canSend = !!guardian && trimmed.length > 0 && message.length <= MAX && !submitting && !running;
  const whyNot = !guardian ? "Choose who the message is from." : trimmed.length === 0 ? "Type or pick a message to continue." : message.length > MAX ? "Shorten the message to 2,000 characters or fewer." : null;

  // Keep the address in step with the request so a refresh re-attaches instead of losing it.
  useEffect(() => {
    window.history.replaceState(null, "", current ? `/reschedules?request=${current.requestId}&run=${current.runId}` : "/reschedules");
  }, [current]);

  // When the agents finish, load the outcome and refresh the feed.
  useEffect(() => {
    if (!current || !state.done) return;
    let alive = true;
    fetchRequest(current.requestId).then((d) => alive && (setDetail(d), setRefreshKey((k) => k + 1))).catch((e: unknown) => alive && setError(messageOf(e)));
    return () => void (alive = false);
  }, [current, state.done]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSend || !guardian) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await sendReschedule({ guardianId: guardian.id, message: trimmed });
      reset();
      setDetail(null);
      setCurrent(created);
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRetry() {
    if (!current) return;
    setRetrying(true);
    setError(null);
    try {
      await retryRun(current.runId);
      setDetail(null);
      restart();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRetrying(false);
    }
  }

  function another() {
    reset();
    setDetail(null);
    setCurrent(null);
    setMessage("");
    setError(null);
  }

  async function reload() {
    if (!current) return;
    try {
      setDetail(await fetchRequest(current.requestId));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <div className="space-y-10">
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Reschedules</h1>
          <p className="mt-1 max-w-prose text-muted">
            Pretend to be a parent asking to move a class. The agents work out what they want, check the tutor&apos;s calendar and either move it, offer other times, or hand it to Ops.
          </p>

          <Card className="mt-5">
            <form onSubmit={onSubmit} noValidate>
              <fieldset disabled={running} className="space-y-5">
                <div>
                  <label htmlFor={parentId} className="font-semibold">Message from</label>
                  <select id={parentId} value={guardianId} onChange={(e) => setGuardianId(e.target.value)} className={cn(fieldClass, "min-h-11")} data-testid="parent-select">
                    <option value="" disabled>Choose a parent…</option>
                    {guardians.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.learner.displayName.split(" ")[0]}&apos;s parent</option>)}
                  </select>
                  {guardian ? (
                    <div className="mt-3 rounded-2xl bg-idle-bg p-3 text-sm" data-testid="parent-info">
                      <p><span className="font-semibold">Tutor:</span> {guardian.tutor.name}</p>
                      <p className="text-muted">Parent&apos;s clock now: {clockIn(guardian.timezone)} ({guardian.timezone}) · Tutor&apos;s: {clockIn(guardian.tutor.timezone)} ({guardian.tutor.timezone})</p>
                      {guardian.upcoming.length > 0 ? (
                        <p className="mt-1 text-muted">Next classes: {guardian.upcoming.map((u) => u.local).join(" · ")}</p>
                      ) : <p className="mt-1 text-muted">No upcoming classes.</p>}
                    </div>
                  ) : null}
                </div>

                <div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <label htmlFor={messageId} className="font-semibold">Their message</label>
                  </div>
                  {examples.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Example messages">
                      {examples.map((ex) => (
                        <button key={ex.id} type="button" title={ex.hint} data-testid={`example-${ex.id}`} onClick={() => setMessage(ex.text)} className="min-h-9 rounded-full bg-surface px-3 text-sm font-semibold text-accent-strong ring-1 ring-line hover:bg-accent-soft">
                          {ex.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <textarea
                    id={messageId} value={message} onChange={(e) => setMessage(e.target.value)} rows={5} placeholder="e.g. Hi, can we move Amara's 7am class on Monday to 7pm please?"
                    aria-invalid={message.length > MAX || undefined} className={cn(fieldClass, "min-h-32 resize-y py-3 leading-relaxed", message.length > MAX && "border-bad ring-2 ring-bad")} data-testid="message"
                  />
                  <p className="mt-1.5 text-sm text-muted">Names and contact details are replaced with placeholders before any AI reads the message. <span className="tabular-nums">{message.length.toLocaleString("en-US")} / {MAX.toLocaleString("en-US")}</span></p>
                </div>
              </fieldset>

              {error ? <div className="mt-5" aria-live="polite"><InlineError>{error}</InlineError></div> : null}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button type="submit" loading={submitting || running} disabled={!canSend && !submitting && !running} icon={!submitting && !running ? <ArrowRightIcon className="size-4" /> : undefined} className="w-full sm:w-auto" data-testid="send-button">
                  {submitting ? "Sending…" : running ? "Working…" : "Send message"}
                </Button>
                {current && state.done ? <Button variant="secondary" onClick={another}>Try another message</Button> : null}
                {whyNot && !running ? <p className="text-sm text-muted">{whyNot}</p> : null}
              </div>
            </form>
          </Card>
        </div>

        <div ref={panelRef} tabIndex={-1} className="scroll-mt-4 space-y-5 outline-none lg:sticky lg:top-6">
          <RescheduleTrace state={state} connection={connection} onRetry={onRetry} retrying={retrying} onReload={() => window.location.reload()} idleText="Send a message and watch each step as it works." />
          {detail ? <OutcomeCard detail={detail} onChanged={reload} /> : null}
        </div>
      </div>

      <RequestFeed initial={feed} refreshKey={refreshKey} highlightId={current?.requestId ?? null} />
    </div>
  );
}
