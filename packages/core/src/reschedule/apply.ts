import type { PrismaClient } from "../db/client";
import { eventIdForBooking, type CalendarService } from "../calendar/port";
import { issueActionToken } from "../notify/action-links";
import { notify, type Mailer, type NotifyOutcome } from "../notify/notifier";
import type { MessageContext, MessageKind } from "../notify/messages";
import type { AgentName, StepEvent } from "../pipeline/types";

export interface ApplyDeps {
  prisma: PrismaClient;
  calendar: CalendarService;
  mailer: Mailer;
  /** HMAC key for accept links; without it proposals are sent without links (and flagged). */
  linkSecret?: string;
  /** Public address of the web app, for accept links. */
  baseUrl: string;
  now?: () => Date;
  /** Trace sink; omitted when applying outside a run (e.g. from an accept link). */
  emit?: (e: StepEvent) => Promise<void>;
  attempts?: Partial<Record<AgentName, number>>;
}

export interface ApplyReport {
  failures: Partial<Record<AgentName, string>>;
}

const first = (name: string) => name.split(" ")[0] ?? name;

async function loadParties(prisma: PrismaClient, requestId: string) {
  const r = await prisma.rescheduleRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { booking: true, guardian: { include: { learner: { include: { tutor: true } } } } },
  });
  const learner = r.guardian.learner;
  const tutor = learner.tutor;
  const context: MessageContext = {
    guardianFirstName: first(r.guardian.name), learnerFirstName: first(learner.displayName), tutorFirstName: first(tutor.name),
    guardianZone: r.guardian.timezone, tutorZone: tutor.timezone,
  };
  return { request: r, learner, tutor, guardian: r.guardian, context };
}

/** A step in the trace around one unit of work. A thrown error is recorded and returned, never lost. */
async function traced(deps: ApplyDeps, agent: AgentName, work: () => Promise<unknown>): Promise<string | null> {
  const attempt = deps.attempts?.[agent] ?? 1;
  const started = Date.now();
  const base = { agent, attempt, model: undefined, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  await deps.emit?.({ ...base, status: "running", durationMs: 0 });
  try {
    const output = await work();
    await deps.emit?.({ ...base, status: "completed", output, durationMs: Date.now() - started });
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unexpected problem.";
    await deps.emit?.({ ...base, status: "failed", error, durationMs: Date.now() - started });
    return error;
  }
}

const summarise = (outs: (NotifyOutcome | null)[]) =>
  outs.filter((o): o is NotifyOutcome => o !== null).map((o) => ({ to: o.role, kind: o.kind, status: o.status, alreadySent: o.alreadySent }));

async function send(deps: ApplyDeps, requestId: string, kind: MessageKind, parties: Awaited<ReturnType<typeof loadParties>>, ctx: MessageContext, roles: ("parent" | "tutor" | "ops")[]) {
  const to = { parent: parties.guardian.email, tutor: parties.tutor.email, ops: undefined } as const;
  const outs: (NotifyOutcome | null)[] = [];
  for (const role of roles) outs.push(await notify(deps.prisma, deps.mailer, { requestId, kind, role, to: to[role], context: ctx }));
  const failed = outs.filter((o) => o?.status === "failed");
  if (failed.length > 0) throw new Error(`Could not send: ${failed.map((o) => `${o!.role} (${o!.error})`).join("; ")}`);
  return summarise(outs);
}

/**
 * After a booking has been moved (automatically, or because a parent or Ops chose a time): put the
 * new time on the calendar and tell the parent and the tutor. Both parts are safe to repeat.
 */
export async function completeMove(deps: ApplyDeps, requestId: string, kind: "applied" | "confirmed"): Promise<ApplyReport> {
  const failures: ApplyReport["failures"] = {};
  const p = await loadParties(deps.prisma, requestId);
  const booking = p.request.booking;
  if (!booking || !p.request.appliedToAt) throw new Error("This request has no moved booking to finish.");

  const calendarError = await traced(deps, "calendar_step", async () => {
    const eventId = booking.calendarEventId ?? eventIdForBooking(booking.id);
    await deps.calendar.upsertEvent({
      eventId, title: `MsSuzie class: ${p.context.learnerFirstName} with ${p.context.tutorFirstName}`,
      startsAt: booking.startsAt, durationMin: booking.durationMin,
    });
    await deps.prisma.booking.update({ where: { id: booking.id }, data: { calendarEventId: eventId } });
    return { eventId, startsAt: booking.startsAt.toISOString() };
  });
  if (calendarError) failures.calendar_step = calendarError;

  const ctx: MessageContext = { ...p.context, from: p.request.appliedFromAt ?? undefined, to: p.request.appliedToAt };
  const mailError = await traced(deps, "notifier_agent", () => send(deps, requestId, kind, p, ctx, ["parent", "tutor"]));
  if (mailError) failures.notifier_agent = mailError;
  return { failures };
}

/** Email the parent the verified alternatives, each with a single-use link. Safe to repeat: links are issued only once. */
export async function announceProposal(deps: ApplyDeps, requestId: string): Promise<ApplyReport> {
  const failures: ApplyReport["failures"] = {};
  const p = await loadParties(deps.prisma, requestId);
  const slots = (Array.isArray(p.request.proposedSlotsJson) ? p.request.proposedSlotsJson : []) as { startsAt: string }[];

  const error = await traced(deps, "notifier_agent", async () => {
    const already = await deps.prisma.notification.findUnique({ where: { requestId_toRole_kind: { requestId, toRole: "parent", kind: "proposal" } } });
    if (already && already.status !== "failed") return summarise([await notify(deps.prisma, deps.mailer, { requestId, kind: "proposal", role: "parent", to: p.guardian.email, context: p.context })]);
    if (!deps.linkSecret) throw new Error("Accept links are not configured (ACTION_LINK_SECRET), so the options were not sent.");
    const now = deps.now?.() ?? new Date();
    const options = [];
    for (const s of slots) {
      const startsAt = new Date(s.startsAt);
      const token = await issueActionToken(deps.prisma, deps.linkSecret, { requestId, slotStartsAt: startsAt, now });
      options.push({ startsAt, url: `${deps.baseUrl.replace(/\/$/, "")}/r/accept?token=${encodeURIComponent(token)}` });
    }
    return send(deps, requestId, "proposal", p, { ...p.context, options }, ["parent"]);
  });
  if (error) failures.notifier_agent = error;
  return { failures };
}

/** A person is needed: leave a note for Ops and tell the parent we have it. */
export async function announceEscalation(deps: ApplyDeps, requestId: string, reason: string): Promise<ApplyReport> {
  const failures: ApplyReport["failures"] = {};
  const p = await loadParties(deps.prisma, requestId);
  const error = await traced(deps, "notifier_agent", () => send(deps, requestId, "escalation", p, { ...p.context, reason }, ["ops", "parent"]));
  if (error) failures.notifier_agent = error;
  return { failures };
}
