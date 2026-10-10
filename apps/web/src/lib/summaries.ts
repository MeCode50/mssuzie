import { AnalysisSchema, GuardOutputSchema, IntakeSchema, MonitorSchema, PlanSchema, ReportSchema, SlotReportSchema, type AgentName } from "@mssuzie/core";
import { z } from "zod";
import { humanizeTokens } from "./display";

const STATUS_LABEL = { on_track: "On track", watch: "Watch", at_risk: "At risk" } as const;
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`}`;

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
    case "intake_agent": {
      const p = IntakeSchema.safeParse(output);
      return p.success ? `${sentence(humanizeTokens(p.data.summary))} (${Math.round(p.data.confidence * 100)}% sure)` : null;
    }
    case "scheduler_agent": {
      const p = SlotReportSchema.safeParse(output);
      if (!p.success) return null;
      return p.data.requestedSlot.available ? "The requested time looks free" : `The requested time is not available${p.data.alternatives.length ? `; found ${plural(p.data.alternatives.length, "alternative")}` : ""}`;
    }
    case "policy_check": {
      const p = PolicyOutput.safeParse(output);
      return p.success ? `${DECISION_LABEL[p.data.outcome]}: ${humanizeTokens(p.data.reason)}` : null;
    }
    case "calendar_step": {
      const p = CalendarOutput.safeParse(output);
      return p.success ? "Calendar updated with the new time" : "Calendar updated";
    }
    case "notifier_agent": {
      const rows = (Array.isArray(output) ? output : []) as { to?: string; status?: string }[];
      if (rows.length === 0) return "Messages recorded";
      const emails = rows.filter((r) => r.to !== "ops");
      const parts: string[] = [];
      if (emails.length > 0) parts.push(`${plural(emails.length, "email")} ${emails.every((r) => r.status === "dry_run") ? "recorded (dry run)" : "sent"}`);
      if (rows.some((r) => r.to === "ops")) parts.push("note left for Ops");
      return parts.join(" · ");
    }
    default:
      return null;
  }
}

const DECISION_LABEL = { auto_apply: "Moving it", propose: "Offering other times", escalate: "Needs a person" } as const;
const PolicyOutput = z.object({ outcome: z.enum(["auto_apply", "propose", "escalate"]), reason: z.string() });
const CalendarOutput = z.object({ eventId: z.string() });

const count = (v: unknown, key: string): number | null => (typeof (v as Record<string, unknown> | null)?.[key] === "number" ? ((v as Record<string, number>)[key] ?? null) : null);

/** A short line for one tool call nested under the Scheduler. Reads only counts, never names. */
export function summarizeTool(tool: string | null, output: unknown): string | null {
  switch (tool) {
    case "get_bookings": {
      const n = count(output, "count");
      return n === null ? null : plural(n, "class");
    }
    case "get_tutor_availability": {
      const o = output as { working?: boolean; windows?: unknown[] } | null;
      return o?.working === false ? "Not working that day" : `Working hours: ${plural(o?.windows?.length ?? 0, "window")}`;
    }
    case "find_free_slots": {
      const n = count(output, "count");
      return n === null ? null : plural(n, "free slot");
    }
    default:
      return null;
  }
}
