import type { Metadata } from "next";
import { NewSession } from "@/components/session/new-session";
import { EmptyState } from "@/components/ui/states";
import { getContainer } from "@/lib/container";
import { listLearners } from "@/lib/learners";
import { requirePageActor } from "@/lib/page-session";
import { UuidSchema } from "@/lib/schemas";

export const metadata: Metadata = { title: "New session" };
export const dynamic = "force-dynamic";

export default async function NewSessionPage({ searchParams }: { searchParams: Promise<{ learner?: string; run?: string }> }) {
  const actor = await requirePageActor();
  const { learner, run } = await searchParams;
  const { learners } = await listLearners({ c: getContainer() }, actor, null);

  if (learners.length === 0) {
    return (
      <EmptyState title="No learners yet">
        {actor.role === "tutor"
          ? "No learners are assigned to you yet. Please ask the MsSuzie team to add your learners."
          : "There are no learners in the demo. Use “Reset demo data” to restore the fictional learners."}
      </EmptyState>
    );
  }

  const options = learners.map((l) => ({ id: l.id, displayName: l.displayName, grade: l.grade, subjects: l.subjects, status: l.status }));
  const chosen = UuidSchema.safeParse(learner).success && options.some((o) => o.id === learner) ? (learner as string) : null;
  return <NewSession learners={options} initialLearnerId={chosen} initialRunId={UuidSchema.safeParse(run).success ? (run as string) : null} />;
}
