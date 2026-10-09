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
    // OpenAI-compatible Chat Completions provider (Gemini by default).
    LLM_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_MODEL_MAIN: z.string().min(1).optional(),
    LLM_MODEL_SMALL: z.string().min(1).optional(),
    LLM_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high"]).default("low"),
    // Extra completion tokens allowed for hidden reasoning (thinking models).
    LLM_REASONING_TOKEN_HEADROOM: z.coerce.number().int().nonnegative().default(2000),
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().max(6).default(3),
    LLM_MAX_RETRY_DELAY_MS: z.coerce.number().int().positive().default(20_000),
    // Process-wide caps that keep us under the provider's quota (0 = unlimited).
    LLM_MAX_CONCURRENCY: z.coerce.number().int().nonnegative().default(4),
    LLM_REQUESTS_PER_MINUTE: z.coerce.number().int().nonnegative().default(0),
    // USD per 1M tokens — configurable, never hard-coded.
    LLM_PRICE_MAIN_INPUT_PER_1M: price,
    LLM_PRICE_MAIN_OUTPUT_PER_1M: price,
    LLM_PRICE_SMALL_INPUT_PER_1M: price,
    LLM_PRICE_SMALL_OUTPUT_PER_1M: price,
    DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(5),
    RUNS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(30),
    // Per-IP cap on creating runs (per 10 minutes) and a cost estimate used to reserve budget for
    // runs that are still in flight when checking the daily spend cap.
    RUNS_PER_IP_PER_10_MIN: z.coerce.number().int().positive().default(20),
    ESTIMATED_RUN_COST_USD: z.coerce.number().nonnegative().default(0.05),
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
