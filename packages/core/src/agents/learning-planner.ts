import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../llm/untrusted.js";
import type { LlmConfig } from "../llm/config.js";
import { PlanSchema, type Analysis, type LearningPlan } from "../schemas/index.js";
import { callAgent, MAX_TOKENS, type AgentStepResult } from "./shared/call.js";
import type { LearnerProfile } from "./session-analyst.js";

export interface PlannerEvent {
  type: "exam" | "assignment";
  subject: string;
  title: string;
  dueDate: string;
}

export interface PlannerInput {
  analysis: Analysis;
  profile: LearnerProfile;
  /** YYYY-MM-DD of the session just held; the plan covers the 14 days after it. */
  referenceDate: string;
  upcoming: PlannerEvent[];
}

const INSTRUCTIONS = `You are the Learning Planner for MsSuzie. Build a two-week plan of tutoring sessions that follows from the session analysis.
Rules:
- Dates are YYYY-MM-DD and fall within the 14 days AFTER referenceDate (day 1 is the day after).
- The total minutes in days 1-7 must not exceed planHoursPerWeek x 60, and the same for days 8-14. Using most of the weekly hours is good; exceeding them is never allowed.
- Each session has: date, durationMin (15-120, multiples of 5), focusSkill, goal (one concrete, checkable sentence), reason (one line linking the session to evidence from the analysis or an upcoming exam/assignment).
- Prioritise the weakest skills and misconceptions, and anything needed for upcoming exams or assignments (with their due dates). Prerequisites implied by a misconception are allowed as a focus skill.
- If engagement or confidence is low, include lighter confidence-building sessions.
- summary: one or two sentences on the plan's shape.
Names are tokens such as [CHILD_1]; keep them as written.
${UNTRUSTED_DATA_RULE}`;

const DAY_MS = 86_400_000;

function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** Enforced in code, not trusted to the model: dates in window, hours within the plan. */
export function checkPlan(plan: LearningPlan, referenceDate: string, planHoursPerWeek: number): string | null {
  const ref = parseDay(referenceDate);
  if (ref === null) return `Invalid reference date ${referenceDate}.`;
  const weekMinutes = [0, 0];
  for (const s of plan.sessions) {
    const day = parseDay(s.date);
    if (day === null) return `Session date "${s.date}" is not a valid YYYY-MM-DD date.`;
    const offset = Math.round((day - ref) / DAY_MS);
    if (offset < 1 || offset > 14) return `Session date ${s.date} is outside the 14 days after ${referenceDate}.`;
    weekMinutes[offset <= 7 ? 0 : 1] = (weekMinutes[offset <= 7 ? 0 : 1] ?? 0) + s.durationMin;
    if (s.focusSkill.trim().length === 0 || s.goal.trim().length === 0 || s.reason.trim().length === 0) {
      return `Session on ${s.date} has an empty focusSkill, goal or reason.`;
    }
  }
  const cap = planHoursPerWeek * 60;
  const [w1 = 0, w2 = 0] = weekMinutes;
  if (w1 > cap) return `Week 1 totals ${w1} minutes but the plan allows at most ${cap} (${planHoursPerWeek} h/week).`;
  if (w2 > cap) return `Week 2 totals ${w2} minutes but the plan allows at most ${cap} (${planHoursPerWeek} h/week).`;
  return null;
}

export function runLearningPlanner(llm: LlmConfig, input: PlannerInput): Promise<AgentStepResult<LearningPlan>> {
  return callAgent(llm, {
    name: "learning_planner",
    tier: "main",
    instructions: INSTRUCTIONS,
    maxTokens: MAX_TOKENS.planner,
    schema: PlanSchema,
    input: `Plan the next two weeks.\n\n${wrapUntrusted("analysis_and_context", JSON.stringify(input))}`,
    check: (p) => checkPlan(p, input.referenceDate, input.profile.planHoursPerWeek),
  });
}
