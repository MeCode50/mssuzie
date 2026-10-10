import { findFreeSlots, isWithinHours, overlaps, type Interval } from "../scheduling/availability";
import { addHours, formatForBoth, hoursBetween, type LocalResolution } from "../scheduling/time";
import type { ScheduleContext } from "./context";
import { blockers } from "./tools";

/**
 * The reschedule policy. Pure code, never an LLM: the agents understand the request and gather facts,
 * this decides what is allowed. It trusts nothing a model said except what the parent asked for
 * (class, new time, confidence), and re-checks every fact against the database snapshot.
 */

export const CONFIDENCE_THRESHOLD = 0.8;

export type Outcome = "auto_apply" | "propose" | "escalate";
export type PolicyCode =
  | "ok" | "slot_unavailable" | "injection" | "not_reschedule" | "wrong_child" | "unclear_booking"
  | "short_notice" | "unclear_time" | "low_confidence" | "no_change" | "no_alternatives";
export type SlotProblem = "too_soon" | "outside_hours" | "tutor_busy" | "learner_busy";

export interface PolicyIntake {
  intent: "reschedule" | "cancel" | "other";
  childReference: "own_child" | "other_child" | "not_stated";
  confidence: number;
  injectionSuspected: boolean;
}

export interface PolicyInput {
  ctx: ScheduleContext;
  intake: PolicyIntake;
  /** Result of the code-side screen over the raw message. */
  injectionDetected: boolean;
  /** The class as stored in the database (null when the agents could not resolve one). */
  booking: { id: string; learnerId: string; startsAt: Date; durationMin: number; status: "scheduled" | "rescheduled" | "cancelled" } | null;
  /** The new start, read in the parent's time zone (null if the parent gave no usable time). */
  requested: { startsAt: Date; resolution: LocalResolution } | null;
  /** Alternatives a model suggested: candidates only, each is re-verified here. */
  schedulerAlternatives: Date[];
  confidenceThreshold?: number;
}

export interface PolicyChecks {
  noticeHours: number | null;
  minNoticeHours: number;
  confidence: number;
  confidenceThreshold: number;
  farEnough: boolean | null;
  withinHours: boolean | null;
  tutorFree: boolean | null;
  learnerFree: boolean | null;
}

export interface PolicyDecision {
  outcome: Outcome;
  code: PolicyCode;
  /** Plain language, with times shown in both people's zones. */
  reason: string;
  problems: SlotProblem[];
  requestedStartsAt: Date | null;
  /** Verified free alternatives (at most 2, nearest first). */
  alternatives: Interval[];
  checks: PolicyChecks;
}

const PROBLEM_TEXT = (tutor: string, minNotice: number): Record<SlotProblem, string> => ({
  too_soon: `it is less than ${minNotice} hours away`,
  outside_hours: `it is outside ${tutor}'s working hours`,
  tutor_busy: `${tutor} already has a class then`,
  learner_busy: "the child already has another class then",
});

/** Why a slot cannot be used. Empty means it can. */
export function slotProblems(slot: Interval, ctx: ScheduleContext): SlotProblem[] {
  const out: SlotProblem[] = [];
  if (slot.startsAt < addHours(ctx.now, ctx.minNoticeHours)) out.push("too_soon");
  if (!isWithinHours(slot, ctx.windows, ctx.tutorZone)) out.push("outside_hours");
  if (ctx.tutorBookings.some((b) => b.id !== ctx.movingBookingId && overlaps(b, slot))) out.push("tutor_busy");
  if (ctx.learnerBookings.some((b) => b.id !== ctx.movingBookingId && overlaps(b, slot))) out.push("learner_busy");
  return out;
}

/** The (at most 2) verified free slots nearest to the requested time. */
export function pickAlternatives(input: PolicyInput, requested: Date, current: Date, durationMin: number): Interval[] {
  const { ctx } = input;
  const found = findFreeSlots({
    windows: ctx.windows, tutorZone: ctx.tutorZone, booked: blockers(ctx), durationMin, around: requested, count: 8,
    searchHours: 72, notBefore: addHours(ctx.now, ctx.minNoticeHours), stepMin: 30, exclude: [current],
  });
  const candidates: Interval[] = [...input.schedulerAlternatives.map((startsAt) => ({ startsAt, durationMin })), ...found];
  const seen = new Set<number>([current.getTime(), requested.getTime()]);
  const valid: Interval[] = [];
  for (const c of candidates) {
    const key = c.startsAt.getTime();
    if (Number.isNaN(key) || seen.has(key)) continue;
    seen.add(key);
    if (slotProblems(c, ctx).length === 0) valid.push(c);
  }
  const dist = (i: Interval) => Math.abs(i.startsAt.getTime() - requested.getTime());
  return valid.sort((a, b) => dist(a) - dist(b) || a.startsAt.getTime() - b.startsAt.getTime()).slice(0, 2);
}

export function decideReschedule(input: PolicyInput): PolicyDecision {
  const { ctx, intake, booking, requested } = input;
  const threshold = input.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
  const confidence = Number.isFinite(intake.confidence) ? intake.confidence : 0;
  const show = (d: Date) => formatForBoth(d, ctx.guardianZone, ctx.tutorZone);
  const tutor = ctx.tutorFirstName;

  const checks: PolicyChecks = {
    noticeHours: booking ? hoursBetween(ctx.now, booking.startsAt) : null,
    minNoticeHours: ctx.minNoticeHours, confidence, confidenceThreshold: threshold,
    farEnough: null, withinHours: null, tutorFree: null, learnerFree: null,
  };
  const escalate = (code: PolicyCode, reason: string, problems: SlotProblem[] = []): PolicyDecision => ({
    outcome: "escalate", code, reason, problems, requestedStartsAt: requested?.startsAt ?? null, alternatives: [], checks,
  });

  // Hard stops, most safety-critical first. Each sends the request to a person.
  if (input.injectionDetected || intake.injectionSuspected) {
    return escalate("injection", "The message contains instructions aimed at the system rather than a simple request, so a person should look at it before anything changes.");
  }
  if (intake.intent !== "reschedule") {
    return escalate("not_reschedule", intake.intent === "cancel" ? "The parent seems to want to cancel the class, which needs a person to handle." : "This does not look like a request to move a class.");
  }
  if (intake.childReference === "other_child") {
    return escalate("wrong_child", "The message names a child who is not this parent's child, so I can't change that booking.");
  }
  if (!booking || booking.learnerId !== ctx.learnerId || booking.status === "cancelled") {
    return escalate("unclear_booking", "I couldn't tell which of the child's classes the parent means.");
  }
  if (checks.noticeHours! < ctx.minNoticeHours) {
    const when = checks.noticeHours! <= 0 ? "has already started or passed" : `starts in ${checks.noticeHours!.toFixed(1)} hours`;
    return escalate("short_notice", `The class (${show(booking.startsAt)}) ${when}, which is under the ${ctx.minNoticeHours}-hour minimum notice, so ops need to decide.`);
  }
  if (!requested) return escalate("unclear_time", "The parent didn't give a clear new date and time.");
  if (requested.resolution !== "ok") {
    return escalate("unclear_time", requested.resolution === "gap"
      ? "The time asked for does not exist on that date (clocks change that night), so ops should confirm a time."
      : "The time asked for happens twice on that date (clocks change that night), so ops should confirm which one is meant.");
  }
  if (confidence < threshold) {
    return escalate("low_confidence", `I'm not confident enough about what the parent asked (${Math.round(confidence * 100)}% sure; I need ${Math.round(threshold * 100)}%), so I'm passing it to ops.`);
  }
  if (requested.startsAt.getTime() === booking.startsAt.getTime()) {
    return escalate("no_change", "The new time is the same as the current class time, so there is nothing to move.");
  }

  // The request is clear and about this child's class: now check the slot itself.
  const slot: Interval = { startsAt: requested.startsAt, durationMin: booking.durationMin };
  const problems = slotProblems(slot, ctx);
  checks.farEnough = !problems.includes("too_soon");
  checks.withinHours = !problems.includes("outside_hours");
  checks.tutorFree = !problems.includes("tutor_busy");
  checks.learnerFree = !problems.includes("learner_busy");

  if (problems.length === 0) {
    return {
      outcome: "auto_apply", code: "ok", problems, requestedStartsAt: requested.startsAt, alternatives: [], checks,
      reason: `${show(requested.startsAt)} is free, inside ${tutor}'s working hours, and ${hoursBetween(ctx.now, requested.startsAt).toFixed(0)} hours away (minimum ${ctx.minNoticeHours}).`,
    };
  }

  const text = PROBLEM_TEXT(tutor, ctx.minNoticeHours);
  const why = problems.map((p) => text[p]).join(" and ");
  const alternatives = pickAlternatives(input, requested.startsAt, booking.startsAt, booking.durationMin);
  if (alternatives.length === 0) {
    return { ...escalate("no_alternatives", `${show(requested.startsAt)} can't be used (${why}) and no free alternative was found nearby, so ops need to decide.`, problems), alternatives };
  }
  return {
    outcome: "propose", code: "slot_unavailable", problems, requestedStartsAt: requested.startsAt, alternatives, checks,
    reason: `${show(requested.startsAt)} can't be used: ${why}. ${alternatives.length === 1 ? "One free alternative was" : "Two free alternatives were"} found nearby.`,
  };
}
