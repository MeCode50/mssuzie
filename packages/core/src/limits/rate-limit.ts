import { Prisma } from "../generated/prisma/client";
import type { PrismaClient } from "../db/client";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Fixed-window counter in Postgres, one row per key. A single atomic upsert, so concurrent
 * requests (and concurrent serverless instances) cannot both slip under the limit.
 * Keys are prefixed so they never collide with Better Auth's own rows in the same table.
 */
export async function consumeRateLimit(
  prisma: PrismaClient,
  args: { key: string; limit: number; windowMs: number; now?: number },
): Promise<RateLimitResult> {
  const now = Math.trunc(args.now ?? Date.now());
  const key = `mssuzie:${args.key}`;
  const upsert = () =>
    prisma.$queryRaw<{ count: number; last_request: bigint }[]>(Prisma.sql`
      INSERT INTO rate_limits (id, key, count, last_request)
      VALUES (${key}, ${key}, 1, ${now}::bigint)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rate_limits.last_request <= ${now}::bigint - ${args.windowMs}::bigint
                     THEN 1 ELSE rate_limits.count + 1 END,
        last_request = CASE WHEN rate_limits.last_request <= ${now}::bigint - ${args.windowMs}::bigint
                            THEN ${now}::bigint ELSE rate_limits.last_request END
      RETURNING count, last_request`);
  const row = (await retryOnUniqueRace(upsert))[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  const count = Number(row.count);
  const allowed = count <= args.limit;
  const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((Number(row.last_request) + args.windowMs - now) / 1000));
  return { allowed, count, limit: args.limit, retryAfterSec };
}

/** Housekeeping: drop our own counters whose window ended long ago. */
export async function pruneRateLimits(prisma: PrismaClient, olderThanMs = 86_400_000, now = Date.now()): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    DELETE FROM rate_limits WHERE key LIKE 'mssuzie:%' AND last_request < ${Math.trunc(now - olderThanMs)}::bigint`);
}

/**
 * The table has two unique constraints (id and key) that always hold the same value for our rows.
 * ON CONFLICT can arbitrate only one of them, so when several requests create a brand-new counter
 * at the same instant, a loser can trip the other constraint. The next attempt finds the row and
 * increments it, so retry a few times.
 */
async function retryOnUniqueRace<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const duplicate = err instanceof Error && /23505|duplicate key/i.test(err.message);
      if (!duplicate || i >= attempts) throw err;
    }
  }
}
