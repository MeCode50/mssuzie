import { createLlmPiiDetector, GuardError, runPrivacyGuard, type KnownEntities, type TokenMap } from "../agents/privacy-guard/index";
import { costUsd, type AgentTier } from "../llm/config";
import { LlmServiceError } from "../llm/errors";
import { StructuredOutputError, type LlmUsage } from "../llm/structured";
import type { ToolEvent } from "../llm/tool-loop";
import type { AgentName, StepSink } from "../pipeline/types";
import type { Window } from "../scheduling/availability";
import { hoursBetween, parseLocal, type LocalResolution } from "../scheduling/time";
import type { LlmConfig } from "../llm/config";
import type { BookingSlot, ScheduleContext } from "./context";
import { runIntakeAgent, runSchedulerAgent, type UpcomingClass } from "./agents";
import { scanForInjection } from "./injection";
import { decideReschedule, type PolicyDecision } from "./policy";
import type { Intake, SlotReport } from "./schemas";
import { serializeDecision, type SerializedDecision } from "./serialize";
import { buildSchedulerTools } from "./tools";

export interface RescheduleBase {
  now: Date;
  minNoticeHours: number;
  guardianZone: string;
  learnerId: string;
  tutor: { id: string; firstName: string; zone: string; windows: Window[] };
  /** The learner's upcoming, non-cancelled classes (with any tutor). */
  classes: (UpcomingClass & { status: "scheduled" | "rescheduled" | "cancelled"; tutorId: string })[];
  /** The tutor's upcoming, non-cancelled classes, including other learners'. */
  tutorBookings: BookingSlot[];
}

export interface RescheduleInput {
  /** The parent's message as written (never sent to a model unredacted). */
  message: string;
  known: KnownEntities;
  base: RescheduleBase;
}

export interface ReschedulePrior {
  guard?: { redactedNotes: string; tokenMap: TokenMap };
  intake?: Intake;
  scheduler?: SlotReport;
}

export interface RescheduleDeps {
  llm: LlmConfig;
  sink: StepSink;
  prior?: ReschedulePrior;
  attempts?: Partial<Record<AgentName, number>>;
  onGuard?: (g: { redactedNotes: string; tokenMap: TokenMap }) => Promise<void>;
}

export interface ResolvedIntake {
  bookingId: string | null;
  requestedStartsAt: Date | null;
  resolution: LocalResolution | null;
}

export interface RescheduleResult {
  outcome: "completed" | "partial" | "failed";
  redactedMessage: string | null;
  tokenMap: TokenMap | null;
  intake: Intake | null;
  resolved: ResolvedIntake | null;
  scheduler: SlotReport | null;
  decision: PolicyDecision | null;
  serialized: SerializedDecision | null;
  ctx: ScheduleContext | null;
  failures: Partial<Record<AgentName, string>>;
}

function describeError(err: unknown): string {
  if (err instanceof GuardError || err instanceof StructuredOutputError || err instanceof LlmServiceError) return err.message.slice(0, 600);
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600);
}

const usageOf = (err: unknown): LlmUsage | null => ((err as { usage?: LlmUsage } | null)?.usage ?? null);

/** The tutor/learner snapshot the tools and the policy read, built around the class being moved. */
export function makeContext(base: RescheduleBase, bookingId: string | null): ScheduleContext {
  const moving = bookingId ? base.classes.find((c) => c.id === bookingId) : undefined;
  return {
    now: base.now, minNoticeHours: base.minNoticeHours, tutorFirstName: base.tutor.firstName, tutorZone: base.tutor.zone,
    guardianZone: base.guardianZone, windows: base.tutor.windows, learnerId: base.learnerId,
    movingBookingId: moving?.id ?? "", durationMin: moving?.durationMin ?? 60, tutorBookings: base.tutorBookings,
    learnerBookings: base.classes.filter((c) => c.id !== moving?.id && c.status !== "cancelled").map((c) => ({ id: c.id, learnerId: base.learnerId, startsAt: c.startsAt, durationMin: c.durationMin })),
  };
}

/**
 * Privacy Guard -> Intake -> Scheduler (tools) -> Policy. The models understand and gather facts;
 * the policy (plain code) decides. Never throws for a step failure: each becomes a `failed` event.
 */
export async function runReschedulePipeline(input: RescheduleInput, deps: RescheduleDeps): Promise<RescheduleResult> {
  const { llm, sink } = deps;
  const { base } = input;
  const prior = deps.prior ?? {};
  const failures: RescheduleResult["failures"] = {};
  const attemptOf = (a: AgentName) => deps.attempts?.[a] ?? 1;

  async function step<T>(
    agent: AgentName,
    work: (attempt: number) => Promise<{ value: T; output: unknown; usage: LlmUsage | null; tier: AgentTier | null; costUsd?: number }>,
    failedTier: AgentTier = "main",
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const attempt = attemptOf(agent);
    const started = Date.now();
    await sink({ agent, status: "running", attempt, tokensIn: 0, tokensOut: 0, durationMs: 0, costUsd: 0 });
    try {
      const w = await work(attempt);
      await sink({
        agent, status: "completed", attempt, output: w.output, model: w.usage?.model, tokensIn: w.usage?.tokensIn ?? 0,
        tokensOut: w.usage?.tokensOut ?? 0, durationMs: Date.now() - started,
        costUsd: w.costUsd ?? (w.usage && w.tier ? costUsd(llm, w.tier, w.usage) : 0),
      });
      return { ok: true, value: w.value };
    } catch (err) {
      const error = describeError(err);
      const usage = usageOf(err);
      failures[agent] = error;
      await sink({
        agent, status: "failed", attempt, error, model: usage?.model, tokensIn: usage?.tokensIn ?? 0, tokensOut: usage?.tokensOut ?? 0,
        durationMs: Date.now() - started, costUsd: usage ? costUsd(llm, failedTier, usage) : 0,
      });
      return { ok: false, error };
    }
  }
  /** `because failure` marks a step that could not run since an earlier step broke; otherwise the skip is deliberate. */
  const skip = async (agent: AgentName, reason: string, becauseFailure = true) => {
    if (becauseFailure) failures[agent] = reason;
    await sink({ agent, status: "skipped", attempt: attemptOf(agent), error: reason, tokensIn: 0, tokensOut: 0, durationMs: 0, costUsd: 0 });
  };
  const empty = (outcome: RescheduleResult["outcome"], extra: Partial<RescheduleResult> = {}): RescheduleResult => ({
    outcome, redactedMessage: null, tokenMap: null, intake: null, resolved: null, scheduler: null, decision: null, serialized: null, ctx: null, failures, ...extra,
  });

  // 1. Privacy Guard on the parent's message
  let guard = prior.guard ?? null;
  if (!guard) {
    const g = await step("privacy_guard", async () => {
      const detector = createLlmPiiDetector(llm.execute, { model: llm.models.small });
      const r = await runPrivacyGuard({ notes: input.message, known: input.known, detector });
      return { value: { redactedNotes: r.output.redactedNotes, tokenMap: r.tokenMap }, output: r.output, usage: r.llmUsage, tier: "small" as const };
    }, "small");
    if (!g.ok) {
      for (const a of ["intake_agent", "scheduler_agent", "policy_check"] as const) await skip(a, "Skipped because the Privacy Guard step failed.");
      return empty("failed");
    }
    guard = g.value;
    await deps.onGuard?.(guard);
  }
  const { redactedNotes: redactedMessage, tokenMap } = guard;

  // 2. Intake agent: what does the parent want?
  let intake: Intake | null = prior.intake ?? null;
  if (!intake) {
    const i = await step("intake_agent", async () => {
      const r = await runIntakeAgent(llm, { redactedMessage, guardianZone: base.guardianZone, now: base.now, classes: base.classes.filter((c) => c.status !== "cancelled") });
      return { value: r.output, output: r.output, usage: r.usage, tier: r.tier };
    });
    if (!i.ok) {
      for (const a of ["scheduler_agent", "policy_check"] as const) await skip(a, "Skipped because the Intake step failed.");
      return empty("failed", { redactedMessage, tokenMap });
    }
    intake = i.value;
  }
  const understood: Intake = intake;

  // Resolve what the model said against real data. The model never converts times; code does.
  const booking = understood.bookingId ? base.classes.find((c) => c.id === understood.bookingId && c.status !== "cancelled") ?? null : null;
  const parsed = understood.requestedDate && understood.requestedTime ? parseLocal(understood.requestedDate, understood.requestedTime, base.guardianZone) : null;
  const resolved: ResolvedIntake = { bookingId: booking?.id ?? null, requestedStartsAt: parsed?.utc ?? null, resolution: parsed?.resolution ?? null };
  const ctx = makeContext(base, booking?.id ?? null);
  const injection = scanForInjection(input.message);

  // 3. Scheduler agent (read-only tools), only when there is a concrete class and time to check
  let scheduler: SlotReport | null = prior.scheduler ?? null;
  const flagged = injection.suspicious || understood.injectionSuspected;
  // Plain code decides whether the model is worth calling: a class under the notice limit is escalated regardless.
  const tooSoon = !!booking && hoursBetween(base.now, booking.startsAt) < base.minNoticeHours;
  const checkable = !!booking && !!parsed && parsed.resolution === "ok" && understood.intent === "reschedule" && !flagged && !tooSoon;
  if (!scheduler && checkable) {
    const tools = buildSchedulerTools(ctx);
    const attempt = attemptOf("scheduler_agent");
    const s = await step("scheduler_agent", async () => {
      const r = await runSchedulerAgent(llm, { ctx, currentStartsAt: booking!.startsAt, requestedStartsAt: parsed!.utc }, tools, async (e: ToolEvent) => {
        await sink({
          agent: "scheduler_agent", kind: "tool", toolName: e.tool, input: e.input, status: e.status,
          attempt, output: e.status === "completed" ? e.output : undefined, error: e.error, tokensIn: 0, tokensOut: 0, durationMs: e.durationMs, costUsd: 0,
        });
      });
      return { value: r.output, output: r.output, usage: r.usage, tier: r.tier, costUsd: r.costUsd };
    }, llm.schedulerTier);
    if (s.ok) scheduler = s.value;
  } else if (!scheduler) {
    await skip("scheduler_agent", flagged
      ? "Skipped: the message needs a person to look at it, so nothing was checked automatically."
      : tooSoon ? "Skipped: the class starts too soon to be moved automatically."
      : "Skipped: there was no clear class and new time to check.", false);
  }

  // 4. Policy check: plain code, always runs once the request is understood
  const decided = await step("policy_check", async () => {
    const decision = decideReschedule({
      ctx, injectionDetected: injection.suspicious, booking: booking ? { id: booking.id, learnerId: base.learnerId, startsAt: booking.startsAt, durationMin: booking.durationMin, status: booking.status } : null,
      intake: { intent: understood.intent, childReference: understood.childReference, confidence: understood.confidence, injectionSuspected: understood.injectionSuspected },
      requested: parsed ? { startsAt: parsed.utc, resolution: parsed.resolution } : null,
      schedulerAlternatives: (scheduler?.alternatives ?? []).map((a) => new Date(a.startsAt)),
    });
    const serialized = serializeDecision(decision, ctx.durationMin, base.guardianZone, base.tutor.zone);
    return { value: { decision, serialized }, output: serialized, usage: null, tier: null };
  });
  const policy = decided.ok ? decided.value : null;

  return {
    outcome: policy && !failures.scheduler_agent ? "completed" : "partial",
    redactedMessage, tokenMap, intake: understood, resolved, scheduler, decision: policy?.decision ?? null, serialized: policy?.serialized ?? null, ctx, failures,
  };
}
