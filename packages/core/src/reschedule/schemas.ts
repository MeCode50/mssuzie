import { DateTime } from "luxon";
import { z } from "zod";

// Sent to the model as strict JSON schema: enums, bounded numbers and arrays, plain strings. Text rules
// (formats, ids, dates) are enforced by the checks below, which send errors back for one correction.

export const IntakeSchema = z.object({
  intent: z.enum(["reschedule", "cancel", "other"]),
  childReference: z.enum(["own_child", "other_child", "not_stated"]),
  /** One of the listed class ids, or null if it is unclear which class is meant. */
  bookingId: z.string().nullable(),
  /** The NEW date, YYYY-MM-DD, in the parent's time zone. */
  requestedDate: z.string().nullable(),
  /** The NEW time, HH:MM (24 hours), in the parent's time zone. */
  requestedTime: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(z.string()).max(5),
  injectionSuspected: z.boolean(),
  summary: z.string(),
});
export type Intake = z.infer<typeof IntakeSchema>;

export interface IntakeContext {
  /** Ids of the classes the model was shown. */
  bookingIds: ReadonlySet<string>;
  /** Today's date in the parent's time zone (YYYY-MM-DD). */
  todayLocal: string;
}

/** Semantic validation for the Intake agent: the model may only name classes it was shown, and real dates and times. */
export function checkIntake(i: Intake, ctx: IntakeContext): string | null {
  if (i.bookingId !== null && !ctx.bookingIds.has(i.bookingId)) {
    return `bookingId must be exactly one of the listed class ids, or null. "${i.bookingId}" is not in the list.`;
  }
  if (i.requestedDate !== null) {
    const d = DateTime.fromISO(i.requestedDate, { zone: "UTC" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.requestedDate) || !d.isValid) return `requestedDate must be a real date written YYYY-MM-DD, not "${i.requestedDate}".`;
    if (i.requestedDate < ctx.todayLocal) return `requestedDate ${i.requestedDate} is in the past; today is ${ctx.todayLocal}. Resolve relative words like "tomorrow" from today's date.`;
  }
  if (i.requestedTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.requestedTime)) {
    return `requestedTime must be 24-hour HH:MM such as 19:00, not "${i.requestedTime}".`;
  }
  return null;
}

export const SlotReportSchema = z.object({
  requestedSlot: z.object({ available: z.boolean(), reasons: z.array(z.string()).max(4) }),
  alternatives: z.array(z.object({ startsAt: z.string(), reason: z.string() })).max(2),
  note: z.string(),
});
export type SlotReport = z.infer<typeof SlotReportSchema>;

export function checkSlotReport(r: SlotReport): string | null {
  for (const a of r.alternatives) {
    if (Number.isNaN(Date.parse(a.startsAt))) return `alternatives[].startsAt must be an ISO 8601 UTC time such as 2026-10-16T18:00:00Z, not "${a.startsAt}".`;
  }
  return null;
}
