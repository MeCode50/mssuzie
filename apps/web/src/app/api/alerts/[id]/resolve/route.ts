import { z } from "zod";
import { readJson } from "@/lib/body";
import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { UuidSchema } from "@/lib/schemas";
import { requireOps } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  note: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Please add a short note about what was done.").max(1000, "The note can be at most 1,000 characters.")),
});

/** Resolve an open alert with a note describing the action taken. */
export const POST = handle(async (ctx) => {
  const actor = await requireOps(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That alert");
  const { note } = await readJson(ctx.req, BodySchema);
  const { prisma } = ctx.c;

  const alert = await prisma.alert.findUnique({ where: { id: id.data } });
  if (!alert) throw errors.notFound("That alert");

  const resolvedAt = new Date();
  const won = await prisma.alert.updateMany({
    where: { id: alert.id, status: "open" },
    data: { status: "resolved", resolvedBy: actor.id, resolutionNote: note, resolvedAt },
  });
  if (won.count !== 1) throw errors.conflict("This alert has already been resolved.");

  ctx.log.info("alert resolved", { alertId: alert.id, learnerId: alert.learnerId, resolvedBy: actor.id });
  return json({ id: alert.id, status: "resolved", resolvedAt, resolvedBy: actor.name, resolutionNote: note });
});
