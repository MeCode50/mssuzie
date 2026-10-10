import { describe, expect, it } from "vitest";
import { describeTool, initialRTrace, reduceRTrace, type RStepData, type RTraceState } from "./reschedule-trace";
import { clock, examplesFor } from "./reschedule-examples";

const step = (over: Partial<RStepData> & Pick<RStepData, "seq" | "agent" | "status">): RStepData => ({
  kind: "agent", toolName: null, input: null, attempt: 1, error: null, model: null, tokensIn: 0, tokensOut: 0, durationMs: 0, costUsd: 0, summary: null, ...over,
});
const apply = (s: RTraceState, ...d: RStepData[]) => d.reduce((acc, data) => reduceRTrace(acc, { type: "step", data, receivedAt: 1000 }), s);

describe("reschedule trace reducer", () => {
  it("nests tool calls under the Scheduler between its start and finish", () => {
    const s = apply(initialRTrace(),
      step({ seq: 1, agent: "scheduler_agent", status: "running" }),
      step({ seq: 2, agent: "scheduler_agent", kind: "tool", toolName: "get_bookings", input: { from: "2026-10-12T00:00:00Z" }, status: "running" }),
      step({ seq: 3, agent: "scheduler_agent", kind: "tool", toolName: "get_bookings", status: "completed", summary: "3 classes", durationMs: 12 }),
      step({ seq: 4, agent: "scheduler_agent", kind: "tool", toolName: "find_free_slots", input: { count: 2 }, status: "running" }),
      step({ seq: 5, agent: "scheduler_agent", status: "completed", summary: "The requested time looks free", tokensIn: 100, tokensOut: 20, costUsd: 0.001 }),
    );
    const a = s.agents.scheduler_agent;
    expect(a.status).toBe("done");
    expect(a.tools.map((t) => `${t.name}:${t.status}`)).toEqual(["get_bookings:done", "find_free_slots:running"]);
    expect(a.tools[0]).toMatchObject({ summary: "3 classes", durationMs: 12, input: { from: "2026-10-12T00:00:00Z" } });
    expect(s.totalTokens).toBe(120);
  });

  it("closes the matching tool when the same tool runs twice", () => {
    const s = apply(initialRTrace(),
      step({ seq: 1, agent: "scheduler_agent", status: "running" }),
      step({ seq: 2, agent: "scheduler_agent", kind: "tool", toolName: "find_free_slots", status: "running" }),
      step({ seq: 3, agent: "scheduler_agent", kind: "tool", toolName: "find_free_slots", status: "completed", summary: "1 free slot" }),
      step({ seq: 4, agent: "scheduler_agent", kind: "tool", toolName: "find_free_slots", status: "running" }),
      step({ seq: 5, agent: "scheduler_agent", kind: "tool", toolName: "find_free_slots", status: "failed", error: "bad date" }),
    );
    expect(s.agents.scheduler_agent.tools.map((t) => `${t.status}:${t.summary}`)).toEqual(["done:1 free slot", "failed:bad date"]);
  });

  it("ignores replayed steps after a reconnect and unknown agents", () => {
    let s = apply(initialRTrace(), step({ seq: 1, agent: "intake_agent", status: "running" }), step({ seq: 2, agent: "intake_agent", status: "completed", summary: "x" }));
    const before = s;
    s = apply(s, step({ seq: 2, agent: "intake_agent", status: "failed", error: "replay" }), step({ seq: 3, agent: "session_analyst", status: "running" }));
    expect(s.agents).toEqual(before.agents);
  });

  it("a retry starts the agent over with a higher attempt and clears the tools", () => {
    const s = apply(initialRTrace(),
      step({ seq: 1, agent: "scheduler_agent", status: "running" }),
      step({ seq: 2, agent: "scheduler_agent", kind: "tool", toolName: "get_bookings", status: "running" }),
      step({ seq: 3, agent: "scheduler_agent", status: "failed", error: "timeout" }),
      step({ seq: 4, agent: "scheduler_agent", status: "running", attempt: 2 }),
    );
    expect(s.agents.scheduler_agent).toMatchObject({ status: "running", attempt: 2, tools: [] });
  });

  it("when the run is done, steps that never ran read as not needed, not as waiting", () => {
    let s = apply(initialRTrace(), step({ seq: 1, agent: "privacy_guard", status: "completed" }));
    s = reduceRTrace(s, { type: "done", data: { status: "completed" } });
    expect(s.agents.calendar_step.status).toBe("skipped");
    expect(s.agents.privacy_guard.status).toBe("done");
    expect(s.done).toBe(true);
  });

  it("takes the server's total cost when the run is finished", () => {
    let s = apply(initialRTrace(), step({ seq: 1, agent: "intake_agent", status: "completed", costUsd: 0.5 }));
    s = reduceRTrace(s, { type: "run", data: { status: "completed", totalTokens: 10, costUsd: 0.75, startedAt: null, finishedAt: null } });
    expect(s.totalCostUsd).toBe(0.75);
  });

  it("describes tool calls in plain words", () => {
    expect(describeTool("get_bookings", { from: "2026-10-12T06:00:00Z", to: "2026-10-13T06:00:00Z" })).toBe("Look up classes 2026-10-12 to 2026-10-13");
    expect(describeTool("get_tutor_availability", { date: "2026-10-12" })).toBe("Check the tutor's working hours on 2026-10-12");
    expect(describeTool("find_free_slots", { count: 4 })).toBe("Find free times (up to 4)");
    expect(describeTool("something_new", null)).toBe("something new");
  });
});

describe("example messages", () => {
  it("writes times the way a parent would", () => {
    expect([clock(7, 0), clock(12, 0), clock(19, 30), clock(0, 0), clock(12, 15)]).toEqual(["7am", "12 noon", "7:30pm", "12am", "12:15pm"]);
  });
  it("builds messages around the parent's next class, in the parent's zone", () => {
    const g = { name: "Ngozi", timezone: "Europe/London", learner: { displayName: "Amara Okafor" }, upcoming: [{ startsAt: "2026-10-12T06:00:00Z", durationMin: 60 }] };
    const ex = examplesFor(g);
    expect(ex[0]!.text).toContain("Amara's 7am class on Monday");
    expect(ex.map((e) => e.id)).toEqual(["evening", "noon", "today", "vague", "cancel", "inject"]);
    expect(ex.every((e) => !e.text.includes("Okafor"))).toBe(true); // first names only, like a real message
  });
  it("still offers something when there is no upcoming class", () => {
    expect(examplesFor({ name: "X", timezone: "UTC", learner: { displayName: "Leo Hartmann" }, upcoming: [] })).toHaveLength(1);
  });
});
