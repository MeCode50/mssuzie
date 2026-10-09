import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { encrypt } from "../crypto/aes-gcm.js";
import type { PrismaClient } from "../db/client.js";
import { amara, leo } from "./learners-a.js";
import { priya, tomas, zainab } from "./learners-b.js";
import type { SeedLearner } from "./types.js";

export const SEED_LEARNERS: readonly SeedLearner[] = [amara, leo, priya, tomas, zainab];
export type { SeedLearner } from "./types.js";

const DAY_MS = 86_400_000;

const email = z.string().email();
const name = z.string().min(1);
const password = z.string().min(12, "seed passwords must be at least 12 characters");

const SeedEnvSchema = z.object({
  SEED_EBUN_EMAIL: email,
  SEED_EBUN_PASSWORD: password,
  SEED_OPS2_NAME: name,
  SEED_OPS2_EMAIL: email,
  SEED_OPS2_PASSWORD: password,
  SEED_TUTOR1_NAME: name,
  SEED_TUTOR1_EMAIL: email,
  SEED_TUTOR1_PASSWORD: password,
  SEED_TUTOR2_NAME: name,
  SEED_TUTOR2_EMAIL: email,
  SEED_TUTOR2_PASSWORD: password,
});

type SeedEnv = z.infer<typeof SeedEnvSchema>;

export function parseSeedEnv(source: Record<string, string | undefined> = process.env): SeedEnv {
  const parsed = SeedEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid seed environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

interface SeedUser {
  key: "ebun" | "ops2" | "tutor1" | "tutor2";
  name: string;
  email: string;
  password: string;
  role: "ops" | "tutor";
}

function seedUsers(env: SeedEnv): SeedUser[] {
  return [
    { key: "ebun", name: "Ebun", email: env.SEED_EBUN_EMAIL, password: env.SEED_EBUN_PASSWORD, role: "ops" },
    { key: "ops2", name: env.SEED_OPS2_NAME, email: env.SEED_OPS2_EMAIL, password: env.SEED_OPS2_PASSWORD, role: "ops" },
    { key: "tutor1", name: env.SEED_TUTOR1_NAME, email: env.SEED_TUTOR1_EMAIL, password: env.SEED_TUTOR1_PASSWORD, role: "tutor" },
    { key: "tutor2", name: env.SEED_TUTOR2_NAME, email: env.SEED_TUTOR2_EMAIL, password: env.SEED_TUTOR2_PASSWORD, role: "tutor" },
  ];
}

/** Create or update the four login accounts (email + password). Idempotent. */
export async function seedAccounts(
  prisma: PrismaClient,
  env: SeedEnv = parseSeedEnv(),
): Promise<Record<SeedUser["key"], string>> {
  const ids = {} as Record<SeedUser["key"], string>;
  for (const u of seedUsers(env)) {
    const email = u.email.toLowerCase();
    const passwordHash = await hashPassword(u.password);
    const user = await prisma.user.upsert({
      where: { email },
      create: { id: randomUUID(), name: u.name, email, emailVerified: true, role: u.role },
      update: { name: u.name, role: u.role },
    });
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });
    if (existing) {
      await prisma.account.update({ where: { id: existing.id }, data: { password: passwordHash } });
    } else {
      await prisma.account.create({
        data: { id: randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash },
      });
    }
    ids[u.key] = user.id;
  }
  return ids;
}

/**
 * Wipe all domain data (learners and everything under them) and restore the fictional demo set.
 * Users and auth sessions are untouched. Used by the seed script and POST /api/demo/reset.
 */
export async function resetDemoData(prisma: PrismaClient, encryptionKey: string): Promise<void> {
  const tutors = await prisma.user.findMany({ where: { role: "tutor" }, orderBy: { createdAt: "asc" }, take: 2 });
  const [t1, t2] = tutors;
  if (!t1 || !t2) throw new Error("Seed tutor accounts are missing; run `pnpm db:seed` first");
  const tutorIds = { tutor1: t1.id, tutor2: t2.id };
  const now = Date.now();
  const at = (days: number) => new Date(now - days * DAY_MS);

  await prisma.$transaction(
    async (tx) => {
      await tx.learner.deleteMany();
      for (const l of SEED_LEARNERS) {
        const learner = await tx.learner.create({
          data: {
            displayName: l.displayName, age: l.age, grade: l.grade, subjects: l.subjects,
            interests: l.interests, planHoursPerWeek: l.planHoursPerWeek, tutorId: tutorIds[l.tutor],
            currentStatus: l.status, school: l.school, city: l.city,
            guardians: { create: { name: l.guardian.name, email: l.guardian.email, phone: l.guardian.phone } },
            events: {
              create: l.events.map((e) => ({
                type: e.type, subject: e.subject, title: e.title, dueDate: at(-e.inDays),
              })),
            },
          },
        });
        for (const s of l.sessions) {
          await tx.tutoringSession.create({
            data: {
              learnerId: learner.id, tutorId: tutorIds[l.tutor], heldAt: at(s.daysAgo),
              durationMin: s.durationMin, notesRaw: encrypt(s.notes, encryptionKey),
              skillSnapshots: {
                create: s.skills.map((k) => ({
                  learnerId: learner.id, skill: k.skill, mastery: k.mastery, evidence: k.evidence,
                })),
              },
            },
          });
        }
        if (l.parentUpdate) {
          const approved = l.parentUpdate.status === "approved";
          await tx.parentUpdate.create({
            data: {
              learnerId: learner.id, body: l.parentUpdate.body, status: l.parentUpdate.status,
              createdAt: at(l.parentUpdate.daysAgo),
              ...(approved ? { approvedBy: "seed", approvedAt: at(l.parentUpdate.daysAgo) } : {}),
            },
          });
        }
        if (l.alert) {
          await tx.alert.create({
            data: {
              learnerId: learner.id, type: "refund_risk", severity: l.alert.severity,
              reason: l.alert.reason, intervention: l.alert.intervention, createdAt: at(l.alert.daysAgo),
            },
          });
        }
      }
    },
    { timeout: 60_000 },
  );
}
