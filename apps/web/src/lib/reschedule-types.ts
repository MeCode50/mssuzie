import type { listGuardians, listRequests, requestDetail } from "./reschedules";
import type { listBookings } from "./schedule";

/** What the browser receives: the server's types with dates as ISO strings. */
export type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

export type RequestDetail = Json<Awaited<ReturnType<typeof requestDetail>>>;
export type RequestSummary = Json<Awaited<ReturnType<typeof listRequests>>["requests"][number]>;
export type RequestCounts = Awaited<ReturnType<typeof listRequests>>["counts"];
export type GuardianOption = Json<Awaited<ReturnType<typeof listGuardians>>[number]>;
export type BookingView = Json<Awaited<ReturnType<typeof listBookings>>[number]>;

export type Decision = "auto_applied" | "proposed" | "escalated" | "confirmed" | "rejected" | null;

export const DECISION_INFO: Record<NonNullable<Decision> | "working", { label: string; tone: "ok" | "warn" | "bad" | "idle"; blurb: string }> = {
  auto_applied: { label: "Moved automatically", tone: "ok", blurb: "Every check passed, so the class was moved and both people were told." },
  confirmed: { label: "Moved (time chosen)", tone: "ok", blurb: "A time was chosen and the class has been moved." },
  proposed: { label: "Waiting for the parent", tone: "warn", blurb: "The time asked for isn't free, so the parent was sent other times to choose from." },
  escalated: { label: "Needs a person", tone: "bad", blurb: "This one can't be handled automatically. Someone from Ops needs to decide." },
  rejected: { label: "Declined", tone: "idle", blurb: "Ops declined the change and told the parent. The class stays as it was." },
  working: { label: "Working on it", tone: "idle", blurb: "The agents are looking at this now." },
};

export const TONE_CLASS = {
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  idle: "bg-idle-bg text-idle",
} as const;

export const KIND_LABEL: Record<string, string> = {
  applied: "Class moved",
  confirmed: "Class moved",
  proposal: "Options to choose from",
  escalation: "We're looking into it",
  rejected: "Request declined",
};
export const ROLE_LABEL: Record<string, string> = { parent: "Parent", tutor: "Tutor", ops: "Ops (in app)" };
