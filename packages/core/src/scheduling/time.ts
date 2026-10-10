import { DateTime, IANAZone } from "luxon";

/**
 * Time handling for scheduling. Everything is stored and compared in UTC (JS Dates); a time zone is
 * only ever applied at the edges: when reading what a person wrote ("7pm" in THEIR zone) and when
 * showing a time to a person. Zones are always explicit IANA names, never guessed from the server.
 */

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

function assertZone(zone: string): void {
  if (!isValidZone(zone)) throw new Error(`Unknown time zone "${zone}"`);
}

export type LocalResolution = "ok" | "gap" | "ambiguous";

export interface ParsedLocal {
  /** The instant, in UTC. For a "gap" time this is the instant after the clocks jump forward. */
  utc: Date;
  /**
   * ok: the local time exists exactly once.
   * gap: it does not exist (clocks skipped it when DST started), so `utc` is the next real time.
   * ambiguous: it happens twice (clocks went back); `utc` is the first occurrence.
   */
  resolution: LocalResolution;
}

/** Turn a wall-clock date and time in `zone` into a UTC instant, reporting DST gaps and overlaps. */
export function parseLocal(date: string, time: string, zone: string): ParsedLocal {
  assertZone(zone);
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid) throw new Error(`Invalid local date/time "${date} ${time}": ${dt.invalidExplanation ?? "unparseable"}`);
  const [h, m] = time.split(":").map(Number);
  if (dt.hour !== h || dt.minute !== m) return { utc: dt.toUTC().toJSDate(), resolution: "gap" };
  // Ambiguous when the same wall time also exists one hour later or earlier (the clocks overlap).
  const sameWall = (other: DateTime) => other.hour === h && other.minute === m && other.toISODate() === date;
  const ambiguous = sameWall(dt.plus({ hours: 1 })) || sameWall(dt.minus({ hours: 1 }));
  return { utc: dt.toUTC().toJSDate(), resolution: ambiguous ? "ambiguous" : "ok" };
}

export function toZone(date: Date, zone: string): DateTime {
  assertZone(zone);
  return DateTime.fromJSDate(date, { zone });
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of an instant, as seen in `zone`. */
export function weekdayIn(date: Date, zone: string): number {
  return toZone(date, zone).weekday;
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. A date has one weekday in every zone, so no zone is needed. */
export function isoWeekdayOfDate(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Minutes since local midnight of an instant in `zone`. */
export function minuteOfDayIn(date: Date, zone: string): number {
  const d = toZone(date, zone);
  return d.hour * 60 + d.minute;
}

export function localDate(date: Date, zone: string): string {
  return toZone(date, zone).toISODate() as string;
}

/** "HH:MM" -> minutes since midnight. */
export function toMinutes(time: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Invalid time "${time}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "UTC+1", "UTC-5", "UTC+5:30": the offset in force at that instant, DST included. */
export function utcOffsetLabel(date: Date, zone: string): string {
  const minutes = toZone(date, zone).offset;
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "Europe/London" -> "London", "America/Chicago" -> "Chicago", "America/Los_Angeles" -> "Los Angeles". */
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** "Sat 11 Oct, 7:00 PM" in the zone (no zone name; pair with zoneLabel). */
export function formatLocal(date: Date, zone: string): string {
  return toZone(date, zone).setLocale("en-GB").toFormat("ccc d LLL, h:mm a").replace(/\b(am|pm)\b/i, (s) => s.toUpperCase());
}

/** "London (UTC+1)". */
export function zoneLabel(date: Date, zone: string): string {
  return `${zoneCity(zone)} (${utcOffsetLabel(date, zone)})`;
}

/** "Sat 11 Oct, 7:00 PM London (UTC+1)": a time shown to someone, with its zone spelled out. */
export function formatWithZone(date: Date, zone: string): string {
  return `${formatLocal(date, zone)} ${zoneLabel(date, zone)}`;
}

/** The same instant for two people: "Sat 11 Oct, 7:00 PM London (UTC+1) · 7:00 PM Lagos (UTC+1)". */
export function formatForBoth(date: Date, parentZone: string, tutorZone: string): string {
  const tutor = toZone(date, tutorZone).setLocale("en-GB").toFormat("h:mm a").replace(/\b(am|pm)\b/i, (s) => s.toUpperCase());
  const tutorDay = localDate(date, tutorZone) === localDate(date, parentZone) ? "" : ` (${toZone(date, tutorZone).setLocale("en-GB").toFormat("ccc d LLL")})`;
  return `${formatWithZone(date, parentZone)} · ${tutor}${tutorDay} ${zoneLabel(date, tutorZone)}`;
}

export const addMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);
export const addHours = (d: Date, hours: number): Date => addMinutes(d, hours * 60);
export const hoursBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 3_600_000;
