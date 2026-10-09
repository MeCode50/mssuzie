import type { SkillTrend } from "../agents/progress-monitor";
import type { SkillPoint } from "./types";

/** Deterministic trend facts for the Monitor: oldest to newest, "sessionsAgo" relative to now. */
export function buildSkillTrends(history: { skill: string; points: SkillPoint[] }[]): SkillTrend[] {
  return history
    .filter((h) => h.points.length > 0)
    .map((h) => {
      const sorted = [...h.points].sort((a, b) => a.heldAt.getTime() - b.heldAt.getTime());
      const last = sorted.length;
      return {
        skill: h.skill,
        history: sorted.map((p, i) => ({ sessionsAgo: last - i, mastery: round(p.mastery) })),
        latestPrevious: round(sorted[last - 1]?.mastery ?? 0),
      };
    });
}

const round = (n: number): number => Math.round(n * 100) / 100;
