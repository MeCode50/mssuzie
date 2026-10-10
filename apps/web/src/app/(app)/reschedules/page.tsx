import type { Metadata } from "next";
import { Simulator } from "@/components/reschedule/simulator";
import { EmptyState } from "@/components/ui/states";
import { getContainer } from "@/lib/container";
import { toJson } from "@/lib/json";
import { requirePageActor } from "@/lib/page-session";
import { listGuardians, listRequests } from "@/lib/reschedules";
import { UuidSchema } from "@/lib/schemas";

export const metadata: Metadata = { title: "Reschedules" };
export const dynamic = "force-dynamic";

export default async function ReschedulesPage({ searchParams }: { searchParams: Promise<{ request?: string; run?: string }> }) {
  const actor = await requirePageActor();
  const { request, run } = await searchParams;
  const c = { c: getContainer() };
  const [guardians, feed] = await Promise.all([listGuardians(c, actor), listRequests(c, actor, "all")]);

  if (guardians.length === 0) {
    return (
      <EmptyState title="No parents yet">
        {actor.role === "tutor" ? "No learners are assigned to you yet." : "There are no learners in the demo. Use “Reset demo data” to restore the fictional learners."}
      </EmptyState>
    );
  }
  const attach = UuidSchema.safeParse(request).success && UuidSchema.safeParse(run).success ? { requestId: request as string, runId: run as string } : null;
  return <Simulator guardians={toJson(guardians)} feed={toJson(feed)} initial={attach} />;
}
