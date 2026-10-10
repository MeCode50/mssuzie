import { endOf, isWithinHours, overlaps, type Interval, type Window } from "./availability";
import { addHours, addMinutes, hoursBetween, isoWeekdayOfDate, parseLocal, toZone } from "./time";

/**
 * The fictional demo timetable, generated relative to "now" so the three demo scenarios work on any
 * day. Pure: give it a time, get bookings back. The seed writes them to the database.
 */

export type TutorKey = "tutor1" | "tutor2";
export type LearnerKey = "Amara" | "Leo" | "Priya" | "Tomás" | "Zainab";

export const TUTOR_ZONE = "Africa/Lagos";

/** Weekly hours, local to the tutor (Africa/Lagos). Tutor 1 does not work Sundays. */
export const DEMO_HOURS: Record<TutorKey, Window[]> = {
  tutor1: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "06:00", end: "21:00" })),
  tutor2: [
    ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "07:00", end: "22:00" })),
    { weekday: 7, start: "12:00", end: "18:00" },
  ],
};

export const GUARDIAN_ZONES: Record<LearnerKey, string> = {
  Amara: "Europe/London",
  Leo: "America/Chicago",
  Priya: "Europe/London",
  Tomás: "Europe/Lisbon",
  Zainab: "Europe/London",
};

const TUTOR_OF: Record<LearnerKey, TutorKey> = { Amara: "tutor1", Priya: "tutor1", Leo: "tutor2", Tomás: "tutor2", Zainab: "tutor2" };

/** Regular weekly classes, in the guardian's local time (weekday 1 = Monday). All 60 minutes. */
const REGULAR: Record<LearnerKey, { weekday: number; time: string }[]> = {
  Amara: [{ weekday: 1, time: "17:00" }, { weekday: 3, time: "17:00" }, { weekday: 5, time: "17:00" }],
  Priya: [{ weekday: 1, time: "18:00" }, { weekday: 2, time: "16:00" }, { weekday: 4, time: "16:00" }, { weekday: 6, time: "10:00" }],
  Leo: [{ weekday: 2, time: "10:00" }, { weekday: 4, time: "10:00" }],
  Tomás: [{ weekday: 1, time: "15:00" }, { weekday: 3, time: "15:00" }],
  Zainab: [{ weekday: 1, time: "09:00" }, { weekday: 3, time: "09:00" }, { weekday: 5, time: "09:00" }],
};

export type BookingRole = "happy" | "conflict" | "conflict-blocker" | "escalation" | "regular";

export interface PlannedBooking extends Interval {
  learner: LearnerKey;
  tutor: TutorKey;
  role: BookingRole;
}

export interface DemoScenarios {
  /** Amara: a 07:00 class (her zone); her tutor is free at 19:00 the same day. */
  happy: { learner: "Amara"; currentStartsAt: Date; requestedStartsAt: Date; zone: string };
  /** Leo: the requested time is taken by another learner; free slots exist nearby. */
  conflict: { learner: "Leo"; currentStartsAt: Date; requestedStartsAt: Date; blockedBy: "Zainab"; zone: string };
  /** Priya: the class starts in about two hours, which is below the minimum notice. */
  escalation: { learner: "Priya"; currentStartsAt: Date; zone: string };
}

export interface DemoPlan {
  bookings: PlannedBooking[];
  scenarios: DemoScenarios;
}

const DURATION = 60;
const LOOKAHEAD_DAYS = 21;
const MARGIN_HOURS = 2;

/** The local calendar dates (YYYY-MM-DD) from today onwards in a zone. */
function* localDays(now: Date, zone: string, count: number): Generator<string> {
  const today = toZone(now, zone).startOf("day");
  for (let i = 0; i < count; i++) yield today.plus({ days: i }).toISODate() as string;
}

function at(date: string, time: string, zone: string): Date | null {
  const p = parseLocal(date, time, zone);
  return p.resolution === "ok" ? p.utc : null; // never place a demo class on a DST gap/overlap
}

const interval = (startsAt: Date): Interval => ({ startsAt, durationMin: DURATION });

function ceilToQuarter(d: Date): Date {
  const q = 15 * 60_000;
  return new Date(Math.ceil(d.getTime() / q) * q);
}

export function planDemoBookings(now: Date, minNoticeHours = 12): DemoPlan {
  const needAhead = minNoticeHours + MARGIN_HOURS;
  const lagosHours = DEMO_HOURS;
  const planned: PlannedBooking[] = [];
  const reserved: { tutor: TutorKey; from: Date; to: Date }[] = [];

  const clashes = (tutor: TutorKey, learner: LearnerKey, slot: Interval) =>
    planned.some((b) => (b.tutor === tutor || b.learner === learner) && overlaps(b, slot));
  const inReservedRange = (tutor: TutorKey, slot: Interval) =>
    reserved.some((r) => r.tutor === tutor && slot.startsAt < r.to && r.from < endOf(slot));

  // Scenario 1: happy path. Amara, a 07:00 class in her zone; 19:00 the same day is free for her tutor.
  const amaraZone = GUARDIAN_ZONES.Amara;
  let happy: DemoScenarios["happy"] | null = null;
  for (const day of localDays(now, amaraZone, LOOKAHEAD_DAYS)) {
    const current = at(day, "07:00", amaraZone);
    const requested = at(day, "19:00", amaraZone);
    if (!current || !requested || hoursBetween(now, current) < needAhead) continue;
    if (!isWithinHours(interval(current), lagosHours.tutor1, TUTOR_ZONE)) continue;
    if (!isWithinHours(interval(requested), lagosHours.tutor1, TUTOR_ZONE)) continue;
    happy = { learner: "Amara", currentStartsAt: current, requestedStartsAt: requested, zone: amaraZone };
    break;
  }
  if (!happy) throw new Error("Could not place the happy-path demo booking");
  planned.push({ learner: "Amara", tutor: "tutor1", ...interval(happy.currentStartsAt), role: "happy" });
  reserved.push({ tutor: "tutor1", from: happy.requestedStartsAt, to: addMinutes(happy.requestedStartsAt, DURATION) });

  // Scenario 2: conflict. Leo asks for 12:00 (his zone); his tutor is teaching Zainab then.
  const leoZone = GUARDIAN_ZONES.Leo;
  let conflict: DemoScenarios["conflict"] | null = null;
  for (const day of localDays(now, leoZone, LOOKAHEAD_DAYS)) {
    const current = at(day, "10:00", leoZone);
    const requested = at(day, "12:00", leoZone);
    if (!current || !requested || hoursBetween(now, current) < needAhead) continue;
    if (!isWithinHours(interval(current), lagosHours.tutor2, TUTOR_ZONE)) continue;
    if (!isWithinHours(interval(requested), lagosHours.tutor2, TUTOR_ZONE)) continue;
    conflict = { learner: "Leo", currentStartsAt: current, requestedStartsAt: requested, blockedBy: "Zainab", zone: leoZone };
    break;
  }
  if (!conflict) throw new Error("Could not place the conflict demo booking");
  planned.push({ learner: "Leo", tutor: "tutor2", ...interval(conflict.currentStartsAt), role: "conflict" });
  planned.push({ learner: "Zainab", tutor: "tutor2", ...interval(conflict.requestedStartsAt), role: "conflict-blocker" });
  // Keep the hours around the requested time free so there are always alternatives to offer.
  reserved.push({ tutor: "tutor2", from: addHours(conflict.requestedStartsAt, -3), to: addHours(conflict.requestedStartsAt, 4) });

  // Scenario 3: escalation. Priya's class starts in about two hours: under any sensible minimum notice.
  const escalationStart = ceilToQuarter(addHours(now, 2));
  const escalation: DemoScenarios["escalation"] = { learner: "Priya", currentStartsAt: escalationStart, zone: GUARDIAN_ZONES.Priya };
  planned.push({ learner: "Priya", tutor: "tutor1", ...interval(escalationStart), role: "escalation" });

  // Regular weekly classes for the next three weeks, wherever they fit.
  for (const learner of Object.keys(REGULAR) as LearnerKey[]) {
    const tutor = TUTOR_OF[learner];
    const zone = GUARDIAN_ZONES[learner];
    for (const day of localDays(now, zone, LOOKAHEAD_DAYS)) {
      const weekday = isoWeekdayOfDate(day);
      for (const t of REGULAR[learner]) {
        if (t.weekday !== weekday) continue;
        const startsAt = at(day, t.time, zone);
        if (!startsAt || startsAt < addHours(now, 1)) continue;
        const slot = interval(startsAt);
        if (!isWithinHours(slot, lagosHours[tutor], TUTOR_ZONE)) continue;
        if (clashes(tutor, learner, slot) || inReservedRange(tutor, slot)) continue;
        planned.push({ learner, tutor, ...slot, role: "regular" });
      }
    }
  }

  planned.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { bookings: planned, scenarios: { happy, conflict, escalation } };
}
