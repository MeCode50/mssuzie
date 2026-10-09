import { createLogger, getPrisma, loadEnv, type Env, type Logger, type PrismaClient } from "@mssuzie/core";

/** Everything a request handler needs. Built once per process; tests inject their own. */
export interface Container {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
}

let current: Container | null = null;

export function getContainer(): Container {
  if (!current) {
    // loadEnv throws (and the process refuses to serve) on a bad configuration, e.g. MOCK_LLM in production.
    const env = loadEnv();
    current = { env, prisma: getPrisma(env.DATABASE_URL), logger: createLogger({ service: "web" }) };
  }
  return current;
}

/** Test seam: replace (or clear) the container. */
export function setContainer(next: Container | null): void {
  current = next;
}
