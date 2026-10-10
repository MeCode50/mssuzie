import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { getContainer } from "@/lib/container";
import { ApiError } from "@/lib/errors";
import { learnerDetail } from "@/lib/learners";
import { toJson } from "@/lib/json";
import { requirePageActor } from "@/lib/page-session";
import { UuidSchema } from "@/lib/schemas";

export const metadata: Metadata = { title: "Learner" };
export const dynamic = "force-dynamic";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default async function LearnerPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePageActor();
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) notFound();
  let d;
  try {
    d = toJson(await learnerDetail({ c: getContainer() }, actor, id));
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const l = d.learner;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/learners" className="text-sm font-semibold text-accent-strong underline-offset-2 hover:underline">← All learners</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{l.displayName}</h1>
          <StatusBadge status={l.status} />
        </div>
        <p className="text-muted">{l.grade} · age {l.age} · {l.subjects.join(", ")} · tutor {l.tutorName}{"guardianNames" in l ? ` · parent: ${(l.guardianNames as string[]).join(", ")}` : ""}</p>
        <Link href={`/sessions/new?learner=${l.id}`} className="mt-3 inline-flex min-h-11 items-center rounded-full bg-accent-strong px-5 font-semibold text-white hover:bg-[#9a4315]">New session</Link>
      </div>

      {d.openAlerts.length > 0 ? (
        <Card className="border-bad/40 bg-bad-bg">
          <h2 className="text-lg font-extrabold text-bad">Open alerts</h2>
          <ul className="mt-2 space-y-3">{d.openAlerts.map((a) => <li key={a.id}><p className="font-semibold">{a.reason}</p><p className="text-sm">Suggested: {a.intervention}</p></li>)}</ul>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-lg font-extrabold">Skills</h2>
          {d.skills.length === 0 ? <p className="mt-2 text-muted">No sessions analysed yet.</p> : (
            <ul className="mt-3 space-y-3">
              {d.skills.map((s) => (
                <li key={s.skill}>
                  <div className="flex items-baseline justify-between gap-3"><span className="font-semibold">{s.skill}</span><span className="text-sm tabular-nums text-muted">{Math.round(s.latest * 100)}% · {s.change >= 0 ? "+" : ""}{Math.round(s.change * 100)} pts</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-idle-bg" role="img" aria-label={`${s.skill}: ${Math.round(s.latest * 100)} percent`}><div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(s.latest * 100)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="text-lg font-extrabold">Coming up</h2>
          {d.upcomingEvents.length === 0 ? <p className="mt-2 text-muted">Nothing scheduled.</p> : (
            <ul className="mt-3 space-y-2">{d.upcomingEvents.map((e) => <li key={e.id} className="flex justify-between gap-3"><span className="font-semibold">{e.title}</span><span className="text-sm text-muted">{e.subject} · {date(e.dueDate)}</span></li>)}</ul>
          )}
          <h2 className="mt-6 text-lg font-extrabold">Sessions</h2>
          <ul className="mt-3 space-y-1">
            {d.sessions.slice(0, 8).map((s) => (
              <li key={s.id} className="flex justify-between gap-3 text-sm">
                <span>{date(s.heldAt)} · {s.durationMin} min</span>
                {s.latestRun ? <Link href={`/runs/${s.latestRun.id}`} className="font-semibold text-accent-strong underline-offset-2 hover:underline">View results</Link> : <span className="text-muted">No analysis</span>}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {d.latestParentUpdate ? (
        <Card>
          <h2 className="text-lg font-extrabold">Latest parent update <span className="text-sm font-semibold text-muted">({d.latestParentUpdate.status})</span></h2>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{d.latestParentUpdate.body}</p>
        </Card>
      ) : null}
    </div>
  );
}
