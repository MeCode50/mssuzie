import { describe, expect, it } from "vitest";
import { checkPlan } from "./learning-planner.js";
import { checkReport } from "./parent-reporter.js";
import { checkMonitor } from "./progress-monitor.js";
import { checkAnalysis } from "./session-analyst.js";
import { AnalysisSchema, MonitorSchema, PlanSchema, ReportSchema, type Analysis, type LearningPlan } from "../schemas/index.js";
import { assembleTemplate, finalizeParentUpdate } from "../pipeline/parent-update.js";
import { buildSkillTrends } from "../pipeline/trends.js";
import { costUsd, loadLlmConfig } from "../llm/config.js";
import { loadEnv } from "../env.js";
import { randomBytes } from "node:crypto";
import { amaraKnown } from "./privacy-guard/test-helpers.js";

const NOTES = "She got 3a + 2a quickly but mixed up 3a + 2b at first, then self-corrected. Confidence clearly up today.";
const analysis = (over: Partial<Analysis["skills"][number]> = {}): Analysis => ({
  topics: ["algebra"],
  skills: [{ skill: "collecting like terms", mastery: 0.6, evidence: "mixed up 3a + 2b at first, then self-corrected", ...over }],
  misconceptions: [], engagement: { level: "high", signals: [] }, confidence: { level: "medium", signals: [] }, homework: [],
});
const session = (date: string, durationMin = 60) => ({ date, durationMin, focusSkill: "x", goal: "g", reason: "r" });
const plan = (...sessions: ReturnType<typeof session>[]): LearningPlan => ({ summary: "s", sessions });

describe("checkAnalysis", () => {
  it("accepts verbatim quotes, ignoring case, spacing and curly quotes", () => {
    expect(checkAnalysis(analysis(), NOTES)).toBeNull();
    expect(checkAnalysis(analysis({ evidence: "“MIXED   up 3a + 2b”" }), NOTES)).toBeNull();
  });
  it("accepts fragments joined with an ellipsis", () => {
    expect(checkAnalysis(analysis({ evidence: "got 3a + 2a quickly ... Confidence clearly up" }), NOTES)).toBeNull();
  });
  it("rejects invented, empty and overlong evidence, and duplicate skills", () => {
    expect(checkAnalysis(analysis({ evidence: "She aced every question perfectly" }), NOTES)).toMatch(/verbatim/);
    expect(checkAnalysis(analysis({ evidence: "" }), NOTES)).toMatch(/verbatim/);
    expect(checkAnalysis(analysis({ evidence: "x".repeat(301) }), NOTES)).toMatch(/300/);
    const dup = analysis();
    dup.skills.push({ ...dup.skills[0]!, skill: "Collecting Like Terms" });
    expect(checkAnalysis(dup, NOTES)).toMatch(/more than once/);
  });
});

describe("checkMonitor", () => {
  const ok = { status: "watch" as const, reasons: ["r"], suggestedIntervention: "i", severity: null };
  it("enforces severity only for at_risk", () => {
    expect(checkMonitor(ok)).toBeNull();
    expect(checkMonitor({ ...ok, status: "at_risk", severity: "high" })).toBeNull();
    expect(checkMonitor({ ...ok, status: "at_risk" })).toMatch(/severity is required/);
    expect(checkMonitor({ ...ok, severity: "medium" })).toMatch(/must be null/);
  });
});

describe("checkPlan: hours never exceed the plan", () => {
  const ref = "2026-10-09";
  it("allows exactly the weekly cap in each week", () => {
    const p = plan(session("2026-10-10"), session("2026-10-12"), session("2026-10-14"), session("2026-10-17"), session("2026-10-19"), session("2026-10-21"));
    expect(checkPlan(p, ref, 3)).toBeNull();
  });
  it.each([2, 3, 4])("rejects week 1 over a %i-hour plan", (hours) => {
    const sessions = Array.from({ length: hours + 1 }, (_, i) => session(`2026-10-${10 + i}`));
    expect(checkPlan(plan(...sessions), ref, hours)).toMatch(/Week 1/);
  });
  it("rejects week 2 over the cap even if week 1 is light", () => {
    const sessions = [session("2026-10-10"), session("2026-10-17", 90), session("2026-10-19", 60)];
    expect(checkPlan(plan(...sessions), ref, 2)).toMatch(/Week 2 totals 150/);
  });
  it("splits weeks at day 7 / day 8 after the reference date", () => {
    expect(checkPlan(plan(session("2026-10-16", 120)), ref, 2)).toBeNull();
    expect(checkPlan(plan(session("2026-10-16", 120), session("2026-10-16", 15)), ref, 2)).toMatch(/Week 1/);
    expect(checkPlan(plan(session("2026-10-17", 120), session("2026-10-23", 15)), ref, 2)).toMatch(/Week 2/);
  });
  it("rejects dates outside the 14-day window or malformed", () => {
    expect(checkPlan(plan(session("2026-10-09")), ref, 3)).toMatch(/outside/);
    expect(checkPlan(plan(session("2026-10-24")), ref, 3)).toMatch(/outside/);
    expect(checkPlan(plan(session("10/12/2026")), ref, 3)).toMatch(/not a valid/);
    expect(checkPlan(plan(session("2026-02-31")), ref, 3)).toMatch(/not a valid|outside/);
  });
});

describe("checkReport", () => {
  const base = { headline: "h", wins: ["[CHILD_1] did well on collecting like terms"], focusNext: "f", oneThingAtHome: "o", skillsMentioned: ["collecting like terms"] };
  const ctx = { analysis: analysis(), forbiddenSkills: ["fractions"] };
  it("accepts text limited to analysed skills", () => expect(checkReport(base, ctx)).toBeNull());
  it("rejects skills not in the analysis, forbidden skills, other tokens, and links", () => {
    expect(checkReport({ ...base, skillsMentioned: ["geometry"] }, ctx)).toMatch(/not a skill/);
    expect(checkReport({ ...base, focusNext: "Revisit Fractions soon" }, ctx)).toMatch(/not part of this session/);
    expect(checkReport({ ...base, headline: "Hi [PERSON_1]" }, ctx)).toMatch(/only \[CHILD_1\]/);
    expect(checkReport({ ...base, oneThingAtHome: "See https://x.io" }, ctx)).toMatch(/links/);
  });
});

describe("finalizeParentUpdate", () => {
  const report = { headline: "[CHILD_1] had a good week.", wins: ["Great effort"], focusNext: "More practice", oneThingAtHome: "Chat about it", skillsMentioned: [] };
  const map = { "[CHILD_1]": "Amara", "[GUARDIAN_1]": "Ngozi", "[TUTOR_1]": "Daniel", "[SCHOOL_1]": "Oakfield Academy" };
  it("restores names and passes the check", () => {
    const r = finalizeParentUpdate(assembleTemplate(report), map, amaraKnown);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.body).toContain("Hi Ngozi,");
  });
  it("blocks leftover tokens, schools, surnames and contacts", () => {
    for (const bad of ["Fine at [SCHOOL_1].", "Fine at Oakfield.", "Say hi to Amara Okafor.", "Mail a@b.com", "Call 07700 900123.", "[PERSON_1] helped."]) {
      const r = finalizeParentUpdate(assembleTemplate({ ...report, focusNext: bad }), map, amaraKnown);
      expect(r.ok, bad).toBe(false);
    }
  });
});

describe("schemas, trends and config", () => {
  it("schemas reject bad model output", () => {
    expect(AnalysisSchema.safeParse({}).success).toBe(false);
    expect(AnalysisSchema.safeParse({ ...analysis(), skills: [{ skill: "a", mastery: 1.5, evidence: "e" }] }).success).toBe(false);
    expect(MonitorSchema.safeParse({ status: "great", reasons: ["r"], suggestedIntervention: "i", severity: null }).success).toBe(false);
    expect(MonitorSchema.safeParse({ status: "watch", reasons: [], suggestedIntervention: "i", severity: null }).success).toBe(false);
    expect(PlanSchema.safeParse({ summary: "s", sessions: [{ ...session("2026-10-10"), durationMin: 7 }] }).success).toBe(false);
    expect(PlanSchema.safeParse({ summary: "s", sessions: [] }).success).toBe(false);
    expect(ReportSchema.safeParse({ headline: "h", wins: [], focusNext: "f", oneThingAtHome: "o", skillsMentioned: [] }).success).toBe(false);
  });

  it("builds skill trends oldest to newest", () => {
    const t = buildSkillTrends([{ skill: "a", points: [{ heldAt: new Date(2), mastery: 0.5 }, { heldAt: new Date(1), mastery: 0.3 }] }, { skill: "empty", points: [] }]);
    expect(t).toEqual([{ skill: "a", history: [{ sessionsAgo: 2, mastery: 0.3 }, { sessionsAgo: 1, mastery: 0.5 }], latestPrevious: 0.5 }]);
  });

  const envBase = { DATABASE_URL: "postgresql://u:p@h/db", ENCRYPTION_KEY: randomBytes(32).toString("base64") };
  it("loadLlmConfig: lists every missing variable in real mode", () => {
    expect(() => loadLlmConfig(loadEnv(envBase))).toThrow(/LLM_API_KEY.*LLM_MODEL_MAIN/s);
  });
  it("loadLlmConfig: mock mode works outside production and prices cost correctly", () => {
    const cfg = loadLlmConfig(loadEnv({ ...envBase, MOCK_LLM: "1", LLM_PRICE_MAIN_INPUT_PER_1M: "2", LLM_PRICE_MAIN_OUTPUT_PER_1M: "8" }));
    expect(cfg.mock).toBe(true);
    expect(costUsd(cfg, "main", { tokensIn: 1000, tokensOut: 500 })).toBeCloseTo(0.006, 6);
    expect(costUsd(cfg, "small", { tokensIn: 1000, tokensOut: 500 })).toBe(0);
  });
  it("loadLlmConfig: refuses mock in production even if env validation were bypassed", () => {
    const env = { ...loadEnv({ ...envBase, MOCK_LLM: "1" }), NODE_ENV: "production" as const };
    expect(() => loadLlmConfig(env)).toThrow(/production/);
  });
});
