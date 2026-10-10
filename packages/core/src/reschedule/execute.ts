import { decryptJson, encryptJson } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { GuardOutputSchema, TokenMapSchema } from "../agents/privacy-guard/index";
import type { LlmConfig } from "../llm/config";
import { assertLock, LockLostError, TOKEN_MAP_RETENTION_DAYS, executeRun, type ExecuteDeps, type RunSummary } from "../pipeline/execute-run";
import { finalizeRun, nextSeq, recordStepEvent } from "../pipeline/record";
import type { AgentName } from "../pipeline/types";
import type { CalendarService } from "../calendar/port";
import type { Mailer } from "../notify/notifier";
import { announceEscalation, announceProposal, completeMove, type ApplyDeps } from "./apply";
import { loadRescheduleWork } from "./load";
import { moveBooking, type MoveRefusal } from "./move";
import { runReschedulePipeline, type ReschedulePrior } from "./pipeline";
import { IntakeSchema, SlotReportSchema } from "./schemas";

const DAY_MS = 86_400_000;

export interface RescheduleDeps extends ExecuteDeps {
  llm: LlmConfig;
  minNoticeHours?: number;
  calendar: CalendarService;
  mailer: Mailer;
  /** HMAC key for accept links in proposal emails. */
  linkSecret?: string;
  /** Public address of the web app (accept links point here). */
  baseUrl: string;
}

const REFUSAL_REASON: Record<MoveRefusal, string> = {
  stale: "The booking was changed by someone else a moment ago, so a person should check it before anything moves.",
  slot_taken: "That time was taken a moment ago, so a person needs to pick another.",
  cancelled: "That class has been cancelled, so there is nothing to move.",
  not_found: "That class could not be found.",
  already_decided: "This request was already settled another way.",
};

/** Outputs of steps that already completed for this run, so a retry only redoes what failed. */
async function loadPrior(prisma: PrismaClient, runId: string, encryptionKey: string) {
  const rows = await prisma.runStep.findMany({ where: { runId, kind: "agent" }, orderBy: { seq: "asc" } });
  const latest = new Map<AgentName, (typeof rows)[number]>();
  for (const r of rows) if (r.status !== "running") latest.set(r.agent, r);
  const out = (a: AgentName) => (latest.get(a)?.status === "completed" ? latest.get(a)!.outputJson : undefined);

  const prior: ReschedulePrior = {};
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { tokenMapEnc: true } });
  const guard = GuardOutputSchema.safeParse(out("privacy_guard"));
  if (guard.success && run.tokenMapEnc) {
    const map = TokenMapSchema.safeParse(decryptJson(run.tokenMapEnc, encryptionKey));
    if (map.success) prior.guard = { redactedNotes: guard.data.redactedNotes, tokenMap: map.data };
  }
  const intake = IntakeSchema.safeParse(out("intake_agent"));
  if (prior.guard && intake.success) prior.intake = intake.data;
  const scheduler = SlotReportSchema.safeParse(out("scheduler_agent"));
  if (prior.intake && scheduler.success) prior.scheduler = scheduler.data;

  const attempts: Partial<Record<AgentName, number>> = {};
  for (const r of rows) if (r.status === "running") attempts[r.agent] = (attempts[r.agent] ?? 0) + 1;
  for (const a of Object.keys(attempts) as AgentName[]) attempts[a] = (attempts[a] ?? 0) + 1;
  return { prior, attempts };
}

/**
 * Execute (or retry) one rescheduling run: understand the request, decide, and carry the decision
 * out (move the booking, update the calendar, email the people). A retry never repeats a step that
 * already happened: a booking that was moved is only followed through (calendar, emails).
 */
export async function executeRescheduleRun(deps: RescheduleDeps, runId: string): Promise<RunSummary> {
  const { prisma, llm, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  try {
    const { request, input, bookingVersions } = await loadRescheduleWork(prisma, runId, encryptionKey, { now: now(), minNoticeHours: deps.minNoticeHours ?? 12 });
    const { prior, attempts } = await loadPrior(prisma, runId, encryptionKey);
    let seq = await nextSeq(prisma, runId);
    const sink = async (e: Parameters<typeof recordStepEvent>[3]) => {
      await recordStepEvent(prisma, runId, seq++, e);
      deps.onEvent?.(e);
    };
    const apply: ApplyDeps = { prisma, calendar: deps.calendar, mailer: deps.mailer, linkSecret: deps.linkSecret, baseUrl: deps.baseUrl, now, emit: sink, attempts };

    const { startedAt } = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { startedAt: true } });
    await prisma.run.update({ where: { id: runId }, data: { status: "running", finishedAt: null, startedAt: startedAt ?? now() } });

    // The booking was already moved by an earlier attempt: do not decide again (the world has changed
    // under us: the class is now AT the requested time), just finish what was left.
    if (request.appliedToAt) {
      await assertLock(deps, runId);
      const done = await completeMove(apply, request.id, request.decision === "confirmed" ? "confirmed" : "applied");
      const failures = done.failures;
      const outcome = Object.keys(failures).length > 0 ? "partial" : "completed";
      const { totalTokens, costUsd } = await finalizeRun(prisma, runId, outcome, now());
      return { runId, outcome, totalTokens, costUsd, failures, parentUpdateId: null, alertId: null };
    }

    const result = await runReschedulePipeline(input, {
      llm, prior, attempts,
      sink,
      onGuard: async (g) => {
        await prisma.run.update({
          where: { id: runId },
          data: { tokenMapEnc: encryptJson(g.tokenMap, encryptionKey), tokenMapExpiresAt: new Date(now().getTime() + TOKEN_MAP_RETENTION_DAYS * DAY_MS) },
        });
      },
    });

    await assertLock(deps, runId);
    // A request that a person (or the apply step) already settled is never overwritten by a re-run.
    const settled = request.decision === "auto_applied" || request.decision === "confirmed" || request.decision === "rejected";
    const d = result.decision;
    if (!settled) {
      const failed = result.outcome === "failed";
      const base = {
        learnerId: input.base.learnerId, bookingId: result.resolved?.bookingId ?? null,
        parsedJson: { intake: result.intake, resolved: result.resolved ? { bookingId: result.resolved.bookingId, requestedStartsAt: result.resolved.requestedStartsAt?.toISOString() ?? null, resolution: result.resolved.resolution } : null, scheduler: result.scheduler, policy: result.serialized } as unknown as Prisma.InputJsonValue,
      };
      if (failed) {
        // Never let a request disappear: if the automatic handling broke, hand it to a person.
        const why = Object.values(result.failures)[0] ?? "an unexpected problem";
        await prisma.rescheduleRequest.update({ where: { id: request.id }, data: { ...base, decision: "escalated", decidedBy: "system", reason: `This request could not be handled automatically (${why}) so a person needs to handle it.`, proposedSlotsJson: undefined } });
      } else if (d) {
        await prisma.rescheduleRequest.update({
          where: { id: request.id },
          data: {
            ...base, reason: d.reason, decidedBy: "policy",
            // auto_apply stays undecided until the booking is actually moved; propose/escalate are final until a person acts.
            decision: d.outcome === "propose" ? "proposed" : d.outcome === "escalate" ? "escalated" : null,
            proposedSlotsJson: d.outcome === "propose" ? (result.serialized?.alternatives as unknown as Prisma.InputJsonValue) : undefined,
          },
        });
      }
    }

    // Carry the decision out. Everything below is safe to repeat; failures are recorded on the trace
    // and make the run "partial" (the request itself is already safely stored).
    const failures = { ...result.failures };
    const merge = (r: { failures: Partial<Record<AgentName, string>> }) => Object.assign(failures, r.failures);
    if (!settled) {
      await assertLock(deps, runId);
      if (result.outcome === "failed") {
        merge(await announceEscalation(apply, request.id, "The automatic check could not finish."));
      } else if (d?.outcome === "auto_apply") {
        const bookingId = result.resolved?.bookingId;
        const toStartsAt = d.requestedStartsAt;
        const version = bookingId ? bookingVersions.get(bookingId) : undefined;
        if (!bookingId || !toStartsAt || version === undefined) throw new Error("An automatic move was decided without a booking and time.");
        const moved = await moveBooking(prisma, { requestId: request.id, bookingId, toStartsAt, expectedVersion: version, decision: "auto_applied", decidedBy: "policy", now: now() });
        if (moved.ok) {
          merge(await completeMove(apply, request.id, "applied"));
        } else {
          const reason = REFUSAL_REASON[moved.reason];
          await prisma.rescheduleRequest.update({ where: { id: request.id }, data: { decision: "escalated", decidedBy: "system", reason } });
          merge(await announceEscalation(apply, request.id, reason));
        }
      } else if (d?.outcome === "propose") {
        merge(await announceProposal(apply, request.id));
      } else if (d?.outcome === "escalate") {
        merge(await announceEscalation(apply, request.id, d.reason));
      }
    }

    const outcome = result.outcome === "completed" && Object.keys(failures).length > 0 ? "partial" : result.outcome;
    const { totalTokens, costUsd } = await finalizeRun(prisma, runId, outcome, now());
    return { runId, outcome, totalTokens, costUsd, failures, parentUpdateId: null, alertId: null };
  } catch (err) {
    if (err instanceof LockLostError) throw err;
    await prisma.run.update({ where: { id: runId }, data: { status: "failed", finishedAt: now(), lockedBy: null, lockedAt: null } }).catch(() => undefined);
    throw err;
  }
}

/** Run whichever kind of run this is. The worker and the CLI use this. */
export async function executeAnyRun(deps: RescheduleDeps, runId: string): Promise<RunSummary> {
  const run = await deps.prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { pipeline: true } });
  return run.pipeline === "reschedule" ? executeRescheduleRun(deps, runId) : executeRun(deps, runId);
}
