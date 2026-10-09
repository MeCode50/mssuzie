import { handle, json } from "@/lib/http";
import { errors } from "@/lib/errors";
import { listLearners, STATUSES, type Status } from "@/lib/learners";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Learners the caller may see (tutors: their own; ops: all), at-risk first. Optional ?status= filter. */
export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const raw = new URL(ctx.req.url).searchParams.get("status");
  if (raw && !STATUSES.includes(raw as Status)) {
    throw errors.validation("status must be one of on_track, watch or at_risk.");
  }
  return json(await listLearners(ctx, actor, (raw as Status | null) ?? null));
});
