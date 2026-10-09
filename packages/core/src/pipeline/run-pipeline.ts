import { StructuredOutputError, type LlmUsage } from "../llm/structured.js";
import { costUsd, type AgentTier } from "../llm/config.js";
import {
  createFieldRedactor, GuardError, runPrivacyGuard, createLlmPiiDetector,
  type TokenMap,
} from "../agents/privacy-guard/index.js";
import { runLearningPlanner } from "../agents/learning-planner.js";
import { runParentReporter } from "../agents/parent-reporter.js";
import { runProgressMonitor } from "../agents/progress-monitor.js";
import { runSessionAnalyst } from "../agents/session-analyst.js";
import type { Analysis, LearningPlan, MonitorResult, ParentReport } from "../schemas/index.js";
import { assembleTemplate, finalizeParentUpdate } from "./parent-update.js";
import { buildSkillTrends } from "./trends.js";
import type { AgentName, PipelineDeps, PipelineInput, PipelineResult } from "./types.js";

type StepOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

interface StepWork<T> {
  value: T;
  /** Stored as output_json (must be free of real names / contacts / token map). */
  output: unknown;
  usage: LlmUsage | null;
  tier: AgentTier;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function describeError(err: unknown): string {
  if (err instanceof GuardError || err instanceof StructuredOutputError) return err.message.slice(0, 600);
  const message = err instanceof Error ? err.message : String(err);
  return `Unexpected error: ${message}`.slice(0, 600);
}

function usageOf(err: unknown): LlmUsage | null {
  const usage = (err as { usage?: LlmUsage } | null)?.usage;
  return usage ?? null;
}

/**
 * Guard -> Analyst -> [Monitor, Planner] in parallel -> Reporter. Orchestration is plain code.
 * Never throws for step failures: every failure becomes a `failed` event and a result entry.
 */
export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const { llm, sink } = deps;
  const prior = deps.prior ?? {};
  const failures: PipelineResult["failures"] = {};

  async function step<T>(
    agent: AgentName,
    work: () => Promise<StepWork<T>>,
    failedTier: AgentTier = "main",
  ): Promise<StepOutcome<T>> {
    const attempt = deps.attempts?.[agent] ?? 1;
    const started = Date.now();
    await sink({ agent, status: "running", attempt, tokensIn: 0, tokensOut: 0, durationMs: 0, costUsd: 0 });
    try {
      const w = await work();
      await sink({
        agent, status: "completed", attempt, output: w.output, model: w.usage?.model,
        tokensIn: w.usage?.tokensIn ?? 0, tokensOut: w.usage?.tokensOut ?? 0,
        durationMs: Date.now() - started, costUsd: w.usage ? costUsd(llm, w.tier, w.usage) : 0,
      });
      return { ok: true, value: w.value };
    } catch (err) {
      const error = describeError(err);
      const usage = usageOf(err);
      failures[agent] = error;
      await sink({
        agent, status: "failed", attempt, error, model: usage?.model,
        tokensIn: usage?.tokensIn ?? 0, tokensOut: usage?.tokensOut ?? 0,
        durationMs: Date.now() - started, costUsd: usage ? costUsd(llm, failedTier, usage) : 0,
      });
      return { ok: false, error };
    }
  }

  async function skip(agent: AgentName, reason: string): Promise<void> {
    failures[agent] = reason;
    await sink({ agent, status: "skipped", attempt: deps.attempts?.[agent] ?? 1, error: reason, tokensIn: 0, tokensOut: 0, durationMs: 0, costUsd: 0 });
  }

  const empty = (outcome: PipelineResult["outcome"], extra: Partial<PipelineResult> = {}): PipelineResult => ({
    outcome, redactedNotes: null, tokenMap: null, analysis: null, monitor: null, plan: null,
    report: null, parentUpdateBody: null, failures, ...extra,
  });

  // 1. Privacy Guard
  let guard = prior.guard ?? null;
  if (!guard) {
    const g = await step("privacy_guard", async () => {
      const detector = createLlmPiiDetector(llm.execute, { model: llm.models.small });
      const r = await runPrivacyGuard({ notes: input.notes, known: input.known, detector });
      return {
        value: { redactedNotes: r.output.redactedNotes, tokenMap: r.tokenMap },
        output: r.output, usage: r.llmUsage, tier: "small" as const,
      };
    }, "small");
    if (!g.ok) {
      for (const a of ["session_analyst", "progress_monitor", "learning_planner", "parent_reporter"] as const) {
        await skip(a, "Skipped because the Privacy Guard step failed.");
      }
      return empty("failed");
    }
    guard = g.value;
    await deps.onGuard?.(guard);
  }
  const { redactedNotes, tokenMap } = guard;

  // Structured fields that accompany the notes get the same redaction before reaching a model.
  const redactField = createFieldRedactor(input.known);
  const profile = {
    ...input.profile,
    subjects: input.profile.subjects.map(redactField),
    interests: input.profile.interests.map(redactField),
  };
  const knownSkills = input.history.map((h) => h.skill);

  // 2. Session Analyst
  let analysis: Analysis | null = prior.analysis ?? null;
  if (!analysis) {
    const a = await step("session_analyst", async () => {
      const r = await runSessionAnalyst(llm, { redactedNotes, profile, knownSkills });
      return { value: r.output, output: r.output, usage: r.usage, tier: r.tier };
    });
    if (!a.ok) {
      for (const agent of ["progress_monitor", "learning_planner", "parent_reporter"] as const) {
        await skip(agent, "Skipped because the Session Analyst step failed.");
      }
      return empty("failed", { redactedNotes, tokenMap });
    }
    analysis = a.value;
  }
  const analysed: Analysis = analysis;

  // 3. Progress Monitor and Learning Planner, side by side
  const monitorStep = async (): Promise<StepOutcome<MonitorResult>> => {
    if (prior.monitor) return { ok: true, value: prior.monitor };
    return step("progress_monitor", async () => {
      const r = await runProgressMonitor(llm, {
        analysis: analysed, skillTrends: buildSkillTrends(input.history),
        previousStatuses: input.previousStatuses, currentStatus: input.currentStatus,
        earlierSignals: input.earlierSignals,
      });
      return { value: r.output, output: r.output, usage: r.usage, tier: r.tier };
    });
  };
  const plannerStep = async (): Promise<StepOutcome<LearningPlan>> => {
    if (prior.plan) return { ok: true, value: prior.plan };
    return step("learning_planner", async () => {
      const r = await runLearningPlanner(llm, {
        analysis: analysed, profile, referenceDate: isoDay(input.sessionDate),
        upcoming: input.events
          .filter((e) => e.dueDate.getTime() >= input.sessionDate.getTime())
          .map((e) => ({ type: e.type, subject: redactField(e.subject), title: redactField(e.title), dueDate: isoDay(e.dueDate) })),
      });
      return { value: r.output, output: r.output, usage: r.usage, tier: r.tier };
    });
  };
  const [monitorSettled, plannerSettled] = await Promise.allSettled([monitorStep(), plannerStep()]);
  const monitor = unwrap(monitorSettled, "progress_monitor", failures);
  const plan = unwrap(plannerSettled, "learning_planner", failures);

  // 4. Parent Reporter: runs with whatever is usable, then real names go in and the draft is checked.
  const analysisSkills = new Set(analysed.skills.map((s) => s.skill.toLowerCase()));
  const forbiddenSkills = knownSkills.filter((s) => !analysisSkills.has(s.toLowerCase()));
  let report: ParentReport | null = prior.report ?? null;
  let parentUpdateBody: string | null = null;
  const rep = await step("parent_reporter", async () => {
    let r = report;
    let usage: LlmUsage | null = null;
    if (!r) {
      const res = await runParentReporter(llm, {
        analysis: analysed, status: monitor?.status ?? null, plan, forbiddenSkills,
      });
      r = res.output;
      usage = res.usage;
    }
    const final = finalizeParentUpdate(assembleTemplate(r), tokenMap, input.known);
    if (!final.ok) throw new Error(`Draft failed the privacy check: ${final.problems.join("; ")}`);
    parentUpdateBody = final.body;
    return { value: r, output: r, usage, tier: "main" as const };
  });
  if (rep.ok) report = rep.value;

  const outcome = monitor && plan && rep.ok ? "completed" : "partial";
  return { outcome, redactedNotes, tokenMap: tokenMap as TokenMap, analysis: analysed, monitor, plan, report: rep.ok ? report : null, parentUpdateBody, failures };
}

function unwrap<T>(
  settled: PromiseSettledResult<StepOutcome<T>>,
  agent: AgentName,
  failures: PipelineResult["failures"],
): T | null {
  if (settled.status === "fulfilled") return settled.value.ok ? settled.value.value : null;
  failures[agent] = describeError(settled.reason);
  return null;
}
