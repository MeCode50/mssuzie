import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChatCompletionsExecutor } from "./chat-executor.js";
import { runStructured } from "./structured.js";

const schema = z.object({ findings: z.array(z.string()) });

/** A fake of Gemini's OpenAI-compatible endpoint: records requests, replies with a thinking-model shape. */
describe("chat completions executor (fake Gemini-style endpoint)", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { headers: Record<string, unknown>; body: Record<string, any> }[] = [];
  let reply: (body: Record<string, any>) => unknown = () => ({});

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        requests.push({ headers: req.headers, body: JSON.parse(data) });
        res.setHeader("content-type", "application/json");
        const parsed = JSON.parse(data);
        setTimeout(() => res.end(JSON.stringify(reply(parsed))), parsed.__delay ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai/`;
  });
  afterAll(() => void server.close());

  const completion = (content: string, usage: object) => ({
    id: "x", object: "chat.completion", created: 1, model: "gemini-test",
    choices: [{
      index: 0, finish_reason: "stop",
      message: { role: "assistant", content, extra_content: { google: { thought_signature: "opaque-signature" } } },
    }],
    usage,
  });
  const exec = (over = {}) =>
    createChatCompletionsExecutor({ apiKey: "test-key", baseUrl, reasoningEffort: "low", reasoningTokenHeadroom: 2000, requestTimeoutMs: 5000, maxRetries: 0, ...over });
  const request = { name: "t", instructions: "Return findings.", model: "gemini-test", input: "hello", maxTokens: 800, schema };

  it("sends reasoning_effort, a raised token ceiling, bearer auth and a JSON schema; ignores extra response fields", async () => {
    requests.length = 0;
    reply = () => completion('{"findings":["a"]}', { prompt_tokens: 7, completion_tokens: 7, total_tokens: 329 });
    const out = await exec()(request);
    expect(out.raw).toEqual({ findings: ["a"] });

    const sent = requests[0]!;
    expect(sent.headers.authorization).toBe("Bearer test-key");
    expect(sent.body.model).toBe("gemini-test");
    expect(sent.body.reasoning_effort).toBe("low");
    expect(sent.body.max_tokens ?? sent.body.max_completion_tokens).toBe(2800);
    expect(sent.body.response_format?.type).toBe("json_schema");
    expect(sent.body.response_format?.json_schema?.strict).toBe(true);
    const schemaSent = sent.body.response_format?.json_schema?.schema;
    expect(schemaSent).toMatchObject({ type: "object", required: ["findings"], additionalProperties: false });
    expect(schemaSent.$schema).toBeUndefined();
    expect(sent.body.tools ?? []).toEqual([]);
  });

  it("counts hidden reasoning tokens: out = total_tokens - prompt_tokens", async () => {
    reply = () => completion('{"findings":[]}', { prompt_tokens: 7, completion_tokens: 7, total_tokens: 329 });
    const out = await exec()(request);
    expect(out).toMatchObject({ tokensIn: 7, tokensOut: 322 });
  });

  it("never reports less than completion_tokens when total is missing", async () => {
    reply = () => completion('{"findings":[]}', { prompt_tokens: 10, completion_tokens: 40, total_tokens: 0 });
    expect((await exec()(request)).tokensOut).toBe(40);
  });

  it("honours a different configured reasoning effort", async () => {
    requests.length = 0;
    reply = () => completion('{"findings":[]}', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    await exec({ reasoningEffort: "high" })(request);
    expect(requests[0]!.body.reasoning_effort).toBe("high");
  });

  it("treats non-JSON text as an invalid answer (retried), not a crash", async () => {
    let n = 0;
    reply = () =>
      n++ === 0
        ? completion("Sure! Here are the findings: none", { prompt_tokens: 5, completion_tokens: 5, total_tokens: 50 })
        : completion('{"findings":[]}', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 40 });
    const r = await runStructured(exec(), request);
    expect(r.usage).toMatchObject({ attempts: 2, tokensIn: 10, tokensOut: 45 + 35 });
  });

  it("keeps usage separate for calls running in parallel", async () => {
    reply = (body) => {
      const text = JSON.stringify(body.messages);
      return text.includes("CALL-A")
        ? completion('{"findings":["a"]}', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 100 })
        : completion('{"findings":["b"]}', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 900 });
    };
    const run = exec();
    const [a, b] = await Promise.all([
      run({ ...request, input: "CALL-A" }),
      run({ ...request, input: "CALL-B" }),
      run({ ...request, input: "CALL-A" }),
    ]);
    expect(a).toMatchObject({ tokensIn: 10, tokensOut: 90, raw: { findings: ["a"] } });
    expect(b).toMatchObject({ tokensIn: 20, tokensOut: 880, raw: { findings: ["b"] } });
  });

  it("feeds runStructured: thinking-token usage lands in the step usage", async () => {
    reply = () => completion('{"findings":["x"]}', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 900 });
    const r = await runStructured(exec(), request);
    expect(r.output).toEqual({ findings: ["x"] });
    expect(r.usage).toMatchObject({ tokensIn: 100, tokensOut: 800, attempts: 1 });
  });

  it("retries once when the model returns JSON that fails the schema, summing both attempts", async () => {
    let n = 0;
    reply = () =>
      n++ === 0
        ? completion('{"findings":"not-an-array"}', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 100 })
        : completion('{"findings":["ok"]}', { prompt_tokens: 12, completion_tokens: 5, total_tokens: 120 });
    const r = await runStructured(exec(), request);
    expect(r.output).toEqual({ findings: ["ok"] });
    expect(r.usage).toMatchObject({ attempts: 2, tokensIn: 22, tokensOut: 90 + 108 });
  });
});
