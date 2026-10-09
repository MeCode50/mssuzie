import { randomBytes } from "node:crypto";
import { createLogger, loadEnv, type Env, type PrismaClient } from "@mssuzie/core";
import { createAuth } from "@/lib/auth";
import type { Container } from "@/lib/container";

export const ORIGIN = "http://localhost:3000";

export function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://u:p@localhost:5432/x",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    MOCK_LLM: "1",
    ...over,
  });
}

/** A container with a captured log and a stubbed prisma, for tests that need no database. */
export function fakeContainer(prisma: unknown = {}, env: Env = testEnv()): Container & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "web-test" }, (line) => void lines.push(JSON.parse(line)));
  const p = prisma as PrismaClient;
  return { env, prisma: p, logger, auth: createAuth(p, env), lines };
}

export const req = (path: string, init: RequestInit & { json?: unknown } = {}): Request => {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) {
    headers.set("content-type", "application/json");
    return new Request(`${ORIGIN}${path}`, { ...rest, headers, body: JSON.stringify(json) });
  }
  return new Request(`${ORIGIN}${path}`, { ...rest, headers });
};
