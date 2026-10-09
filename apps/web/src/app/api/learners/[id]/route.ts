import { errors } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { learnerDetail } from "@/lib/learners";
import { UuidSchema } from "@/lib/schemas";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That learner");
  return json(await learnerDetail(ctx, actor, id.data));
});
