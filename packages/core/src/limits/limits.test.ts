import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db.js";
import { consumeRateLimit, pruneRateLimits } from "./rate-limit.js";
import { countUserRuns, DAY_MS, getSpendStatus, utcDayStart } from "./spend.js";

describe("utcDayStart", () => {
  it("returns UTC midnight", () => {
    expect(utcDayStart(new Date("2026-10-09T23:59:59.999Z")).toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-10-10T00:00:00.000Z")).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("limits (real Postgres)", () => {
  let db: TestDb;
  let sessionId: string;
  let userId: string;

  beforeAll(async () => {
    db = await createTestDb();
    userId = (await db.prisma.user.create({ data: { id: randomUUID(), name: "T", email: "t@example.com", role: "tutor" } })).id;
    const learner = await db.prisma.learner.create({
      data: { displayName: "A B", age: 9, grade: "Y4", subjects: [], interests: [], planHoursPerWeek: 2, tutorId: userId },
    });
    sessionId = (await db.prisma.tutoringSession.create({
      data: { learnerId: learner.id, tutorId: userId, heldAt: new Date(), durationMin: 30, notesRaw: "x" },
    })).id;
  });
  beforeEach(async () => {
    await db.prisma.run.deleteMany();
    await db.prisma.rateLimit.deleteMany();
  });
  afterAll(async () => db.drop());

  const makeRun = (data: Record<string, unknown> = {}) =>
    db.prisma.run.create({ data: { sessionId, idempotencyKey: randomUUID(), ...data } });

  describe("consumeRateLimit", () => {
    const hit = (key = "k", over: Partial<{ limit: number; windowMs: number; now: number }> = {}) =>
      consumeRateLimit(db.prisma, { key, limit: 3, windowMs: 1000, ...over });

    it("allows up to the limit, then blocks with a retry-after", async () => {
      const t = 1_000_000;
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await hit("ip:1", { now: t + i * 10 }));
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
      expect(results[3]).toMatchObject({ count: 4, limit: 3 });
      expect(results[3]!.retryAfterSec).toBe(1);
      expect(results[0]!.retryAfterSec).toBe(0);
    });

    it("starts a fresh window once the old one has elapsed", async () => {
      const t = 5_000_000;
      for (let i = 0; i < 4; i++) await hit("ip:2", { now: t });
      expect((await hit("ip:2", { now: t + 500 })).allowed).toBe(false);
      expect(await hit("ip:2", { now: t + 1000 })).toMatchObject({ allowed: true, count: 1 });
    });

    it("keeps keys independent", async () => {
      for (let i = 0; i < 4; i++) await hit("ip:a");
      expect((await hit("ip:a")).allowed).toBe(false);
      expect((await hit("ip:b")).allowed).toBe(true);
    });

    it("is atomic: 30 concurrent requests against a limit of 5 let exactly 5 through", async () => {
      const clients = Array.from({ length: 10 }, () => db.connect(1));
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          consumeRateLimit(clients[i % clients.length]!, { key: "burst", limit: 5, windowMs: 60_000 })),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });

    it("stays exact when many requests create a brand-new counter at the same instant (repeated)", async () => {
      const clients = Array.from({ length: 12 }, () => db.connect(1));
      for (let round = 0; round < 25; round++) {
        const results = await Promise.all(
          Array.from({ length: 24 }, (_, i) =>
            consumeRateLimit(clients[i % clients.length]!, { key: `fresh-${round}`, limit: 4, windowMs: 60_000 })),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(4);
        expect(Math.max(...results.map((r) => r.count))).toBe(24);
      }
    });

    it("prefixes keys so they cannot collide with Better Auth rows, and prunes only its own old rows", async () => {
      await hit("old", { now: 1000 });
      await db.prisma.rateLimit.create({ data: { id: "auth-row", key: "1.2.3.4|/sign-in/email", count: 1, lastRequest: BigInt(1000) } });
      expect(await pruneRateLimits(db.prisma, 1000, 10_000_000)).toBe(1);
      expect(await db.prisma.rateLimit.count({ where: { key: "1.2.3.4|/sign-in/email" } })).toBe(1);
    });
  });

  describe("getSpendStatus", () => {
    const status = (over = {}) => getSpendStatus(db.prisma, { capUsd: 5, estimatedRunCostUsd: 0.5, ...over });

    it("allows when nothing is spent", async () => {
      expect(await status()).toMatchObject({ allowed: true, spentUsd: 0, inFlightRuns: 0, reservedUsd: 0 });
    });

    it("counts only today's (UTC) spend", async () => {
      await makeRun({ status: "completed", costUsd: 4.7, createdAt: new Date(Date.now() - 2 * DAY_MS) });
      await makeRun({ status: "completed", costUsd: 1.25 });
      expect((await status()).spentUsd).toBeCloseTo(1.25, 6);
    });

    it("blocks once spend plus the new run's estimate would pass the cap", async () => {
      await makeRun({ status: "completed", costUsd: 4.5 });
      expect((await status()).allowed).toBe(true); // 4.5 + 0.5 = 5.0 <= 5
      await makeRun({ status: "completed", costUsd: 0.01 });
      expect((await status()).allowed).toBe(false);
    });

    it("reserves budget for in-flight runs so a burst cannot overshoot", async () => {
      for (let i = 0; i < 9; i++) await makeRun({ status: i % 2 ? "queued" : "running" });
      // 9 x 0.5 reserved + 0.5 for the new run = 5.0, exactly the cap: still allowed.
      expect(await status()).toMatchObject({ inFlightRuns: 9, reservedUsd: 4.5, allowed: true });
      await makeRun({ status: "queued" });
      expect(await status()).toMatchObject({ inFlightRuns: 10, reservedUsd: 5, allowed: false });
    });

    it("finished runs stop reserving budget and count their real cost instead", async () => {
      for (let i = 0; i < 10; i++) await makeRun({ status: "completed", costUsd: 0.1 });
      expect(await status()).toMatchObject({ inFlightRuns: 0, reservedUsd: 0, allowed: true });
    });

    it("an unlimited-looking free run (cost 0) never blocks", async () => {
      for (let i = 0; i < 50; i++) await makeRun({ status: "completed", costUsd: 0 });
      expect((await status({ estimatedRunCostUsd: 0 })).allowed).toBe(true);
    });
  });

  describe("countUserRuns", () => {
    it("counts only this user's runs from the last 24 hours", async () => {
      const other = (await db.prisma.user.create({ data: { id: randomUUID(), name: "O", email: "o@example.com", role: "tutor" } })).id;
      await makeRun({ createdById: userId });
      await makeRun({ createdById: userId });
      await makeRun({ createdById: userId, createdAt: new Date(Date.now() - 25 * 3_600_000) });
      await makeRun({ createdById: other });
      expect(await countUserRuns(db.prisma, userId)).toBe(2);
    });
  });
});
