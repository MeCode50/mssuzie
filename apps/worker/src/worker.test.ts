import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLogger, createMockExecutor, resetDemoData, seedAccounts, type ExecuteDeps, type LlmConfig, type RunSummary,
} from "@mssuzie/core";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "@mssuzie/core/testing";
import { Worker, type WorkerOptions } from "./worker";

const KEY = randomBytes(32).toString("base64");
const llm: LlmConfig = {
  execute: createMockExecutor(),
  models: { main: "m", small: "s" },
  pricing: { main: { inPer1M: 1, outPer1M: 1 }, small: { inPer1M: 1, outPer1M: 1 } },
  mock: true,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}

describe.skipIf(!TEST_DATABASE_URL)("worker (real Postgres)", () => {
  let db: TestDb;
  let sessionId: string;
  const lines: string[] = [];
  const logger = createLogger({ service: "worker-test" }, (line) => void lines.push(line));

  beforeAll(async () => {
    db = await createTestDb();
    const tutor = await db.prisma.user.create({ data: { id: randomUUID(), name: "T", email: "t@example.com", role: "tutor" } });
    const learner = await db.prisma.learner.create({
      data: { displayName: "Amara Okafor", age: 12, grade: "Y8", subjects: [], interests: [], planHoursPerWeek: 3, tutorId: tutor.id },
    });
    sessionId = (await db.prisma.tutoringSession.create({
      data: { learnerId: learner.id, tutorId: tutor.id, heldAt: new Date(), durationMin: 60, notesRaw: "x" },
    })).id;
  });
  beforeEach(async () => {
    lines.length = 0;
    await db.prisma.run.deleteMany();
  });
  afterAll(async () => db.drop());

  const makeRuns = (n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) =>
      db.prisma.run.create({ data: { sessionId, idempotencyKey: randomUUID(), createdAt: new Date(Date.now() - (n - i) * 1000) } })));
  const statusOf = async (id: string) => (await db.prisma.run.findUniqueOrThrow({ where: { id } })).status;

  /** Fake executor: records who ran what, then marks the run completed like the real one does. */
  function fakeExecute(ms = 0, seen: { runId: string; lockedBy?: string }[] = [], active = { now: 0, max: 0 }) {
    const fn: NonNullable<WorkerOptions["execute"]> = async (deps: ExecuteDeps, runId: string): Promise<RunSummary> => {
      seen.push({ runId, lockedBy: deps.lockedBy });
      active.now++;
      active.max = Math.max(active.max, active.now);
      await sleep(ms);
      active.now--;
      await db.prisma.run.update({ where: { id: runId }, data: { status: "completed", finishedAt: new Date(), lockedBy: null, lockedAt: null } });
      return { runId, outcome: "completed", totalTokens: 1, costUsd: 0, failures: {}, parentUpdateId: null, alertId: null };
    };
    return { fn, seen, active };
  }

  const make = (over: Partial<WorkerOptions> = {}) =>
    new Worker({ prisma: db.connect(8), llm, encryptionKey: KEY, logger, pollIntervalMs: 20, maintenanceMs: 60_000, ...over });

  it("processes every queued run exactly once, passing its own id as the lock owner", async () => {
    const runs = await makeRuns(3);
    const { fn, seen } = fakeExecute();
    const w = make({ execute: fn, workerId: "w-test" });
    w.start();
    await waitFor(async () => (await db.prisma.run.count({ where: { status: "completed" } })) === 3);
    await w.stop();
    expect(seen.map((s) => s.runId).sort()).toEqual(runs.map((r) => r.id).sort());
    expect(seen.every((s) => s.lockedBy === "w-test")).toBe(true);
  });

  it("runs up to `concurrency` runs at once and never more", async () => {
    await makeRuns(8);
    const { fn, seen, active } = fakeExecute(120);
    const w = make({ execute: fn, concurrency: 3 });
    w.start();
    await waitFor(async () => (await db.prisma.run.count({ where: { status: "completed" } })) === 8);
    await w.stop();
    expect(active.max).toBe(3);
    expect(new Set(seen.map((s) => s.runId)).size).toBe(8);
  });

  it("two worker processes share the queue without double-processing", async () => {
    await makeRuns(12);
    const shared = fakeExecute(30);
    const a = make({ execute: shared.fn, workerId: "A" });
    const b = make({ execute: shared.fn, workerId: "B" });
    a.start(); b.start();
    await waitFor(async () => (await db.prisma.run.count({ where: { status: "completed" } })) === 12);
    await Promise.all([a.stop(), b.stop()]);
    expect(shared.seen).toHaveLength(12);
    expect(new Set(shared.seen.map((s) => s.runId)).size).toBe(12);
    expect(new Set(shared.seen.map((s) => s.lockedBy))).toEqual(new Set(["A", "B"]));
  });

  it("survives an executor that throws and keeps processing", async () => {
    const [bad, good] = await makeRuns(2);
    const { fn } = fakeExecute();
    const w = make({
      execute: async (deps, runId) => {
        if (runId === bad!.id) throw new Error("boom");
        return fn(deps, runId);
      },
    });
    w.start();
    await waitFor(async () => (await statusOf(good!.id)) === "completed");
    await w.stop();
    expect(lines.some((l) => JSON.parse(l).msg === "run crashed" && JSON.parse(l).runId === bad!.id)).toBe(true);
  });

  it("refreshes the lock while a long run executes", async () => {
    const [run] = await makeRuns(1);
    const { fn } = fakeExecute(700);
    const w = make({ execute: fn, heartbeatMs: 100 });
    w.start();
    await waitFor(async () => (await statusOf(run!.id)) === "running");
    const first = (await db.prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).lockedAt!.getTime();
    await sleep(350);
    const later = (await db.prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).lockedAt!.getTime();
    await w.stop();
    expect(later).toBeGreaterThan(first);
  });

  it("recovers a run abandoned by a dead worker", async () => {
    const [run] = await makeRuns(1);
    await db.prisma.run.update({ where: { id: run!.id }, data: { status: "running", lockedBy: "dead", claimCount: 1 } });
    await db.prisma.$executeRawUnsafe(`UPDATE runs SET locked_at = now() - interval '10 minutes' WHERE id = '${run!.id}'`);
    const { fn, seen } = fakeExecute();
    const w = make({ execute: fn, maintenanceMs: 50 });
    w.start();
    await waitFor(async () => (await statusOf(run!.id)) === "completed");
    await w.stop();
    expect(seen).toHaveLength(1);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).claimCount).toBe(2);
  });

  it("graceful stop lets the in-flight run finish and claims nothing new", async () => {
    const [first] = await makeRuns(1);
    const { fn } = fakeExecute(300);
    const w = make({ execute: fn, shutdownGraceMs: 5000 });
    w.start();
    await waitFor(() => w.activeRuns.length === 1);
    const stopping = w.stop();
    const [late] = await makeRuns(1);
    expect(await stopping).toEqual({ released: [] });
    expect(await statusOf(first!.id)).toBe("completed");
    expect(await statusOf(late!.id)).toBe("queued");
  });

  it("when the grace period runs out, hands the run back to the queue", async () => {
    const [run] = await makeRuns(1);
    const { fn } = fakeExecute(1500);
    const w = make({ execute: fn, shutdownGraceMs: 100 });
    w.start();
    await waitFor(() => w.activeRuns.length === 1);
    expect(await w.stop()).toEqual({ released: [run!.id] });
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run!.id } })).toMatchObject({ status: "queued", lockedBy: null, claimCount: 0 });
  });

  it("stops promptly when idle, even with a long poll interval", async () => {
    const w = make({ pollIntervalMs: 30_000 });
    w.start();
    await sleep(100);
    const t = Date.now();
    await w.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("logs structured JSON with the runId and never any tutor-note content", async () => {
    await resetAndRunReal();
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const stepLines = parsed.filter((l) => l.msg === "step");
    expect(stepLines.length).toBe(10);
    expect(stepLines.every((l) => typeof l.runId === "string" && l.service === "worker-test")).toBe(true);
    const all = lines.join("\n");
    for (const secret of ["Leo", "Hartmann", "Katrin", "Brigid", "Bristol"]) expect(all).not.toContain(secret);
  });

  async function resetAndRunReal(): Promise<void> {
    await seedAccounts(db.prisma, {
      SEED_EBUN_EMAIL: "e@example.com", SEED_EBUN_PASSWORD: "ebun-password-123",
      SEED_OPS2_NAME: "O", SEED_OPS2_EMAIL: "o@example.com", SEED_OPS2_PASSWORD: "ops2-password-123",
      SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: "t1@example.com", SEED_TUTOR1_PASSWORD: "tutor1-password-123",
      SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: "t2@example.com", SEED_TUTOR2_PASSWORD: "tutor2-password-123",
    });
    await resetDemoData(db.prisma, KEY);
    const leo = await db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Leo" } } });
    const session = await db.prisma.tutoringSession.findFirstOrThrow({ where: { learnerId: leo.id }, orderBy: { heldAt: "desc" } });
    lines.length = 0;
    const run = await db.prisma.run.create({ data: { sessionId: session.id, idempotencyKey: randomUUID() } });
    const w = make(); // real executeRun + mock LLM
    w.start();
    await waitFor(async () => ["completed", "partial", "failed"].includes(await statusOf(run.id)), 20_000);
    await w.stop();
    expect(await statusOf(run.id)).toBe("completed");
    expect(await db.prisma.parentUpdate.count({ where: { runId: run.id } })).toBe(1);
  }
});
