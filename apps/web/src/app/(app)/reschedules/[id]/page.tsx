import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RequestView } from "@/components/reschedule/request-view";
import { getContainer } from "@/lib/container";
import { ApiError } from "@/lib/errors";
import { toJson } from "@/lib/json";
import { requirePageActor } from "@/lib/page-session";
import { requestDetail } from "@/lib/reschedules";
import { UuidSchema } from "@/lib/schemas";

export const metadata: Metadata = { title: "Reschedule request" };
export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) notFound();
  try {
    return <RequestView initial={toJson(await requestDetail({ c: getContainer() }, actor, id))} />;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}
