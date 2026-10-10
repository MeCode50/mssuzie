/** The live trace of one rescheduling run: pure state driven by server-sent events. No React, no DOM. */

export const RAGENT_IDS = ["privacy_guard", "intake_agent", "scheduler_agent", "policy_check", "calendar_step", "notifier_agent"] as const;
export type RAgentId = (typeof RAGENT_IDS)[number];

export const RAGENT_INFO: Record<RAgentId, { name: string; idle: string; working: string }> = {
  privacy_guard: { name: "Privacy Guard", idle: "Removes names and contact details first", working: "Replacing personal details with placeholders…" },
  intake_agent: { name: "Intake", idle: "Works out what the parent is asking for", working: "Reading the message…" },
  scheduler_agent: { name: "Scheduler", idle: "Checks the tutor's calendar and finds free times", working: "Checking the calendar…" },
  policy_check: { name: "Policy check", idle: "Applies the rules. Plain code, no AI", working: "Checking the rules…" },
  calendar_step: { name: "Calendar", idle: "Puts the new time on the calendar", working: "Updating the calendar…" },
  notifier_agent: { name: "Notifier", idle: "Emails the parent and the tutor", working: "Sending messages…" },
};

export type RStatus = "waiting" | "running" | "done" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface ToolCall {
  seq: number;
  name: string;
  input: unknown;
  status: "running" | "done" | "failed";
  summary: string | null;
  durationMs: number | null;
}

export interface RAgentView {
  id: RAgentId;
  status: RStatus;
  attempt: number;
  startedAtMs: number | null;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  model: string | null;
  tools: ToolCall[];
}

export interface RTraceState {
  agents: Record<RAgentId, RAgentView>;
  runStatus: RunStatus | null;
  lastSeq: number;
  totalCostUsd: number;
  totalTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
  done: boolean;
}

export interface RStepData {
  seq: number;
  agent: string;
  kind?: "agent" | "tool";
  toolName?: string | null;
  input?: unknown;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  attempt: number;
  error: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  costUsd: number;
  summary: string | null;
}

export type RTraceEvent =
  | { type: "step"; data: RStepData; receivedAt: number }
  | { type: "run"; data: { status: RunStatus; totalTokens: number; costUsd: number; startedAt: string | null; finishedAt: string | null } }
  | { type: "done"; data: { status: RunStatus } }
  | { type: "reset" };

const blank = (id: RAgentId): RAgentView => ({
  id, status: "waiting", attempt: 1, startedAtMs: null, summary: null, error: null, durationMs: null, tokens: null, costUsd: null, model: null, tools: [],
});

export function initialRTrace(): RTraceState {
  return {
    agents: Object.fromEntries(RAGENT_IDS.map((id) => [id, blank(id)])) as Record<RAgentId, RAgentView>,
    runStatus: null, lastSeq: 0, totalCostUsd: 0, totalTokens: 0, startedAt: null, finishedAt: null, done: false,
  };
}

const isAgent = (v: string): v is RAgentId => (RAGENT_IDS as readonly string[]).includes(v);
const TERMINAL = new Set<RunStatus>(["completed", "partial", "failed"]);

export function reduceRTrace(state: RTraceState, event: RTraceEvent): RTraceState {
  switch (event.type) {
    case "reset":
      return initialRTrace();
    case "run":
      return {
        ...state, runStatus: event.data.status, startedAt: event.data.startedAt, finishedAt: event.data.finishedAt,
        totalTokens: Math.max(state.totalTokens, event.data.totalTokens),
        totalCostUsd: TERMINAL.has(event.data.status) ? event.data.costUsd : state.totalCostUsd,
        done: state.done && TERMINAL.has(event.data.status),
      };
    case "done": {
      // Steps that never ran (e.g. no calendar change for an escalation) are shown as "not needed".
      const agents = { ...state.agents };
      for (const id of RAGENT_IDS) if (agents[id].status === "waiting") agents[id] = { ...agents[id], status: "skipped", error: null };
      return { ...state, agents, done: true, runStatus: event.data.status };
    }
    case "step": {
      const s = event.data;
      if (s.seq <= state.lastSeq || !isAgent(s.agent)) return state;
      const prev = state.agents[s.agent];

      if (s.kind === "tool") {
        // Tool calls are nested under their agent; a "running" row opens one, the next row for that tool closes it.
        let tools = prev.tools;
        if (s.status === "running") {
          tools = [...tools, { seq: s.seq, name: s.toolName ?? "tool", input: s.input ?? null, status: "running", summary: null, durationMs: null }];
        } else {
          const at = [...tools].reverse().findIndex((t) => t.status === "running" && t.name === s.toolName);
          const idx = at === -1 ? -1 : tools.length - 1 - at;
          const closed: ToolCall = {
            seq: s.seq, name: s.toolName ?? "tool", input: s.input ?? (idx >= 0 ? tools[idx]!.input : null),
            status: s.status === "completed" ? "done" : "failed", summary: s.summary ?? s.error, durationMs: s.durationMs,
          };
          tools = idx >= 0 ? tools.map((t, i) => (i === idx ? closed : t)) : [...tools, closed];
        }
        return { ...state, lastSeq: s.seq, agents: { ...state.agents, [s.agent]: { ...prev, tools } } };
      }

      let next: RAgentView = prev;
      let cost = state.totalCostUsd;
      let tokens = state.totalTokens;
      if (s.status === "running") {
        next = { ...blank(s.agent), status: "running", attempt: s.attempt, startedAtMs: event.receivedAt };
      } else if (s.status === "completed") {
        next = { ...prev, status: "done", attempt: s.attempt, summary: s.summary, error: null, durationMs: s.durationMs, tokens: s.tokensIn + s.tokensOut, costUsd: s.costUsd, model: s.model };
        cost += s.costUsd;
        tokens += s.tokensIn + s.tokensOut;
      } else if (s.status === "failed") {
        next = { ...prev, status: "failed", attempt: s.attempt, summary: null, error: s.error ?? "This step didn't finish.", durationMs: s.durationMs, tokens: s.tokensIn + s.tokensOut, costUsd: s.costUsd, model: s.model };
        cost += s.costUsd;
        tokens += s.tokensIn + s.tokensOut;
      } else if (s.status === "skipped") {
        next = { ...blank(s.agent), status: "skipped", attempt: s.attempt, error: s.error };
      }
      return { ...state, lastSeq: s.seq, agents: { ...state.agents, [s.agent]: next }, totalCostUsd: cost, totalTokens: tokens, done: false };
    }
  }
}

export const failedRAgents = (state: RTraceState): RAgentId[] => RAGENT_IDS.filter((id) => state.agents[id].status === "failed");

/** "get_bookings" + its arguments, as one plain line. Arguments are dates and counts only. */
export function describeTool(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : null);
  switch (name) {
    case "get_bookings":
      return `Look up classes${day(o.from) ? ` ${day(o.from)}${day(o.to) && day(o.to) !== day(o.from) ? ` to ${day(o.to)}` : ""}` : ""}`;
    case "get_tutor_availability":
      return `Check the tutor's working hours${day(o.date) ? ` on ${day(o.date)}` : ""}`;
    case "find_free_slots":
      return `Find free times${typeof o.count === "number" ? ` (up to ${o.count})` : ""}`;
    default:
      return name.replace(/_/g, " ");
  }
}
