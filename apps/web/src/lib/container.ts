import { createIntegrations, createLogger, getPrisma, loadEnv, type Env, type Integrations, type Logger, type PrismaClient } from "@mssuzie/core";
import { createAuth, type Auth } from "./auth";

/** Everything a request handler needs. Built once per process; tests inject their own. */
export interface Container {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
  auth: Auth;
  /** Calendar and mailer: the real ones from the environment, or in-memory fakes under MOCK_LLM. */
  integrations: Pick<Integrations, "calendar" | "mailer" | "linkSecret" | "baseUrl">;
}

let current: Container | null = null;

export function getContainer(): Container {
  if (!current) {
    // loadEnv throws (and the process refuses to serve) on a bad configuration, e.g. MOCK_LLM in production.
    const env = loadEnv();
    if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) {
      throw new Error("BETTER_AUTH_SECRET (32+ chars) and BETTER_AUTH_URL must be set for the web app");
    }
    const prisma = getPrisma(env.DATABASE_URL);
    const { describe: _describe, ...integrations } = createIntegrations(env);
    current = { env, prisma, logger: createLogger({ service: "web" }), auth: createAuth(prisma, env), integrations };
  }
  return current;
}

/** Test seam: replace (or clear) the container. */
export function setContainer(next: Container | null): void {
  current = next;
}
