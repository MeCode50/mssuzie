import { consumeRateLimit, resetDemoData } from "@mssuzie/core";
import { z } from "zod";
import { readJson } from "@/lib/body";
import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { requireOps } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const RESET_PHRASE = "reset demo data";
const BodySchema = z.object({
  confirm: z.string().refine((v) => v.trim().toLowerCase() === RESET_PHRASE, { message: `Type "${RESET_PHRASE}" to confirm.` }),
});

/**
 * Wipe all learners, sessions, runs, updates and alerts and restore the fictional seed data.
 * Accounts and sign-ins are untouched. Destructive, so: ops only, explicit confirmation, rate
 * limited, and refused while any run is queued or running.
 */
export const POST = handle(async (ctx) => {
  const actor = await requireOps(ctx);
  await readJson(ctx.req, BodySchema);
  const { prisma, env } = ctx.c;

  const limit = await consumeRateLimit(prisma, { key: `user:${actor.id}:demo-reset`, limit: 3, windowMs: 600_000 });
  if (!limit.allowed) throw errors.rateLimited("The demo was reset a few times already. Please wait a few minutes.", limit.retryAfterSec);

  const busy = await prisma.run.count({ where: { status: { in: ["queued", "running"] } } });
  if (busy > 0) throw errors.conflict("A run is still in progress. Please wait for it to finish, then reset the demo.");

  ctx.log.warn("demo reset started", { requestedBy: actor.id });
  await resetDemoData(prisma, env.ENCRYPTION_KEY, { minNoticeHours: env.RESCHEDULE_MIN_NOTICE_HOURS });
  const [learners, sessions, alerts] = await Promise.all([
    prisma.learner.count(), prisma.tutoringSession.count(), prisma.alert.count({ where: { status: "open" } }),
  ]);
  ctx.log.warn("demo reset finished", { requestedBy: actor.id, learners, sessions });
  return json({ status: "reset", learners, sessions, openAlerts: alerts });
});
