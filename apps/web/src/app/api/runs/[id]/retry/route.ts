import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { enforceRunLimits, loadRunFor } from "@/lib/runs";
import { UuidSchema } from "@/lib/schemas";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Re-queue a partial or failed run. The worker re-runs only failed steps and reuses the rest. */
export const POST = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That run");
  const run = await loadRunFor(ctx, actor, id.data);
  ctx.fields.runId = run.id;
  if (run.status !== "partial" && run.status !== "failed") {
    throw errors.conflict(
      run.status === "completed" ? "This run already completed, so there is nothing to retry." : "This run is already in progress.",
    );
  }
  await enforceRunLimits(ctx, "retry", actor);

  // Conditional update: of several simultaneous retries, exactly one wins.
  const won = await ctx.c.prisma.run.updateMany({
    where: { id: run.id, status: { in: ["partial", "failed"] } },
    data: { status: "queued", finishedAt: null, lockedBy: null, lockedAt: null },
  });
  if (won.count !== 1) throw errors.conflict("This run is already being retried.");
  return json({ runId: run.id, status: "queued" }, { status: 202 });
});
