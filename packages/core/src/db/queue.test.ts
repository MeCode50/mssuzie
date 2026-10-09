import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db.js";
import { claimRun, releaseRun, requeueStuckRuns, sweepExpiredTokenMaps, touchLock } from "./queue.js";
import type { PrismaClient } from "./client.js";

describe.skipIf(!TEST_DATABASE_URL)("queue (real Postgres)", () => {
  let db: TestDb;
  let sessionId: string;

  beforeAll(async () => {
    db = await createTestDb();
    const tutor = await db.prisma.user.create({ data: { id: randomUUID(), name: "T", email: "t@example.com", role: "tutor" } });
    const learner = await db.prisma.learner.create({
      data: { displayName: "Amara Okafor", age: 12, grade: "Year 8", subjects: [], interests: [], planHoursPerWeek: 3, tutorId: tutor.id },
    });
    const s = await db.prisma.tutoringSession.create({
      data: { learnerId: learner.id, tutorId: tutor.id, heldAt: new Date(), durationMin: 60, notesRaw: "x" },
    });
    sessionId = s.id;
  });
  beforeEach(async () => void (await db.prisma.run.deleteMany()));
  afterAll(async () => db.drop());

  const makeRun = (data: Partial<{ createdAt: Date; status: "queued" | "running" | "completed"; claimCount: number }> = {}) =>
    db.prisma.run.create({ data: { sessionId, idempotencyKey: randomUUID(), ...data } });
  const age = (id: string, minutes: number) =>
    db.prisma.$executeRawUnsafe(`UPDATE runs SET locked_at = now() - interval '${minutes} minutes' WHERE id = '${id}'`);

  it("claims a single queued run exactly once under 16 concurrent workers", async () => {
    const run = await makeRun();
    const clients = Array.from({ length: 16 }, () => db.connect(1));
    const results = await Promise.all(clients.map((c, i) => claimRun(c, `worker-${i}`)));
    const winners = results.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    const row = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: "running", lockedBy: `worker-${winners[0]}`, claimCount: 1 });
    expect(row.lockedAt).toBeInstanceOf(Date);
    expect(row.startedAt).toBeInstanceOf(Date);
  });

  it("drains 40 runs across 12 concurrent workers with no run claimed twice and none lost", async () => {
    await Promise.all(Array.from({ length: 40 }, () => makeRun()));
    const clients: PrismaClient[] = Array.from({ length: 12 }, () => db.connect(1));
    const claimed: string[] = [];
    await Promise.all(
      clients.map(async (c, i) => {
        for (;;) {
          const r = await claimRun(c, `worker-${i}`);
          if (!r) return;
          claimed.push(r.id);
        }
      }),
    );
    expect(claimed).toHaveLength(40);
    expect(new Set(claimed).size).toBe(40);
    expect(await db.prisma.run.count({ where: { status: "queued" } })).toBe(0);
    expect(await db.prisma.run.count({ where: { claimCount: 1 } })).toBe(40);
  });

  it("claims oldest first and ignores runs that are not queued", async () => {
    const t = Date.now();
    const newest = await makeRun({ createdAt: new Date(t) });
    const oldest = await makeRun({ createdAt: new Date(t - 3000) });
    const middle = await makeRun({ createdAt: new Date(t - 1000) });
    await makeRun({ status: "completed", createdAt: new Date(t - 9000) });
    await makeRun({ status: "running", createdAt: new Date(t - 8000) });
    const order = [await claimRun(db.prisma, "w"), await claimRun(db.prisma, "w"), await claimRun(db.prisma, "w"), await claimRun(db.prisma, "w")];
    expect(order.map((r) => r?.id)).toEqual([oldest.id, middle.id, newest.id, undefined]);
  });

  it("re-queues runs locked longer than 5 minutes and leaves fresh ones alone", async () => {
    const stale = await makeRun();
    const fresh = await makeRun();
    await claimRun(db.prisma, "dead-worker");
    await claimRun(db.prisma, "live-worker");
    const [first, second] = await db.prisma.run.findMany({ orderBy: { createdAt: "asc" } });
    await age(first!.id, 6);
    await age(second!.id, 4);
    const r = await requeueStuckRuns(db.prisma);
    expect(r.requeued).toEqual([stale.id]);
    expect(r.failed).toEqual([]);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "queued", lockedBy: null, lockedAt: null });
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("running");
    const again = await claimRun(db.prisma, "new-worker");
    expect(again?.id).toBe(stale.id);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: stale.id } })).claimCount).toBe(2);
  });

  it("fails a run that keeps killing workers instead of re-queueing it forever", async () => {
    const run = await makeRun();
    await db.prisma.run.update({ where: { id: run.id }, data: { status: "running", lockedBy: "w", lockedAt: new Date(), claimCount: 3 } });
    await db.prisma.runStep.create({ data: { runId: run.id, seq: 1, agent: "privacy_guard", status: "completed" } });
    await age(run.id, 10);
    const r = await requeueStuckRuns(db.prisma);
    expect(r).toEqual({ requeued: [], failed: [run.id] });
    const row = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ status: "failed", lockedBy: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
    const steps = await db.prisma.runStep.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    expect(steps.at(-1)).toMatchObject({ seq: 2, agent: "session_analyst", status: "failed" });
    expect(steps.at(-1)?.error).toMatch(/repeated worker crashes/);
  });

  it("heartbeat keeps a long run from being re-queued, and fails for a non-owner", async () => {
    const run = await makeRun();
    await claimRun(db.prisma, "w1");
    await age(run.id, 10);
    expect(await touchLock(db.prisma, run.id, "someone-else")).toBe(false);
    expect(await touchLock(db.prisma, run.id, "w1")).toBe(true);
    expect(await requeueStuckRuns(db.prisma)).toEqual({ requeued: [], failed: [] });
    await age(run.id, 10);
    await requeueStuckRuns(db.prisma);
    expect(await touchLock(db.prisma, run.id, "w1")).toBe(false);
  });

  it("releases a run for graceful shutdown without counting it as a crash", async () => {
    const run = await makeRun();
    await claimRun(db.prisma, "w1");
    expect(await releaseRun(db.prisma, run.id, "other")).toBe(false);
    expect(await releaseRun(db.prisma, run.id, "w1")).toBe(true);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "queued", lockedBy: null, claimCount: 0 });
  });

  it("deletes only token maps past their 30-day expiry", async () => {
    const day = 86_400_000;
    const expired = await makeRun();
    const live = await makeRun();
    const none = await makeRun();
    await db.prisma.run.update({ where: { id: expired.id }, data: { tokenMapEnc: "v1:a:b:c", tokenMapExpiresAt: new Date(Date.now() - day) } });
    await db.prisma.run.update({ where: { id: live.id }, data: { tokenMapEnc: "v1:a:b:c", tokenMapExpiresAt: new Date(Date.now() + 29 * day) } });
    expect(await sweepExpiredTokenMaps(db.prisma)).toBe(1);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ tokenMapEnc: null, tokenMapExpiresAt: null });
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: live.id } })).tokenMapEnc).toBe("v1:a:b:c");
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: none.id } })).tokenMapEnc).toBeNull();
  });
});
