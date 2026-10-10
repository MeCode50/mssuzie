import { decrypt } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import { buildKnownEntities } from "../agents/privacy-guard/index";
import type { RescheduleBase, RescheduleInput } from "./pipeline";
import type { Prisma } from "../generated/prisma/client";

const DAY_MS = 86_400_000;

const REQUEST_INCLUDE = { guardian: { include: { learner: { include: { guardians: true, tutor: { include: { availability: true } } } } } } } satisfies Prisma.RescheduleRequestInclude;
export type LoadedRequest = Prisma.RescheduleRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/** The tutor's and learner's schedule around `now`: what the policy and the tools are allowed to see. */
async function loadBase(prisma: PrismaClient, request: LoadedRequest, opts: { now: Date; minNoticeHours: number }) {
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
  return { base, bookingVersions: new Map(classes.map((c) => [c.id, c.version])) };
}

/** The schedule snapshot for an existing request (used when a person or a link settles it later). */
export async function loadScheduleFor(prisma: PrismaClient, requestId: string, opts: { now: Date; minNoticeHours: number }) {
  const request = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId }, include: REQUEST_INCLUDE });
  return { request, ...(await loadBase(prisma, request, opts)) };
}

/** Everything the pipeline needs for one request, read from the database in a handful of queries. */
export async function loadRescheduleWork(prisma: PrismaClient, runId: string, encryptionKey: string, opts: { now: Date; minNoticeHours: number }) {
  const request = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { runId }, include: REQUEST_INCLUDE });
  const learner = request.guardian.learner;
  const tutor = learner.tutor;
  const { base, bookingVersions } = await loadBase(prisma, request, opts);
  const input: RescheduleInput = {
    message: decrypt(request.rawMessageEnc, encryptionKey),
    known: buildKnownEntities({ learner, guardians: learner.guardians, tutor }),
    base,
  };
  return { request, learner, input, bookingVersions };
}
