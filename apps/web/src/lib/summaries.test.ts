import { describe, expect, it } from "vitest";
import { summarizeStep, summarizeTool } from "./summaries";

describe("rescheduling summaries", () => {
  it("pluralises tool results properly", () => {
    expect(summarizeTool("get_bookings", { count: 3 })).toBe("3 classes");
    expect(summarizeTool("get_bookings", { count: 1 })).toBe("1 class");
    expect(summarizeTool("find_free_slots", { count: 4 })).toBe("4 free slots");
    expect(summarizeTool("find_free_slots", { count: 1 })).toBe("1 free slot");
    expect(summarizeTool("get_tutor_availability", { working: false })).toBe("Not working that day");
    expect(summarizeTool("get_tutor_availability", { working: true, windows: [{}] })).toBe("Working hours: 1 window");
    expect(summarizeTool("unknown", {})).toBeNull();
    expect(summarizeTool("get_bookings", { nope: 1 })).toBeNull();
  });

  it("describes each rescheduling step in plain language, never with placeholders or raw JSON", () => {
    const intake = { intent: "reschedule", childReference: "own_child", bookingId: null, requestedDate: null, requestedTime: null, confidence: 0.92, ambiguities: [], injectionSuspected: false, summary: "[GUARDIAN_1] wants to move [CHILD_1]'s class." };
    expect(summarizeStep("intake_agent", intake)).toBe("Their parent wants to move the learner's class. (92% sure)");
    expect(summarizeStep("scheduler_agent", { requestedSlot: { available: false, reasons: [] }, alternatives: [{ startsAt: "x", reason: "y" }], note: "" })).toBe("The requested time is not available; found 1 alternative");
    expect(summarizeStep("policy_check", { outcome: "escalate", reason: "Starts in 2 hours." })).toBe("Needs a person: Starts in 2 hours.");
    expect(summarizeStep("calendar_step", { eventId: "abc" })).toBe("Calendar updated with the new time");
    expect(summarizeStep("notifier_agent", [{ to: "parent", status: "dry_run" }, { to: "tutor", status: "dry_run" }])).toBe("2 emails recorded (dry run)");
    expect(summarizeStep("notifier_agent", [{ to: "parent", status: "sent" }])).toBe("1 email sent");
    expect(summarizeStep("notifier_agent", [{ to: "ops", status: "sent" }, { to: "parent", status: "dry_run" }])).toBe("1 email recorded (dry run) · note left for Ops");
    expect(summarizeStep("notifier_agent", [{ to: "ops", status: "sent" }])).toBe("note left for Ops");
    expect(summarizeStep("intake_agent", { garbage: true })).toBeNull();
  });
});
