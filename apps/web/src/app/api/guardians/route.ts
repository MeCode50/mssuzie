import { handle, json } from "@/lib/http";
import { listGuardians } from "@/lib/reschedules";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The parents a message can be sent as in the simulator, with their learner, tutor, zones and next classes. */
export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  return json({ guardians: await listGuardians(ctx, actor) });
});
