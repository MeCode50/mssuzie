import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../llm/untrusted.js";
import type { LlmConfig } from "../llm/config.js";
import { ReportSchema, type Analysis, type LearningPlan, type MonitorResult, type ParentReport } from "../schemas/index.js";
import { callAgent, fold, MAX_TOKENS, type AgentStepResult } from "./shared/call.js";

export interface ReporterInput {
  analysis: Analysis;
  /** Null when the Progress Monitor step failed; used only to set tone. */
  status: MonitorResult["status"] | null;
  /** Null when the Learning Planner step failed. */
  plan: LearningPlan | null;
  /** Skills tracked before this session but absent from this analysis: must not be mentioned. */
  forbiddenSkills: string[];
}

export const ALLOWED_TOKENS = new Set(["[CHILD_1]", "[GUARDIAN_1]"]);

const INSTRUCTIONS = `You write a DRAFT update from MsSuzie to a child's parent or guardian. MsSuzie staff review every draft before anything is sent.
Style: warm, plain English, no jargon, no raw scores out of context. Honest but encouraging: celebrate real wins; if progress is slow, say so kindly and focus on the plan. Never blame the child or the parent. Never mention refunds, risk, alerts, statuses or other internal terms.
Tokens: refer to the child only as [CHILD_1]. Never write a real name, and do not write any other bracketed token. The greeting and sign-off are added for you.
Fields:
- headline: one friendly sentence.
- wins: 1-4 specific things that went well, grounded in the analysis.
- focusNext: what we will work on over the next two weeks (from the plan; if there is no plan, from the analysis).
- oneThingAtHome: one small, easy thing the parent can do at home.
- skillsMentioned: the exact skill names from the analysis that your text mentions. Your text may mention ONLY skills present in the analysis; do not mention any skill listed in forbiddenSkills.
"status" is only a hint for tone: never state it.
${UNTRUSTED_DATA_RULE}`;

export function reportText(r: ParentReport): string {
  return [r.headline, ...r.wins, r.focusNext, r.oneThingAtHome].join("\n");
}

export function checkReport(r: ParentReport, input: Pick<ReporterInput, "analysis" | "forbiddenSkills">): string | null {
  const analysisSkills = new Set(input.analysis.skills.map((s) => fold(s.skill)));
  for (const s of r.skillsMentioned) {
    if (!analysisSkills.has(fold(s))) return `skillsMentioned contains "${s}", which is not a skill in the analysis.`;
  }
  const text = fold(reportText(r));
  for (const f of input.forbiddenSkills) {
    if (!analysisSkills.has(fold(f)) && text.includes(fold(f))) return `The text mentions "${f}", which is not part of this session's analysis.`;
  }
  const tokens = reportText(r).match(/\[[A-Z]+_\d+\]/g) ?? [];
  const bad = tokens.find((t) => !ALLOWED_TOKENS.has(t));
  if (bad) return `The text contains ${bad}; only [CHILD_1] may be used.`;
  if (/@|https?:\/\//i.test(reportText(r))) return "The text must not contain email addresses or links.";
  if ([r.headline, r.focusNext, r.oneThingAtHome].some((v) => v.trim().length === 0)) return "headline, focusNext and oneThingAtHome must not be empty.";
  return null;
}

export function runParentReporter(llm: LlmConfig, input: ReporterInput): Promise<AgentStepResult<ParentReport>> {
  return callAgent(llm, {
    name: "parent_reporter",
    tier: "main",
    instructions: INSTRUCTIONS,
    maxTokens: MAX_TOKENS.reporter,
    schema: ReportSchema,
    input: `Draft the parent update.\n\n${wrapUntrusted("analysis_plan_status", JSON.stringify(input))}`,
    check: (r) => checkReport(r, input),
  });
}
