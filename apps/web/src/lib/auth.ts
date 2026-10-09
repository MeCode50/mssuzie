import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import type { Env, PrismaClient } from "@mssuzie/core";

const WEEK = 60 * 60 * 24 * 7;

/**
 * Email + password only. There is no sign-up: accounts exist only because the seed script made
 * them. Roles are stored on the user and can never be set from client input.
 */
export function createAuth(prisma: PrismaClient, env: Env) {
  const origin = new URL(env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
  return betterAuth({
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    // Our Prisma model is AuthSession (the `sessions` table is tutoring sessions).
    session: { modelName: "authSession", expiresIn: WEEK, updateAge: 60 * 60 * 24 },
    user: {
      additionalFields: {
        role: { type: ["ops", "tutor"], required: false, defaultValue: "tutor", input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    // Per-IP login throttling, stored in Postgres so it holds across serverless instances.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-real-ip"] },
      useSecureCookies: origin.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
