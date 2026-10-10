/** Wall-clock time in an IANA zone <-> UTC, with the browser's Intl only (no date library in the client). */

function offsetMinutes(utcMs: number, zone: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(f.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/**
 * "2026-10-12T19:00" read as a wall-clock time in `zone`. Returns null for a time that does not exist
 * there (the spring-forward gap) or is malformed. For an ambiguous time (the autumn repeat) the
 * earlier instant is returned, which is what most calendars do.
 */
export function wallTimeToUtc(local: string, zone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(naive).getUTCMonth() !== mo - 1 || new Date(naive).getUTCHours() !== h) return null; // 31 Feb, 25:00, …
  const candidates = new Set<number>();
  for (const guess of [offsetMinutes(naive, zone), offsetMinutes(naive - 86_400_000, zone), offsetMinutes(naive + 86_400_000, zone)]) {
    const utc = naive - guess * 60_000;
    if (offsetMinutes(utc, zone) === guess) candidates.add(utc);
  }
  if (candidates.size === 0) return null;
  return new Date(Math.min(...candidates));
}

/** The same instant as a value for <input type="datetime-local"> in `zone`. */
export function utcToWallTime(date: Date, zone: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
