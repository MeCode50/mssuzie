import { AnalysisSchema, GuardOutputSchema, MonitorSchema, PlanSchema, ReportSchema, type AgentName } from "@mssuzie/core";

const STATUS_LABEL = { on_track: "On track", watch: "Watch", at_risk: "At risk" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One plain-language line for an agent card. Never includes tokens or personal details. */
export function summarizeStep(agent: AgentName, output: unknown): string | null {
  switch (agent) {
    case "privacy_guard": {
      const p = GuardOutputSchema.safeParse(output);
      if (!p.success) return null;
      const n = p.data.redactionLog.reduce((sum, e) => sum + e.occurrences, 0);
      return n === 0 ? "No personal details found to remove" : `${plural(n, "personal detail")} replaced with placeholders`;
    }
    case "session_analyst": {
      const p = AnalysisSchema.safeParse(output);
      return p.success ? `${plural(p.data.skills.length, "skill")} rated · engagement ${p.data.engagement.level}` : null;
    }
    case "progress_monitor": {
      const p = MonitorSchema.safeParse(output);
      return p.success ? `${STATUS_LABEL[p.data.status]}: ${p.data.reasons[0] ?? ""}`.trim() : null;
    }
    case "learning_planner": {
      const p = PlanSchema.safeParse(output);
      return p.success ? `${plural(p.data.sessions.length, "session")} planned over the next 2 weeks` : null;
    }
    case "parent_reporter": {
      const p = ReportSchema.safeParse(output);
      return p.success ? `Draft ready: ${plural(p.data.wins.length, "win")} and one thing to try at home` : null;
    }
    default:
      return null; // rescheduling agents get their summaries with the rescheduling screens
  }
}
