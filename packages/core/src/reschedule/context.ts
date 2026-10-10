import type { Interval, Window } from "../scheduling/availability";

/**
 * Everything the rescheduling tools and the policy engine may look at for ONE request, loaded once.
 * It is a snapshot for a single tutor and a single learner: tools can only ever see what is in here,
 * so there is no way for a model to ask about someone else's schedule.
 */
export interface ScheduleContext {
  now: Date;
  minNoticeHours: number;
  tutorFirstName: string;
  tutorZone: string;
  guardianZone: string;
  /** The tutor's weekly working windows (local to the tutor). */
  windows: Window[];
  learnerId: string;
  /** The class the parent wants to move. */
  movingBookingId: string;
  durationMin: number;
  /** The tutor's non-cancelled classes (including the one being moved). Other learners' ids are never shown to a model. */
  tutorBookings: BookingSlot[];
  /** The learner's other non-cancelled classes with any tutor (excluding the one being moved). */
  learnerBookings: BookingSlot[];
}

export interface BookingSlot extends Interval {
  id: string;
  learnerId: string;
}
