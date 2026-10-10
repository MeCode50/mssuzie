import { decrypt, decryptJson, encryptJson } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import { buildKnownEntities, TokenMapSchema } from "../agents/privacy-guard/index";
import type { LlmConfig } from "../llm/config";
import { AnalysisSchema, MonitorSchema, PlanSchema, ReportSchema } from "../schemas/index";
import { runPipeline } from "./run-pipeline";
import type { AgentName, PipelineInput, PriorOutputs, StepEvent } from "./types";

export const TOKEN_MAP_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** Thrown when this worker no longer holds the run's lock (it was re-queued and taken over). */
export class LockLostError extends Error {
  constructor(readonly runId: string) {
    super(`Lock on run ${runId} was lost; abandoning without writing results`);
    this.name = "LockLostError";
  }
}

export interface ExecuteDeps {
  /** When set, results are only written while this worker still holds the run's lock. */
  lockedBy?: string;
  prisma: PrismaClient;
  llm: LlmConfig;
  encryptionKey: string;
  now?: () => Date;
  onEvent?: (event: StepEvent) => void;
}

export interface RunSummary {
  runId: string;
  outcome: "completed" | "partial" | "failed";
  totalTokens: number;
  costUsd: number;
  failures: Partial<Record<AgentName, string>>;
  parentUpdateId: string | null;
  alertId: string | null;
}

export async function createRun(
  prisma: PrismaClient,
  args: { sessionId: string; idempotencyKey: string; createdById?: string },
): Promise<{ id: string }> {
  return prisma.run.create({
    data: { sessionId: args.sessionId, idempotencyKey: args.idempotencyKey, createdById: args.createdById ?? null },
    select: { id: true },
  });
}

async function loadInput(deps: ExecuteDeps, runId: string): Promise<{ input: PipelineInput; learnerId: string; sessionId: string }> {
  const { prisma, encryptionKey } = deps;
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { session: { include: { tutor: true, learner: { include: { guardians: true, events: true } } } } },
  });
  const { session } = run;
  // Rescheduling runs have their own executor; this one only handles Session Copilot analyses.
  if (!session) throw new Error(`Run ${runId} is not a Session Copilot run`);
  const learner = session.learner;

  const snapshots = await prisma.skillSnapshot.findMany({
    where: { learnerId: learner.id, sessionId: { not: session.id } },
    include: { session: { select: { heldAt: true } } },
    orderBy: { session: { heldAt: "asc" } },
  });
  const bySkill = new Map<string, { heldAt: Date; mastery: number }[]>();
  for (const s of snapshots) {
    const list = bySkill.get(s.skill) ?? [];
    list.push({ heldAt: s.session.heldAt, mastery: s.mastery });
    bySkill.set(s.skill, list);
  }

  const pastSteps = (agent: AgentName) =>
    prisma.runStep.findMany({
      where: { agent, status: "completed", runId: { not: runId }, run: { session: { learnerId: learner.id } } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { outputJson: true },
    });
  const [monitors, analyses] = await Promise.all([pastSteps("progress_monitor"), pastSteps("session_analyst")]);

  const input: PipelineInput = {
    notes: decrypt(session.notesRaw, encryptionKey),
    known: buildKnownEntities({ learner, guardians: learner.guardians, tutor: session.tutor }),
    profile: {
      age: learner.age, grade: learner.grade, subjects: learner.subjects,
      interests: learner.interests, planHoursPerWeek: learner.planHoursPerWeek,
    },
    sessionDate: session.heldAt,
    history: [...bySkill].map(([skill, points]) => ({ skill, points })),
    previousStatuses: monitors
      .map((m) => MonitorSchema.safeParse(m.outputJson))
      .flatMap((p) => (p.success ? [p.data.status] : [])),
    currentStatus: learner.currentStatus,
    earlierSignals: analyses
      .map((a) => AnalysisSchema.safeParse(a.outputJson))
      .flatMap((p) =>
        p.success
          ? [{
              engagement: p.data.engagement.level, confidence: p.data.confidence.level,
              homeworkNotDone: p.data.homework.filter((h) => h.status === "not_done").length,
            }]
          : [],
      ),
    events: learner.events.map((e) => ({ type: e.type, subject: e.subject, title: e.title, dueDate: e.dueDate })),
  };
  return { input, learnerId: learner.id, sessionId: session.id };
}

/** Outputs of steps that already completed for this run, so a retry only re-runs what failed. */
async function loadPrior(deps: ExecuteDeps, runId: string, sessionId: string) {
  const { prisma, encryptionKey } = deps;
  const rows = await prisma.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });
  const latest = new Map<AgentName, (typeof rows)[number]>();
  for (const r of rows) if (r.status !== "running") latest.set(r.agent, r);
  const ok = (agent: AgentName) => {
    const r = latest.get(agent);
    return r?.status === "completed" ? r.outputJson : undefined;
  };

  const prior: PriorOutputs = {};
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { tokenMapEnc: true } });
  const session = await prisma.tutoringSession.findUniqueOrThrow({ where: { id: sessionId }, select: { notesRedacted: true } });
  if (ok("privacy_guard") && run.tokenMapEnc && session.notesRedacted) {
    const map = TokenMapSchema.safeParse(decryptJson(run.tokenMapEnc, encryptionKey));
    if (map.success) prior.guard = { redactedNotes: session.notesRedacted, tokenMap: map.data };
  }
  const analysis = AnalysisSchema.safeParse(ok("session_analyst"));
  const monitor = MonitorSchema.safeParse(ok("progress_monitor"));
  const plan = PlanSchema.safeParse(ok("learning_planner"));
  const report = ReportSchema.safeParse(ok("parent_reporter"));
  // Anything downstream of a re-run step is stale, so it is dropped and re-run too.
  if (prior.guard && analysis.success) prior.analysis = analysis.data;
  if (prior.analysis && monitor.success) prior.monitor = monitor.data;
  if (prior.analysis && plan.success) prior.plan = plan.data;
  if (prior.monitor && prior.plan && report.success) prior.report = report.data;

  const attempts: Partial<Record<AgentName, number>> = {};
  for (const r of rows) if (r.status === "running") attempts[r.agent] = (attempts[r.agent] ?? 0) + 1;
  for (const agent of Object.keys(attempts) as AgentName[]) attempts[agent] = (attempts[agent] ?? 0) + 1;
  return { prior, attempts, nextSeq: (rows.at(-1)?.seq ?? 0) + 1 };
}

async function assertLock(deps: ExecuteDeps, runId: string): Promise<void> {
  if (!deps.lockedBy) return;
  const held = await deps.prisma.run.count({ where: { id: runId, lockedBy: deps.lockedBy, status: "running" } });
  if (held === 0) throw new LockLostError(runId);
}

/**
 * Execute (or retry) one run: load inputs, run the pipeline while appending a run_steps row per
 * event, then persist snapshots, learner status, the refund-risk alert and the draft parent update.
 * Callers (CLI, worker) own claiming/locking; this owns everything after.
 */
export async function executeRun(deps: ExecuteDeps, runId: string): Promise<RunSummary> {
  const { prisma, llm, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  try {
    const { input, learnerId, sessionId } = await loadInput(deps, runId);
    const { prior, attempts, nextSeq } = await loadPrior(deps, runId, sessionId);
    let seq = nextSeq;

    const { startedAt } = await prisma.run.findUniqueOrThrow({ where: { id: runId }, select: { startedAt: true } });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "running", finishedAt: null, startedAt: startedAt ?? now() },
    });

    const result = await runPipeline(input, {
      llm, prior, attempts,
      sink: async (e) => {
        await prisma.runStep.create({
          data: {
            runId, seq: seq++, agent: e.agent, status: e.status, attempt: e.attempt,
            outputJson: e.output === undefined ? undefined : (e.output as Prisma.InputJsonValue),
            error: e.error ?? null, model: e.model ?? null, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
            durationMs: e.durationMs, costUsd: e.costUsd,
          },
        });
        deps.onEvent?.(e);
      },
      onGuard: async (g) => {
        await prisma.tutoringSession.update({ where: { id: sessionId }, data: { notesRedacted: g.redactedNotes } });
        await prisma.run.update({
          where: { id: runId },
          data: {
            tokenMapEnc: encryptJson(g.tokenMap, encryptionKey),
            tokenMapExpiresAt: new Date(now().getTime() + TOKEN_MAP_RETENTION_DAYS * DAY_MS),
          },
        });
      },
    });

    await assertLock(deps, runId);
    const persisted = await prisma.$transaction(async (tx) => {
      if (result.analysis) {
        await tx.skillSnapshot.deleteMany({ where: { sessionId } });
        await tx.skillSnapshot.createMany({
          data: result.analysis.skills.map((s) => ({ learnerId, sessionId, skill: s.skill, mastery: s.mastery, evidence: s.evidence })),
        });
      }

      let alertId: string | null = null;
      if (result.monitor) {
        await tx.learner.update({ where: { id: learnerId }, data: { currentStatus: result.monitor.status } });
        if (result.monitor.status === "at_risk") {
          const data = {
            runId, severity: result.monitor.severity ?? "medium",
            reason: result.monitor.reasons.join(" "), intervention: result.monitor.suggestedIntervention,
          } as const;
          // One open refund-risk alert per learner: refresh it rather than stacking duplicates.
          const open = await tx.alert.findFirst({ where: { learnerId, type: "refund_risk", status: "open" } });
          alertId = open
            ? (await tx.alert.update({ where: { id: open.id }, data })).id
            : (await tx.alert.create({ data: { learnerId, type: "refund_risk", ...data } })).id;
        }
      }

      let parentUpdateId: string | null = null;
      if (result.parentUpdateBody) {
        const existing = await tx.parentUpdate.findFirst({ where: { runId } });
        if (!existing) {
          parentUpdateId = (await tx.parentUpdate.create({ data: { learnerId, runId, body: result.parentUpdateBody } })).id;
        } else if (existing.status === "draft") {
          parentUpdateId = (await tx.parentUpdate.update({ where: { id: existing.id }, data: { body: result.parentUpdateBody } })).id;
        } else {
          parentUpdateId = existing.id; // already approved: never overwrite
        }
      }
      return { alertId, parentUpdateId };
    });

    await assertLock(deps, runId);
    const totals = await prisma.runStep.aggregate({
      where: { runId }, _sum: { tokensIn: true, tokensOut: true, costUsd: true },
    });
    const totalTokens = (totals._sum.tokensIn ?? 0) + (totals._sum.tokensOut ?? 0);
    const cost = Number(totals._sum.costUsd ?? 0);
    await prisma.run.update({
      where: { id: runId },
      data: { status: result.outcome, finishedAt: now(), totalTokens, costUsd: cost, lockedBy: null, lockedAt: null },
    });

    return { runId, outcome: result.outcome, totalTokens, costUsd: cost, failures: result.failures, ...persisted };
  } catch (err) {
    if (err instanceof LockLostError) throw err;
    await prisma.run
      .update({ where: { id: runId }, data: { status: "failed", finishedAt: now(), lockedBy: null, lockedAt: null } })
      .catch(() => undefined);
    throw err;
  }
}
