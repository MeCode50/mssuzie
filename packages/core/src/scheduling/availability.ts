import { addMinutes, toMinutes, toZone } from "./time";

/** A weekly working window in the tutor's own time zone. weekday: 1 = Monday ... 7 = Sunday. */
export interface Window {
  weekday: number;
  start: string;
  end: string;
}

export interface Interval {
  startsAt: Date;
  durationMin: number;
}

export const endOf = (i: Interval): Date => addMinutes(i.startsAt, i.durationMin);

/** Half-open overlap: a class ending exactly when another starts does not overlap it. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < endOf(b) && b.startsAt < endOf(a);
}

/**
 * Is the whole class inside one of the tutor's windows? Windows are local to the tutor's zone, and
 * a class may not run past midnight (it must start and end on the same local day).
 */
export function isWithinHours(interval: Interval, windows: Window[], tutorZone: string): boolean {
  const first = toZone(interval.startsAt, tutorZone);
  const last = toZone(addMinutes(endOf(interval), -1), tutorZone);
  if (first.ordinal !== last.ordinal || first.year !== last.year) return false;
  const weekday = first.weekday;
  const start = first.hour * 60 + first.minute;
  const end = start + interval.durationMin;
  return windows.some((w) => w.weekday === weekday && start >= toMinutes(w.start) && end <= toMinutes(w.end));
}

export interface FreeSlotQuery {
  windows: Window[];
  tutorZone: string;
  /** The tutor's existing classes (cancelled ones already removed). */
  booked: Interval[];
  durationMin: number;
  /** Look for the slots nearest to this instant. */
  around: Date;
  count: number;
  /** Never offer anything before this instant (notice policy, "now"). */
  notBefore: Date;
  /** How far either side of `around` to look, in hours. */
  searchHours?: number;
  /** Slots start on multiples of this many minutes of the tutor's local hour. */
  stepMin?: number;
  /** Instants to skip (e.g. the slot that was asked for and found taken). */
  exclude?: Date[];
}

/**
 * The nearest free slots to a time, inside working hours, not overlapping existing classes.
 * Returns up to `count`, ordered by how close they are to `around`.
 */
export function findFreeSlots(q: FreeSlotQuery): Interval[] {
  const step = q.stepMin ?? 30;
  const span = (q.searchHours ?? 72) * 60;
  const exclude = new Set((q.exclude ?? []).map((d) => d.getTime()));
  // Snap the search origin to the tutor's local step grid so slots land on tidy times (e.g. :00, :30).
  const local = toZone(q.around, q.tutorZone);
  const snappedMin = Math.round((local.hour * 60 + local.minute) / step) * step;
  const origin = local.startOf("day").plus({ minutes: snappedMin }).toUTC().toJSDate();

  const found: { slot: Interval; distance: number }[] = [];
  for (let offset = -span; offset <= span; offset += step) {
    const startsAt = addMinutes(origin, offset);
    if (startsAt < q.notBefore || exclude.has(startsAt.getTime())) continue;
    const slot: Interval = { startsAt, durationMin: q.durationMin };
    if (!isWithinHours(slot, q.windows, q.tutorZone)) continue;
    if (q.booked.some((b) => overlaps(slot, b))) continue;
    found.push({ slot, distance: Math.abs(startsAt.getTime() - q.around.getTime()) });
  }
  return found
    .sort((a, b) => a.distance - b.distance || a.slot.startsAt.getTime() - b.slot.startsAt.getTime())
    .slice(0, q.count)
    .map((f) => f.slot);
}
