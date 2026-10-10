import { config as loadEnv } from "dotenv";
import { createPrisma } from "../src/db/client";
import { loadEnv as loadCoreEnv } from "../src/env";
import { formatForBoth, TUTOR_ZONE } from "../src/scheduling/index";
import { resetDemoData, seedAccounts } from "../src/seed/index";

loadEnv({ path: "../../.env", quiet: true });

async function main(): Promise<void> {
  const env = loadCoreEnv();
  if (env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "yes") {
    throw new Error("Refusing to seed with NODE_ENV=production (set ALLOW_PROD_SEED=yes to override)");
  }
  const prisma = createPrisma(env.DIRECT_URL ?? env.DATABASE_URL);
  try {
    const ids = await seedAccounts(prisma);
    const scenarios = await resetDemoData(prisma, env.ENCRYPTION_KEY, { minNoticeHours: env.RESCHEDULE_MIN_NOTICE_HOURS });
    const [learners, sessions, snapshots, bookings] = await Promise.all([
      prisma.learner.count(),
      prisma.tutoringSession.count(),
      prisma.skillSnapshot.count(),
      prisma.booking.count(),
    ]);
    console.log(JSON.stringify({ users: Object.keys(ids).length, learners, sessions, snapshots, bookings }));
    const show = (d: Date, zone: string) => formatForBoth(d, zone, TUTOR_ZONE);
    console.log("\nRescheduling demo scenarios (times shown for the parent, then the tutor):");
    console.log(`  Happy path : Amara's class ${show(scenarios.happy.currentStartsAt, scenarios.happy.guardianZone)}; her tutor is free at ${show(scenarios.happy.requestedStartsAt, scenarios.happy.guardianZone)}`);
    console.log(`  Conflict   : Leo's class ${show(scenarios.conflict.currentStartsAt, scenarios.conflict.guardianZone)}; asking for ${show(scenarios.conflict.requestedStartsAt, scenarios.conflict.guardianZone)} (taken; alternatives nearby)`);
    console.log(`  Escalation : Priya's class ${show(scenarios.escalation.currentStartsAt, scenarios.escalation.guardianZone)} (under the minimum notice)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
