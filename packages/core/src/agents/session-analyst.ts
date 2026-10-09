import { UNTRUSTED_DATA_RULE, wrapUntrusted } from "../llm/untrusted.js";
import type { LlmConfig } from "../llm/config.js";
import { AnalysisSchema, type Analysis } from "../schemas/index.js";
import { callAgent, fold, MAX_TOKENS, quoteAppearsIn, type AgentStepResult } from "./shared/call.js";

export interface LearnerProfile {
  age: number;
  grade: string;
  subjects: string[];
  interests: string[];
  planHoursPerWeek: number;
}

export interface AnalystInput {
  redactedNotes: string;
  profile: LearnerProfile;
  /** Skill names already tracked for this learner, so the same skill keeps the same name. */
  knownSkills: string[];
}

const INSTRUCTIONS = `You are the Session Analyst for MsSuzie, a 1:1 online tutoring service for children. You turn a tutor's notes from ONE session into structured progress data.
Rules:
- Use only what the notes say. Do not infer, guess or invent. If something is not in the notes, leave it out.
- Names are already replaced by tokens such as [CHILD_1]. Keep tokens exactly as written and never guess the real value.
- skills: the specific skills worked on, e.g. "adding fractions". If a skill matches one in "knownSkills", reuse that exact name.
- mastery is 0-1: 0.0-0.3 not yet understood, 0.4-0.6 developing with support, 0.7-0.85 mostly independent, 0.9-1.0 secure.
- evidence MUST be a short direct quote (max 200 characters) copied exactly from the notes that justifies the rating. Use "..." to join separate fragments of one quote.
- misconceptions: specific wrong ideas or recurring errors the notes mention.
- engagement and confidence: a level plus short observed signals taken from the notes.
- homework: tasks set or mentioned, and whether they were done.
Return only the structured output.
${UNTRUSTED_DATA_RULE}`;

/** Semantic validation: every rating must be backed by a verbatim quote from the notes. */
export function checkAnalysis(a: Analysis, notes: string): string | null {
  const seen = new Set<string>();
  for (const s of a.skills) {
    const key = fold(s.skill);
    if (key.length === 0) return "A skill name is empty.";
    if (seen.has(key)) return `Skill "${s.skill}" appears more than once; merge duplicates.`;
    seen.add(key);
    if (s.evidence.length > 300) return `Evidence for "${s.skill}" is longer than 300 characters; use a short quote.`;
    if (!quoteAppearsIn(s.evidence, notes)) {
      return `Evidence for "${s.skill}" is not a verbatim quote from the notes. Copy exact words from the notes.`;
    }
  }
  return null;
}

export function runSessionAnalyst(llm: LlmConfig, input: AnalystInput): Promise<AgentStepResult<Analysis>> {
  const payload = JSON.stringify({ learnerProfile: input.profile, knownSkills: input.knownSkills });
  return callAgent(llm, {
    name: "session_analyst",
    tier: "main",
    instructions: INSTRUCTIONS,
    maxTokens: MAX_TOKENS.analyst,
    schema: AnalysisSchema,
    input: `Context (JSON): ${payload}\n\nAnalyse this session.\n\n${wrapUntrusted("tutor_notes", input.redactedNotes)}`,
    check: (a) => checkAnalysis(a, input.redactedNotes),
  });
}
