import type { z } from "zod";
import { costUsd, type AgentTier, type LlmConfig } from "../../llm/config";
import { runStructured, type LlmUsage } from "../../llm/structured";

export interface AgentStepResult<T> {
  output: T;
  usage: LlmUsage;
  tier: AgentTier;
  costUsd: number;
}

export interface AgentCall<S extends z.ZodObject> {
  name: string;
  tier: AgentTier;
  instructions: string;
  input: string;
  maxTokens: number;
  schema: S;
  check?: (output: z.infer<S>) => string | null;
}

/** Per-agent output ceilings (tokens). */
export const MAX_TOKENS = { analyst: 1500, monitor: 900, planner: 1600, reporter: 900 } as const;

export async function callAgent<S extends z.ZodObject>(
  llm: LlmConfig,
  call: AgentCall<S>,
): Promise<AgentStepResult<z.infer<S>>> {
  const { tier, ...rest } = call;
  const { output, usage } = await runStructured(llm.execute, { ...rest, model: llm.models[tier] });
  return { output, usage, tier, costUsd: costUsd(llm, tier, usage) };
}

const normalise = (s: string): string =>
  s.normalize("NFC").toLowerCase().replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** True when `quote` (fragments joined by "..." or "…") appears verbatim, ignoring case/spacing, in `source`. */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const haystack = normalise(source);
  const fragments = quote
    .split(/…|\.{3}/)
    .map((f) => normalise(f).replace(/^["']+|["']+$/g, "").trim())
    .filter((f) => f.length >= 6);
  return fragments.length > 0 && fragments.every((f) => haystack.includes(f));
}

export const fold = (s: string): string => normalise(s);
