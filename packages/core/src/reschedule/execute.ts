import { decryptJson, encryptJson } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { GuardOutputSchema, TokenMapSchema } from "../agents/privacy-guard/index";
import type { LlmConfig } from "../llm/config";
import { assertLock, LockLostError, TOKEN_MAP_RETENTION_DAYS, executeRun, type ExecuteDeps, type RunSummary } from "../pipeline/execute-run";
import { finalizeRun, nextSeq, recordStepEvent } from "../pipeline/record";
import type { AgentName } from "../pipeline/types";
import { loadRescheduleWork } from "./load";
import { runReschedulePipeline, type ReschedulePrior } from "./pipeline";
import { IntakeSchema, SlotReportSchema } from "./schemas";

const DAY_MS = 86_400_000;

export interface RescheduleDeps extends ExecuteDeps {
  llm: LlmConfig;
  minNoticeHours?: number;
}

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
 * Execute (or retry) one rescheduling run and record its decision on the request.
 * In this build the policy's "auto_apply" is recorded but not yet carried out: moving the booking,
 * the calendar and the emails are the next step.
 */
export async function executeRescheduleRun(deps: RescheduleDeps, runId: string): Promise<RunSummary> {
  const { prisma, llm, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  try {
    const { request, input } = await loadRescheduleWork(prisma, runId, encryptionKey, { now: now(), minNoticeHours: deps.minNoticeHours ?? 12 });
    const { prior, attempts } = await loadPrior(prisma, runId, encryptionKey);
    let seq = await nextSeq(prisma, runId);

    const { startedAt } = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { startedAt: true } });
    await prisma.run.update({ where: { id: runId }, data: { status: "running", finishedAt: null, startedAt: startedAt ?? now() } });

    const result = await runReschedulePipeline(input, {
      llm, prior, attempts,
      sink: async (e) => {
        await recordStepEvent(prisma, runId, seq++, e);
        deps.onEvent?.(e);
      },
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

    const { totalTokens, costUsd } = await finalizeRun(prisma, runId, result.outcome, now());
    return { runId, outcome: result.outcome, totalTokens, costUsd, failures: result.failures, parentUpdateId: null, alertId: null };
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
