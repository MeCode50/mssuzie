import { describe, expect, it } from "vitest";
import { dayKey, dayLabel, timeLabel, weekBounds } from "./week";

describe("week bounds", () => {
  it("runs Monday to Monday around the date in the chosen zone", () => {
    const w = weekBounds(new Date("2026-10-14T10:00:00Z"), "Europe/London"); // a Wednesday
    expect(w.days[0]).toBe("2026-10-12");
    expect(w.days[6]).toBe("2026-10-18");
    expect(w.start.toISOString()).toBe("2026-10-11T23:00:00.000Z"); // Monday 00:00 BST
    expect(w.end.toISOString()).toBe("2026-10-18T23:00:00.000Z");
  });
  it("the same instant can be a different week day in a different zone", () => {
    const sundayNight = new Date("2026-10-11T23:30:00Z");
    expect(weekBounds(sundayNight, "Europe/London").days[0]).toBe("2026-10-12"); // already Monday in London (BST)
    expect(weekBounds(sundayNight, "America/Chicago").days[0]).toBe("2026-10-05"); // still Sunday 6:30pm in Chicago
  });
  it("moves forwards and backwards by whole weeks", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    expect(weekBounds(now, "Africa/Lagos", 1).days[0]).toBe("2026-10-19");
    expect(weekBounds(now, "Africa/Lagos", -1).days[0]).toBe("2026-10-05");
  });
  it("a week with a clock change is still 7 local days, though not 168 hours", () => {
    const quiet = weekBounds(new Date("2026-10-27T10:00:00Z"), "Europe/London"); // after the change
    expect((quiet.end.getTime() - quiet.start.getTime()) / 3_600_000).toBe(168);
    const spring = weekBounds(new Date("2026-03-25T10:00:00Z"), "Europe/London"); // clocks go forward on the 29th
    expect(spring.days).toHaveLength(7);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(167);
    const autumn = weekBounds(new Date("2026-10-21T10:00:00Z"), "Europe/London"); // clocks went back on the 25th
    expect(autumn.days[0]).toBe("2026-10-19");
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(169);
  });
  it("labels days and times", () => {
    expect(dayKey(new Date("2026-10-12T23:30:00Z"), "Europe/London")).toBe("2026-10-13");
    expect(dayLabel("2026-10-12")).toEqual({ weekday: "Mon", date: "12 Oct" });
    expect(timeLabel(new Date("2026-10-12T18:00:00Z"), "Europe/London")).toBe("7:00 PM");
    expect(timeLabel(new Date("2026-10-12T06:00:00Z"), "Europe/London")).toBe("7:00 AM");
  });
});
