import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing";
import { moveBooking } from "./move";

const T0 = new Date("2026-10-20T08:00:00Z");
const T1 = new Date("2026-10-20T14:00:00Z");

describe.skipIf(!TEST_DATABASE_URL)("moveBooking (real Postgres)", () => {
  let db: TestDb;
  let tutorId: string;
  let learnerA: string;
  let learnerB: string;
  let guardianA: string;

  beforeAll(async () => {
    db = await createTestDb();
    tutorId = (await db.prisma.user.create({ data: { id: randomUUID(), name: "Tutor", email: "t@example.com", role: "tutor" } })).id;
    const mk = (displayName: string) => db.prisma.learner.create({ data: { displayName, age: 12, grade: "Y8", subjects: [], interests: [], planHoursPerWeek: 3, tutorId } });
    learnerA = (await mk("Amara")).id;
    learnerB = (await mk("Leo")).id;
    guardianA = (await db.prisma.guardian.create({ data: { learnerId: learnerA, name: "G", email: "g@example.com", phone: "+1" } })).id;
  });
  beforeEach(async () => {
    await db.prisma.rescheduleRequest.deleteMany();
    await db.prisma.booking.deleteMany();
  });
  afterAll(async () => db.drop());

  const booking = (learnerId: string, startsAt: Date, durationMin = 60) => db.prisma.booking.create({ data: { learnerId, tutorId, startsAt, durationMin } });
  const request = () => db.prisma.rescheduleRequest.create({ data: { guardianId: guardianA, learnerId: learnerA, rawMessageEnc: "x" } });
  const base = { decision: "auto_applied" as const, decidedBy: "policy" };

  it("moves the booking, bumps the version, and settles the request with before and after", async () => {
    const b = await booking(learnerA, T0);
    const r = await request();
    const res = await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base });
    expect(res).toMatchObject({ ok: true, alreadyApplied: false, version: 2 });
    const after = await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ status: "rescheduled", version: 2 });
    expect(after.startsAt.toISOString()).toBe(T1.toISOString());
    expect(after.lastMovedAt).not.toBeNull();
    const req = await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(req).toMatchObject({ decision: "auto_applied", decidedBy: "policy", bookingId: b.id });
    expect(req.appliedFromAt?.toISOString()).toBe(T0.toISOString());
    expect(req.appliedToAt?.toISOString()).toBe(T1.toISOString());
  });

  it("is idempotent: the same request and slot again changes nothing", async () => {
    const b = await booking(learnerA, T0);
    const r = await request();
    const input = { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base };
    await moveBooking(db.prisma, input);
    const again = await moveBooking(db.prisma, input);
    expect(again).toMatchObject({ ok: true, alreadyApplied: true, version: 2 });
    expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).version).toBe(2);
  });

  it("two concurrent moves for one request: exactly one applies, the other is a no-op", async () => {
    const b = await booking(learnerA, T0);
    const r = await request();
    const input = { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base };
    const pool = db.connect(6); // real concurrency needs several connections
    const results = await Promise.all([moveBooking(pool, input), moveBooking(pool, input), moveBooking(pool, input)]);
    await pool.$disconnect();
    expect(results.every((x) => x.ok)).toBe(true);
    expect(results.filter((x) => x.ok && !x.alreadyApplied)).toHaveLength(1);
    expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).version).toBe(2);
  });

  it("refuses a stale version without touching anything", async () => {
    const b = await booking(learnerA, T0);
    await db.prisma.booking.update({ where: { id: b.id }, data: { version: 2 } }); // someone else changed it
    const r = await request();
    const res = await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base });
    expect(res).toEqual({ ok: false, reason: "stale" });
    expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).startsAt.toISOString()).toBe(T0.toISOString());
    expect((await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.id } })).decision).toBeNull();
  });

  it("refuses a slot the tutor already has, and rolls the whole thing back", async () => {
    const b = await booking(learnerA, T0);
    await booking(learnerB, new Date(T1.getTime() + 30 * 60_000)); // overlaps T1..T1+60
    const r = await request();
    const res = await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base });
    expect(res).toEqual({ ok: false, reason: "slot_taken" });
    expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).version).toBe(1);
    expect((await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.id } })).appliedToAt).toBeNull();
  });

  it("two requests racing for the same free slot: one wins, one is told the slot is taken", async () => {
    const a = await booking(learnerA, T0);
    const l = await booking(learnerB, new Date("2026-10-20T09:30:00Z"));
    const [ra, rb] = [await request(), await request()];
    const pool = db.connect(6);
    const [x, y] = await Promise.all([
      moveBooking(pool, { requestId: ra.id, bookingId: a.id, toStartsAt: T1, expectedVersion: 1, ...base }),
      moveBooking(pool, { requestId: rb.id, bookingId: l.id, toStartsAt: T1, expectedVersion: 1, ...base }),
    ]);
    await pool.$disconnect();
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect([x, y].find((z) => !z.ok)).toEqual({ ok: false, reason: "slot_taken" });
  });

  it("a settled request cannot be applied to a different slot, and a rejected one cannot be applied at all", async () => {
    const b = await booking(learnerA, T0);
    const r = await request();
    await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base });
    expect(await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: new Date("2026-10-21T14:00:00Z"), expectedVersion: 2, ...base })).toEqual({ ok: false, reason: "already_decided" });
    const b2 = await booking(learnerB, new Date("2026-10-22T08:00:00Z"));
    const rejected = await db.prisma.rescheduleRequest.create({ data: { guardianId: guardianA, rawMessageEnc: "x", decision: "rejected" } });
    expect(await moveBooking(db.prisma, { requestId: rejected.id, bookingId: b2.id, toStartsAt: T1, expectedVersion: 1, ...base })).toEqual({ ok: false, reason: "already_decided" });
  });

  it("will not move a cancelled booking, or one that does not exist", async () => {
    const b = await booking(learnerA, T0);
    await db.prisma.booking.update({ where: { id: b.id }, data: { status: "cancelled" } });
    const r = await request();
    expect(await moveBooking(db.prisma, { requestId: r.id, bookingId: b.id, toStartsAt: T1, expectedVersion: 1, ...base })).toEqual({ ok: false, reason: "cancelled" });
    expect(await moveBooking(db.prisma, { requestId: r.id, bookingId: randomUUID(), toStartsAt: T1, expectedVersion: 1, ...base })).toEqual({ ok: false, reason: "not_found" });
  });
});
