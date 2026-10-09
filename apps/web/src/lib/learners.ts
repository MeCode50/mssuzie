import { PlanSchema } from "@mssuzie/core";
import { humanize, humanizeTokens } from "./display";
import { errors } from "./errors";
import type { RequestContext } from "./http";
import { learnerScope, type Actor } from "./session";

export const STATUSES = ["on_track", "watch", "at_risk"] as const;
export type Status = (typeof STATUSES)[number];
const ORDER: Record<Status, number> = { at_risk: 0, watch: 1, on_track: 2 };

const startOfToday = () => new Date(new Date().setUTCHours(0, 0, 0, 0));

export async function listLearners(ctx: Pick<RequestContext, "c">, actor: Actor, status: Status | null) {
  const rows = await ctx.c.prisma.learner.findMany({
    where: learnerScope(actor),
    include: {
      tutor: { select: { name: true } },
      events: { where: { dueDate: { gte: startOfToday() } }, orderBy: { dueDate: "asc" }, take: 1 },
      sessions: { orderBy: { heldAt: "desc" }, take: 1, select: { heldAt: true } },
      alerts: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const counts = { on_track: 0, watch: 0, at_risk: 0 };
  for (const l of rows) counts[l.currentStatus] += 1;

  const learners = rows
    .filter((l) => !status || l.currentStatus === status)
    .sort((a, b) => ORDER[a.currentStatus] - ORDER[b.currentStatus] || a.displayName.localeCompare(b.displayName))
    .map((l) => ({
      id: l.id, displayName: l.displayName, age: l.age, grade: l.grade, subjects: l.subjects, interests: l.interests,
      planHoursPerWeek: l.planHoursPerWeek, status: l.currentStatus, tutorName: l.tutor.name,
      nextEvent: l.events[0] ? { type: l.events[0].type, subject: l.events[0].subject, title: l.events[0].title, dueDate: l.events[0].dueDate } : null,
      lastSessionAt: l.sessions[0]?.heldAt ?? null,
      openAlert: l.alerts[0] ? { id: l.alerts[0].id, severity: l.alerts[0].severity } : null,
    }));
  return { learners, counts };
}

export async function learnerDetail(ctx: RequestContext, actor: Actor, id: string) {
  const { prisma } = ctx.c;
  const learner = await prisma.learner.findFirst({
    where: { id, ...learnerScope(actor) },
    include: { tutor: { select: { name: true } }, guardians: { select: { name: true } } },
  });
  if (!learner) throw errors.notFound("That learner");

  const [events, snapshots, sessions, planStep, parentUpdate, alerts] = await Promise.all([
    prisma.event.findMany({ where: { learnerId: id, dueDate: { gte: startOfToday() } }, orderBy: { dueDate: "asc" } }),
    prisma.skillSnapshot.findMany({ where: { learnerId: id }, include: { session: { select: { heldAt: true } } }, orderBy: { session: { heldAt: "asc" } } }),
    prisma.tutoringSession.findMany({
      where: { learnerId: id }, orderBy: { heldAt: "desc" }, take: 50,
      select: { id: true, heldAt: true, durationMin: true, runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true } } },
    }),
    prisma.runStep.findFirst({
      where: { agent: "learning_planner", status: "completed", run: { session: { learnerId: id } } },
      orderBy: { createdAt: "desc" }, include: { run: { select: { id: true, session: { select: { heldAt: true } } } } },
    }),
    prisma.parentUpdate.findFirst({ where: { learnerId: id }, orderBy: { createdAt: "desc" } }),
    prisma.alert.findMany({ where: { learnerId: id, status: "open" }, orderBy: { createdAt: "desc" } }),
  ]);

  const bySkill = new Map<string, { date: Date; mastery: number; evidence: string }[]>();
  for (const s of snapshots) {
    const list = bySkill.get(s.skill) ?? [];
    list.push({ date: s.session.heldAt, mastery: s.mastery, evidence: humanizeTokens(s.evidence) });
    bySkill.set(s.skill, list);
  }
  const skills = [...bySkill].map(([skill, points]) => {
    const latest = points.at(-1)!;
    const first = points[0]!;
    return { skill, points, latest: latest.mastery, change: Math.round((latest.mastery - first.mastery) * 100) / 100 };
  });

  const plan = planStep ? PlanSchema.safeParse(planStep.outputJson) : null;

  return {
    learner: {
      id: learner.id, displayName: learner.displayName, age: learner.age, grade: learner.grade, subjects: learner.subjects,
      interests: learner.interests, planHoursPerWeek: learner.planHoursPerWeek, status: learner.currentStatus,
      tutorName: learner.tutor.name,
      // Guardian contact details are never returned; the name only to ops.
      ...(actor.role === "ops" ? { guardianNames: learner.guardians.map((g) => g.name) } : {}),
    },
    upcomingEvents: events.map((e) => ({ id: e.id, type: e.type, subject: e.subject, title: e.title, dueDate: e.dueDate })),
    skills,
    sessions: sessions.map((s) => ({ id: s.id, heldAt: s.heldAt, durationMin: s.durationMin, latestRun: s.runs[0] ?? null })),
    currentPlan: plan?.success && planStep
      ? { runId: planStep.run.id, generatedAt: planStep.createdAt, afterSessionOn: planStep.run.session.heldAt, ...humanize(plan.data) }
      : null,
    latestParentUpdate: parentUpdate
      ? { id: parentUpdate.id, runId: parentUpdate.runId, body: parentUpdate.body, status: parentUpdate.status, createdAt: parentUpdate.createdAt, approvedAt: parentUpdate.approvedAt }
      : null,
    openAlerts: alerts.map((a) => ({ id: a.id, severity: a.severity, reason: humanize(a.reason), intervention: humanize(a.intervention), createdAt: a.createdAt, runId: a.runId })),
  };
}
