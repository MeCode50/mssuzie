import type { Metadata } from "next";
import { LearnerCard } from "@/components/learners/learner-card";
import { EmptyState } from "@/components/ui/states";
import { getContainer } from "@/lib/container";
import { listLearners } from "@/lib/learners";
import { toJson } from "@/lib/json";
import { requirePageActor } from "@/lib/page-session";

export const metadata: Metadata = { title: "Learners" };
export const dynamic = "force-dynamic";

export default async function LearnersPage() {
  const actor = await requirePageActor();
  const { learners, counts } = toJson(await listLearners({ c: getContainer() }, actor, null));
  if (learners.length === 0) return <EmptyState title="No learners yet">{actor.role === "tutor" ? "No learners are assigned to you yet." : "Use “Reset demo data” to restore the fictional learners."}</EmptyState>;
  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Learners</h1>
      <p className="mt-1 text-muted" data-testid="learner-counts">{counts.at_risk} at risk · {counts.watch} to watch · {counts.on_track} on track</p>
      <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {learners.map((l) => <LearnerCard key={l.id} l={l} />)}
      </ul>
    </div>
  );
}
