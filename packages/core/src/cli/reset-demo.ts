import { config as loadDotenv } from "dotenv";
import { getPrisma } from "../db/client";
import { loadEnv } from "../env";
import { resetDemoData } from "../seed/index";

loadDotenv({ path: "../../.env", quiet: true });

/** Put the fictional learners and this week's timetable back as they started. Same as the Reset demo button. */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma(env.DATABASE_URL);
  try {
    await resetDemoData(prisma, env.ENCRYPTION_KEY, { minNoticeHours: env.RESCHEDULE_MIN_NOTICE_HOURS });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
