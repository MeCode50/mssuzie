import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../llm/untrusted.js";
import type { LlmConfig } from "../llm/config.js";
import { MonitorSchema, type Analysis, type MonitorResult } from "../schemas/index.js";
import { callAgent, MAX_TOKENS, type AgentStepResult } from "./shared/call.js";

export interface SkillTrend {
  skill: string;
  /** Oldest to newest, this session excluded. */
  history: { sessionsAgo: number; mastery: number }[];
  latestPrevious: number;
}

export interface MonitorInput {
  analysis: Analysis;
  skillTrends: SkillTrend[];
  /** Earlier statuses from past runs, newest first, and the learner's current stored status. */
  previousStatuses: string[];
  currentStatus: string;
  /** Engagement/confidence/homework signals from earlier analysed sessions, newest first. */
  earlierSignals: { engagement: string; confidence: string; homeworkNotDone: number }[];
}

const INSTRUCTIONS = `You are the Progress Monitor for MsSuzie. MsSuzie promises parents a refund if they see no improvement in grades, confidence or learning, so your job is to judge early and honestly whether a child is improving.
You receive this session's analysis, skill trends from earlier sessions (computed by code), earlier statuses and earlier session signals.
Status:
- on_track: clear improvement or steady progress toward goals, with healthy engagement.
- watch: mixed or plateaued progress, or one worrying signal.
- at_risk: sustained lack of improvement or decline across sessions together with engagement or confidence problems, so the parent is unlikely to see improvement soon.
Rules:
- Base the judgement on the evidence given. Do not rely on a single session when trends exist; if there is little history, say so and lean to "watch" only when there is a concrete concern.
- reasons: 1-5 short reasons citing concrete facts (skill names, mastery changes, signals).
- suggestedIntervention: one concrete, kind next action for the tutor or ops team.
- severity: only when status is at_risk: "high" if a refund request looks likely soon, otherwise "medium". Use null for any other status.
- Never blame the child. Names are tokens such as [CHILD_1]; keep them as written.
${UNTRUSTED_DATA_RULE}`;

export function checkMonitor(m: MonitorResult): string | null {
  if (m.status === "at_risk" && m.severity === null) return 'severity is required ("medium" or "high") when status is at_risk.';
  if (m.status !== "at_risk" && m.severity !== null) return "severity must be null unless status is at_risk.";
  if (m.reasons.some((r) => r.trim().length === 0)) return "Reasons must not be empty.";
  if (m.suggestedIntervention.trim().length === 0) return "suggestedIntervention must not be empty.";
  return null;
}

export function runProgressMonitor(llm: LlmConfig, input: MonitorInput): Promise<AgentStepResult<MonitorResult>> {
  return callAgent(llm, {
    name: "progress_monitor",
    tier: "main",
    instructions: INSTRUCTIONS,
    maxTokens: MAX_TOKENS.monitor,
    schema: MonitorSchema,
    input: `Assess this learner's progress.\n\n${wrapUntrusted("evidence", JSON.stringify(input))}`,
    check: checkMonitor,
  });
}
