import type { LlmExecutor, LlmRawResult, LlmRequest } from "./structured.js";

export interface MockOptions {
  /** Artificial latency per call, so a UI can show agents running. */
  delayMs?: number;
  /** Agents whose calls always throw, for failure-path tests. */
  failAgents?: ReadonlySet<string>;
}

const NEGATIVE = /(struggl|frustrat|hate|refus|not done|did not do|forgot|distract|unfocus|fidget|upset|rubbish|down from|tearful|boring|worried|reluctan|considering|no improvement|does not want)/gi;
const POSITIVE = /(proud|got it|secure|(?<!no )improv|excellent|great|confident|enjoy|fluent|cracked|up from|good session|went well)/gi;

function block(input: string, label: string): string {
  const re = new RegExp(`<<<BEGIN UNTRUSTED DATA "${label}" \\w+>>>\\n([\\s\\S]*?)\\n<<<END UNTRUSTED DATA`);
  return re.exec(input)?.[1] ?? "";
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

function analyst(input: string): unknown {
  const notes = block(input, "tutor_notes");
  const context = JSON.parse(/Context \(JSON\): (.*)\n/.exec(input)?.[1] ?? "{}") as { knownSkills?: string[] };
  const neg = count(notes, NEGATIVE);
  const pos = count(notes, POSITIVE);
  const mastery = Math.min(0.9, Math.max(0.2, 0.5 + 0.08 * (pos - neg)));
  const words = notes.replace(/\s+/g, " ").trim().split(" ");
  let evidence = words.slice(0, 14).join(" ");
  while (evidence.length < 12 && words.length > evidence.split(" ").length) evidence = words.slice(0, 20).join(" ");
  const level = neg >= pos + 2 ? "low" : neg > pos ? "medium" : "high";
  const homeworkMentioned = /homework/i.test(notes);
  return {
    topics: ["session review"],
    skills: [{ skill: context.knownSkills?.[0] ?? "general progress", mastery, evidence }],
    misconceptions: neg > 1 ? [{ skill: "general progress", description: "Struggled with parts of the task." }] : [],
    engagement: { level, signals: [level === "low" ? "Low focus noted" : "Engaged in the session"] },
    confidence: { level: neg > pos ? "low" : "medium", signals: ["Based on the tutor's notes"] },
    homework: homeworkMentioned
      ? [{ task: "Homework mentioned in notes", status: /not done|did not do|forgot/i.test(notes) ? "not_done" : "unknown" }]
      : [],
  };
}

function monitor(input: string): unknown {
  const evidence = JSON.parse(block(input, "evidence")) as {
    analysis: { engagement: { level: string }; confidence: { level: string } };
  };
  const low = [evidence.analysis.engagement.level, evidence.analysis.confidence.level].filter((l) => l === "low").length;
  if (low === 2) {
    return {
      status: "at_risk",
      reasons: ["Engagement and confidence are both low in this session", "Progress is not visible yet"],
      suggestedIntervention: "Call the family this week and agree smaller, interest-led goals.",
      severity: "high",
    };
  }
  if (low === 1) {
    return { status: "watch", reasons: ["One worrying signal this session"], suggestedIntervention: "Keep sessions light and re-check next session.", severity: null };
  }
  return { status: "on_track", reasons: ["Steady engagement and progress this session"], suggestedIntervention: "Keep the current approach.", severity: null };
}

const dayString = (ref: string, offset: number): string =>
  new Date(Date.parse(`${ref}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

function planner(input: string): unknown {
  const ctx = JSON.parse(block(input, "analysis_and_context")) as {
    referenceDate: string;
    profile: { planHoursPerWeek: number };
    analysis: { skills: { skill: string }[] };
  };
  const skill = ctx.analysis.skills[0]?.skill ?? "general progress";
  const perWeek = Math.max(1, ctx.profile.planHoursPerWeek);
  const slots = [1, 3, 5, 7];
  const offsets = [...slots.slice(0, perWeek), ...slots.slice(0, perWeek).map((d) => d + 7)];
  return {
    summary: `Two weeks of ${perWeek} one-hour sessions focused on ${skill}.`,
    sessions: offsets.map((o, i) => ({
      date: dayString(ctx.referenceDate, o),
      durationMin: 60,
      focusSkill: skill,
      goal: `Complete a short check on ${skill} with at most one prompt (session ${i + 1}).`,
      reason: "Follows from the evidence in the latest session.",
    })),
  };
}

function reporter(input: string): unknown {
  const ctx = JSON.parse(block(input, "analysis_plan_status")) as {
    analysis: { skills: { skill: string }[] };
    plan: { sessions: { focusSkill: string }[] } | null;
  };
  const skills = ctx.analysis.skills.map((s) => s.skill);
  const first = skills[0] ?? "learning";
  const next = ctx.plan?.sessions[0]?.focusSkill ?? first;
  return {
    headline: "[CHILD_1] put in a good effort this week.",
    wins: [`[CHILD_1] worked on ${first} and kept trying.`],
    focusNext: `Over the next two weeks we will keep building ${next}.`,
    oneThingAtHome: "Ask [CHILD_1] to explain one thing they learned this week, in their own words.",
    skillsMentioned: [...new Set([first, next].filter((s) => skills.includes(s)))],
  };
}

const HANDLERS: Record<string, (input: string) => unknown> = {
  privacy_guard: () => ({ findings: [] }),
  session_analyst: analyst,
  progress_monitor: monitor,
  learning_planner: planner,
  parent_reporter: reporter,
};

export function createMockExecutor(options: MockOptions = {}): LlmExecutor {
  const delay = options.delayMs ?? Number(process.env.MOCK_LLM_DELAY_MS ?? 0);
  return async (req: LlmRequest): Promise<LlmRawResult> => {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (options.failAgents?.has(req.name)) throw new Error(`mock failure injected for ${req.name}`);
    const handler = HANDLERS[req.name];
    if (!handler) throw new Error(`mock executor has no handler for agent "${req.name}"`);
    const raw = handler(req.input);
    return {
      raw,
      tokensIn: Math.ceil((req.instructions.length + req.input.length) / 4),
      tokensOut: Math.ceil(JSON.stringify(raw).length / 4),
    };
  };
}
