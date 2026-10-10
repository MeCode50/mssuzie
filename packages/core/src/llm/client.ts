import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { z } from "zod";
import { findServiceError, kindForStatus, LlmServiceError } from "./errors";
import { Throttle } from "./throttle";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ChatExecutorOptions {
  apiKey: string;
  /** Any OpenAI-compatible Chat Completions endpoint (here: Gemini's /v1beta/openai/). */
  baseUrl: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Thinking models count hidden reasoning tokens against the completion limit, so the per-agent
   * output ceiling is raised by this much to keep the visible JSON from being cut off.
   */
  reasoningTokenHeadroom: number;
  /** Per-attempt HTTP timeout. A hung request is cut and retried instead of waiting minutes. */
  requestTimeoutMs: number;
  /** Retries on timeout, network errors, 5xx and retryable 429s. */
  maxRetries: number;
  /** Longest wait we accept before a retry (backoff cap and provider "retry in Ns" cap). */
  maxRetryDelayMs?: number;
  /** First backoff step; doubles each retry, with jitter. */
  retryBaseDelayMs?: number;
  /** Max LLM calls in flight at once across the process (0 = unlimited). */
  maxConcurrency?: number;
  /** Max HTTP requests per minute across the process (0 = unlimited). */
  requestsPerMinute?: number;
}

export interface Ledger {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** JSON schema for the model's structured output (strict: closed objects, every key required). */
export function wireSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return rest;
}

/**
 * Hidden reasoning tokens appear only in total_tokens, so everything beyond the prompt is billed
 * as output: out = total - in (never less than the reported completion tokens).
 */
export function billed(l: Ledger): { tokensIn: number; tokensOut: number } {
  return {
    tokensIn: l.promptTokens,
    tokensOut: Math.max(l.totalTokens - l.promptTokens, l.completionTokens),
  };
}


export interface LlmClientHandle {
  client: OpenAI;
  throttle: Throttle;
  ledgers: AsyncLocalStorage<Ledger>;
  options: ChatExecutorOptions;
}

/**
 * The OpenAI-compatible client every LLM call goes through: our retry policy, per-attempt timeout,
 * process-wide throttle, and a per-call usage ledger fed by every successful response.
 */
export function createLlmClient(options: ChatExecutorOptions): LlmClientHandle {
  const ledgers = new AsyncLocalStorage<Ledger>();
  const throttle = new Throttle({
    maxConcurrent: options.maxConcurrency ?? 0,
    perWindow: options.requestsPerMinute ?? 0,
  });
  const maxDelay = options.maxRetryDelayMs ?? 20_000;
  const baseDelay = options.retryBaseDelayMs ?? 1000;

  /**
   * One HTTP request with OUR retry policy (the SDK's client retries are off): per-attempt
   * timeout, backoff on 5xx/timeouts, wait-and-retry on a 429 only when the provider says how
   * long (or it is a plain rate limit), fail fast on quota exhaustion and client errors.
   * Usage from every successful response goes into the calling run's ledger.
   */
  const resilientFetch: typeof fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      await throttle.waitForRate();
      let response: Response | undefined;
      let timedOut = false;
      try {
        const timeout = AbortSignal.timeout(options.requestTimeoutMs);
        response = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        timedOut = err instanceof Error && err.name === "TimeoutError";
      }

      if (response?.ok) {
        const ledger = ledgers.getStore();
        if (ledger) {
          const body = (await response.clone().json().catch(() => null)) as { usage?: Record<string, number> } | null;
          ledger.promptTokens += body?.usage?.prompt_tokens ?? 0;
          ledger.completionTokens += body?.usage?.completion_tokens ?? 0;
          ledger.totalTokens += body?.usage?.total_tokens ?? 0;
        }
        return response;
      }

      const wait = response ? await retryWait(response, attempt, baseDelay, maxDelay) : backoff(attempt, baseDelay, maxDelay);
      if (wait === null || attempt >= options.maxRetries) {
        if (response) return response; // the SDK turns it into an APIError; we classify it below
        throw new LlmServiceError(timedOut ? "timeout" : "unavailable");
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    fetch: resilientFetch,
    maxRetries: 0,
  });
  return { client, throttle, ledgers, options };
}

export const newLedger = (): Ledger => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

export function backoff(attempt: number, baseMs: number, maxMs: number): number {
  const step = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(step * (0.75 + Math.random() * 0.5));
}

/** Seconds from a Gemini-style `"retryDelay": "23s"` hint in an error body, if present. */
function providerRetryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m?.[1] ? Math.round(Number(m[1]) * 1000) : null;
}

/** How long to wait before retrying this failed response, or null if retrying is pointless. */
async function retryWait(response: Response, attempt: number, baseMs: number, maxMs: number): Promise<number | null> {
  const { status } = response;
  if (status === 429) {
    const body = await response.clone().text().catch(() => "");
    const hinted = providerRetryDelayMs(body);
    if (hinted !== null) return hinted <= maxMs ? hinted + 50 : null; // told to wait too long: fail fast
    return /quota/i.test(body) ? null : backoff(attempt, baseMs, maxMs); // quota exhausted vs plain rate limit
  }
  return [408, 500, 502, 503, 504].includes(status) ? backoff(attempt, baseMs, maxMs) : null;
}

/** Turn anything the SDK/client throws into a short, plain-language error. */
export function toServiceError(err: unknown): Error {
  const known = findServiceError(err);
  if (known) return known;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return new LlmServiceError(kindForStatus(status), status);
  if (err instanceof Error && /timeout|timed out|abort/i.test(`${err.name} ${err.message}`)) return new LlmServiceError("timeout");
  return err instanceof Error ? err : new Error(String(err));
}
