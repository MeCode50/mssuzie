/** The live trace of one run: pure state, driven by server-sent events. No React, no DOM. */

export const AGENT_IDS = ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_INFO: Record<AgentId, { name: string; idle: string; working: string }> = {
  privacy_guard: { name: "Privacy Guard", idle: "Removes names and contact details first", working: "Replacing personal details with placeholders…" },
  session_analyst: { name: "Session Analyst", idle: "Turns the notes into skills, signals and homework", working: "Reading the session and rating skills…" },
  progress_monitor: { name: "Progress Monitor", idle: "Checks whether progress is on track", working: "Comparing with earlier sessions…" },
  learning_planner: { name: "Learning Planner", idle: "Builds the two-week plan", working: "Planning the next two weeks…" },
  parent_reporter: { name: "Parent Reporter", idle: "Drafts a warm update for the parents", working: "Writing the parent update…" },
};

export type AgentStatus = "waiting" | "running" | "done" | "failed" | "skipped";
export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface AgentView {
  id: AgentId;
  status: AgentStatus;
  attempt: number;
  /** Browser clock when this attempt started (for the live per-agent seconds). */
  startedAtMs: number | null;
  summary: string | null;
  error: string | null;
  durationMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  model: string | null;
}

export interface TraceState {
  agents: Record<AgentId, AgentView>;
  runStatus: RunStatus | null;
  /** Highest step sequence applied; used to dedupe replays and to resume after a reconnect. */
  lastSeq: number;
  totalCostUsd: number;
  totalTokens: number;
  /** Server clock (ISO strings) so the timer is right even when the page opens mid-run. */
  startedAt: string | null;
  finishedAt: string | null;
  done: boolean;
}

export interface StepData {
  seq: number;
  agent: string;
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

export type TraceEvent =
  | { type: "step"; data: StepData; receivedAt: number }
  | { type: "run"; data: { status: RunStatus; totalTokens: number; costUsd: number; startedAt: string | null; finishedAt: string | null } }
  | { type: "done"; data: { status: RunStatus } }
  | { type: "reset" };

const blank = (id: AgentId): AgentView => ({
  id, status: "waiting", attempt: 1, startedAtMs: null, summary: null, error: null, durationMs: null, tokens: null, costUsd: null, model: null,
});

export function initialTrace(): TraceState {
  return {
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, blank(id)])) as Record<AgentId, AgentView>,
    runStatus: null, lastSeq: 0, totalCostUsd: 0, totalTokens: 0, startedAt: null, finishedAt: null, done: false,
  };
}

const isAgent = (v: string): v is AgentId => (AGENT_IDS as readonly string[]).includes(v);

export function reduceTrace(state: TraceState, event: TraceEvent): TraceState {
  switch (event.type) {
    case "reset":
      return initialTrace();
    case "run":
      return {
        ...state, runStatus: event.data.status, startedAt: event.data.startedAt, finishedAt: event.data.finishedAt,
        totalTokens: Math.max(state.totalTokens, event.data.totalTokens),
        // the server's total is authoritative once the run is finished
        totalCostUsd: event.data.status === "completed" || event.data.status === "partial" || event.data.status === "failed"
          ? event.data.costUsd : state.totalCostUsd,
        done: state.done && event.data.status !== "queued" && event.data.status !== "running",
      };
    case "done":
      return { ...state, done: true, runStatus: event.data.status };
    case "step": {
      const s = event.data;
      // Replays after a reconnect re-send steps we already applied: ignore them.
      if (s.seq <= state.lastSeq || !isAgent(s.agent)) return state;
      const prev = state.agents[s.agent];
      let next: AgentView = prev;
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

/** The agents that need attention, in pipeline order. */
export function failedAgents(state: TraceState): AgentId[] {
  return AGENT_IDS.filter((id) => state.agents[id].status === "failed");
}

export function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** mm:ss for the run timer. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
