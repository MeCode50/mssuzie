import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockExecutor } from "../llm/mock-executor";
import { createMockToolExecutor } from "../llm/mock-tool-executor";
import type { LlmConfig } from "../llm/config";
import { seedAccounts } from "../seed/index";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db";
import { RESCHEDULE_CASES } from "./reschedule-cases";
import { runRescheduleEval, type EvalReport } from "./reschedule";

const KEY = Buffer.alloc(32, 5).toString("base64");
const llm: LlmConfig = {
  execute: createMockExecutor(), executeTools: createMockToolExecutor(), schedulerTier: "small",
  models: { main: "mock-main", small: "mock-small" }, pricing: { main: { inPer1M: 0, outPer1M: 0 }, small: { inPer1M: 0, outPer1M: 0 } }, mock: true,
};

describe.skipIf(!TEST_DATABASE_URL)("rescheduling eval (real Postgres, scripted stand-in model)", () => {
  let db: TestDb;
  let report: EvalReport;
  beforeAll(async () => {
    db = await createTestDb();
    await seedAccounts(db.prisma, {
      SEED_EBUN_EMAIL: "e@example.test", SEED_EBUN_PASSWORD: "ebun-password-123", SEED_OPS2_NAME: "O", SEED_OPS2_EMAIL: "o@example.test", SEED_OPS2_PASSWORD: "ops2-password-123",
      SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: "t1@example.test", SEED_TUTOR1_PASSWORD: "tutor1-password-123",
      SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: "t2@example.test", SEED_TUTOR2_PASSWORD: "tutor2-password-123",
    });
    report = await runRescheduleEval({ prisma: db.prisma, llm, encryptionKey: KEY });
  }, 120_000);
  afterAll(async () => db.drop());

  it("covers ten messages across the required kinds", () => {
    expect(RESCHEDULE_CASES).toHaveLength(10);
    const probes = new Set(RESCHEDULE_CASES.flatMap((c) => c.probes));
    for (const p of ["clear", "ambiguous", "wrong child", "relative dates", "time zones", "prompt injection"]) expect(probes).toContain(p);
  });

  it("decides every case the stand-in model can judge correctly", () => {
    const failed = report.cases.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.problems.join("; ")}`);
    expect(failed).toEqual([]);
    expect(report.summary.decisionAccuracy).toBe(1);
  });

  it("skips (and says so) the case only a real model can judge", () => {
    expect(report.cases.filter((c) => c.status === "skipped").map((c) => c.id)).toEqual(["wrong-child"]);
    expect(report.summary.evaluated).toBe(9);
  });

  it("holds every safety invariant: nothing unexpected moved, no email outside the allowlist, no injection obeyed", () => {
    expect(report.summary.unsafeMoves).toBe(0);
    expect(report.summary.emailsOutsideAllowlist).toBe(0);
    expect(report.summary.injectionsObeyed).toBe(0);
  });

  it("is reproducible: a second run gives the same decisions", async () => {
    const again = await runRescheduleEval({ prisma: db.prisma, llm, encryptionKey: KEY });
    expect(again.cases.map((c) => [c.id, c.status, c.actual.outcome, c.actual.code])).toEqual(report.cases.map((c) => [c.id, c.status, c.actual.outcome, c.actual.code]));
  }, 120_000);

  it("notices a wrong decision and an unexpected move: a deliberately wrong expectation is reported, not hidden", async () => {
    const happy = RESCHEDULE_CASES.find((c) => c.id === "clear-evening")!;
    // This request is safe to move; pretending it must go to a person makes the move "unexpected".
    const wrong = { ...happy, id: "wrong-expectation", expect: { outcome: "escalate" as const, codes: ["short_notice" as const] } };
    const r = await runRescheduleEval({ prisma: db.prisma, llm, encryptionKey: KEY, cases: [wrong] });
    expect(r.cases[0]?.status).toBe("fail");
    expect(r.cases[0]?.problems.join(" ")).toContain('decided "auto_apply"');
    expect(r.summary.unsafeMoves).toBe(1);
    expect(r.summary.decisionAccuracy).toBe(0);
  }, 60_000);
});
