import type { Env } from "../env.js";
import { createMockExecutor } from "./mock-executor.js";
import { createChatCompletionsExecutor } from "./chat-executor.js";
import type { LlmExecutor, LlmUsage } from "./structured.js";

export type AgentTier = "main" | "small";

export interface Price {
  inPer1M: number;
  outPer1M: number;
}

export interface LlmConfig {
  execute: LlmExecutor;
  models: Record<AgentTier, string>;
  pricing: Record<AgentTier, Price>;
  mock: boolean;
}

export function costUsd(config: LlmConfig, tier: AgentTier, usage: Pick<LlmUsage, "tokensIn" | "tokensOut">): number {
  const p = config.pricing[tier];
  const raw = (usage.tokensIn * p.inPer1M + usage.tokensOut * p.outPer1M) / 1_000_000;
  return Math.round(raw * 1e6) / 1e6;
}

/** Build the LLM config from the environment. Real mode requires every model/price/key. */
export function loadLlmConfig(env: Env): LlmConfig {
  if (env.MOCK_LLM) {
    if (env.NODE_ENV === "production") throw new Error("MOCK_LLM must never be enabled in production");
    return {
      execute: createMockExecutor(),
      models: { main: "mock-main", small: "mock-small" },
      pricing: {
        main: { inPer1M: env.LLM_PRICE_MAIN_INPUT_PER_1M ?? 0, outPer1M: env.LLM_PRICE_MAIN_OUTPUT_PER_1M ?? 0 },
        small: { inPer1M: env.LLM_PRICE_SMALL_INPUT_PER_1M ?? 0, outPer1M: env.LLM_PRICE_SMALL_OUTPUT_PER_1M ?? 0 },
      },
      mock: true,
    };
  }
  const required = {
    LLM_API_KEY: env.LLM_API_KEY,
    LLM_MODEL_MAIN: env.LLM_MODEL_MAIN,
    LLM_MODEL_SMALL: env.LLM_MODEL_SMALL,
    LLM_PRICE_MAIN_INPUT_PER_1M: env.LLM_PRICE_MAIN_INPUT_PER_1M,
    LLM_PRICE_MAIN_OUTPUT_PER_1M: env.LLM_PRICE_MAIN_OUTPUT_PER_1M,
    LLM_PRICE_SMALL_INPUT_PER_1M: env.LLM_PRICE_SMALL_INPUT_PER_1M,
    LLM_PRICE_SMALL_OUTPUT_PER_1M: env.LLM_PRICE_SMALL_OUTPUT_PER_1M,
  };
  const missing = Object.entries(required).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) throw new Error(`Missing LLM configuration: ${missing.join(", ")}`);
  return {
    execute: createChatCompletionsExecutor({
      apiKey: env.LLM_API_KEY as string,
      baseUrl: env.LLM_BASE_URL,
      reasoningEffort: env.LLM_REASONING_EFFORT,
      reasoningTokenHeadroom: env.LLM_REASONING_TOKEN_HEADROOM,
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
      maxRetryDelayMs: env.LLM_MAX_RETRY_DELAY_MS,
      maxConcurrency: env.LLM_MAX_CONCURRENCY,
      requestsPerMinute: env.LLM_REQUESTS_PER_MINUTE,
    }),
    models: { main: env.LLM_MODEL_MAIN as string, small: env.LLM_MODEL_SMALL as string },
    pricing: {
      main: { inPer1M: env.LLM_PRICE_MAIN_INPUT_PER_1M as number, outPer1M: env.LLM_PRICE_MAIN_OUTPUT_PER_1M as number },
      small: { inPer1M: env.LLM_PRICE_SMALL_INPUT_PER_1M as number, outPer1M: env.LLM_PRICE_SMALL_OUTPUT_PER_1M as number },
    },
    mock: false,
  };
}
