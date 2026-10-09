import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptJson } from "../crypto/aes-gcm.js";
import { claimRun } from "../db/queue.js";
import { resetDemoData, seedAccounts } from "../seed/index.js";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db.js";
import { createRun, executeRun, LockLostError, TOKEN_MAP_RETENTION_DAYS } from "./execute-run.js";
import { llmConfig } from "./test-fixtures.js";

const KEY = randomBytes(32).toString("base64");
const seedEnv = {
  SEED_EBUN_EMAIL: "ebun@example.com", SEED_EBUN_PASSWORD: "ebun-password-123",
  SEED_OPS2_NAME: "Ops Two", SEED_OPS2_EMAIL: "ops2@example.com", SEED_OPS2_PASSWORD: "ops2-password-123",
  SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: "tutor1@example.com", SEED_TUTOR1_PASSWORD: "tutor1-password-123",
  SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: "tutor2@example.com", SEED_TUTOR2_PASSWORD: "tutor2-password-123",
};
const REAL_NAMES = ["Leo", "Hartmann", "Katrin", "Brigid", "Bristol", "Sophie", "Lindqvist"];

describe.skipIf(!TEST_DATABASE_URL)("executeRun (real Postgres)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    await seedAccounts(db.prisma, seedEnv);
    await resetDemoData(db.prisma, KEY);
  });
  afterAll(async () => db.drop());

  const latestSessionFor = async (name: string) => {
    const learner = await db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: name } } });
    const session = await db.prisma.tutoringSession.findFirstOrThrow({ where: { learnerId: learner.id }, orderBy: { heldAt: "desc" } });
    return { learner, session };
  };
  const newRun = async (sessionId: string) => (await createRun(db.prisma, { sessionId, idempotencyKey: `t-${Math.random()}` })).id;
  const deps = (llm = llmConfig(), extra = {}) => ({ prisma: db.prisma, llm, encryptionKey: KEY, ...extra });

  it("seeds the demo: 5 learners, 25 sessions, Leo has exactly one open alert", async () => {
    expect(await db.prisma.learner.count()).toBe(5);
    expect(await db.prisma.tutoringSession.count()).toBe(25);
    const { learner } = await latestSessionFor("Leo");
    expect(await db.prisma.alert.count({ where: { learnerId: learner.id, status: "open" } })).toBe(1);
    expect(await db.prisma.user.count()).toBe(4);
  });

  it("runs a session end to end and persists everything", async () => {
    const { learner, session } = await latestSessionFor("Leo");
    const runId = await newRun(session.id);
    const summary = await executeRun(deps(), runId);
    expect(summary.outcome).toBe("completed");

    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "completed", lockedBy: null });
    expect(run.totalTokens).toBeGreaterThan(0);
    expect(Number(run.costUsd)).toBeGreaterThan(0);
    expect(run.finishedAt).toBeInstanceOf(Date);

    const steps = await db.prisma.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(steps.filter((s) => s.status === "completed").map((s) => s.agent).sort()).toEqual(
      ["learning_planner", "parent_reporter", "privacy_guard", "progress_monitor", "session_analyst"],
    );
    const stored = JSON.stringify(steps.map((s) => s.outputJson));
    for (const n of REAL_NAMES) expect(stored).not.toContain(n);

    const after = await db.prisma.tutoringSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.notesRedacted).toBeTruthy();
    for (const n of REAL_NAMES) expect(after.notesRedacted).not.toContain(n);

    const map = decryptJson<Record<string, string>>(run.tokenMapEnc ?? "", KEY);
    expect(map["[CHILD_1]"]).toBe("Leo");
    const days = ((run.tokenMapExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(TOKEN_MAP_RETENTION_DAYS - 0.1);
    expect(days).toBeLessThan(TOKEN_MAP_RETENTION_DAYS + 0.1);

    expect(await db.prisma.skillSnapshot.count({ where: { sessionId: session.id } })).toBeGreaterThan(0);
    expect((await db.prisma.learner.findUniqueOrThrow({ where: { id: learner.id } })).currentStatus).toBe("at_risk");
    const alerts = await db.prisma.alert.findMany({ where: { learnerId: learner.id, status: "open" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: summary.alertId, runId, type: "refund_risk" });
    const update = await db.prisma.parentUpdate.findFirstOrThrow({ where: { runId } });
    expect(update).toMatchObject({ status: "draft", id: summary.parentUpdateId });
    expect(update.body).toContain("Hi Katrin,");
    expect(update.body).not.toMatch(/\[[A-Z]+_\d+\]|Hartmann|Brigid|Bristol/);
  });

  it("retry re-runs only the failed step (and what depends on it), reusing the rest", async () => {
    const { session } = await latestSessionFor("Amara");
    const runId = await newRun(session.id);
    const first = await executeRun(deps(llmConfig({ failAgents: new Set(["progress_monitor"]) })), runId);
    expect(first.outcome).toBe("partial");
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("partial");

    const second = await executeRun(deps(), runId);
    expect(second.outcome).toBe("completed");

    const steps = await db.prisma.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    const runs = (agent: string) => steps.filter((s) => s.agent === agent && s.status === "running").length;
    expect(runs("privacy_guard")).toBe(1);
    expect(runs("session_analyst")).toBe(1);
    expect(runs("learning_planner")).toBe(1);
    expect(runs("progress_monitor")).toBe(2);
    expect(runs("parent_reporter")).toBe(2);
    expect(steps.filter((s) => s.agent === "progress_monitor").map((s) => `${s.status}#${s.attempt}`)).toEqual(
      ["running#1", "failed#1", "running#2", "completed#2"],
    );
    expect(await db.prisma.parentUpdate.count({ where: { runId } })).toBe(1);
  });

  it("a failed Guard fails the run, and a retry starts again from the Guard", async () => {
    const { session } = await latestSessionFor("Priya");
    const runId = await newRun(session.id);
    const first = await executeRun(deps(llmConfig({ failAgents: new Set(["privacy_guard"]) })), runId);
    expect(first.outcome).toBe("failed");
    expect(await db.prisma.parentUpdate.count({ where: { runId } })).toBe(0);
    expect((await db.prisma.tutoringSession.findUniqueOrThrow({ where: { id: session.id } })).notesRedacted).toBeNull();
    expect((await executeRun(deps(), runId)).outcome).toBe("completed");
  });

  it("never overwrites an approved parent update on a re-run", async () => {
    const { session } = await latestSessionFor("Tom");
    const runId = await newRun(session.id);
    await executeRun(deps(), runId);
    const draft = await db.prisma.parentUpdate.findFirstOrThrow({ where: { runId } });
    await db.prisma.parentUpdate.update({ where: { id: draft.id }, data: { status: "approved", approvedBy: "ops", approvedAt: new Date(), body: "APPROVED TEXT" } });
    await db.prisma.runStep.deleteMany({ where: { runId, agent: "parent_reporter" } });
    await executeRun(deps(), runId);
    expect((await db.prisma.parentUpdate.findUniqueOrThrow({ where: { id: draft.id } })).body).toBe("APPROVED TEXT");
  });

  it("abandons a run whose lock was lost and writes no results", async () => {
    const { session } = await latestSessionFor("Zainab");
    const runId = await newRun(session.id);
    await claimRun(db.prisma, "worker-that-holds-the-lock");
    await expect(executeRun(deps(llmConfig(), { lockedBy: "a-stale-worker" }), runId)).rejects.toBeInstanceOf(LockLostError);
    expect(await db.prisma.parentUpdate.count({ where: { runId } })).toBe(0);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe("running");
  });
});
