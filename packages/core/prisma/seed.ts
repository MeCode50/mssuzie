import { config as loadEnv } from "dotenv";
import { createPrisma } from "../src/db/client.js";
import { loadEnv as loadCoreEnv } from "../src/env.js";
import { resetDemoData, seedAccounts } from "../src/seed/index.js";

loadEnv({ path: "../../.env", quiet: true });

async function main(): Promise<void> {
  const env = loadCoreEnv();
  if (env.NODE_ENV === "production" && process.env.ALLOW_PROD_SEED !== "yes") {
    throw new Error("Refusing to seed with NODE_ENV=production (set ALLOW_PROD_SEED=yes to override)");
  }
  const prisma = createPrisma(env.DIRECT_URL ?? env.DATABASE_URL);
  try {
    const ids = await seedAccounts(prisma);
    await resetDemoData(prisma, env.ENCRYPTION_KEY);
    const [learners, sessions, snapshots] = await Promise.all([
      prisma.learner.count(),
      prisma.tutoringSession.count(),
      prisma.skillSnapshot.count(),
    ]);
    console.log(JSON.stringify({ users: Object.keys(ids).length, learners, sessions, snapshots }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
