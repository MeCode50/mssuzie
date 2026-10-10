import type { AgentName } from "../generated/prisma/enums";
import type { KnownEntities, TokenMap } from "../agents/privacy-guard/index";
import type { LearnerProfile } from "../agents/session-analyst";
import type { MonitorResult, Analysis, LearningPlan, ParentReport } from "../schemas/index";
import type { LlmConfig } from "../llm/config";

export type { AgentName };
export const AGENT_ORDER: readonly AgentName[] = [
  "privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter",
];

export type StepEventStatus = "running" | "completed" | "failed" | "skipped";

/** One append-only event per step transition; becomes a run_steps row. */
export interface StepEvent {
  agent: AgentName;
  /** "tool" rows are tool calls nested under the agent on the live trace. */
  kind?: "agent" | "tool";
  toolName?: string;
  /** The validated arguments a tool was called with. */
  input?: unknown;
  status: StepEventStatus;
  attempt: number;
  /** Stored as output_json. Never contains real names, contacts or the token map. */
  output?: unknown;
  error?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  costUsd: number;
}

export type StepSink = (event: StepEvent) => Promise<void>;

export interface SkillPoint {
  heldAt: Date;
  mastery: number;
}

export interface PipelineInput {
  notes: string;
  known: KnownEntities;
  profile: LearnerProfile;
  sessionDate: Date;
  /** Earlier skill snapshots (this session excluded), grouped by skill, oldest first. */
  history: { skill: string; points: SkillPoint[] }[];
  previousStatuses: string[];
  currentStatus: string;
  earlierSignals: { engagement: string; confidence: string; homeworkNotDone: number }[];
  events: { type: "exam" | "assignment"; subject: string; title: string; dueDate: Date }[];
}

/** Successful outputs from an earlier attempt of the same run; those steps are not re-run. */
export interface PriorOutputs {
  guard?: { redactedNotes: string; tokenMap: TokenMap };
  analysis?: Analysis;
  monitor?: MonitorResult;
  plan?: LearningPlan;
  report?: ParentReport;
}

export interface PipelineDeps {
  llm: LlmConfig;
  sink: StepSink;
  prior?: PriorOutputs;
  /** Attempt number to stamp per agent (1 for a first run). */
  attempts?: Partial<Record<AgentName, number>>;
  /** Called as soon as the Guard succeeds, so the token map is persisted before later steps run. */
  onGuard?: (g: { redactedNotes: string; tokenMap: TokenMap }) => Promise<void>;
}

export type RunOutcome = "completed" | "partial" | "failed";

export interface PipelineResult {
  outcome: RunOutcome;
  redactedNotes: string | null;
  tokenMap: TokenMap | null;
  analysis: Analysis | null;
  monitor: MonitorResult | null;
  plan: LearningPlan | null;
  report: ParentReport | null;
  /** The only artifact containing real names. Null unless the Reporter and privacy check passed. */
  parentUpdateBody: string | null;
  failures: Partial<Record<AgentName, string>>;
}
