import { decrypt } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import { buildKnownEntities } from "../agents/privacy-guard/index";
import type { RescheduleBase, RescheduleInput } from "./pipeline";

const DAY_MS = 86_400_000;

/** Everything the pipeline needs for one request, read from the database in a handful of queries. */
export async function loadRescheduleWork(prisma: PrismaClient, runId: string, encryptionKey: string, opts: { now: Date; minNoticeHours: number }) {
  const request = await prisma.rescheduleRequest.findUniqueOrThrow({
    where: { runId },
    include: { guardian: { include: { learner: { include: { guardians: true, tutor: { include: { availability: true } } } } } } },
  });
  const learner = request.guardian.learner;
  const tutor = learner.tutor;
  const { now } = opts;

  const [classes, tutorBookings] = await Promise.all([
    prisma.booking.findMany({
      where: { learnerId: learner.id, status: { not: "cancelled" }, startsAt: { gte: now, lte: new Date(now.getTime() + 21 * DAY_MS) } },
      orderBy: { startsAt: "asc" },
    }),
    prisma.booking.findMany({
      where: { tutorId: tutor.id, status: { not: "cancelled" }, startsAt: { gte: new Date(now.getTime() - DAY_MS), lte: new Date(now.getTime() + 35 * DAY_MS) } },
    }),
  ]);

  const base: RescheduleBase = {
    now, minNoticeHours: opts.minNoticeHours, guardianZone: request.guardian.timezone, learnerId: learner.id,
    tutor: {
      id: tutor.id, firstName: tutor.name.split(" ")[0] ?? tutor.name, zone: tutor.timezone,
      windows: tutor.availability.map((a) => ({ weekday: a.weekday, start: a.startTime, end: a.endTime })),
    },
    classes: classes.map((c) => ({ id: c.id, startsAt: c.startsAt, durationMin: c.durationMin, status: c.status, tutorId: c.tutorId })),
    tutorBookings: tutorBookings.map((b) => ({ id: b.id, learnerId: b.learnerId, startsAt: b.startsAt, durationMin: b.durationMin })),
  };
  const input: RescheduleInput = {
    message: decrypt(request.rawMessageEnc, encryptionKey),
    known: buildKnownEntities({ learner, guardians: learner.guardians, tutor }),
    base,
  };
  return { request, learner, input };
}
