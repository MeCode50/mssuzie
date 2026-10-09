import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChatCompletionsExecutor, type ChatExecutorOptions } from "./chat-executor.js";
import { LlmServiceError } from "./errors.js";
import { Throttle } from "./throttle.js";

const schema = z.object({ ok: z.boolean() });
const request = { name: "t", instructions: "x", model: "m", input: "hi", maxTokens: 100, schema };

interface Reply { status?: number; delayMs?: number; json?: unknown }
const good = (total = 50): Reply => ({
  json: {
    id: "x", object: "chat.completion", created: 1, model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: total },
  },
});
const err = (status: number, message: string, extra: object = {}): Reply => ({
  status, json: { error: { code: status, message, status: "X", ...extra } },
});

describe("LLM resilience (scripted fake provider)", () => {
  let server: Server;
  let baseUrl: string;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let script: (n: number) => Reply = () => good();

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const n = ++calls;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const reply = script(n);
        setTimeout(() => {
          inFlight--;
          if (res.destroyed) return;
          res.statusCode = reply.status ?? 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(reply.json));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  afterAll(() => void server.close());
  beforeEach(() => {
    calls = 0; inFlight = 0; maxInFlight = 0;
  });

  const exec = (over: Partial<ChatExecutorOptions> = {}) =>
    createChatCompletionsExecutor({
      apiKey: "k", baseUrl, reasoningEffort: "low", reasoningTokenHeadroom: 0,
      requestTimeoutMs: 200, maxRetries: 2, maxRetryDelayMs: 300, retryBaseDelayMs: 5, ...over,
    });
  const failure = async (p: Promise<unknown>): Promise<LlmServiceError> => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LlmServiceError);
    return e as LlmServiceError;
  };

  it("recovers from a 503 and bills only the successful response", async () => {
    script = (n) => (n === 1 ? err(503, "This model is currently experiencing high demand.") : good(60));
    const out = await exec()(request);
    expect(calls).toBe(2);
    expect(out).toMatchObject({ raw: { ok: true }, tokensIn: 10, tokensOut: 50 });
  });

  it("gives up after maxRetries and says so in plain language", async () => {
    script = () => err(503, "high demand");
    const e = await failure(exec()(request));
    expect(calls).toBe(3);
    expect(e).toMatchObject({ kind: "unavailable", status: 503 });
    expect(e.message).toBe("The AI service is busy or unavailable right now. Please retry shortly. (HTTP 503)");
  });

  it("waits the provider's retryDelay on a 429 and retries", async () => {
    script = (n) => (n === 1 ? err(429, "Quota exceeded for metric", { details: [{ retryDelay: "0.05s" }] }) : good());
    await exec()(request);
    expect(calls).toBe(2);
  });

  it("fails fast when the provider asks for a wait longer than we accept", async () => {
    script = () => err(429, "Quota exceeded", { details: [{ retryDelay: "120s" }] });
    const e = await failure(exec()(request));
    expect(calls).toBe(1);
    expect(e.kind).toBe("rate_limited");
  });

  it("fails fast on exhausted quota (no retry hint) with a friendly message, not raw JSON", async () => {
    script = () => err(429, "You exceeded your current quota, please check your plan and billing details.");
    const e = await failure(exec()(request));
    expect(calls).toBe(1);
    expect(e.kind).toBe("rate_limited");
    expect(e.message).toBe("The AI service hit its rate limit or quota. Please try again in a few minutes. (HTTP 429)");
    expect(e.message).not.toContain("{");
  });

  it("retries a plain rate limit that is not a quota problem", async () => {
    script = (n) => (n === 1 ? err(429, "Too many requests") : good());
    await exec()(request);
    expect(calls).toBe(2);
  });

  it("cuts a hung request at the timeout and retries instead of waiting", async () => {
    script = (n) => (n === 1 ? { ...good(), delayMs: 2000 } : good());
    const t = Date.now();
    const out = await exec({ requestTimeoutMs: 150 })(request);
    expect(out.raw).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("reports a timeout once retries are exhausted", async () => {
    script = () => ({ ...good(), delayMs: 2000 });
    const t = Date.now();
    const e = await failure(exec({ requestTimeoutMs: 100, maxRetries: 1 })(request));
    expect(e.kind).toBe("timeout");
    expect(calls).toBe(2);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it.each([
    [401, "auth"], [403, "auth"], [400, "bad_request"],
  ] as const)("does not retry a %i (%s)", async (status, kind) => {
    script = () => err(status, "nope");
    const e = await failure(exec()(request));
    expect(calls).toBe(1);
    expect(e.kind).toBe(kind);
  });

  it("caps concurrent calls process-wide", async () => {
    script = () => ({ ...good(), delayMs: 40 });
    const run = exec({ maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => run(request)));
    expect(calls).toBe(6);
    expect(maxInFlight).toBe(2);
  });
});

describe("Throttle", () => {
  it("never runs more than maxConcurrent at once, and 0 means unlimited", async () => {
    const run = async (limit: number) => {
      const t = new Throttle({ maxConcurrent: limit, perWindow: 0 });
      let now = 0, max = 0;
      await Promise.all(Array.from({ length: 8 }, () => t.withSlot(async () => {
        max = Math.max(max, ++now);
        await new Promise((r) => setTimeout(r, 15));
        now--;
      })));
      return max;
    };
    expect(await run(3)).toBe(3);
    expect(await run(0)).toBe(8);
  });

  it("releases the slot when a task throws", async () => {
    const t = new Throttle({ maxConcurrent: 1, perWindow: 0 });
    await expect(t.withSlot(async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(t.withSlot(async () => "ok")).resolves.toBe("ok");
  });

  it("holds requests back to the per-window rate", async () => {
    const t = new Throttle({ maxConcurrent: 0, perWindow: 3, windowMs: 120 });
    const start = Date.now();
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      await t.waitForRate();
      times.push(Date.now() - start);
    }
    expect(times[2]!).toBeLessThan(60);
    expect(times[3]!).toBeGreaterThanOrEqual(115);
    expect(times[6]!).toBeGreaterThanOrEqual(235);
  });
});
