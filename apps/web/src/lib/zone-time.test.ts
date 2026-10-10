import { describe, expect, it } from "vitest";
import { utcToWallTime, wallTimeToUtc } from "./zone-time";

describe("wall-clock time in a zone", () => {
  it("reads 7pm in London in summer and winter", () => {
    expect(wallTimeToUtc("2026-10-12T19:00", "Europe/London")?.toISOString()).toBe("2026-10-12T18:00:00.000Z"); // BST (UTC+1)
    expect(wallTimeToUtc("2026-12-14T19:00", "Europe/London")?.toISOString()).toBe("2026-12-14T19:00:00.000Z"); // GMT
  });
  it("handles zones behind and ahead of UTC", () => {
    expect(wallTimeToUtc("2026-10-10T12:00", "America/Chicago")?.toISOString()).toBe("2026-10-10T17:00:00.000Z");
    expect(wallTimeToUtc("2026-10-10T12:00", "Africa/Lagos")?.toISOString()).toBe("2026-10-10T11:00:00.000Z");
  });
  it("rejects a time that does not exist (spring forward) and impossible dates", () => {
    expect(wallTimeToUtc("2026-03-29T01:30", "Europe/London")).toBeNull(); // clocks jump 01:00 to 02:00
    expect(wallTimeToUtc("2026-02-30T10:00", "Europe/London")).toBeNull();
    expect(wallTimeToUtc("2026-02-10T25:00", "Europe/London")).toBeNull();
    expect(wallTimeToUtc("tomorrow", "Europe/London")).toBeNull();
  });
  it("picks the earlier instant for a repeated hour (autumn back)", () => {
    expect(wallTimeToUtc("2026-10-25T01:30", "Europe/London")?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("round-trips through a zone", () => {
    const d = new Date("2026-10-12T18:00:00Z");
    expect(utcToWallTime(d, "Europe/London")).toBe("2026-10-12T19:00");
    expect(wallTimeToUtc(utcToWallTime(d, "America/Chicago"), "America/Chicago")?.toISOString()).toBe(d.toISOString());
  });
});
