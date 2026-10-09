import { config as loadDotenv } from "dotenv";
import { createLogger, errorFields, getPrisma, loadEnv, loadLlmConfig } from "@mssuzie/core";
import { Worker } from "./worker";

loadDotenv({ path: "../../.env", quiet: true });

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
};

const logger = createLogger({ service: "worker" });

async function main(): Promise<void> {
  // loadEnv refuses to start if MOCK_LLM is set in production.
  const env = loadEnv();
  const llm = loadLlmConfig(env);
  const prisma = getPrisma(env.DATABASE_URL);

  const worker = new Worker({
    prisma, llm, logger, encryptionKey: env.ENCRYPTION_KEY,
    concurrency: positiveInt("WORKER_CONCURRENCY", 1),
    pollIntervalMs: positiveInt("WORKER_POLL_MS", 1000),
    shutdownGraceMs: positiveInt("WORKER_SHUTDOWN_GRACE_MS", 60_000),
  });
  worker.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown signal received", { signal });
    try {
      await worker.stop();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error("shutdown failed", errorFields(err));
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", errorFields(reason));
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", errorFields(err));
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.error("worker failed to start", errorFields(err));
  process.exit(1);
});
