import { describe, expect, it } from "vitest";
import {
  AGENT_IDS, failedAgents, formatClock, formatDuration, formatUsd, initialTrace, reduceTrace,
  type StepData, type TraceEvent, type TraceState,
} from "./trace";

let seq = 0;
const step = (agent: string, status: StepData["status"], over: Partial<StepData> = {}): TraceEvent => ({
  type: "step", receivedAt: 1000 + seq,
  data: { seq: ++seq, agent, status, attempt: 1, error: null, model: "m", tokensIn: 100, tokensOut: 20, durationMs: 1500, costUsd: 0.01, summary: null, ...over },
});
const run = (events: TraceEvent[], from: TraceState = initialTrace()) => events.reduce(reduceTrace, from);
const happy = (): TraceEvent[] => {
  seq = 0;
  return [
    step("privacy_guard", "running"), step("privacy_guard", "completed", { summary: "3 details replaced" }),
    step("session_analyst", "running"), step("session_analyst", "completed", { summary: "2 skills rated" }),
    step("progress_monitor", "running"), step("learning_planner", "running"),
    step("progress_monitor", "completed", { summary: "On track" }), step("learning_planner", "completed", { summary: "4 sessions" }),
    step("parent_reporter", "running"), step("parent_reporter", "completed", { summary: "Draft ready" }),
  ];
};

describe("reduceTrace", () => {
  it("starts with every agent waiting", () => {
    const s = initialTrace();
    expect(AGENT_IDS.map((id) => s.agents[id].status)).toEqual(Array(5).fill("waiting"));
    expect(s).toMatchObject({ lastSeq: 0, totalCostUsd: 0, done: false, runStatus: null });
  });

  it("walks the agents through running to done and keeps their summaries", () => {
    const s = run(happy());
    expect(AGENT_IDS.map((id) => s.agents[id].status)).toEqual(Array(5).fill("done"));
    expect(s.agents.session_analyst).toMatchObject({ summary: "2 skills rated", tokens: 120, durationMs: 1500, model: "m" });
    expect(s.lastSeq).toBe(10);
  });

  it("shows Monitor and Planner running at the same time", () => {
    const s = run(happy().slice(0, 6));
    expect(s.agents.progress_monitor.status).toBe("running");
    expect(s.agents.learning_planner.status).toBe("running");
    expect(s.agents.parent_reporter.status).toBe("waiting");
  });

  it("sums cost and tokens from finished steps only", () => {
    const s = run(happy());
    expect(s.totalCostUsd).toBeCloseTo(0.05, 6);
    expect(s.totalTokens).toBe(600);
    expect(run(happy().slice(0, 3)).totalCostUsd).toBeCloseTo(0.01, 6); // running steps cost nothing yet
  });

  it("ignores events it has already seen, so a reconnect replay cannot double-count", () => {
    const events = happy();
    const once = run(events);
    const twice = run(events, once);
    expect(twice).toEqual(once);
    expect(run([...events.slice(0, 4), ...events]).totalCostUsd).toBeCloseTo(0.05, 6);
  });

  it("ignores out-of-order older steps and unknown agents", () => {
    const s = run([...happy().slice(0, 4), { type: "step", receivedAt: 1, data: { ...(happy()[0] as { data: StepData }).data, seq: 2, status: "failed" } }]);
    expect(s.agents.privacy_guard.status).toBe("done");
    const unknown = reduceTrace(initialTrace(), step("time_machine", "running"));
    expect(unknown.lastSeq).toBe(0);
  });

  it("records a failure with its message and still adds the spent cost", () => {
    seq = 0;
    const s = run([step("privacy_guard", "completed"), step("session_analyst", "running"), step("session_analyst", "failed", { error: "The AI service is busy.", costUsd: 0.02 })]);
    expect(s.agents.session_analyst).toMatchObject({ status: "failed", error: "The AI service is busy.", summary: null });
    expect(s.totalCostUsd).toBeCloseTo(0.03, 6);
    expect(failedAgents(s)).toEqual(["session_analyst"]);
  });

  it("marks downstream steps skipped with the reason", () => {
    seq = 0;
    const s = run([step("session_analyst", "failed", { error: "boom" }), step("progress_monitor", "skipped", { error: "Skipped because the Session Analyst step failed." })]);
    expect(s.agents.progress_monitor).toMatchObject({ status: "skipped", error: "Skipped because the Session Analyst step failed." });
    expect(failedAgents(s)).toEqual(["session_analyst"]);
  });

  it("a retry resets the agent to running (attempt 2), clears the old error, and finishes done", () => {
    seq = 0;
    let s = run([step("progress_monitor", "running"), step("progress_monitor", "failed", { error: "x" })]);
    s = run([{ type: "run", data: { status: "queued", totalTokens: 0, costUsd: 0, startedAt: null, finishedAt: null } }], s);
    s = reduceTrace(s, step("progress_monitor", "running", { attempt: 2 }));
    expect(s.agents.progress_monitor).toMatchObject({ status: "running", attempt: 2, error: null });
    s = reduceTrace(s, step("progress_monitor", "completed", { attempt: 2, summary: "On track" }));
    expect(s.agents.progress_monitor).toMatchObject({ status: "done", attempt: 2, error: null, summary: "On track" });
  });

  it("run events set the status and the server clock; the final server totals win", () => {
    let s = reduceTrace(initialTrace(), { type: "run", data: { status: "running", totalTokens: 0, costUsd: 0, startedAt: "2026-10-10T10:00:00Z", finishedAt: null } });
    expect(s).toMatchObject({ runStatus: "running", startedAt: "2026-10-10T10:00:00Z", done: false });
    s = run(happy(), s);
    s = reduceTrace(s, { type: "run", data: { status: "completed", totalTokens: 640, costUsd: 0.051, startedAt: "2026-10-10T10:00:00Z", finishedAt: "2026-10-10T10:00:09Z" } });
    s = reduceTrace(s, { type: "done", data: { status: "completed" } });
    expect(s).toMatchObject({ runStatus: "completed", done: true, totalCostUsd: 0.051, totalTokens: 640, finishedAt: "2026-10-10T10:00:09Z" });
  });

  it("is not finished again while a retried run is queued", () => {
    let s = reduceTrace(run(happy()), { type: "done", data: { status: "partial" } });
    expect(s.done).toBe(true);
    s = reduceTrace(s, { type: "run", data: { status: "queued", totalTokens: 600, costUsd: 0.05, startedAt: null, finishedAt: null } });
    expect(s.done).toBe(false);
  });

  it("reset returns to the blank state", () => {
    expect(reduceTrace(run(happy()), { type: "reset" })).toEqual(initialTrace());
  });
});

describe("formatting", () => {
  it("formats cost, duration and the run clock", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatDuration(480)).toBe("480 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_900)).toBe("01:05");
    expect(formatClock(-5)).toBe("00:00");
  });
});
