import { errors } from "@/lib/errors";
import { handle } from "@/lib/http";
import { loadRunFor } from "@/lib/runs";
import { UuidSchema } from "@/lib/schemas";
import { requireActor } from "@/lib/session";
import { acquireStreamSlot, createEventStream, resumeSeq } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Live trace of a run (server-sent events): replays past steps, then streams new ones.
 * Reconnecting with Last-Event-ID resumes after the last step the browser saw.
 */
export const GET = handle(async (ctx) => {
  const actor = await requireActor(ctx);
  const id = UuidSchema.safeParse(ctx.params.id);
  if (!id.success) throw errors.notFound("That run");
  const run = await loadRunFor(ctx, actor, id.data);
  ctx.fields.runId = run.id;

  const release = acquireStreamSlot(actor.id);
  const stream = createEventStream({
    prisma: ctx.c.prisma, runId: run.id, afterSeq: resumeSeq(ctx.req), signal: ctx.req.signal,
  });
  // Free the per-user slot when the stream ends for any reason.
  const tracked = stream.pipeThrough(new TransformStream({ flush: release }), { preventCancel: false });
  ctx.req.signal.addEventListener("abort", release);

  return new Response(tracked, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
