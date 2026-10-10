import { readJson } from "@/lib/body";
import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { ApproveSchema, approveTime } from "@/lib/reschedules";
import { UuidSchema } from "@/lib/schemas";
import { requireOps } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Ops settle a proposed or escalated request on a chosen time: move the class, update the calendar, tell both people. */
export const POST = handle(async (ctx) => {
  const actor = await requireOps(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That request");
  const { startsAt } = await readJson(ctx.req, ApproveSchema);
  ctx.fields.requestId = id.data;
  return json(await approveTime(ctx, actor, id.data, startsAt));
});
