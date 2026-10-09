import { z } from "zod";

// NOTE: these schemas are sent to the model as strict JSON schema. Keep them to enums, numbers
// with bounds, arrays with bounds and plain strings; text rules (lengths, quotes, dates) are
// enforced by the code checks next to each agent.

const Level = z.enum(["low", "medium", "high"]);

export const AnalysisSchema = z.object({
  topics: z.array(z.string()).min(1).max(8),
  skills: z
    .array(z.object({ skill: z.string(), mastery: z.number().min(0).max(1), evidence: z.string() }))
    .min(1)
    .max(8),
  misconceptions: z.array(z.object({ skill: z.string(), description: z.string() })).max(6),
  engagement: z.object({ level: Level, signals: z.array(z.string()).max(5) }),
  confidence: z.object({ level: Level, signals: z.array(z.string()).max(5) }),
  homework: z
    .array(z.object({ task: z.string(), status: z.enum(["set", "done", "not_done", "unknown"]) }))
    .max(6),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const LEARNER_STATUSES = ["on_track", "watch", "at_risk"] as const;

export const MonitorSchema = z.object({
  status: z.enum(LEARNER_STATUSES),
  reasons: z.array(z.string()).min(1).max(5),
  suggestedIntervention: z.string(),
  severity: z.enum(["medium", "high"]).nullable(),
});
export type MonitorResult = z.infer<typeof MonitorSchema>;

export const PlanSchema = z.object({
  summary: z.string(),
  sessions: z
    .array(
      z.object({
        date: z.string(),
        durationMin: z.number().int().min(15).max(120),
        focusSkill: z.string(),
        goal: z.string(),
        reason: z.string(),
      }),
    )
    .min(1)
    .max(14),
});
export type LearningPlan = z.infer<typeof PlanSchema>;

export const ReportSchema = z.object({
  headline: z.string(),
  wins: z.array(z.string()).min(1).max(4),
  focusNext: z.string(),
  oneThingAtHome: z.string(),
  skillsMentioned: z.array(z.string()).max(8),
});
export type ParentReport = z.infer<typeof ReportSchema>;
