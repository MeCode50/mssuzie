import { handle, json } from "@/lib/http";
import { readJson } from "@/lib/body";
import { createSessionRun, readIdempotencyKey } from "@/lib/runs";
import { CreateSessionSchema } from "@/lib/schemas";
import { requireActor } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a tutoring session from pasted notes and queue its run. */
export const POST = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const key = readIdempotencyKey(ctx.req);
  const input = await readJson(ctx.req, CreateSessionSchema);
  const created = await createSessionRun(ctx, actor, input, key);
  ctx.fields.runId = created.runId;
  ctx.fields.learnerId = input.learnerId;
  ctx.fields.replay = created.replay;
  return json(
    { runId: created.runId, sessionId: created.sessionId, status: created.status, idempotentReplay: created.replay },
    { status: created.replay ? 200 : 201 },
  );
});
