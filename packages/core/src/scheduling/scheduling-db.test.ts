import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../crypto/aes-gcm";
import { resetDemoData, seedAccounts, type DemoScenarioInfo } from "../seed/index";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db";
import { DEMO_HOURS, GUARDIAN_ZONES, TUTOR_ZONE } from "./demo-plan";
import { overlaps } from "./availability";
import { hoursBetween, localDate, minuteOfDayIn } from "./time";

const KEY = Buffer.alloc(32, 7).toString("base64");
const seedEnv = {
  SEED_EBUN_EMAIL: "ebun@example.test", SEED_EBUN_PASSWORD: "ebun-password-123",
  SEED_OPS2_NAME: "Ops Two", SEED_OPS2_EMAIL: "ops2@example.test", SEED_OPS2_PASSWORD: "ops2-password-123",
  SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: "tutor1@example.test", SEED_TUTOR1_PASSWORD: "tutor1-password-123",
  SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: "tutor2@example.test", SEED_TUTOR2_PASSWORD: "tutor2-password-123",
};

describe.skipIf(!TEST_DATABASE_URL)("scheduling schema and demo seed (real Postgres)", () => {
  let db: TestDb;
  let scenarios: DemoScenarioInfo;
  const NOW = new Date("2026-10-14T09:30:00Z");

  beforeAll(async () => {
    db = await createTestDb();
    await seedAccounts(db.prisma, seedEnv);
    scenarios = await resetDemoData(db.prisma, KEY, { now: NOW });
  });
  afterAll(async () => db.drop());

  const tutorOf = async (learnerId: string) => (await db.prisma.learner.findUniqueOrThrow({ where: { id: learnerId } })).tutorId;
  const minutes = (n: number) => new Date(Date.UTC(2031, 0, 6, 10) + n * 60_000);
  const book = (tutorId: string, learnerId: string, startsAt: Date, durationMin = 60, status: "scheduled" | "cancelled" = "scheduled") =>
    db.prisma.booking.create({ data: { tutorId, learnerId, startsAt, durationMin, status } });

  describe("database guarantees against double-booking", () => {
    let tutorId: string;
    let otherLearner: string;
    let learnerA: string;
    beforeAll(async () => {
      const learners = await db.prisma.learner.findMany({ orderBy: { displayName: "asc" } });
      learnerA = learners[0]!.id;
      otherLearner = learners[1]!.id;
      tutorId = (await db.prisma.user.findUniqueOrThrow({ where: { email: "tutor1@example.test" } })).id;
    });

    it("rejects a second class for the same tutor at an overlapping time", async () => {
      await book(tutorId, learnerA, minutes(0));
      await expect(book(tutorId, otherLearner, minutes(30))).rejects.toThrow(/bookings_tutor_no_overlap|exclusion|23P01/i);
      await expect(book(tutorId, otherLearner, minutes(0))).rejects.toThrow(/no_overlap|exclusion|23P01/i);
      await expect(book(tutorId, otherLearner, minutes(-45))).rejects.toThrow(/no_overlap|exclusion|23P01/i);
    });

    it("allows back-to-back classes (one ending exactly when the next starts)", async () => {
      await expect(book(tutorId, otherLearner, minutes(60))).resolves.toBeDefined();
      await expect(book(tutorId, otherLearner, minutes(-60))).resolves.toBeDefined();
    });

    it("rejects the same learner being booked with two tutors at once", async () => {
      const other = (await db.prisma.user.findUniqueOrThrow({ where: { email: "tutor2@example.test" } })).id;
      await expect(book(other, learnerA, minutes(15))).rejects.toThrow(/bookings_learner_no_overlap|exclusion|23P01/i);
    });

    it("ignores cancelled classes, so their slot can be used again", async () => {
      const slot = minutes(600);
      const cancelled = await book(tutorId, learnerA, slot, 60, "cancelled");
      await expect(book(tutorId, otherLearner, slot)).resolves.toBeDefined();
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects moving a class onto a taken slot", async () => {
      const mine = await book(tutorId, learnerA, minutes(900));
      await expect(db.prisma.booking.update({ where: { id: mine.id }, data: { startsAt: minutes(30) } })).rejects.toThrow(/no_overlap|exclusion|23P01/i);
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: mine.id } })).startsAt.getTime()).toBe(minutes(900).getTime());
    });

    it("of 8 simultaneous attempts to take one free slot, exactly one succeeds", async () => {
      const learners = await db.prisma.learner.findMany();
      const slot = minutes(2000);
      const clients = Array.from({ length: 8 }, () => db.connect(1));
      const results = await Promise.allSettled(
        clients.map((c, i) => c.booking.create({ data: { tutorId, learnerId: learners[i % learners.length]!.id, startsAt: slot, durationMin: 60 } })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
    });

    it("enforces sane durations and a starting version", async () => {
      await expect(book(tutorId, learnerA, minutes(3000), 10)).rejects.toThrow(/duration_check|23514/i);
      await expect(book(tutorId, learnerA, minutes(3100), 300)).rejects.toThrow(/duration_check|23514/i);
      const ok = await book(tutorId, learnerA, minutes(3200), 45);
      expect(ok.version).toBe(1);
    });

    it("supports optimistic locking: a stale version updates nothing", async () => {
      const b = await book(tutorId, learnerA, minutes(4000));
      const first = await db.prisma.booking.updateMany({ where: { id: b.id, version: 1 }, data: { startsAt: minutes(4100), version: { increment: 1 } } });
      const stale = await db.prisma.booking.updateMany({ where: { id: b.id, version: 1 }, data: { startsAt: minutes(4200), version: { increment: 1 } } });
      expect([first.count, stale.count]).toEqual([1, 0]);
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } }))).toMatchObject({ version: 2 });
    });
  });

  describe("tutor availability constraints", () => {
    const add = (over: Record<string, unknown>) =>
      db.prisma.$transaction(async (tx) => {
        const tutor = await tx.user.findUniqueOrThrow({ where: { email: "tutor2@example.test" } });
        return tx.tutorAvailability.create({ data: { tutorId: tutor.id, weekday: 1, startTime: "23:00", endTime: "23:30", ...over } as never });
      });
    it("rejects a bad weekday, a bad time format and an end that is not after the start", async () => {
      await expect(add({ weekday: 8 })).rejects.toThrow(/weekday_check|23514/i);
      await expect(add({ weekday: 0 })).rejects.toThrow(/weekday_check|23514/i);
      await expect(add({ startTime: "9:00", endTime: "10:00" })).rejects.toThrow(/time_format_check|23514/i);
      await expect(add({ startTime: "24:00", endTime: "24:30" })).rejects.toThrow(/time_format_check|23514/i);
      await expect(add({ startTime: "10:00", endTime: "10:00" })).rejects.toThrow(/order_check|23514/i);
      await expect(add({ startTime: "10:00", endTime: "09:00" })).rejects.toThrow(/order_check|23514/i);
    });
    it("accepts a valid extra window and rejects the same window twice", async () => {
      await expect(add({})).resolves.toBeDefined();
      await expect(add({})).rejects.toThrow(/Unique|23505/i);
    });
  });

  describe("the demo seed", () => {
    it("puts the tutors in Africa/Lagos with their weekly hours, and gives each guardian a time zone", async () => {
      const t1 = await db.prisma.user.findUniqueOrThrow({ where: { email: "tutor1@example.test" }, include: { availability: true } });
      const t2 = await db.prisma.user.findUniqueOrThrow({ where: { email: "tutor2@example.test" }, include: { availability: true } });
      expect(t1.timezone).toBe(TUTOR_ZONE);
      expect(t2.timezone).toBe(TUTOR_ZONE);
      expect(t1.availability).toHaveLength(DEMO_HOURS.tutor1.length);
      expect(t1.availability.some((a) => a.weekday === 7)).toBe(false); // tutor 1 does not work Sundays
      expect(t2.availability.find((a) => a.weekday === 7)).toMatchObject({ startTime: "12:00", endTime: "18:00" });
      const guardians = await db.prisma.guardian.findMany({ include: { learner: true } });
      const zones = Object.fromEntries(guardians.map((g) => [g.learner.displayName.split(" ")[0], g.timezone]));
      expect(zones).toEqual(GUARDIAN_ZONES);
      expect(new Set(Object.values(zones)).size).toBeGreaterThanOrEqual(3);
    });

    it("never double-books anyone, and every booking is in the future", async () => {
      const bookings = await db.prisma.booking.findMany({ where: { createdAt: { gte: new Date(Date.now() - 600_000) }, durationMin: 60 }, orderBy: { startsAt: "asc" } });
      expect(bookings.length).toBeGreaterThan(30);
      const planned = bookings.filter((b) => b.startsAt.getFullYear() === 2026);
      for (let i = 0; i < planned.length; i++) {
        for (let j = i + 1; j < planned.length; j++) {
          const a = planned[i]!, b = planned[j]!;
          if (a.tutorId === b.tutorId || a.learnerId === b.learnerId) expect(overlaps(a, b)).toBe(false);
        }
        expect(planned[i]!.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
      }
    });

    it("Scenario 1 (happy path): Amara has a 07:00 class in her zone, with enough notice, and 19:00 is free", async () => {
      const b = await db.prisma.booking.findUniqueOrThrow({ where: { id: scenarios.happy.bookingId } });
      expect(b.learnerId).toBe(scenarios.happy.learnerId);
      expect(b.startsAt.toISOString()).toBe(scenarios.happy.currentStartsAt.toISOString());
      expect(minuteOfDayIn(b.startsAt, "Europe/London")).toBe(7 * 60);
      expect(hoursBetween(NOW, b.startsAt)).toBeGreaterThanOrEqual(12);
      const clash = await db.prisma.booking.findMany({ where: { tutorId: b.tutorId, status: { not: "cancelled" } } });
      expect(clash.some((c) => overlaps(c, { startsAt: scenarios.happy.requestedStartsAt, durationMin: 60 }))).toBe(false);
      expect(minuteOfDayIn(scenarios.happy.requestedStartsAt, "Europe/London")).toBe(19 * 60);
    });

    it("Scenario 2 (conflict): Leo's tutor is teaching Zainab at the requested time", async () => {
      const leo = await db.prisma.booking.findUniqueOrThrow({ where: { id: scenarios.conflict.bookingId } });
      const requested = { startsAt: scenarios.conflict.requestedStartsAt, durationMin: 60 };
      const taken = (await db.prisma.booking.findMany({ where: { tutorId: leo.tutorId }, include: { learner: true } })).filter((b) => overlaps(b, requested));
      expect(taken.map((b) => b.learner.displayName)).toEqual(["Zainab Bello"]);
      expect(minuteOfDayIn(leo.startsAt, GUARDIAN_ZONES.Leo)).toBe(10 * 60);
      expect(minuteOfDayIn(requested.startsAt, GUARDIAN_ZONES.Leo)).toBe(12 * 60);
    });

    it("Scenario 3 (escalation): Priya's class starts in about two hours", async () => {
      const b = await db.prisma.booking.findUniqueOrThrow({ where: { id: scenarios.escalation.bookingId } });
      const lead = hoursBetween(NOW, b.startsAt);
      expect(lead).toBeGreaterThanOrEqual(2);
      expect(lead).toBeLessThan(2.25);
      expect(b.learnerId).toBe(scenarios.escalation.learnerId);
    });

    it("the scenario learners belong to the right guardians and tutors", async () => {
      expect(await tutorOf(scenarios.happy.learnerId)).toBe(await tutorOf(scenarios.escalation.learnerId));
      expect(await tutorOf(scenarios.conflict.learnerId)).not.toBe(await tutorOf(scenarios.happy.learnerId));
      const g = await db.prisma.guardian.findUniqueOrThrow({ where: { id: scenarios.conflict.guardianId } });
      expect(g).toMatchObject({ learnerId: scenarios.conflict.learnerId, timezone: "America/Chicago" });
    });
  });

  describe("requests, notifications and the demo reset", () => {
    it("stores a request with an encrypted message, a decision and its notifications, and cascades on delete", async () => {
      const message = "Hi, it's Ngozi Okafor. Can we move Amara's class to 7pm? 07700 900101";
      const req = await db.prisma.rescheduleRequest.create({
        data: {
          guardianId: scenarios.happy.guardianId, learnerId: scenarios.happy.learnerId, bookingId: scenarios.happy.bookingId,
          rawMessageEnc: encrypt(message, KEY), decision: "auto_applied", reason: "Free slot with enough notice",
          appliedFromAt: scenarios.happy.currentStartsAt, appliedToAt: scenarios.happy.requestedStartsAt,
          proposedSlotsJson: [{ startsAt: "2026-10-16T18:00:00Z" }], parsedJson: { confidence: 0.93 },
          notifications: { create: [
            { toRole: "parent", kind: "applied", toEmail: "ngozi.okafor@example.com", subject: "Moved", body: "Done", status: "dry_run" },
            { toRole: "ops", kind: "escalation", subject: "FYI", body: "Moved automatically", status: "sent" },
          ] },
        },
        include: { notifications: true },
      });
      expect(req.rawMessageEnc).not.toContain("Ngozi");
      expect(decrypt(req.rawMessageEnc, KEY)).toBe(message);
      expect(req.notifications.map((n) => n.toRole).sort()).toEqual(["ops", "parent"]);
      expect(req.notifications.find((n) => n.toRole === "ops")?.toEmail).toBeNull(); // in-app notice, no address
    });

    it("rejects an unknown decision or channel, and requires a guardian", async () => {
      const base = { guardianId: scenarios.happy.guardianId, rawMessageEnc: "x" };
      await expect(db.prisma.rescheduleRequest.create({ data: { ...base, decision: "maybe" as never } })).rejects.toThrow();
      await expect(db.prisma.rescheduleRequest.create({ data: { ...base, channel: "fax" as never } })).rejects.toThrow();
      await expect(db.prisma.rescheduleRequest.create({ data: { guardianId: randomUUID(), rawMessageEnc: "x" } })).rejects.toThrow(/Foreign key|23503/i);
    });

    it("reset rebuilds the timetable around a new 'now', and clears requests, notifications and rescheduling runs", async () => {
      const run = await db.prisma.run.create({ data: { pipeline: "reschedule", idempotencyKey: randomUUID(), status: "completed" } });
      await db.prisma.rescheduleRequest.updateMany({ data: { runId: run.id } });
      expect(await db.prisma.rescheduleRequest.count()).toBeGreaterThan(0);
      const before = await db.prisma.booking.count();
      await db.prisma.booking.delete({ where: { id: scenarios.happy.bookingId } });

      const later = new Date("2027-03-27T20:00:00Z"); // the evening before UK clocks go forward
      const again = await resetDemoData(db.prisma, KEY, { now: later });
      expect(await db.prisma.rescheduleRequest.count()).toBe(0);
      expect(await db.prisma.notification.count()).toBe(0);
      expect(await db.prisma.run.count({ where: { pipeline: "reschedule" } })).toBe(0);
      expect(await db.prisma.booking.count()).toBeGreaterThan(30);
      expect(await db.prisma.booking.count()).not.toBe(before + 100); // sanity: not accumulating
      expect(await db.prisma.booking.findUnique({ where: { id: scenarios.happy.bookingId } })).toBeNull();
      const happy = await db.prisma.booking.findUniqueOrThrow({ where: { id: again.happy.bookingId } });
      expect(happy.startsAt.getTime()).toBeGreaterThan(later.getTime());
      expect(minuteOfDayIn(happy.startsAt, "Europe/London")).toBe(7 * 60);
      expect(localDate(happy.startsAt, "Europe/London") >= "2027-03-28").toBe(true); // lands after the clock change, still 07:00 local
      expect(await db.prisma.tutorAvailability.count()).toBe(DEMO_HOURS.tutor1.length + DEMO_HOURS.tutor2.length);
      expect(await db.prisma.user.count()).toBe(4); // accounts untouched
    });
  });
});
