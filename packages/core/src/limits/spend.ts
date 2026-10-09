import type { PrismaClient } from "../db/client.js";

export const DAY_MS = 86_400_000;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface SpendStatus {
  allowed: boolean;
  spentUsd: number;
  inFlightRuns: number;
  /** Money set aside for runs that have not finished yet. */
  reservedUsd: number;
  capUsd: number;
}

/**
 * Global daily spend cap (UTC day). A new run is allowed only if what is already spent, plus an
 * estimate for every run still in flight, plus an estimate for this run, stays within the cap,
 * so a burst of requests cannot overshoot it while earlier runs are still unbilled.
 */
export async function getSpendStatus(
  prisma: PrismaClient,
  args: { capUsd: number; estimatedRunCostUsd: number; now?: Date },
): Promise<SpendStatus> {
  const since = utcDayStart(args.now ?? new Date());
  const [spent, inFlightRuns] = await Promise.all([
    prisma.run.aggregate({ where: { createdAt: { gte: since } }, _sum: { costUsd: true } }),
    prisma.run.count({ where: { status: { in: ["queued", "running"] } } }),
  ]);
  const spentUsd = Number(spent._sum.costUsd ?? 0);
  const reservedUsd = inFlightRuns * args.estimatedRunCostUsd;
  const allowed = spentUsd + reservedUsd + args.estimatedRunCostUsd <= args.capUsd;
  return { allowed, spentUsd, inFlightRuns, reservedUsd, capUsd: args.capUsd };
}

/** Runs a user started in the last 24 hours (the per-user daily quota). */
export async function countUserRuns(prisma: PrismaClient, userId: string, now = new Date()): Promise<number> {
  return prisma.run.count({ where: { createdById: userId, createdAt: { gt: new Date(now.getTime() - DAY_MS) } } });
}
