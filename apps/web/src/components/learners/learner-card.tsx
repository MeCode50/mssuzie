import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { StatusBadge, type LearnerStatus } from "@/components/ui/status-badge";

export interface LearnerCardData {
  id: string;
  displayName: string;
  grade: string;
  subjects: string[];
  status: LearnerStatus;
  tutorName: string;
  nextEvent: { type: string; subject: string; title: string; dueDate: string } | null;
  lastSessionAt: string | null;
  openAlert: { id: string; severity: string } | null;
}

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function LearnerCard({ l }: { l: LearnerCardData }) {
  return (
    <li data-testid="learner-card" className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-extrabold"><Link href={`/learners/${l.id}`} className="underline-offset-2 hover:underline">{l.displayName}</Link></h2>
          <p className="text-sm text-muted">{l.grade} · {l.subjects.join(", ")}</p>
        </div>
        <StatusBadge status={l.status} />
      </div>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex gap-2"><dt className="text-muted">Tutor</dt><dd className="font-semibold">{l.tutorName}</dd></div>
        <div className="flex gap-2"><dt className="text-muted">Last session</dt><dd className="font-semibold">{l.lastSessionAt ? date(l.lastSessionAt) : "None yet"}</dd></div>
        {l.nextEvent ? <div className="flex gap-2"><dt className="text-muted">Next</dt><dd className="font-semibold">{l.nextEvent.title} · {date(l.nextEvent.dueDate)}</dd></div> : null}
      </dl>
      {l.openAlert ? <p className={cn("mt-3 inline-block rounded-full px-3 py-1 text-sm font-bold", l.openAlert.severity === "high" ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn")}>Open alert · {l.openAlert.severity}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/sessions/new?learner=${l.id}`} className="inline-flex min-h-9 items-center rounded-full bg-accent-strong px-4 text-sm font-semibold text-white hover:bg-[#9a4315]">New session</Link>
        <Link href={`/learners/${l.id}`} className="inline-flex min-h-9 items-center rounded-full bg-surface px-4 text-sm font-semibold ring-1 ring-field hover:bg-accent-soft">Details</Link>
      </div>
    </li>
  );
}
