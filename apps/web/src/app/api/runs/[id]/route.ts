import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { loadRunFor, serializeRun } from "@/lib/runs";
import { UuidSchema } from "@/lib/schemas";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That run");
  const run = await loadRunFor(ctx, actor, id.data);
  ctx.fields.runId = run.id;
  return json(await serializeRun(ctx, run));
});
