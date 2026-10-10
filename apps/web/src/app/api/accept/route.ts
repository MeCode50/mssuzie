import { acceptFromLink, AcceptSchema } from "@/lib/accept";
import { readJson } from "@/lib/body";
import { handle, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Public: a parent confirms one of the times we offered. The single-use signed link is the credential. */
export const POST = handle(async (ctx) => {
  const { token } = await readJson(ctx.req, AcceptSchema);
  return json(await acceptFromLink(ctx, token));
});
