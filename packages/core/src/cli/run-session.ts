import { config as loadDotenv } from "dotenv";
import { getPrisma } from "../db/client.js";
import { loadEnv } from "../env.js";
import { loadLlmConfig } from "../llm/config.js";
import { createRun, executeRun } from "../pipeline/execute-run.js";
import type { StepEvent } from "../pipeline/types.js";

loadDotenv({ path: "../../.env", quiet: true });

const usd = (n: number) => `$${n.toFixed(4)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function printEvent(e: StepEvent): void {
  if (e.status === "running") {
    console.log(`\n▶ ${e.agent}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""} ...`);
    return;
  }
  if (e.status === "skipped") {
    console.log(`\n– ${e.agent}: skipped (${e.error})`);
    return;
  }
  const meta = `${secs(e.durationMs)} · ${e.tokensIn} in / ${e.tokensOut} out tokens · ${usd(e.costUsd)} · ${e.model ?? "-"}`;
  if (e.status === "failed") {
    console.log(`✖ ${e.agent} FAILED: ${e.error}\n  ${meta}`);
    return;
  }
  console.log(`✔ ${e.agent}  ${meta}`);
  console.log(JSON.stringify(e.output, null, 2).replace(/^/gm, "  "));
}

async function listSessions(): Promise<void> {
  const prisma = getPrisma();
  const sessions = await prisma.tutoringSession.findMany({
    orderBy: { heldAt: "desc" }, take: 15, include: { learner: { select: { displayName: true } } },
  });
  console.log("Usage: pnpm run-session <sessionId>\n\nRecent sessions:");
  for (const s of sessions) console.log(`  ${s.id}  ${s.heldAt.toISOString().slice(0, 10)}  ${s.learner.displayName}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const sessionId = process.argv[2];
  if (!sessionId) return listSessions();

  const llm = loadLlmConfig(env);
  const prisma = getPrisma();
  const session = await prisma.tutoringSession.findUnique({ where: { id: sessionId }, include: { learner: true } });
  if (!session) throw new Error(`No session with id ${sessionId}. Run without arguments to list sessions.`);

  console.log(`Session ${session.id} (${session.learner.displayName}, ${session.heldAt.toISOString().slice(0, 10)})`);
  console.log(`Mode: ${llm.mock ? "MOCK LLM (canned outputs)" : `live — main=${llm.models.main}, small=${llm.models.small}`}`);

  const run = await createRun(prisma, { sessionId, idempotencyKey: `cli:${sessionId}:${Date.now()}` });
  const summary = await executeRun({ prisma, llm, encryptionKey: env.ENCRYPTION_KEY, onEvent: printEvent }, run.id);

  console.log(`\n══ Run ${summary.runId}: ${summary.outcome.toUpperCase()} · ${summary.totalTokens} tokens · ${usd(summary.costUsd)}`);
  if (summary.alertId) console.log(`   refund-risk alert: ${summary.alertId}`);
  if (summary.parentUpdateId) {
    const update = await prisma.parentUpdate.findUniqueOrThrow({ where: { id: summary.parentUpdateId } });
    console.log("\nParent update DRAFT (contains real names; terminal only, never sent automatically):\n");
    console.log(update.body.replace(/^/gm, "  "));
  }
  for (const [agent, why] of Object.entries(summary.failures)) console.log(`\n! ${agent}: ${why}`);
  process.exitCode = summary.outcome === "failed" ? 1 : 0;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPrisma().$disconnect());
