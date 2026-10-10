import type { Interval } from "../scheduling/availability";
import { endOf } from "../scheduling/availability";
import { formatForBoth, formatWithZone } from "../scheduling/time";
import type { PolicyDecision } from "./policy";

export interface SlotView {
  startsAt: string;
  endsAt: string;
  durationMin: number;
  /** Shown to the parent, in their zone. */
  parentLocal: string;
  /** Shown to the tutor, in theirs. */
  tutorLocal: string;
  /** Both people, one line. */
  both: string;
}

export function slotView(i: Interval, parentZone: string, tutorZone: string): SlotView {
  return {
    startsAt: i.startsAt.toISOString(), endsAt: endOf(i).toISOString(), durationMin: i.durationMin,
    parentLocal: formatWithZone(i.startsAt, parentZone), tutorLocal: formatWithZone(i.startsAt, tutorZone),
    both: formatForBoth(i.startsAt, parentZone, tutorZone),
  };
}

/** The decision as stored on the trace and on the request: UTC instants plus ready-to-show local times. */
export function serializeDecision(d: PolicyDecision, durationMin: number, parentZone: string, tutorZone: string) {
  return {
    outcome: d.outcome, code: d.code, reason: d.reason, problems: d.problems, checks: d.checks,
    requested: d.requestedStartsAt ? slotView({ startsAt: d.requestedStartsAt, durationMin }, parentZone, tutorZone) : null,
    alternatives: d.alternatives.map((a) => slotView(a, parentZone, tutorZone)),
  };
}
export type SerializedDecision = ReturnType<typeof serializeDecision>;
