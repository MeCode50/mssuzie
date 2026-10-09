"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ArrowRightIcon } from "@/components/ui/icons";
import { InlineError } from "@/components/ui/states";
import { StatusBadge, type LearnerStatus } from "@/components/ui/status-badge";
import { TracePanel } from "@/components/trace/trace-panel";
import { useRunStream } from "@/components/trace/use-run-stream";
import { ApiClientError, createRun, makeKeyKeeper, retryRun } from "@/lib/api-client";
import { exampleNotes } from "@/lib/example-notes";
import { counterState, MAX_NOTES } from "./notes-counter";

export interface LearnerOption {
  id: string;
  displayName: string;
  grade: string;
  subjects: string[];
  status: LearnerStatus;
}

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : "Something went wrong. Please try again.");
const fieldClass = "mt-1.5 block w-full rounded-xl border border-field bg-surface px-4 text-base placeholder:text-muted disabled:bg-idle-bg disabled:text-muted";

export function NewSession({ learners, initialLearnerId, initialRunId }: { learners: LearnerOption[]; initialLearnerId: string | null; initialRunId: string | null }) {
  const learnerId_ = useId();
  const notesId = useId();
  const helpId = useId();
  const [learnerId, setLearnerId] = useState(initialLearnerId ?? "");
  const [notes, setNotes] = useState("");
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyFor = useRef(makeKeyKeeper()).current;
  const panelRef = useRef<HTMLDivElement>(null);
  const { state, connection, restart, reset } = useRunStream(runId);

  const learner = learners.find((l) => l.id === learnerId) ?? null;
  const counter = counterState(notes.length);
  const trimmed = notes.trim();
  const running = runId !== null && !state.done && connection !== "expired" && connection !== "lost";
  const canRun = !!learner && trimmed.length > 0 && notes.length <= MAX_NOTES && !submitting && !running;
  const whyNot = !learner ? "Choose a learner to continue." : trimmed.length === 0 ? "Paste the session notes to continue." : notes.length > MAX_NOTES ? "Shorten the notes to 8,000 characters or fewer." : null;

  // Keep the URL in step with the run, so a refresh re-attaches to it instead of losing it.
  useEffect(() => {
    const url = runId ? `/sessions/new?run=${runId}` : "/sessions/new";
    window.history.replaceState(null, "", url);
  }, [runId]);

  // Quiet announcement only at the thresholds that matter, not on every keystroke.
  const announce = useMemo(() => counter.announce, [counter.announce]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canRun || !learner) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createRun({ learnerId: learner.id, notes: trimmed }, keyFor(learner.id, trimmed));
      reset();
      setRunId(created.runId);
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
      panelRef.current?.focus({ preventScroll: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onRetry() {
    if (!runId) return;
    setRetrying(true);
    setError(null);
    try {
      await retryRun(runId);
      restart();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRetrying(false);
    }
  }

  function startAnother() {
    reset();
    setRunId(null);
    setNotes("");
    setError(null);
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">New session</h1>
        <p className="mt-1 max-w-prose text-muted">Paste the tutor&apos;s notes. In about a minute you&apos;ll have progress data, a risk check, a two-week plan and a parent update draft.</p>

        <Card className="mt-5">
          <form onSubmit={onSubmit} noValidate>
            <fieldset disabled={running} className="space-y-5">
              <div>
                <label htmlFor={learnerId_} className="font-semibold">Who was the session with?</label>
                <select id={learnerId_} value={learnerId} onChange={(e) => setLearnerId(e.target.value)} className={cn(fieldClass, "min-h-11")}>
                  <option value="" disabled>Choose a learner…</option>
                  {learners.map((l) => (
                    <option key={l.id} value={l.id}>{l.displayName} · {l.grade}</option>
                  ))}
                </select>
                {learner ? (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                    <StatusBadge status={learner.status} />
                    <span>{learner.subjects.join(", ")}</span>
                  </p>
                ) : null}
              </div>

              <div>
                <div className="flex items-end justify-between gap-3">
                  <label htmlFor={notesId} className="font-semibold">Session notes</label>
                  <button
                    type="button" disabled={!learner} onClick={() => learner && setNotes(exampleNotes(learner.displayName))}
                    className="rounded-full px-3 py-1 text-sm font-semibold text-accent-strong hover:bg-accent-soft disabled:text-muted disabled:hover:bg-transparent"
                  >
                    Use example notes
                  </button>
                </div>
                <textarea
                  id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)} rows={11} aria-describedby={`${helpId} ${notesId}-count`}
                  aria-invalid={notes.length > MAX_NOTES || undefined} placeholder="What did you cover? How did it go? What was homework?"
                  className={cn(fieldClass, "min-h-56 resize-y py-3 leading-relaxed", notes.length > MAX_NOTES && "border-bad ring-2 ring-bad")}
                />
                <div className="mt-1.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <p id={helpId} className="max-w-sm text-sm text-muted">Names, schools and contact details are replaced with placeholders before any AI sees the notes.</p>
                  <p id={`${notesId}-count`} data-testid="notes-counter" className={cn("text-sm font-semibold tabular-nums", counter.tone === "ok" && "text-muted", counter.tone === "near" && "text-warn", counter.tone === "over" && "text-bad")}>
                    {counter.text}
                  </p>
                </div>
                <p className="sr-only" role="status" aria-live="polite">{announce}</p>
              </div>
            </fieldset>

            {error ? <div className="mt-5" aria-live="polite"><InlineError>{error}</InlineError></div> : null}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button type="submit" loading={submitting || running} disabled={!canRun && !submitting && !running} icon={!submitting && !running ? <ArrowRightIcon className="size-4" /> : undefined} className="w-full sm:w-auto" data-testid="run-button">
                {submitting ? "Starting…" : running ? "Analysing…" : "Run analysis"}
              </Button>
              {runId && state.done ? <Button variant="secondary" onClick={startAnother}>Start another session</Button> : null}
              {whyNot && !running ? <p className="text-sm text-muted">{whyNot}</p> : null}
            </div>
          </form>
        </Card>
      </div>

      <div ref={panelRef} tabIndex={-1} className="scroll-mt-4 outline-none lg:sticky lg:top-6">
        <TracePanel state={state} connection={connection} runId={runId} onRetry={onRetry} retrying={retrying} onReload={() => window.location.reload()} />
      </div>
    </div>
  );
}
