import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { endOf, findFreeSlots, isWithinHours, overlaps, type Interval } from "./availability";
import { DEMO_HOURS, GUARDIAN_ZONES, planDemoBookings, TUTOR_ZONE } from "./demo-plan";
import {
  formatForBoth, formatWithZone, hoursBetween, isValidZone, localDate, minuteOfDayIn, parseLocal, toMinutes,
  utcOffsetLabel, weekdayIn, zoneLabel,
} from "./time";

const iso = (d: Date) => d.toISOString();

describe("time zones", () => {
  it("reads a wall-clock time in the right zone: 7pm London is 18:00 UTC in summer, 19:00 in winter", () => {
    expect(iso(parseLocal("2026-07-10", "19:00", "Europe/London").utc)).toBe("2026-07-10T18:00:00.000Z");
    expect(iso(parseLocal("2026-12-10", "19:00", "Europe/London").utc)).toBe("2026-12-10T19:00:00.000Z");
    expect(iso(parseLocal("2026-07-10", "19:00", "America/Chicago").utc)).toBe("2026-07-11T00:00:00.000Z");
    expect(iso(parseLocal("2026-12-10", "19:00", "Africa/Lagos").utc)).toBe("2026-12-10T18:00:00.000Z");
  });

  it("the same 7pm means different instants in different zones", () => {
    const london = parseLocal("2026-10-12", "19:00", "Europe/London").utc;
    const chicago = parseLocal("2026-10-12", "19:00", "America/Chicago").utc;
    expect(hoursBetween(london, chicago)).toBe(6);
  });

  it("flags a time that does not exist (spring forward) and one that happens twice (fall back)", () => {
    const gap = parseLocal("2026-03-29", "01:30", "Europe/London"); // UK clocks jump 01:00 -> 02:00
    expect(gap.resolution).toBe("gap");
    expect(iso(gap.utc)).toBe("2026-03-29T01:30:00.000Z"); // the first real instant after the gap
    const twice = parseLocal("2026-10-25", "01:30", "Europe/London"); // UK clocks go back 02:00 -> 01:00
    expect(twice.resolution).toBe("ambiguous");
    expect(iso(twice.utc)).toBe("2026-10-25T00:30:00.000Z"); // first occurrence (still summer time)
    expect(parseLocal("2026-10-25", "03:00", "Europe/London").resolution).toBe("ok");
    expect(parseLocal("2026-03-08", "02:30", "America/Chicago").resolution).toBe("gap");
  });

  it("keeps a weekly class at the same local hour across a DST change (UTC moves)", () => {
    const before = parseLocal("2026-03-28", "19:00", "Europe/London").utc;
    const after = parseLocal("2026-03-30", "19:00", "Europe/London").utc;
    expect(iso(before)).toBe("2026-03-28T19:00:00.000Z");
    expect(iso(after)).toBe("2026-03-30T18:00:00.000Z");
    expect(minuteOfDayIn(before, "Europe/London")).toBe(minuteOfDayIn(after, "Europe/London"));
  });

  it("different zones can be on different days, and offsets follow DST", () => {
    const d = parseLocal("2026-10-12", "23:30", "America/Chicago").utc; // 04:30 UTC on the 13th
    expect(localDate(d, "America/Chicago")).toBe("2026-10-12");
    expect(localDate(d, "Africa/Lagos")).toBe("2026-10-13");
    expect(weekdayIn(d, "Africa/Lagos")).toBe(2); // Tuesday
    expect(utcOffsetLabel(parseLocal("2026-07-10", "12:00", "Europe/London").utc, "Europe/London")).toBe("UTC+1");
    expect(utcOffsetLabel(parseLocal("2026-12-10", "12:00", "Europe/London").utc, "Europe/London")).toBe("UTC+0");
    expect(utcOffsetLabel(parseLocal("2026-12-10", "12:00", "America/Chicago").utc, "America/Chicago")).toBe("UTC-6");
    expect(utcOffsetLabel(parseLocal("2026-12-10", "12:00", "Asia/Kolkata").utc, "Asia/Kolkata")).toBe("UTC+5:30");
  });

  it("shows a time to a person in their own zone, spelled out, and to both people together", () => {
    const d = parseLocal("2026-10-17", "19:00", "Europe/London").utc;
    expect(formatWithZone(d, "Europe/London")).toBe("Sat 17 Oct, 7:00 PM London (UTC+1)");
    expect(zoneLabel(d, "Africa/Lagos")).toBe("Lagos (UTC+1)");
    const c = parseLocal("2026-10-17", "12:00", "America/Chicago").utc;
    expect(formatForBoth(c, "America/Chicago", "Africa/Lagos")).toBe("Sat 17 Oct, 12:00 PM Chicago (UTC-5) · 6:00 PM Lagos (UTC+1)");
    const late = parseLocal("2026-10-17", "20:00", "America/Chicago").utc; // 02:00 next day in Lagos
    expect(formatForBoth(late, "America/Chicago", "Africa/Lagos")).toContain("2:00 AM (Sun 18 Oct) Lagos");
  });

  it("rejects bad input loudly", () => {
    expect(() => parseLocal("2026-02-30", "10:00", "Europe/London")).toThrow(/Invalid local date/);
    expect(() => parseLocal("2026-02-10", "25:00", "Europe/London")).toThrow();
    expect(() => parseLocal("2026-02-10", "10:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(() => toMinutes("9:00")).toThrow();
    expect(isValidZone("America/Los_Angeles")).toBe(true);
    expect(isValidZone("PST8PDT-ish")).toBe(false);
  });
});

describe("availability", () => {
  const windows = [{ weekday: 1, start: "09:00", end: "17:00" }, { weekday: 1, start: "19:00", end: "21:00" }];
  const monday = (time: string) => parseLocal("2026-10-12", time, TUTOR_ZONE).utc; // a Monday
  const slot = (time: string, durationMin = 60): Interval => ({ startsAt: monday(time), durationMin });

  it("accepts a class fully inside a window, including one ending exactly at the end", () => {
    expect(isWithinHours(slot("09:00"), windows, TUTOR_ZONE)).toBe(true);
    expect(isWithinHours(slot("16:00"), windows, TUTOR_ZONE)).toBe(true);
    expect(isWithinHours(slot("20:00"), windows, TUTOR_ZONE)).toBe(true);
  });
  it("rejects classes that start early, end late, straddle a gap, or fall on a day with no hours", () => {
    expect(isWithinHours(slot("08:30"), windows, TUTOR_ZONE)).toBe(false);
    expect(isWithinHours(slot("16:30"), windows, TUTOR_ZONE)).toBe(false);
    expect(isWithinHours(slot("17:30"), windows, TUTOR_ZONE)).toBe(false);
    expect(isWithinHours({ startsAt: parseLocal("2026-10-13", "10:00", TUTOR_ZONE).utc, durationMin: 60 }, windows, TUTOR_ZONE)).toBe(false);
  });
  it("uses the tutor's zone, not the parent's", () => {
    const sevenPmLondon = parseLocal("2026-10-12", "19:00", "Europe/London").utc; // 19:00 Lagos too in October
    expect(isWithinHours({ startsAt: sevenPmLondon, durationMin: 60 }, windows, TUTOR_ZONE)).toBe(true);
    const sevenPmChicago = parseLocal("2026-10-12", "19:00", "America/Chicago").utc; // 01:00 Tuesday in Lagos
    expect(isWithinHours({ startsAt: sevenPmChicago, durationMin: 60 }, windows, TUTOR_ZONE)).toBe(false);
  });
  it("never lets a class run past midnight", () => {
    const wide = [{ weekday: 1, start: "00:00", end: "23:59" }];
    expect(isWithinHours({ startsAt: monday("23:30"), durationMin: 60 }, wide, TUTOR_ZONE)).toBe(false);
  });

  it("treats back-to-back classes as not overlapping, and anything sharing time as overlapping", () => {
    expect(overlaps(slot("10:00"), slot("11:00"))).toBe(false);
    expect(overlaps(slot("10:00"), slot("10:30"))).toBe(true);
    expect(overlaps(slot("10:00", 120), slot("11:00"))).toBe(true);
    expect(overlaps(slot("11:00"), slot("10:00"))).toBe(false);
  });

  it("finds the free slots nearest to a time, skipping booked and out-of-hours times", () => {
    const booked = [slot("12:00")];
    const free = findFreeSlots({
      windows: [{ weekday: 1, start: "09:00", end: "17:00" }], tutorZone: TUTOR_ZONE, booked, durationMin: 60,
      around: monday("12:00"), count: 2, notBefore: monday("00:00"), stepMin: 30,
    });
    expect(free).toHaveLength(2);
    expect(free.map((f) => f.startsAt.toISOString())).toEqual([monday("11:00").toISOString(), monday("13:00").toISOString()]);
    expect(free.every((f) => !overlaps(f, booked[0]!))).toBe(true);
  });
  it("respects notBefore and the excluded slot", () => {
    const free = findFreeSlots({
      windows: [{ weekday: 1, start: "09:00", end: "17:00" }], tutorZone: TUTOR_ZONE, booked: [], durationMin: 60,
      around: monday("12:00"), count: 3, notBefore: monday("12:00"), exclude: [monday("12:00")], stepMin: 60,
    });
    expect(free.map((f) => f.startsAt.toISOString())).toEqual([monday("13:00").toISOString(), monday("14:00").toISOString(), monday("15:00").toISOString()]);
  });
  it("returns fewer slots than asked when there are not enough, and none when the tutor is fully booked", () => {
    const only = findFreeSlots({
      windows: [{ weekday: 1, start: "10:00", end: "11:00" }], tutorZone: TUTOR_ZONE, booked: [], durationMin: 60,
      around: monday("10:00"), count: 5, notBefore: monday("00:00"), searchHours: 5,
    });
    expect(only).toHaveLength(1);
    const none = findFreeSlots({
      windows: [{ weekday: 1, start: "10:00", end: "11:00" }], tutorZone: TUTOR_ZONE, booked: [slot("10:00")], durationMin: 60,
      around: monday("10:00"), count: 5, notBefore: monday("00:00"), searchHours: 5,
    });
    expect(none).toEqual([]);
  });
});

describe("demo timetable: the three scenarios hold on any day", () => {
  /** Random-looking (but fixed) instants over 15 months, plus the hours around every DST change. */
  function sampleNows(): Date[] {
    const out: Date[] = [];
    let x = 123456789;
    const next = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const start = Date.UTC(2026, 0, 1);
    const span = Date.UTC(2027, 3, 1) - start;
    for (let i = 0; i < 260; i++) out.push(new Date(start + Math.floor(next() * span)));
    // Clock changes: UK/Lisbon 29 Mar and 25 Oct 2026, 28 Mar 2027; Chicago 8 Mar and 1 Nov 2026, 14 Mar 2027.
    for (const [y, m, d] of [[2026, 2, 29], [2026, 9, 25], [2027, 2, 28], [2026, 2, 8], [2026, 10, 1], [2027, 2, 14]] as const) {
      for (let h = -12; h <= 36; h += 4) out.push(new Date(Date.UTC(y, m, d, 0) + h * 3_600_000));
    }
    return out;
  }

  it("holds for ~340 different 'now' values (random instants and the hours around every DST change)", () => {
    const failures: string[] = [];
    const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
    let minFree = Infinity;
    const nows = sampleNows();
    for (const now of nows) {
      const { bookings, scenarios } = planDemoBookings(now, 12);
      const label = iso(now);

      // no tutor or learner is ever double-booked, and everything is in the future
      for (let i = 0; i < bookings.length; i++) {
        for (let j = i + 1; j < bookings.length; j++) {
          const a = bookings[i]!, b = bookings[j]!;
          if (a.tutor === b.tutor || a.learner === b.learner) check(!overlaps(a, b), `${label}: overlap ${a.learner}/${b.learner}`);
        }
        check(bookings[i]!.startsAt.getTime() > now.getTime(), `${label}: booking in the past`);
      }

      // happy path: Amara 07:00 class, 19:00 same day free for her tutor, with enough notice
      const { happy, conflict, escalation } = scenarios;
      const hhmm = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("HH:mm");
      check(hhmm(happy.currentStartsAt, GUARDIAN_ZONES.Amara) === "07:00", `${label}: happy class is not 07:00 local`);
      check(hhmm(happy.requestedStartsAt, GUARDIAN_ZONES.Amara) === "19:00", `${label}: happy request is not 19:00 local`);
      check(localDate(happy.requestedStartsAt, GUARDIAN_ZONES.Amara) === localDate(happy.currentStartsAt, GUARDIAN_ZONES.Amara), `${label}: happy dates differ`);
      check(hoursBetween(now, happy.currentStartsAt) >= 12, `${label}: happy notice < 12h`);
      const tutor1 = bookings.filter((b) => b.tutor === "tutor1");
      const happyReq = { startsAt: happy.requestedStartsAt, durationMin: 60 };
      check(isWithinHours(happyReq, DEMO_HOURS.tutor1, TUTOR_ZONE), `${label}: happy slot outside tutor hours`);
      check(!tutor1.some((b) => overlaps(b, happyReq)), `${label}: happy slot is not free`);

      // conflict: exactly Zainab blocks the requested time; two or more free slots nearby
      const confReq = { startsAt: conflict.requestedStartsAt, durationMin: 60 };
      const tutor2 = bookings.filter((b) => b.tutor === "tutor2");
      check(tutor2.filter((b) => overlaps(b, confReq)).map((b) => b.learner).join() === "Zainab", `${label}: conflict blocker wrong`);
      check(hoursBetween(now, conflict.currentStartsAt) >= 12, `${label}: conflict notice < 12h`);
      check(isWithinHours(confReq, DEMO_HOURS.tutor2, TUTOR_ZONE), `${label}: conflict slot outside tutor hours`);
      const near = findFreeSlots({
        windows: DEMO_HOURS.tutor2, tutorZone: TUTOR_ZONE, booked: tutor2, durationMin: 60, around: conflict.requestedStartsAt,
        count: 10, notBefore: new Date(now.getTime() + 12 * 3_600_000), searchHours: 3, stepMin: 60,
      });
      minFree = Math.min(minFree, near.length);
      check(near.length >= 2, `${label}: only ${near.length} free slot(s) near Leo's request`);

      // escalation: about two hours away, far below the minimum notice
      const lead = hoursBetween(now, escalation.currentStartsAt);
      check(lead >= 2 && lead < 2.25, `${label}: escalation lead ${lead}h`);
      check(bookings.filter((b) => b.role === "escalation").length === 1, `${label}: escalation booking count`);
    }
    expect(nows.length).toBeGreaterThan(300);
    expect(failures.slice(0, 5)).toEqual([]);
    expect(minFree).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic, and fills a believable week for every learner", () => {
    const now = new Date("2026-10-14T09:30:00Z");
    expect(planDemoBookings(now)).toEqual(planDemoBookings(now));
    const { bookings } = planDemoBookings(now);
    for (const learner of ["Amara", "Leo", "Priya", "Tomás", "Zainab"] as const) {
      expect(bookings.filter((b) => b.learner === learner).length, learner).toBeGreaterThanOrEqual(4);
    }
    expect(bookings.every((b) => endOf(b) > b.startsAt && b.durationMin === 60)).toBe(true);
  });

  it("respects a stricter notice policy when choosing the scenario days", () => {
    const now = new Date("2026-10-14T09:30:00Z");
    const { scenarios } = planDemoBookings(now, 48);
    expect(hoursBetween(now, scenarios.happy.currentStartsAt)).toBeGreaterThanOrEqual(48);
    expect(hoursBetween(now, scenarios.conflict.currentStartsAt)).toBeGreaterThanOrEqual(48);
  });
});
