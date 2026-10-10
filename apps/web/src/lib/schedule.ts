import { z } from "zod";
import { errors } from "./errors";
import type { RequestContext } from "./http";
import { learnerScope, type Actor } from "./session";

const MAX_SPAN_MS = 31 * 86_400_000;

export const ScheduleQuerySchema = z.object({
  from: z.string().datetime({ message: "from must be an ISO date-time" }).transform((s) => new Date(s)),
  to: z.string().datetime({ message: "to must be an ISO date-time" }).transform((s) => new Date(s)),
});

/** Classes between two instants, with enough to draw a week: who, with whom, and whether it was moved. */
export async function listBookings(ctx: Pick<RequestContext, "c">, actor: Actor, from: Date, to: Date) {
  if (!(to > from) || to.getTime() - from.getTime() > MAX_SPAN_MS) throw errors.validation("Choose a range of up to 31 days.");
  const rows = await ctx.c.prisma.booking.findMany({
    where: { startsAt: { gte: from, lt: to }, learner: learnerScope(actor) },
    include: {
      learner: { select: { id: true, displayName: true, guardians: { select: { timezone: true }, take: 1 } } },
      tutor: { select: { id: true, name: true, timezone: true } },
      requests: { where: { appliedToAt: { not: null } }, orderBy: { updatedAt: "desc" }, take: 1, select: { id: true, appliedFromAt: true, decidedBy: true } },
    },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((b) => ({
    id: b.id, startsAt: b.startsAt, durationMin: b.durationMin, status: b.status,
    learner: { id: b.learner.id, displayName: b.learner.displayName },
    tutor: { id: b.tutor.id, name: b.tutor.name, timezone: b.tutor.timezone },
    guardianTimezone: b.learner.guardians[0]?.timezone ?? null,
    moved: b.requests[0]?.appliedFromAt ? { requestId: b.requests[0].id, from: b.requests[0].appliedFromAt, by: b.requests[0].decidedBy } : null,
    calendarSynced: b.calendarEventId !== null,
  }));
}
