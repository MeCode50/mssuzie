import type { PrismaClient } from "../db/client";
import { consumeActionToken, voidActionTokens } from "../notify/action-links";
import { notify } from "../notify/notifier";
import { completeMove, type ApplyDeps, type ApplyReport } from "./apply";
import { loadScheduleFor } from "./load";
import { moveBooking } from "./move";
import { makeContext } from "./pipeline";
import { slotProblems, type SlotProblem } from "./policy";

export type ConfirmActor =
  /** A parent following the single-use link from their email. */
  | { kind: "parent_link"; tokenId: string }
  /** A member of the ops team choosing a time (may override the minimum notice). */
  | { kind: "ops"; userId: string; name: string };

export type ConfirmRefusal =
  | "not_open" | "no_booking" | "not_offered" | "slot_unavailable" | "slot_taken" | "stale" | "cancelled" | "in_the_past";

export type ConfirmResult =
  | { ok: true; alreadyApplied: boolean; report: ApplyReport }
  | { ok: false; reason: ConfirmRefusal; problems?: SlotProblem[] };

export interface SettleDeps extends ApplyDeps {
  minNoticeHours: number;
}

const decidedBy = (a: ConfirmActor) => (a.kind === "ops" ? `ops:${a.name}` : "parent_link");

/**
 * Settle a proposed or escalated request on a chosen time: re-check everything against the schedule
 * as it is NOW (it may have changed since the options were offered), move the booking, then update
 * the calendar and tell both people. Safe to repeat for the same request and time.
 */
export async function confirmSlot(deps: SettleDeps, input: { requestId: string; startsAt: Date; actor: ConfirmActor }): Promise<ConfirmResult> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const { request, base, bookingVersions } = await loadScheduleFor(prisma, input.requestId, { now, minNoticeHours: deps.minNoticeHours });

  // Already done with this very time: report success and just make sure the follow-through finished.
  if (request.appliedToAt && request.appliedToAt.getTime() === input.startsAt.getTime()) {
    return { ok: true, alreadyApplied: true, report: await completeMove(deps, request.id, "confirmed") };
  }
  const open = request.decision === "proposed" || (request.decision === "escalated" && input.actor.kind === "ops");
  if (!open || request.appliedToAt) return { ok: false, reason: "not_open" };
  if (!request.bookingId) return { ok: false, reason: "no_booking" };

  // A parent can only pick a time we actually offered.
  if (input.actor.kind === "parent_link") {
    const offered = (Array.isArray(request.proposedSlotsJson) ? request.proposedSlotsJson : []) as { startsAt?: string }[];
    if (!offered.some((s) => s.startsAt && new Date(s.startsAt).getTime() === input.startsAt.getTime())) return { ok: false, reason: "not_offered" };
  }
  if (input.startsAt <= now) return { ok: false, reason: "in_the_past" };

  const booking = await prisma.booking.findUnique({ where: { id: request.bookingId } });
  if (!booking || booking.status === "cancelled") return { ok: false, reason: "cancelled" };

  // Re-verify against the current schedule. Ops may knowingly go inside the notice window; nothing else.
  const ctx = makeContext(base, booking.id);
  const noticeOverride = input.actor.kind === "ops";
  const problems = slotProblems({ startsAt: input.startsAt, durationMin: booking.durationMin }, noticeOverride ? { ...ctx, minNoticeHours: 0 } : ctx);
  if (problems.length > 0) return { ok: false, reason: "slot_unavailable", problems };

  const version = bookingVersions.get(booking.id) ?? booking.version;
  const moved = await moveBooking(prisma, {
    requestId: request.id, bookingId: booking.id, toStartsAt: input.startsAt, expectedVersion: version,
    decision: "confirmed", decidedBy: decidedBy(input.actor), now,
  });
  if (!moved.ok) {
    const reason = moved.reason === "slot_taken" ? "slot_taken" : moved.reason === "stale" ? "stale" : moved.reason === "cancelled" ? "cancelled" : "not_open";
    return { ok: false, reason };
  }

  // Every other offered link is now void; the one used is spent.
  if (input.actor.kind === "parent_link") await consumeActionToken(prisma, input.actor.tokenId, now);
  await voidActionTokens(prisma, request.id, now);
  return { ok: true, alreadyApplied: moved.alreadyApplied, report: await completeMove(deps, request.id, "confirmed") };
}

export type RejectResult = { ok: true; alreadyRejected: boolean; report: ApplyReport } | { ok: false; reason: "not_open" };

/** Ops declines a request with a note; the parent is told, the booking is left exactly as it was. */
export async function rejectRequest(deps: ApplyDeps, input: { requestId: string; userName: string; note: string }): Promise<RejectResult> {
  const { prisma } = deps;
  const now = deps.now?.() ?? new Date();
  const request = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: input.requestId } });
  if (request.decision === "rejected") return { ok: true, alreadyRejected: true, report: await sendRejection(deps, request.id) };
  if (request.appliedToAt || (request.decision !== "proposed" && request.decision !== "escalated")) return { ok: false, reason: "not_open" };

  const { count } = await prisma.rescheduleRequest.updateMany({
    where: { id: request.id, appliedToAt: null, decision: { in: ["proposed", "escalated"] } },
    data: { decision: "rejected", decidedBy: `ops:${input.userName}`, reason: input.note.trim() },
  });
  if (count !== 1) return { ok: false, reason: "not_open" }; // someone settled it first
  await voidActionTokens(prisma, request.id, now);
  return { ok: true, alreadyRejected: false, report: await sendRejection(deps, request.id) };
}

async function sendRejection(deps: ApplyDeps, requestId: string): Promise<ApplyReport> {
  // Reuse the escalation announcer's loader through a tiny local send: one parent email, recorded once.
  const r = await deps.prisma.rescheduleRequest.findUniqueOrThrow({
    where: { id: requestId }, include: { guardian: { include: { learner: { include: { tutor: true } } } } },
  });
  const first = (n: string) => n.split(" ")[0] ?? n;
  const out = await notify(deps.prisma, deps.mailer, {
    requestId, kind: "rejected", role: "parent", to: r.guardian.email,
    context: {
      guardianFirstName: first(r.guardian.name), learnerFirstName: first(r.guardian.learner.displayName), tutorFirstName: first(r.guardian.learner.tutor.name),
      guardianZone: r.guardian.timezone, tutorZone: r.guardian.learner.tutor.timezone, reason: r.reason ?? undefined,
    },
  });
  return { failures: out?.status === "failed" ? { notifier_agent: out.error ?? "The email could not be sent." } : {} };
}
