import type { PrismaClient } from "../db/client";
import type { Prisma } from "../generated/prisma/client";
import type { StepEvent } from "./types";

/** Append one event to the run's trace. Rows are never updated: the SSE stream replays them in `seq` order. */
export async function recordStepEvent(prisma: PrismaClient, runId: string, seq: number, e: StepEvent): Promise<void> {
  await prisma.runStep.create({
    data: {
      runId, seq, agent: e.agent, status: e.status, attempt: e.attempt,
      kind: e.kind ?? "agent", toolName: e.toolName ?? null,
      inputJson: e.input === undefined ? undefined : (e.input as Prisma.InputJsonValue),
      outputJson: e.output === undefined ? undefined : (e.output as Prisma.InputJsonValue),
      error: e.error ?? null, model: e.model ?? null, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
      durationMs: e.durationMs, costUsd: e.costUsd,
    },
  });
}

export async function nextSeq(prisma: PrismaClient, runId: string): Promise<number> {
  const last = await prisma.runStep.findFirst({ where: { runId }, orderBy: { seq: "desc" }, select: { seq: true } });
  return (last?.seq ?? 0) + 1;
}

/** Close a run: status, finish time, and token/cost totals summed over every step (retries included). */
export async function finalizeRun(prisma: PrismaClient, runId: string, outcome: "completed" | "partial" | "failed", now: Date): Promise<{ totalTokens: number; costUsd: number }> {
  const totals = await prisma.runStep.aggregate({ where: { runId }, _sum: { tokensIn: true, tokensOut: true, costUsd: true } });
  const totalTokens = (totals._sum.tokensIn ?? 0) + (totals._sum.tokensOut ?? 0);
  const costUsd = Number(totals._sum.costUsd ?? 0);
  await prisma.run.update({ where: { id: runId }, data: { status: outcome, finishedAt: now, totalTokens, costUsd, lockedBy: null, lockedAt: null } });
  return { totalTokens, costUsd };
}
