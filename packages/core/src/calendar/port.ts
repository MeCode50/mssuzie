export interface CalendarEventInput {
  /** Stable id (the booking's id, without dashes): makes create idempotent. */
  eventId: string;
  title: string;
  startsAt: Date;
  durationMin: number;
}

/** What the rescheduler needs from a calendar. Both operations are safe to repeat. */
export interface CalendarService {
  /** Create the event, or update it to this time if it already exists. Returns the event id. */
  upsertEvent(event: CalendarEventInput): Promise<string>;
}

export class CalendarError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "CalendarError";
  }
}

/** Google event ids allow only a-v and 0-9 (base32hex): a UUID without dashes qualifies. */
export const eventIdForBooking = (bookingId: string): string => bookingId.replace(/-/g, "").toLowerCase();

export const eventEnd = (e: Pick<CalendarEventInput, "startsAt" | "durationMin">): Date => new Date(e.startsAt.getTime() + e.durationMin * 60_000);
