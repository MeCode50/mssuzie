import { Prisma } from "../generated/prisma/client";
import type { PrismaClient } from "./client";

/** A run locked longer than this without a heartbeat is considered abandoned. */
export const STUCK_AFTER_MS = 5 * 60_000;
/** A run claimed this many times without finishing is failed instead of re-queued. */
export const MAX_CLAIMS = 3;

/**
 * Claim the oldest queued run. One statement: the inner SELECT ... FOR UPDATE SKIP LOCKED makes
 * concurrent workers skip rows another worker is claiming, so a run is claimed exactly once.
 * Timestamps come from the database clock so workers with skewed clocks agree.
 */
export async function claimRun(prisma: PrismaClient, workerId: string): Promise<{ id: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE runs
       SET status = 'running',
           locked_by = ${workerId},
           locked_at = now(),
           started_at = COALESCE(started_at, now()),
           claim_count = claim_count + 1
     WHERE id = (
       SELECT id FROM runs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id`);
  return rows[0] ?? null;
}

/** Heartbeat. Returns false if this worker no longer holds the lock (it was re-queued/taken). */
export async function touchLock(prisma: PrismaClient, runId: string, workerId: string): Promise<boolean> {
  const n = await prisma.$executeRaw(Prisma.sql`
    UPDATE runs SET locked_at = now()
     WHERE id = ${runId} AND locked_by = ${workerId} AND status = 'running'`);
  return n === 1;
}

/** Give a run back (graceful shutdown). Does not count as a crash. */
export async function releaseRun(prisma: PrismaClient, runId: string, workerId: string): Promise<boolean> {
  const n = await prisma.$executeRaw(Prisma.sql`
    UPDATE runs
       SET status = 'queued', locked_by = NULL, locked_at = NULL,
           claim_count = GREATEST(claim_count - 1, 0)
     WHERE id = ${runId} AND locked_by = ${workerId} AND status = 'running'`);
  return n === 1;
}

export interface StuckResult {
  requeued: string[];
  failed: string[];
}

/**
 * Recover runs whose worker died: locked past the threshold -> back to queued, unless they have
 * already been claimed MAX_CLAIMS times, in which case they are failed (a poison run must not
 * loop forever, spending money on every attempt).
 */
export async function requeueStuckRuns(
  prisma: PrismaClient,
  options: { olderThanMs?: number; maxClaims?: number } = {},
): Promise<StuckResult> {
  const secs = (options.olderThanMs ?? STUCK_AFTER_MS) / 1000;
  const maxClaims = options.maxClaims ?? MAX_CLAIMS;
  return prisma.$transaction(async (tx) => {
    const failed = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE runs SET status = 'failed', finished_at = now(), locked_by = NULL, locked_at = NULL
       WHERE status = 'running'
         AND locked_at < now() - make_interval(secs => ${secs}::double precision)
         AND claim_count >= ${maxClaims}
      RETURNING id`);
    const requeued = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE runs SET status = 'queued', locked_by = NULL, locked_at = NULL
       WHERE status = 'running'
         AND locked_at < now() - make_interval(secs => ${secs}::double precision)
         AND claim_count < ${maxClaims}
      RETURNING id`);
    for (const { id } of failed) await recordCrashLoopFailure(tx, id);
    return { requeued: requeued.map((r) => r.id), failed: failed.map((r) => r.id) };
  });
}

/** Leave a plain-language failed step so the UI can say why the run failed. */
async function recordCrashLoopFailure(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  const steps = await tx.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });
  const done = new Set(steps.filter((s) => s.status === "completed").map((s) => s.agent));
  const order = ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"] as const;
  const agent = order.find((a) => !done.has(a)) ?? "parent_reporter";
  await tx.runStep.create({
    data: {
      runId, seq: (steps.at(-1)?.seq ?? 0) + 1, agent, status: "failed",
      attempt: steps.filter((s) => s.agent === agent && s.status === "running").length + 1,
      error: "This run was stopped after repeated worker crashes. Use Retry once the problem is resolved.",
    },
  });
}

/** Privacy: token maps are deleted 30 days after creation. Returns how many were wiped. */
export async function sweepExpiredTokenMaps(prisma: PrismaClient, now = new Date()): Promise<number> {
  const r = await prisma.run.updateMany({
    where: { tokenMapExpiresAt: { lt: now } },
    data: { tokenMapEnc: null, tokenMapExpiresAt: null },
  });
  return r.count;
}
