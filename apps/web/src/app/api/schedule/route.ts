import { handle, json } from "@/lib/http";
import { listBookings, ScheduleQuerySchema } from "@/lib/schedule";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const q = new URL(ctx.req.url).searchParams;
  const { from, to } = ScheduleQuerySchema.parse({ from: q.get("from") ?? undefined, to: q.get("to") ?? undefined });
  return json({ bookings: await listBookings(ctx, actor, from, to) });
});
