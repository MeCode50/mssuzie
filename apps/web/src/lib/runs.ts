import { createHash } from "node:crypto";
import {
  AnalysisSchema, consumeRateLimit, countUserRuns, encrypt, getSpendStatus, GuardOutputSchema,
  MonitorSchema, PlanSchema, utcDayStart, DAY_MS, type AgentName,
} from "@mssuzie/core";
import { ApiError, errors } from "./errors";
import type { RequestContext } from "./http";
import { IDEMPOTENCY_KEY, type CreateSessionInput } from "./schemas";
import { learnerScope, type Actor } from "./session";
import { summarizeStep } from "./summaries";

const TEN_MINUTES = 600_000;
const AGENTS: AgentName[] = ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"];

export function readIdempotencyKey(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key header (8-128 letters, numbers, - _ . :) so a double-click can't create two runs.");
  }
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError(400, "validation_failed", "The Idempotency-Key must be 8-128 characters: letters, numbers, - _ . or :");
  }
  return key;
}

/** Stored as: u:<user>:k:<key>:h:<payload hash>. Same key + same payload = replay; same key + other payload = conflict. */
function keyPrefix(userId: string, key: string): string {
  return `u:${userId}:k:${key}:h:`;
}

function payloadHash(input: CreateSessionInput): string {
  const canonical = JSON.stringify([input.learnerId, input.notes, input.heldAt?.toISOString() ?? null, input.durationMin ?? null]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Per-IP, per-user and global-budget guards shared by run creation and retry. */
export async function enforceRunLimits(ctx: RequestContext, scope: "create" | "retry", actor: Actor): Promise<void> {
  const { c, ip } = ctx;
  const perIp = await consumeRateLimit(c.prisma, {
    key: `ip:${ip}:runs-${scope}`, limit: c.env.RUNS_PER_IP_PER_10_MIN, windowMs: TEN_MINUTES,
  });
  if (!perIp.allowed) {
    throw errors.rateLimited("You're doing that a bit too quickly. Please wait a few minutes and try again.", perIp.retryAfterSec);
  }
  if (scope === "create") {
    const used = await countUserRuns(c.prisma, actor.id);
    if (used >= c.env.RUNS_PER_USER_PER_DAY) {
      throw errors.rateLimited(`You've reached today's limit of ${c.env.RUNS_PER_USER_PER_DAY} session runs. Please try again tomorrow.`, 3600);
    }
  }
  const spend = await getSpendStatus(c.prisma, { capUsd: c.env.DAILY_SPEND_CAP_USD, estimatedRunCostUsd: c.env.ESTIMATED_RUN_COST_USD });
  if (!spend.allowed) {
    const untilMidnight = Math.ceil((utcDayStart(new Date()).getTime() + DAY_MS - Date.now()) / 1000);
    throw new ApiError(
      503, "daily_budget_reached",
      "MsSuzie Copilot has reached its daily AI budget, so new runs are paused. They resume tomorrow (UTC), or sooner if an admin raises the budget.",
      { "retry-after": String(untilMidnight) },
    );
  }
}

export interface CreatedRun {
  runId: string;
  sessionId: string;
  status: string;
  replay: boolean;
}

async function findReplay(ctx: RequestContext, actor: Actor, key: string, hash: string): Promise<CreatedRun | null> {
  const prefix = keyPrefix(actor.id, key);
  const existing = await ctx.c.prisma.run.findFirst({ where: { idempotencyKey: { startsWith: prefix } } });
  if (!existing) return null;
  if (existing.idempotencyKey !== `${prefix}${hash}`) {
    throw new ApiError(409, "idempotency_conflict", "That Idempotency-Key was already used for a different request. Use a new key for new notes.");
  }
  return { runId: existing.id, sessionId: existing.sessionId, status: existing.status, replay: true };
}

export async function createSessionRun(ctx: RequestContext, actor: Actor, input: CreateSessionInput, key: string): Promise<CreatedRun> {
  const { c } = ctx;
  const hash = payloadHash(input);

  // 1. A repeated request is answered from the first one and never consumes quota.
  const replay = await findReplay(ctx, actor, key, hash);
  if (replay) return replay;

  // 2. Tutors can only add sessions for their own learners; a missing learner and someone else's look the same.
  const learner = await c.prisma.learner.findFirst({ where: { id: input.learnerId, ...learnerScope(actor) } });
  if (!learner) throw errors.notFound("That learner");

  await enforceRunLimits(ctx, "create", actor);

  try {
    const created = await c.prisma.$transaction(async (tx) => {
      const session = await tx.tutoringSession.create({
        data: {
          learnerId: learner.id, tutorId: learner.tutorId, heldAt: input.heldAt ?? new Date(),
          durationMin: input.durationMin ?? 60, notesRaw: encrypt(input.notes, c.env.ENCRYPTION_KEY),
        },
      });
      const run = await tx.run.create({
        data: { sessionId: session.id, idempotencyKey: `${keyPrefix(actor.id, key)}${hash}`, createdById: actor.id },
      });
      return { runId: run.id, sessionId: session.id, status: run.status, replay: false };
    });
    return created;
  } catch (err) {
    // Two identical requests raced: the loser's transaction rolled back, so answer with the winner's run.
    if ((err as { code?: string }).code === "P2002") {
      const raced = await findReplay(ctx, actor, key, hash);
      if (raced) return raced;
    }
    throw err;
  }
}

/** Load a run the actor may see, or 404 (also for someone else's run, so existence is not revealed). */
export async function loadRunFor(ctx: RequestContext, actor: Actor, id: string) {
  const run = await ctx.c.prisma.run.findFirst({
    where: { id, session: { learner: learnerScope(actor) } },
    include: { session: { include: { learner: { select: { id: true, displayName: true } } } } },
  });
  if (!run) throw errors.notFound("That run");
  return run;
}

type StepRow = {
  seq: number; agent: AgentName; status: string; attempt: number; error: string | null; model: string | null;
  tokensIn: number; tokensOut: number; durationMs: number; costUsd: { toString(): string } | number; outputJson: unknown;
};

/** The browser-safe view of one run_steps row (no raw output; a plain-language summary instead). */
export function stepView(s: StepRow) {
  return {
    seq: s.seq, agent: s.agent, status: s.status, attempt: s.attempt, error: s.error, model: s.model,
    tokensIn: s.tokensIn, tokensOut: s.tokensOut, durationMs: s.durationMs, costUsd: Number(s.costUsd),
    summary: s.status === "completed" ? summarizeStep(s.agent, s.outputJson) : null,
  };
}

export async function serializeRun(ctx: RequestContext, run: Awaited<ReturnType<typeof loadRunFor>>) {
  const { prisma } = ctx.c;
  const [steps, parentUpdate, alert] = await Promise.all([
    prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } }),
    prisma.parentUpdate.findFirst({ where: { runId: run.id }, orderBy: { createdAt: "desc" } }),
    prisma.alert.findFirst({ where: { runId: run.id }, orderBy: { createdAt: "desc" } }),
  ]);

  // The latest event per agent is its current state (the log is append-only).
  const agents = Object.fromEntries(AGENTS.map((a) => {
    const latest = [...steps].reverse().find((s) => s.agent === a);
    return [a, latest ? stepView(latest) : { agent: a, status: "pending" }];
  }));
  const output = (agent: AgentName) => [...steps].reverse().find((s) => s.agent === agent && s.status === "completed")?.outputJson;
  const guard = GuardOutputSchema.safeParse(output("privacy_guard"));

  return {
    run: {
      id: run.id, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      totalTokens: run.totalTokens, costUsd: Number(run.costUsd),
      sessionId: run.sessionId, heldAt: run.session.heldAt, learner: run.session.learner,
    },
    steps: steps.map(stepView),
    agents,
    results: {
      analysis: AnalysisSchema.safeParse(output("session_analyst")).data ?? null,
      monitor: MonitorSchema.safeParse(output("progress_monitor")).data ?? null,
      plan: PlanSchema.safeParse(output("learning_planner")).data ?? null,
      // Counts and token labels only: the originals live in the encrypted token map and never leave the server.
      privacy: guard.success ? { redactedNotes: guard.data.redactedNotes, log: guard.data.redactionLog } : null,
    },
    parentUpdate: parentUpdate
      ? { id: parentUpdate.id, body: parentUpdate.body, status: parentUpdate.status, approvedAt: parentUpdate.approvedAt }
      : null,
    alert: alert
      ? { id: alert.id, severity: alert.severity, reason: alert.reason, intervention: alert.intervention, status: alert.status }
      : null,
  };
}
