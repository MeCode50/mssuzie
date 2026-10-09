import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunView } from "@/components/run/run-view";
import { getContainer } from "@/lib/container";
import { requirePageActor } from "@/lib/page-session";
import { loadRunFor, serializeRun } from "@/lib/runs";
import { UuidSchema } from "@/lib/schemas";
import { ApiError } from "@/lib/errors";

export const metadata: Metadata = { title: "Run results" };
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  const id = UuidSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const ctx = { c: getContainer() };
  const run = await loadRunFor(ctx, actor, id.data).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });
  // Dates cross the server/client boundary as ISO strings.
  const data = JSON.parse(JSON.stringify(await serializeRun(ctx, run)));
  return <RunView data={data} isOps={actor.role === "ops"} />;
}
