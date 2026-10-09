import type { Env } from "../env.js";
import { createMockExecutor } from "./mock-executor.js";
import { createOpenAiExecutor } from "./openai-executor.js";
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
        main: { inPer1M: env.OPENAI_PRICE_MAIN_INPUT_PER_1M ?? 0, outPer1M: env.OPENAI_PRICE_MAIN_OUTPUT_PER_1M ?? 0 },
        small: { inPer1M: env.OPENAI_PRICE_SMALL_INPUT_PER_1M ?? 0, outPer1M: env.OPENAI_PRICE_SMALL_OUTPUT_PER_1M ?? 0 },
      },
      mock: true,
    };
  }
  const required = {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_MODEL_MAIN: env.OPENAI_MODEL_MAIN,
    OPENAI_MODEL_SMALL: env.OPENAI_MODEL_SMALL,
    OPENAI_PRICE_MAIN_INPUT_PER_1M: env.OPENAI_PRICE_MAIN_INPUT_PER_1M,
    OPENAI_PRICE_MAIN_OUTPUT_PER_1M: env.OPENAI_PRICE_MAIN_OUTPUT_PER_1M,
    OPENAI_PRICE_SMALL_INPUT_PER_1M: env.OPENAI_PRICE_SMALL_INPUT_PER_1M,
    OPENAI_PRICE_SMALL_OUTPUT_PER_1M: env.OPENAI_PRICE_SMALL_OUTPUT_PER_1M,
  };
  const missing = Object.entries(required).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) throw new Error(`Missing LLM configuration: ${missing.join(", ")}`);
  return {
    execute: createOpenAiExecutor(env.OPENAI_API_KEY as string),
    models: { main: env.OPENAI_MODEL_MAIN as string, small: env.OPENAI_MODEL_SMALL as string },
    pricing: {
      main: { inPer1M: env.OPENAI_PRICE_MAIN_INPUT_PER_1M as number, outPer1M: env.OPENAI_PRICE_MAIN_OUTPUT_PER_1M as number },
      small: { inPer1M: env.OPENAI_PRICE_SMALL_INPUT_PER_1M as number, outPer1M: env.OPENAI_PRICE_SMALL_OUTPUT_PER_1M as number },
    },
    mock: false,
  };
}
