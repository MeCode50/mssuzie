import { describe, expect, it } from "vitest";
import { createMockExecutor } from "../llm/mock-executor.js";
import type { LlmExecutor } from "../llm/structured.js";
import { checkPlan } from "../agents/learning-planner.js";
import { amaraInput, collectingSink, leoInput, llmConfig } from "./test-fixtures.js";
import { runPipeline } from "./run-pipeline.js";
import type { StepEvent } from "./types.js";

const statusOf = (events: StepEvent[], agent: string) =>
  events.filter((e) => e.agent === agent).map((e) => e.status);

describe("pipeline: happy path", () => {
  it("runs all five steps, ends completed, and drafts a parent update with real names", async () => {
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig(), sink });
    expect(r.outcome).toBe("completed");
    for (const agent of ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"]) {
      expect(statusOf(events, agent)).toEqual(["running", "completed"]);
    }
    expect(r.parentUpdateBody).toContain("Hi Ngozi,");
    expect(r.parentUpdateBody).toContain("Amara");
    expect(r.parentUpdateBody).not.toMatch(/\[[A-Z]+_\d+\]|Okafor|Oakfield|Leeds|@|7700/);
  });

  it("keeps real names out of every stored step output", async () => {
    const { sink, events } = collectingSink();
    await runPipeline(amaraInput(), { llm: llmConfig(), sink });
    const stored = JSON.stringify(events.map((e) => e.output));
    for (const secret of ["Amara", "Okafor", "Ngozi", "Daniel", "Oakfield", "Leeds"]) {
      expect(stored).not.toContain(secret);
    }
  });

  it("starts Monitor and Planner together, before either finishes", async () => {
    const { sink, events } = collectingSink();
    await runPipeline(amaraInput(), { llm: llmConfig({ delayMs: 15 }), sink });
    const idx = (agent: string, status: string) => events.findIndex((e) => e.agent === agent && e.status === status);
    const firstDone = Math.min(idx("progress_monitor", "completed"), idx("learning_planner", "completed"));
    expect(idx("progress_monitor", "running")).toBeLessThan(firstDone);
    expect(idx("learning_planner", "running")).toBeLessThan(firstDone);
    expect(idx("parent_reporter", "running")).toBeGreaterThan(Math.max(idx("progress_monitor", "completed"), idx("learning_planner", "completed")));
  });

  it("produces a plan that respects the plan hours", async () => {
    const r = await runPipeline(amaraInput(), { llm: llmConfig(), sink: collectingSink().sink });
    expect(r.plan).not.toBeNull();
    expect(checkPlan(r.plan!, "2026-10-09", 3)).toBeNull();
  });

  it("records tokens and cost per step from the configured prices", async () => {
    const { sink, events } = collectingSink();
    await runPipeline(amaraInput(), { llm: llmConfig(), sink });
    const done = events.filter((e) => e.status === "completed");
    expect(done.every((e) => e.tokensIn > 0 && e.tokensOut > 0 && e.costUsd > 0)).toBe(true);
    const analyst = done.find((e) => e.agent === "session_analyst")!;
    expect(analyst.costUsd).toBeCloseTo((analyst.tokensIn * 2 + analyst.tokensOut * 8) / 1e6, 6);
    expect(analyst.model).toBe("test-main");
    expect(done.find((e) => e.agent === "privacy_guard")?.model).toBe("test-small");
  });

  it("flags a struggling learner as at_risk with a severity", async () => {
    const r = await runPipeline(leoInput(), { llm: llmConfig(), sink: collectingSink().sink });
    expect(r.monitor?.status).toBe("at_risk");
    expect(r.monitor?.severity).toBe("high");
  });
});

describe("pipeline: failures", () => {
  it("Monitor failure -> partial, Reporter still drafts", async () => {
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({ failAgents: new Set(["progress_monitor"]) }), sink });
    expect(r.outcome).toBe("partial");
    expect(r.monitor).toBeNull();
    expect(statusOf(events, "progress_monitor")).toEqual(["running", "failed"]);
    expect(r.parentUpdateBody).toContain("Hi Ngozi,");
    expect(r.failures.progress_monitor).toMatch(/mock failure/);
  });

  it("Planner failure -> partial with analysis, monitor and draft intact", async () => {
    const r = await runPipeline(amaraInput(), { llm: llmConfig({ failAgents: new Set(["learning_planner"]) }), sink: collectingSink().sink });
    expect(r.outcome).toBe("partial");
    expect(r.plan).toBeNull();
    expect(r.monitor).not.toBeNull();
    expect(r.parentUpdateBody).not.toBeNull();
  });

  it("Analyst failure -> failed, downstream steps skipped, nothing drafted", async () => {
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({ failAgents: new Set(["session_analyst"]) }), sink });
    expect(r.outcome).toBe("failed");
    expect(r.parentUpdateBody).toBeNull();
    for (const a of ["progress_monitor", "learning_planner", "parent_reporter"]) expect(statusOf(events, a)).toEqual(["skipped"]);
    expect(r.redactedNotes).not.toBeNull();
  });

  it("Guard model failure -> failed (fail closed): the Analyst is never called", async () => {
    const called: string[] = [];
    const inner = createMockExecutor({ failAgents: new Set(["privacy_guard"]) });
    const execute: LlmExecutor = async (req) => (called.push(req.name), inner(req));
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({}, execute), sink });
    expect(r.outcome).toBe("failed");
    expect(called).toEqual(["privacy_guard"]);
    expect(statusOf(events, "session_analyst")).toEqual(["skipped"]);
  });

  it("fails the Reporter when the final draft contains unexpected PII", async () => {
    const inner = createMockExecutor();
    const execute: LlmExecutor = async (req) => {
      const res = await inner(req);
      if (req.name !== "parent_reporter") return res;
      return { ...res, raw: { ...(res.raw as object), focusNext: "We will keep working with the Okafor family." } };
    };
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({}, execute), sink });
    expect(r.outcome).toBe("partial");
    expect(r.parentUpdateBody).toBeNull();
    expect(statusOf(events, "parent_reporter")).toEqual(["running", "failed"]);
    expect(r.failures.parent_reporter).toMatch(/privacy check/);
    expect(r.failures.parent_reporter).not.toContain("Okafor");
  });

  it("retries once on an output that fails the code checks, then succeeds", async () => {
    const inner = createMockExecutor();
    let analystCalls = 0;
    const execute: LlmExecutor = async (req) => {
      const res = await inner(req);
      if (req.name !== "session_analyst" || ++analystCalls > 1) return res;
      const raw = res.raw as { skills: { evidence: string }[] };
      return { ...res, raw: { ...raw, skills: raw.skills.map((s) => ({ ...s, evidence: "a quote that is nowhere in the notes" })) } };
    };
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({}, execute), sink });
    expect(r.outcome).toBe("completed");
    expect(analystCalls).toBe(2);
    const done = events.find((e) => e.agent === "session_analyst" && e.status === "completed")!;
    expect(done.tokensIn).toBeGreaterThan(0);
  });

  it("fails the step (with spent tokens recorded) when the retry is also invalid", async () => {
    const inner = createMockExecutor();
    const execute: LlmExecutor = async (req) => {
      const res = await inner(req);
      return req.name === "progress_monitor" ? { ...res, raw: { status: "at_risk", reasons: ["x"], suggestedIntervention: "y", severity: null } } : res;
    };
    const { sink, events } = collectingSink();
    const r = await runPipeline(amaraInput(), { llm: llmConfig({}, execute), sink });
    expect(r.outcome).toBe("partial");
    const failed = events.find((e) => e.agent === "progress_monitor" && e.status === "failed")!;
    expect(failed.error).toMatch(/severity/);
    expect(failed.tokensIn).toBeGreaterThan(0);
    expect(failed.costUsd).toBeGreaterThan(0);
  });
});

describe("pipeline: reuse of earlier outputs (retry)", () => {
  it("re-runs only the failed steps and reuses the rest", async () => {
    const first = collectingSink();
    const done = await runPipeline(amaraInput(), { llm: llmConfig({ failAgents: new Set(["progress_monitor"]) }), sink: first.sink });
    expect(done.outcome).toBe("partial");

    const called: string[] = [];
    const inner = createMockExecutor();
    const execute: LlmExecutor = async (req) => (called.push(req.name), inner(req));
    const second = collectingSink();
    const r = await runPipeline(amaraInput(), {
      llm: llmConfig({}, execute),
      sink: second.sink,
      attempts: { progress_monitor: 2, parent_reporter: 2 },
      prior: {
        guard: { redactedNotes: done.redactedNotes!, tokenMap: done.tokenMap! },
        analysis: done.analysis!, plan: done.plan!,
      },
    });
    expect(r.outcome).toBe("completed");
    expect(called).toEqual(["progress_monitor", "parent_reporter"]);
    expect(second.events.every((e) => e.attempt === 2)).toBe(true);
    expect(r.parentUpdateBody).toContain("Hi Ngozi,");
  });
});
