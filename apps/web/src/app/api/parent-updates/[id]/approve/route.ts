import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { UuidSchema } from "@/lib/schemas";
import { requireOps, requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ops approve a parent update draft. Approval only records who approved and when: nothing in this
 * app ever sends a message to a family, so "approved" means "ready for a person to send".
 */
export const POST = handle(async (ctx) => {
  const actor = await requireOps(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That parent update");
  const { prisma } = ctx.c;

  const update = await prisma.parentUpdate.findUnique({ where: { id: id.data } });
  if (!update) throw errors.notFound("That parent update");
  ctx.fields.parentUpdateId = update.id;
  if (update.runId) ctx.fields.runId = update.runId;

  // Conditional update: of several simultaneous approvals exactly one wins.
  const approvedAt = new Date();
  const won = await prisma.parentUpdate.updateMany({
    where: { id: update.id, status: "draft" },
    data: { status: "approved", approvedBy: actor.id, approvedAt },
  });
  if (won.count !== 1) throw errors.conflict("This parent update has already been approved.");

  ctx.log.info("parent update approved", { parentUpdateId: update.id, approvedBy: actor.id });
  return json({ id: update.id, status: "approved", approvedAt, approvedBy: actor.name });
});
