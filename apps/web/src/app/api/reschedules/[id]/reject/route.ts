import { readJson } from "@/lib/body";
import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { declineRequest, RejectSchema } from "@/lib/reschedules";
import { UuidSchema } from "@/lib/schemas";
import { requireOps } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ops decline a request with a note for the parent. The class stays exactly as it was. */
export const POST = handle(async (ctx) => {
  const actor = await requireOps(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That request");
  const { note } = await readJson(ctx.req, RejectSchema);
  ctx.fields.requestId = id.data;
  return json(await declineRequest(ctx, actor, id.data, note));
});
