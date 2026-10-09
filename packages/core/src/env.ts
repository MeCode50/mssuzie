import { z } from "zod";

const flag = z
  .enum(["0", "1", "true", "false", ""])
  .optional()
  .transform((v) => v === "1" || v === "true");

const price = z.coerce.number().nonnegative().optional();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),
    // 32 random bytes, base64 (openssl rand -base64 32)
    ENCRYPTION_KEY: z.string().refine(
      (v) => Buffer.from(v, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)",
    ),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_MODEL_MAIN: z.string().min(1).optional(),
    OPENAI_MODEL_SMALL: z.string().min(1).optional(),
    // USD per 1M tokens — configurable, never hard-coded.
    OPENAI_PRICE_MAIN_INPUT_PER_1M: price,
    OPENAI_PRICE_MAIN_OUTPUT_PER_1M: price,
    OPENAI_PRICE_SMALL_INPUT_PER_1M: price,
    OPENAI_PRICE_SMALL_OUTPUT_PER_1M: price,
    DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(5),
    RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(30),
    MOCK_LLM: flag,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.MOCK_LLM) {
      ctx.addIssue({
        code: "custom",
        path: ["MOCK_LLM"],
        message: "MOCK_LLM must never be enabled when NODE_ENV=production",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Parse and validate the environment. Throws (and so refuses to start) on any problem. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // dotenv yields "" for blank entries in .env; treat those as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
