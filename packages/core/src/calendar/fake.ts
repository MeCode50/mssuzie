import { CalendarError, eventEnd, type CalendarEventInput, type CalendarService } from "./port";

/** In-memory calendar for tests and MOCK mode. Can be told to fail. */
export class FakeCalendar implements CalendarService {
  readonly events = new Map<string, { title: string; startsAt: Date; endsAt: Date }>();
  calls = 0;
  failWith: CalendarError | null = null;

  async upsertEvent(event: CalendarEventInput): Promise<string> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    this.events.set(event.eventId, { title: event.title, startsAt: event.startsAt, endsAt: eventEnd(event) });
    return event.eventId;
  }
}
