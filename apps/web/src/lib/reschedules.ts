import {
  confirmSlot, createRescheduleRequest, decrypt, formatForBoth, formatWithZone, MAX_MESSAGE_CHARS, rejectRequest, RequestError,
  type ConfirmRefusal, type Prisma, type SlotProblem,
} from "@mssuzie/core";
import { z } from "zod";
import { humanizeTokens } from "./display";
import { ApiError, errors } from "./errors";
import type { RequestContext } from "./http";
import { enforceRunLimits, stepView } from "./runs";
import { UuidSchema } from "./schemas";
import { learnerScope, type Actor } from "./session";

export const CreateRescheduleSchema = z.object({
  guardianId: UuidSchema,
  message: z
    .string()
    .transform((s) => s.normalize("NFC").replace(/\u0000/g, "").trim())
    .pipe(z.string().min(1, "Please type the parent's message.").max(MAX_MESSAGE_CHARS, `The message can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`)),
});

export const ApproveSchema = z.object({ startsAt: z.string().datetime({ message: "Choose one of the times." }).transform((s) => new Date(s)) });
export const RejectSchema = z.object({
  note: z.string().transform((s) => s.trim()).pipe(z.string().min(3, "Please add a short note for the parent.").max(500, "Keep the note under 500 characters.")),
});

export const FILTERS = ["all", "needs_person", "waiting", "done"] as const;
export type Filter = (typeof FILTERS)[number];

/** Tutors only see requests about their own learners; ops see all. */
export const requestScope = (actor: Actor): Prisma.RescheduleRequestWhereInput => ({ guardian: { learner: learnerScope(actor) } });

const FILTER_WHERE: Record<Filter, Prisma.RescheduleRequestWhereInput> = {
  all: {},
  needs_person: { decision: "escalated" },
  waiting: { decision: "proposed" },
  done: { decision: { in: ["auto_applied", "confirmed", "rejected"] } },
};

const firstName = (n: string) => n.split(" ")[0] ?? n;

/** The people a message can be sent as: one row per parent, with who they are and their upcoming classes. */
export async function listGuardians(ctx: Pick<RequestContext, "c">, actor: Actor) {
  const now = new Date();
  const rows = await ctx.c.prisma.guardian.findMany({
    where: { learner: learnerScope(actor) },
    include: { learner: { include: { tutor: { select: { name: true, timezone: true } }, bookings: { where: { status: { not: "cancelled" }, startsAt: { gte: now } }, orderBy: { startsAt: "asc" }, take: 3 } } } },
    orderBy: { learner: { displayName: "asc" } },
  });
  return rows.map((g) => ({
    id: g.id, name: g.name, timezone: g.timezone,
    learner: { id: g.learner.id, displayName: g.learner.displayName },
    tutor: { name: g.learner.tutor.name, timezone: g.learner.tutor.timezone },
    upcoming: g.learner.bookings.map((b) => ({ id: b.id, startsAt: b.startsAt, durationMin: b.durationMin, status: b.status, local: formatWithZone(b.startsAt, g.timezone) })),
  }));
}

export async function createRequest(ctx: RequestContext, actor: Actor, input: z.infer<typeof CreateRescheduleSchema>) {
  const { c } = ctx;
  const guardian = await c.prisma.guardian.findFirst({ where: { id: input.guardianId, learner: learnerScope(actor) }, select: { id: true } });
  if (!guardian) throw errors.notFound("That parent");
  await enforceRunLimits(ctx, "create", actor);
  try {
    return await createRescheduleRequest(c.prisma, { guardianId: guardian.id, message: input.message, encryptionKey: c.env.ENCRYPTION_KEY, createdById: actor.id });
  } catch (err) {
    if (err instanceof RequestError) throw errors.validation(err.message);
    throw err;
  }
}

type Row = Prisma.RescheduleRequestGetPayload<{
  include: { guardian: { include: { learner: { include: { tutor: { select: { name: true; timezone: true } } } } } }; run: { select: { id: true; status: true } } };
}>;
const ROW_INCLUDE = {
  guardian: { include: { learner: { include: { tutor: { select: { name: true, timezone: true } } } } } },
  run: { select: { id: true, status: true } },
} as const;

function policyOf(parsed: unknown) {
  return (parsed as { policy?: { requested?: SlotView | null; alternatives?: SlotView[]; checks?: unknown; code?: string; outcome?: string } | null } | null)?.policy ?? null;
}
interface SlotView { startsAt: string; durationMin: number; parentLocal: string; tutorLocal: string; both: string }

function summary(r: Row) {
  const g = r.guardian;
  const policy = policyOf(r.parsedJson);
  const zoneParent = g.timezone;
  const zoneTutor = g.learner.tutor.timezone;
  const intake = (r.parsedJson as { intake?: { summary?: string } } | null)?.intake;
  return {
    id: r.id, createdAt: r.createdAt, channel: r.channel,
    runId: r.run?.id ?? null, runStatus: r.run?.status ?? null,
    decision: r.decision, decidedBy: r.decidedBy, reason: r.reason ? humanizeTokens(r.reason) : null,
    understood: intake?.summary ? humanizeTokens(intake.summary) : null,
    needsPerson: r.decision === "escalated",
    guardian: { id: g.id, name: g.name, timezone: zoneParent },
    learner: { id: g.learner.id, displayName: g.learner.displayName },
    tutor: { name: g.learner.tutor.name, timezone: zoneTutor },
    requested: policy?.requested ?? null,
    moved: r.appliedFromAt && r.appliedToAt
      ? {
          from: { startsAt: r.appliedFromAt, parentLocal: formatWithZone(r.appliedFromAt, zoneParent), tutorLocal: formatWithZone(r.appliedFromAt, zoneTutor), both: formatForBoth(r.appliedFromAt, zoneParent, zoneTutor) },
          to: { startsAt: r.appliedToAt, parentLocal: formatWithZone(r.appliedToAt, zoneParent), tutorLocal: formatWithZone(r.appliedToAt, zoneTutor), both: formatForBoth(r.appliedToAt, zoneParent, zoneTutor) },
        }
      : null,
  };
}

export async function listRequests(ctx: Pick<RequestContext, "c">, actor: Actor, filter: Filter, limit = 50) {
  const { prisma } = ctx.c;
  const scope = requestScope(actor);
  const [rows, counts] = await Promise.all([
    prisma.rescheduleRequest.findMany({ where: { AND: [scope, FILTER_WHERE[filter]] }, include: ROW_INCLUDE, orderBy: { createdAt: "desc" }, take: Math.min(limit, 100) }),
    Promise.all((["all", "needs_person", "waiting", "done"] as const).map(async (f) => [f, await prisma.rescheduleRequest.count({ where: { AND: [scope, FILTER_WHERE[f]] } })] as const)),
  ]);
  return { requests: rows.map(summary), counts: Object.fromEntries(counts) as Record<Filter, number> };
}

export async function requestDetail(ctx: RequestContext, actor: Actor, id: string) {
  const { prisma, env } = ctx.c;
  const row = await prisma.rescheduleRequest.findFirst({
    where: { id, ...requestScope(actor) },
    include: { ...ROW_INCLUDE, booking: true, notifications: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) throw errors.notFound("That request");
  const steps = row.runId ? await prisma.runStep.findMany({ where: { runId: row.runId }, orderBy: { seq: "asc" } }) : [];
  const policy = policyOf(row.parsedJson);
  const open = row.decision === "proposed" || row.decision === "escalated";
  const options = (Array.isArray(row.proposedSlotsJson) ? row.proposedSlotsJson : []) as unknown as SlotView[];
  return {
    ...summary(row),
    message: decrypt(row.rawMessageEnc, env.ENCRYPTION_KEY),
    checks: policy?.checks ?? null,
    code: policy?.code ?? null,
    options,
    booking: row.booking
      ? { id: row.booking.id, status: row.booking.status, startsAt: row.booking.startsAt, durationMin: row.booking.durationMin, calendarSynced: row.booking.calendarEventId !== null }
      : null,
    // Ops can approve a time once the class is known; escalations without one can only be declined.
    canSettle: open && actor.role === "ops",
    canChooseTime: open && actor.role === "ops" && row.bookingId !== null,
    steps: steps.map(stepView),
    notifications: row.notifications.map((n) => ({
      id: n.id, role: n.toRole, kind: n.kind, status: n.status, to: n.toEmail, intendedFor: n.intendedEmail, subject: n.subject, body: n.body, error: n.error, createdAt: n.createdAt,
    })),
  };
}

const PROBLEM_TEXT: Record<SlotProblem, string> = {
  too_soon: "it is too close to the start time",
  outside_hours: "it is outside the tutor's working hours",
  tutor_busy: "the tutor has another class then",
  learner_busy: "the learner already has a class then",
};

const REFUSAL: Record<ConfirmRefusal, { status: number; message: string }> = {
  not_open: { status: 409, message: "This request has already been settled." },
  no_booking: { status: 409, message: "We couldn't tell which class this is about, so a time can't be chosen here. You can decline it with a note." },
  not_offered: { status: 400, message: "That time wasn't one of the options." },
  slot_unavailable: { status: 409, message: "That time is no longer free." },
  slot_taken: { status: 409, message: "Someone just booked that time. Please choose another." },
  stale: { status: 409, message: "The class was changed a moment ago. Please refresh and look again." },
  cancelled: { status: 409, message: "That class has been cancelled." },
  in_the_past: { status: 400, message: "That time is in the past." },
};

export function refusalError(reason: ConfirmRefusal, problems?: SlotProblem[]): ApiError {
  const r = REFUSAL[reason];
  const why = problems?.length ? ` Because ${problems.map((p) => PROBLEM_TEXT[p]).join(" and ")}.` : "";
  return new ApiError(r.status, "conflict" as const, `${r.message}${why}`.trim());
}

const settleDeps = (ctx: Pick<RequestContext, "c">) => ({
  prisma: ctx.c.prisma, ...ctx.c.integrations, minNoticeHours: ctx.c.env.RESCHEDULE_MIN_NOTICE_HOURS,
});

export async function approveTime(ctx: RequestContext, actor: Actor, id: string, startsAt: Date) {
  const request = await ctx.c.prisma.rescheduleRequest.findFirst({ where: { id, ...requestScope(actor) }, select: { id: true } });
  if (!request) throw errors.notFound("That request");
  const res = await confirmSlot(settleDeps(ctx), { requestId: id, startsAt, actor: { kind: "ops", userId: actor.id, name: firstName(actor.name) } });
  if (!res.ok) throw refusalError(res.reason, res.problems);
  return { ok: true, alreadyApplied: res.alreadyApplied, problems: Object.entries(res.report.failures).map(([step, error]) => ({ step, error })) };
}

export async function declineRequest(ctx: RequestContext, actor: Actor, id: string, note: string) {
  const request = await ctx.c.prisma.rescheduleRequest.findFirst({ where: { id, ...requestScope(actor) }, select: { id: true } });
  if (!request) throw errors.notFound("That request");
  const res = await rejectRequest(settleDeps(ctx), { requestId: id, userName: firstName(actor.name), note });
  if (!res.ok) throw refusalError("not_open");
  return { ok: true, alreadyRejected: res.alreadyRejected, problems: Object.entries(res.report.failures).map(([step, error]) => ({ step, error })) };
}
