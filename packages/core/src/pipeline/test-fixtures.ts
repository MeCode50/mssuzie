import type { LlmConfig } from "../llm/config";
import { createMockExecutor, type MockOptions } from "../llm/mock-executor";
import type { LlmExecutor } from "../llm/structured";
import { SEED_LEARNERS } from "../seed/index";
import type { PipelineInput, StepEvent, StepSink } from "./types";

const amara = SEED_LEARNERS.find((l) => l.displayName === "Amara Okafor")!;
const leo = SEED_LEARNERS.find((l) => l.displayName === "Leo Hartmann")!;

export const llmConfig = (opts: MockOptions = {}, execute?: LlmExecutor): LlmConfig => ({
  execute: execute ?? createMockExecutor(opts),
  models: { main: "test-main", small: "test-small" },
  pricing: { main: { inPer1M: 2, outPer1M: 8 }, small: { inPer1M: 0.5, outPer1M: 2 } },
  mock: true,
});

export function inputFor(seed: (typeof SEED_LEARNERS)[number], sessionIndex = -1): PipelineInput {
  const sessions = seed.sessions;
  const session = sessions.at(sessionIndex)!;
  const earlier = sessions.slice(0, sessions.indexOf(session));
  const bySkill = new Map<string, { heldAt: Date; mastery: number }[]>();
  earlier.forEach((s, i) =>
    s.skills.forEach((k) => {
      const list = bySkill.get(k.skill) ?? [];
      list.push({ heldAt: new Date(Date.UTC(2026, 8, 1 + i)), mastery: k.mastery });
      bySkill.set(k.skill, list);
    }),
  );
  return {
    notes: session.notes,
    known: {
      learnerName: seed.displayName,
      guardianNames: [seed.guardian.name],
      guardianEmails: [seed.guardian.email],
      guardianPhones: [seed.guardian.phone],
      tutorName: seed.tutor === "tutor1" ? "Daniel Reyes" : "Sophie Lindqvist",
      schools: [seed.school],
      cities: [seed.city],
    },
    profile: {
      age: seed.age, grade: seed.grade, subjects: seed.subjects,
      interests: seed.interests, planHoursPerWeek: seed.planHoursPerWeek,
    },
    sessionDate: new Date(Date.UTC(2026, 9, 9, 16)),
    history: [...bySkill].map(([skill, points]) => ({ skill, points })),
    previousStatuses: [],
    currentStatus: seed.status,
    earlierSignals: [],
    events: seed.events.map((e) => ({
      type: e.type, subject: e.subject, title: e.title, dueDate: new Date(Date.UTC(2026, 9, 9 + e.inDays)),
    })),
  };
}

export const amaraInput = (): PipelineInput => inputFor(amara);
export const leoInput = (): PipelineInput => inputFor(leo);

export function collectingSink(): { sink: StepSink; events: StepEvent[] } {
  const events: StepEvent[] = [];
  return { events, sink: async (e) => void events.push(e) };
}
