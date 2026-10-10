"use client";

import Link from "next/link";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ApiClientError, fetchRequest, retryRun } from "@/lib/api-client";
import type { RequestDetail } from "@/lib/reschedule-types";
import { OutcomeCard } from "./outcome-card";
import { RescheduleTrace } from "./trace";
import { useRescheduleStream } from "./use-reschedule-stream";
import { InlineError } from "@/components/ui/states";

/** One request: the parent's message, what the agents did (replayed from the stored steps), the outcome and Ops actions. */
export function RequestView({ initial }: { initial: RequestDetail }) {
  const [detail, setDetail] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { state, connection, restart } = useRescheduleStream(detail.runId);

  async function reload() {
    try {
      setDetail(await fetchRequest(detail.id));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "We couldn't refresh this request.");
    }
  }
  async function onRetry() {
    if (!detail.runId) return;
    setRetrying(true);
    try {
      await retryRun(detail.runId);
      restart();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "We couldn't retry. Please try again.");
    } finally {
      setRetrying(false);
    }
  }

  const first = detail.learner.displayName.split(" ")[0];
  return (
    <div className="space-y-6">
      <div>
        <Link href="/reschedules" className="text-sm font-semibold text-accent-strong underline-offset-2 hover:underline">← All reschedules</Link>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">{first}&apos;s class</h1>
        <p className="text-muted">From {detail.guardian.name} · tutor {detail.tutor.name} · {new Date(detail.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
      </div>
      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">The parent&apos;s message</h2>
        <blockquote data-testid="parent-message" className="mt-2 whitespace-pre-wrap border-l-4 border-accent pl-4 text-lg leading-relaxed">{detail.message}</blockquote>
      </Card>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <RescheduleTrace state={state} connection={connection} onRetry={onRetry} retrying={retrying} onReload={() => window.location.reload()} />
        <OutcomeCard detail={detail} onChanged={reload} />
      </div>
    </div>
  );
}
