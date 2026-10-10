import { DateTime } from "luxon";
import { z } from "zod";
import type { ToolDef } from "../llm/tool-loop";
import { endOf, findFreeSlots, isWithinHours, overlaps, type Interval } from "../scheduling/availability";
import { addHours, formatLocal, zoneLabel } from "../scheduling/time";
import type { ScheduleContext } from "./context";

const MS_DAY = 86_400_000;
const iso = z.string().datetime({ message: "must be an ISO 8601 UTC date-time such as 2026-10-12T18:00:00Z" });

/** Free slots must keep clear of every class the tutor teaches and every other class the learner has. */
export function blockers(ctx: ScheduleContext): Interval[] {
  return [
    ...ctx.tutorBookings.filter((b) => b.id !== ctx.movingBookingId),
    ...ctx.learnerBookings.filter((b) => b.id !== ctx.movingBookingId),
  ];
}

const view = (ctx: ScheduleContext, i: Interval) => ({
  startsAt: i.startsAt.toISOString(),
  endsAt: endOf(i).toISOString(),
  durationMin: i.durationMin,
  tutorLocal: `${formatLocal(i.startsAt, ctx.tutorZone)} ${zoneLabel(i.startsAt, ctx.tutorZone)}`,
  parentLocal: `${formatLocal(i.startsAt, ctx.guardianZone)} ${zoneLabel(i.startsAt, ctx.guardianZone)}`,
});

/**
 * The Scheduler agent's tools. All three are read-only (so trivially idempotent) and take no tutor or
 * learner argument: they are bound to this request's tutor and learner. They never reveal other
 * learners' names or ids; a busy slot is just busy.
 */
export function buildSchedulerTools(ctx: ScheduleContext): ToolDef[] {
  const get_bookings: ToolDef = {
    name: "get_bookings",
    description:
      "List the tutor's classes that overlap a time range (UTC). Other learners appear only as busy time. " +
      "'isThisLearner' marks this child's own classes; 'isTheClassBeingMoved' marks the class being rescheduled. Range at most 14 days.",
    parameters: z.object({ from: iso, to: iso }),
    execute: async (input: { from: string; to: string }) => {
      const from = new Date(input.from);
      const to = new Date(input.to);
      if (!(from < to)) throw new Error("'from' must be before 'to'.");
      if (to.getTime() - from.getTime() > 14 * MS_DAY) throw new Error("Ask for at most 14 days at a time.");
      const range: Interval = { startsAt: from, durationMin: Math.round((to.getTime() - from.getTime()) / 60_000) };
      const bookings = ctx.tutorBookings
        .filter((b) => overlaps(b, range))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .map((b) => ({ ...view(ctx, b), isThisLearner: b.learnerId === ctx.learnerId, isTheClassBeingMoved: b.id === ctx.movingBookingId }));
      return { tutorTimezone: ctx.tutorZone, count: bookings.length, bookings };
    },
  };

  const get_tutor_availability: ToolDef = {
    name: "get_tutor_availability",
    description: "The tutor's working hours on one calendar date, in the tutor's own time zone. An empty list means the tutor does not work that day.",
    parameters: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD (the tutor's local date)") }),
    execute: async (input: { date: string }) => {
      // Luxon checks the calendar properly (JavaScript's Date quietly turns 30 February into 2 March).
      const day = DateTime.fromISO(input.date, { zone: "UTC" }).set({ hour: 12 });
      if (!day.isValid) throw new Error("That is not a real date.");
      if (Math.abs(day.toMillis() - ctx.now.getTime()) > 90 * MS_DAY) throw new Error("Ask about a date within 90 days of today.");
      const weekday = day.weekday;
      const windows = ctx.windows.filter((w) => w.weekday === weekday).map((w) => ({ start: w.start, end: w.end }));
      return { date: input.date, weekday: day.weekdayLong, tutorTimezone: ctx.tutorZone, working: windows.length > 0, windows };
    },
  };

  const find_free_slots: ToolDef = {
    name: "find_free_slots",
    description:
      "Find the free slots nearest to a time: inside the tutor's working hours, not overlapping any of the tutor's classes or this child's other classes, " +
      "and far enough ahead to meet the minimum notice. The class being moved does not block its own replacement slot. Slots start on the hour or half hour (tutor's time).",
    parameters: z.object({
      around: iso,
      count: z.number().int().min(1).max(5).optional(),
      searchHours: z.number().int().min(1).max(72).optional(),
      durationMin: z.number().int().min(15).max(240).optional(),
    }),
    execute: async (input: { around: string; count?: number; searchHours?: number; durationMin?: number }) => {
      const slots = findFreeSlots({
        windows: ctx.windows, tutorZone: ctx.tutorZone, booked: blockers(ctx), durationMin: input.durationMin ?? ctx.durationMin,
        around: new Date(input.around), count: input.count ?? 2, searchHours: input.searchHours ?? 24,
        notBefore: addHours(ctx.now, ctx.minNoticeHours), stepMin: 30,
      });
      return { count: slots.length, minimumNoticeHours: ctx.minNoticeHours, slots: slots.map((s) => view(ctx, s)) };
    },
  };

  return [get_bookings, get_tutor_availability, find_free_slots];
}

export { isWithinHours };
