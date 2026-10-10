import { config as loadDotenv } from "dotenv";
import { DateTime } from "luxon";
import { getPrisma, type PrismaClient } from "../db/client";
import { loadEnv } from "../env";
import { FakeCalendar } from "../calendar/fake";
import { loadLlmConfig } from "../llm/config";
import { createIntegrations } from "../notify/integrations";
import { executeAnyRun } from "../reschedule/execute";
import { createRescheduleRequest, RequestError } from "../reschedule/requests";
import type { SerializedDecision } from "../reschedule/serialize";
import { formatForBoth, formatWithZone } from "../scheduling/time";
import type { StepEvent } from "../pipeline/types";

loadDotenv({ path: "../../.env", quiet: true });

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number) => `$${n.toFixed(4)}`;
const clip = (v: unknown, n = 150) => {
  const text = JSON.stringify(v) ?? "";
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

function printEvent(e: StepEvent): void {
  if (e.kind === "tool") {
    if (e.status === "running") console.log(`    ↳ ${e.toolName}(${clip(e.input, 110)})`);
    else if (e.status === "completed") console.log(`      ✔ ${e.toolName} ${secs(e.durationMs)}  → ${clip(e.output, 110)}`);
    else console.log(`      ✖ ${e.toolName}: ${e.error}`);
    return;
  }
  if (e.status === "running") return void console.log(`\n▶ ${e.agent}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""} ...`);
  if (e.status === "skipped") return void console.log(`\n– ${e.agent}: ${e.error}`);
  const meta = `${secs(e.durationMs)} · ${e.tokensIn + e.tokensOut} tokens · ${usd(e.costUsd)}${e.model ? ` · ${e.model}` : ""}`;
  if (e.status === "failed") return void console.log(`✖ ${e.agent} FAILED: ${e.error}\n  ${meta}`);
  console.log(`✔ ${e.agent}  ${meta}`);
}

async function findGuardian(prisma: PrismaClient, key: string) {
  const include = { learner: { include: { tutor: true } } } as const;
  const byId = /^[0-9a-f-]{36}$/i.test(key) ? await prisma.guardian.findUnique({ where: { id: key }, include }) : null;
  if (byId) return byId;
  const byName = await prisma.guardian.findMany({ where: { learner: { displayName: { startsWith: key, mode: "insensitive" } } }, include });
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`"${key}" matches several learners; use the guardian id (run with --list).`);
  throw new Error(`No guardian found for "${key}". Run with --list to see them.`);
}

async function list(prisma: PrismaClient): Promise<void> {
  const guardians = await prisma.guardian.findMany({ include: { learner: { include: { tutor: true, bookings: { where: { status: { not: "cancelled" }, startsAt: { gte: new Date() } }, orderBy: { startsAt: "asc" }, take: 1 } } } }, orderBy: { name: "asc" } });
  console.log('Usage: pnpm reschedule "<message>" --guardian <id | learner first name>\n');
  for (const g of guardians) {
    const next = g.learner.bookings[0];
    const first = g.learner.displayName.split(" ")[0];
    console.log(`  ${g.id}  ${g.name} (${g.timezone})  parent of ${g.learner.displayName}, tutor ${g.learner.tutor.name}`);
    if (next) {
      const local = DateTime.fromJSDate(next.startsAt, { zone: g.timezone });
      console.log(`      next class: ${formatForBoth(next.startsAt, g.timezone, g.learner.tutor.timezone)}`);
      console.log(`      try: pnpm reschedule "Hi, can we move ${first}'s ${local.toFormat("h:mm a").toLowerCase().replace(" ", "")} class on ${local.toFormat("cccc")} to 7pm please?" --guardian ${first?.toLowerCase()}`);
    }
  }
}

function printDecision(d: SerializedDecision | null, parsed: Record<string, any> | null, guardianZone: string): void {
  console.log("\n" + "═".repeat(78));
  if (!d) return void console.log("No decision was reached (see the failed steps above).");
  const label = { auto_apply: "AUTO-APPLY", propose: "PROPOSE ALTERNATIVES", escalate: "ESCALATE TO OPS" }[d.outcome];
  console.log(`DECISION: ${label}   (${d.code})`);
  if (d.outcome === "auto_apply") console.log("  (This step only decides: the booking, calendar and emails are not changed yet.)");
  console.log(`Reason:   ${d.reason}`);
  const intake = parsed?.intake;
  if (intake) console.log(`Understood: ${intake.summary}  [intent ${intake.intent}, child ${intake.childReference}, confidence ${Math.round(intake.confidence * 100)}%]`);
  if (d.requested) console.log(`Requested:  ${d.requested.both}`);
  d.alternatives.forEach((a, i) => console.log(`Option ${i + 1}:   ${a.both}`));
  const c = d.checks;
  console.log(`Checks:   notice ${c.noticeHours === null ? "n/a" : `${c.noticeHours.toFixed(1)}h (min ${c.minNoticeHours}h)`} · confidence ${Math.round(c.confidence * 100)}% (need ${Math.round(c.confidenceThreshold * 100)}%) · in hours ${c.withinHours ?? "n/a"} · tutor free ${c.tutorFree ?? "n/a"} · child free ${c.learnerFree ?? "n/a"}`);
  console.log(`(Parent's time zone: ${guardianZone})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const env = loadEnv();
  const prisma = getPrisma();
  if (args.includes("--list") || args.length === 0) return list(prisma);

  const gi = args.indexOf("--guardian");
  const message = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--guardian")[0];
  const guardianKey = flag("--guardian");
  if (!message || !guardianKey || gi < 0) throw new Error('Usage: pnpm reschedule "<message>" --guardian <id | learner first name>   (or --list)');

  const guardian = await findGuardian(prisma, guardianKey);
  const llm = loadLlmConfig(env);
  // Safe by default: the real Google calendar is only touched with --live-calendar. Email always
  // goes through the allowlist (and is a dry run when EMAIL_DRY_RUN is on).
  const { describe, calendar, ...rest } = createIntegrations(env);
  const live = args.includes("--live-calendar");
  const reschedule = { ...rest, calendar: live ? calendar : new FakeCalendar() };
  console.log(`Guardian: ${guardian.name} (${guardian.timezone}) · Learner: ${guardian.learner.displayName} · Tutor: ${guardian.learner.tutor.name} (${guardian.learner.tutor.timezone})`);
  console.log(`Now:      ${formatWithZone(new Date(), guardian.timezone)}`);
  console.log(`Mode:     ${llm.mock ? "MOCK LLM (deterministic stand-ins)" : `live: main=${llm.models.main}, small=${llm.models.small}, scheduler tier=${llm.schedulerTier}`}`);
  console.log(`Actions:  calendar=${live ? describe.calendar : "in-memory (use --live-calendar for Google)"}, email=${describe.email}`);
  console.log(`Message:  "${message}"`);

  const { requestId, runId } = await createRescheduleRequest(prisma, { guardianId: guardian.id, message, encryptionKey: env.ENCRYPTION_KEY });
  const summary = await executeAnyRun({ prisma, llm, encryptionKey: env.ENCRYPTION_KEY, minNoticeHours: env.RESCHEDULE_MIN_NOTICE_HOURS, onEvent: printEvent, ...reschedule }, runId);
  const request = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
  const parsed = request.parsedJson as { policy: SerializedDecision | null; intake: unknown } | null;
  printDecision(parsed?.policy ?? null, parsed as Record<string, any> | null, guardian.timezone);
  if (request.decision) console.log(`Recorded:   request ${request.decision}${request.decidedBy ? ` by ${request.decidedBy}` : ""}`);
  console.log(`\nRun ${runId}: ${summary.outcome.toUpperCase()} · ${summary.totalTokens} tokens · ${usd(summary.costUsd)}   Request ${requestId}`);
  for (const [agent, why] of Object.entries(summary.failures)) console.log(`! ${agent}: ${why}`);
  process.exitCode = summary.outcome === "failed" ? 1 : 0;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof RequestError || err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
