import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { encrypt } from "../crypto/aes-gcm";
import type { PrismaClient } from "../db/client";
import { amara, leo } from "./learners-a";
import { priya, tomas, zainab } from "./learners-b";
import { DEMO_HOURS, planDemoBookings, TUTOR_ZONE, type LearnerKey } from "../scheduling/demo-plan";
import type { SeedLearner } from "./types";

export const SEED_LEARNERS: readonly SeedLearner[] = [amara, leo, priya, tomas, zainab];
export type { SeedLearner } from "./types";

const DAY_MS = 86_400_000;

const email = z.string().email();
const name = z.string().min(1);
const password = z.string().min(8, "seed passwords must be at least 8 characters");

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
      create: { id: randomUUID(), name: u.name, email, emailVerified: true, role: u.role, ...(u.role === "tutor" ? { timezone: TUTOR_ZONE } : {}) },
      update: { name: u.name, role: u.role, ...(u.role === "tutor" ? { timezone: TUTOR_ZONE } : {}) },
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

export interface DemoScenarioInfo {
  /** Amara: a 07:00 class (her guardian's zone) and a free 19:00 the same day. */
  happy: { learnerId: string; guardianId: string; bookingId: string; currentStartsAt: Date; requestedStartsAt: Date; guardianZone: string };
  /** Leo: the requested time is taken; free slots exist nearby. */
  conflict: { learnerId: string; guardianId: string; bookingId: string; currentStartsAt: Date; requestedStartsAt: Date; guardianZone: string };
  /** Priya: a class starting in about two hours (under the minimum notice). */
  escalation: { learnerId: string; guardianId: string; bookingId: string; currentStartsAt: Date; guardianZone: string };
}

export interface ResetOptions {
  /** The moment the demo timetable is built around (defaults to now). */
  now?: Date;
  /** The reschedule notice policy the scenario days must satisfy. */
  minNoticeHours?: number;
}

/**
 * Wipe all domain data (learners and everything under them: bookings, requests, notifications)
 * and restore the fictional demo set, with a timetable generated relative to "now" so the three
 * rescheduling scenarios work on any day. Users and auth sessions are untouched.
 * Used by the seed script and POST /api/demo/reset.
 */
export async function resetDemoData(prisma: PrismaClient, encryptionKey: string, options: ResetOptions = {}): Promise<DemoScenarioInfo> {
  const tutors = await prisma.user.findMany({ where: { role: "tutor" }, orderBy: { createdAt: "asc" }, take: 2 });
  const [t1, t2] = tutors;
  if (!t1 || !t2) throw new Error("Seed tutor accounts are missing; run `pnpm db:seed` first");
  const tutorIds = { tutor1: t1.id, tutor2: t2.id };
  const now = options.now ?? new Date();
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const plan = planDemoBookings(now, options.minNoticeHours ?? 12);
  const learnerIds = {} as Record<LearnerKey, string>;
  const guardianIds = {} as Record<LearnerKey, string>;
  let scenarioIds = new Map<string, string>();

  await prisma.$transaction(
    async (tx) => {
      // Rescheduling runs belong to no learner, so clear them explicitly; everything else cascades.
      await tx.run.deleteMany({ where: { pipeline: "reschedule" } });
      await tx.learner.deleteMany();

      await tx.user.updateMany({ where: { id: { in: [t1.id, t2.id] } }, data: { timezone: TUTOR_ZONE } });
      await tx.tutorAvailability.deleteMany({ where: { tutorId: { in: [t1.id, t2.id] } } });
      await tx.tutorAvailability.createMany({
        data: (["tutor1", "tutor2"] as const).flatMap((key) =>
          DEMO_HOURS[key].map((w) => ({ tutorId: tutorIds[key], weekday: w.weekday, startTime: w.start, endTime: w.end })),
        ),
      });

      for (const l of SEED_LEARNERS) {
        const key = (l.displayName.split(" ")[0] ?? l.displayName) as LearnerKey;
        const learner = await tx.learner.create({
          data: {
            displayName: l.displayName, age: l.age, grade: l.grade, subjects: l.subjects,
            interests: l.interests, planHoursPerWeek: l.planHoursPerWeek, tutorId: tutorIds[l.tutor],
            currentStatus: l.status, school: l.school, city: l.city,
            guardians: { create: { name: l.guardian.name, email: l.guardian.email, phone: l.guardian.phone, timezone: l.guardian.timezone } },
            events: {
              create: l.events.map((e) => ({
                type: e.type, subject: e.subject, title: e.title, dueDate: at(-e.inDays),
              })),
            },
          },
          include: { guardians: true },
        });
        learnerIds[key] = learner.id;
        guardianIds[key] = learner.guardians[0]?.id ?? "";
        for (const sess of l.sessions) {
          await tx.tutoringSession.create({
            data: {
              learnerId: learner.id, tutorId: tutorIds[l.tutor], heldAt: at(sess.daysAgo),
              durationMin: sess.durationMin, notesRaw: encrypt(sess.notes, encryptionKey),
              skillSnapshots: {
                create: sess.skills.map((k) => ({
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

      // The timetable. Scenario bookings get ids we can hand back; the database's exclusion
      // constraints would reject any overlap the planner got wrong.
      const bookingIds = new Map<string, string>();
      await tx.booking.createMany({
        data: plan.bookings.map((b) => {
          const id = randomUUID();
          if (b.role !== "regular") bookingIds.set(b.role, id);
          return { id, learnerId: learnerIds[b.learner], tutorId: tutorIds[b.tutor], startsAt: b.startsAt, durationMin: b.durationMin };
        }),
      });
      scenarioIds = bookingIds;
    },
    { timeout: 60_000 },
  );

  const { happy, conflict, escalation } = plan.scenarios;
  const ids = scenarioIds;
  return {
    happy: { learnerId: learnerIds.Amara, guardianId: guardianIds.Amara, bookingId: ids.get("happy") ?? "", currentStartsAt: happy.currentStartsAt, requestedStartsAt: happy.requestedStartsAt, guardianZone: happy.zone },
    conflict: { learnerId: learnerIds.Leo, guardianId: guardianIds.Leo, bookingId: ids.get("conflict") ?? "", currentStartsAt: conflict.currentStartsAt, requestedStartsAt: conflict.requestedStartsAt, guardianZone: conflict.zone },
    escalation: { learnerId: learnerIds.Priya, guardianId: guardianIds.Priya, bookingId: ids.get("escalation") ?? "", currentStartsAt: escalation.currentStartsAt, guardianZone: escalation.zone },
  };
}
