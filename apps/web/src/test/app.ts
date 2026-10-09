import { randomUUID } from "node:crypto";
import { createLogger, resetDemoData, seedAccounts, type Env } from "@mssuzie/core";
import { createTestDb, type TestDb } from "@mssuzie/core/testing";
import { createAuth } from "@/lib/auth";
import type { Container } from "@/lib/container";
import { setContainer } from "@/lib/container";
import { ORIGIN, req, testEnv } from "./fake-container";

export const PASSWORDS = {
  ebun: "ebun-test-password-1", ops2: "ops2-test-password-1",
  tutor1: "tutor1-test-password-1", tutor2: "tutor2-test-password-1",
} as const;
export const EMAILS = {
  ebun: "ebun@example.test", ops2: "ops2@example.test", tutor1: "tutor1@example.test", tutor2: "tutor2@example.test",
} as const;
export type Who = keyof typeof EMAILS;

export interface TestApp {
  db: TestDb;
  c: Container & { lines: Record<string, unknown>[] };
  env: Env;
  /** Sign in and return a Cookie header value. Each call can use its own client IP. */
  login(who: Who, ip?: string): Promise<string>;
  /** Build a request carrying a session cookie (and our own Origin, as a browser would send). */
  as(cookie: string | null, path: string, init?: RequestInit & { json?: unknown }): Request;
  close(): Promise<void>;
}

/** A real Postgres schema, seeded demo data, real Better Auth, wired into the web container. */
export async function startTestApp(envOver: Record<string, string> = {}): Promise<TestApp> {
  const db = await createTestDb();
  const env = testEnv(envOver);
  await seedAccounts(db.prisma, {
    SEED_EBUN_EMAIL: EMAILS.ebun, SEED_EBUN_PASSWORD: PASSWORDS.ebun,
    SEED_OPS2_NAME: "Ops Two", SEED_OPS2_EMAIL: EMAILS.ops2, SEED_OPS2_PASSWORD: PASSWORDS.ops2,
    SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: EMAILS.tutor1, SEED_TUTOR1_PASSWORD: PASSWORDS.tutor1,
    SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: EMAILS.tutor2, SEED_TUTOR2_PASSWORD: PASSWORDS.tutor2,
  });
  await resetDemoData(db.prisma, env.ENCRYPTION_KEY);

  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "web-test" }, (line) => void lines.push(JSON.parse(line)));
  const c = { env, prisma: db.prisma, logger, auth: createAuth(db.prisma, env), lines };
  setContainer(c);

  return {
    db, c, env,
    async login(who, ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
      const res = await c.auth.api.signInEmail({
        body: { email: EMAILS[who], password: PASSWORDS[who] },
        headers: new Headers({ "x-real-ip": ip }),
        asResponse: true,
      });
      if (!res.ok) throw new Error(`test login failed for ${who}: ${res.status}`);
      return res.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
    },
    as(cookie, path, init = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      if (init.method && init.method !== "GET") headers.set("origin", ORIGIN);
      return req(path, { ...init, headers });
    },
    async close() {
      setContainer(null);
      await db.drop();
    },
  };
}

export const unique = () => randomUUID().slice(0, 12);
