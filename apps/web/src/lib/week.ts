import { wallTimeToUtc } from "./zone-time";

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-12" for an instant, as the calendar date in `zone`. */
export function dayKey(date: Date, zone: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Monday 00:00 to next Monday 00:00 (as local midnights in `zone`), `offsetWeeks` away from the week containing `now`. */
export function weekBounds(now: Date, zone: string, offsetWeeks = 0): { start: Date; end: Date; days: string[] } {
  const today = dayKey(now, zone);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const isoWeekday = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7); // Monday = 0
  const monday = addDays(today, -isoWeekday + offsetWeeks * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  // Local midnight can fall in a clock change in a few zones; step forward until it exists.
  const midnight = (key: string) => wallTimeToUtc(`${key}T00:00`, zone) ?? wallTimeToUtc(`${key}T01:00`, zone)!;
  return { start: midnight(days[0]!), end: midnight(addDays(days[6]!, 1)), days };
}

export const dayLabel = (key: string): { weekday: string; date: string } => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  return {
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(t),
    date: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(t),
  };
};

export const timeLabel = (date: Date, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(/\s?(am|pm)/i, (s) => s.toUpperCase().trim().replace(/^/, " "));
