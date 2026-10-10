import { z } from "zod";
import { readJson } from "@/lib/body";
import { handle, json } from "@/lib/http";
import { CreateRescheduleSchema, createRequest, FILTERS, listRequests } from "@/lib/reschedules";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({ filter: z.enum(FILTERS, { message: "filter must be all, needs_person, waiting or done" }).default("all") });

/** Rescheduling requests, newest first (tutors see only their own learners'). */
export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const { filter } = QuerySchema.parse({ filter: new URL(ctx.req.url).searchParams.get("filter") ?? undefined });
  return json(await listRequests(ctx, actor, filter));
});

/** The simulator: a parent's message arrives. Stores it (encrypted) and queues the agents' run. */
export const POST = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const input = await readJson(ctx.req, CreateRescheduleSchema);
  const created = await createRequest(ctx, actor, input);
  ctx.fields.runId = created.runId;
  ctx.fields.requestId = created.requestId;
  return json(created, { status: 201 });
});
