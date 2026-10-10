import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient } from "./client";
import { LlmServiceError } from "./errors";
import { acceptFinal, createToolLoopExecutor, invokeTool, ToolLoopError, type ToolAgentRequest, type ToolDef, type ToolEvent } from "./tool-loop";

const FINAL = { name: "report", description: "Finish.", schema: z.object({ ok: z.boolean(), note: z.string() }) };
const lookup: ToolDef = {
  name: "lookup", description: "Look something up.", parameters: z.object({ id: z.string(), count: z.number().int().min(1).max(5).optional() }),
  execute: async (input: { id: string }) => ({ found: input.id }),
};

const call = (id: string, name: string, args: unknown, extra?: unknown) => ({
  id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }, ...(extra ? { extra_content: extra } : {}),
});
const reply = (message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 40 }) => ({
  status: 200,
  json: { id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, ...message } }], usage },
});

describe("tool loop (scripted fake provider)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Record<string, any>[] = [];
  let script: ((n: number, body: Record<string, any>) => { status: number; json: unknown })[] = [];
  const events: ToolEvent[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const body = JSON.parse(data);
        requests.push(body);
        const step = script[Math.min(requests.length - 1, script.length - 1)]!;
        const out = step(requests.length, body);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  afterAll(() => void server.close());
  beforeEach(() => {
    requests = [];
    events.length = 0;
  });

  const run = (over: Partial<ToolAgentRequest> = {}) =>
    createToolLoopExecutor(createLlmClient({ apiKey: "k", baseUrl, reasoningEffort: "low", reasoningTokenHeadroom: 100, requestTimeoutMs: 5000, maxRetries: 0 }))({
      name: "agent", instructions: "Be careful.", model: "m", input: "go", maxTokens: 400, tools: [lookup], final: FINAL,
      onToolEvent: (e) => void events.push(e), ...over,
    });

  it("runs a tool, returns its result to the model, and finishes with the final answer", async () => {
    script = [
      () => reply({ tool_calls: [call("c1", "lookup", { id: "abc" })] }),
      () => reply({ tool_calls: [call("c2", "report", { ok: true, note: "done" })] }),
    ];
    const out = await run();
    expect(out).toMatchObject({ output: { ok: true, note: "done" }, turns: 2, toolCalls: 1, tokensIn: 20, tokensOut: 60 });
    const second = requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: JSON.stringify({ found: "abc" }) });
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "c1", function: { name: "lookup" } }] });
    expect(events.map((e) => `${e.tool}:${e.status}`)).toEqual(["lookup:running", "lookup:completed"]);
    expect(events[1]).toMatchObject({ input: { id: "abc" }, output: { found: "abc" } });
  });

  it("sends the tools and the final tool as function declarations, requires a tool call, and sets reasoning and token limits", async () => {
    script = [() => reply({ tool_calls: [call("c1", "report", { ok: true, note: "x" })] })];
    await run();
    const body = requests[0]!;
    expect(body.tools.map((t: any) => t.function.name)).toEqual(["lookup", "report"]);
    expect(body.tools[0].function.parameters).toMatchObject({ type: "object", required: ["id"] });
    expect(body.tools[0].function.parameters.$schema).toBeUndefined();
    expect(body).toMatchObject({ tool_choice: "required", reasoning_effort: "low", max_tokens: 500, model: "m" });
  });

  it("echoes Gemini's thought_signature back with the matching function call", async () => {
    const sig = { google: { thought_signature: "opaque-signature-abc" } };
    script = [
      () => reply({ tool_calls: [call("c1", "lookup", { id: "a" }, sig)] }),
      () => reply({ tool_calls: [call("c2", "report", { ok: true, note: "x" })] }),
    ];
    await run();
    const echoed = requests[1]!.messages.find((m: any) => m.role === "assistant");
    expect(echoed.tool_calls[0].extra_content).toEqual(sig);
  });

  it("handles several tool calls in one turn, in order, and reports each result", async () => {
    script = [
      () => reply({ tool_calls: [call("a", "lookup", { id: "1" }), call("b", "lookup", { id: "2" })] }),
      () => reply({ tool_calls: [call("c", "report", { ok: true, note: "x" })] }),
    ];
    const out = await run();
    expect(out.toolCalls).toBe(2);
    const toolMsgs = requests[1]!.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    expect(toolMsgs).toEqual(["a", "b"]);
  });

  it("tells the model when arguments are invalid, never runs the tool, and lets it correct itself", async () => {
    let ran = 0;
    const counted: ToolDef = { ...lookup, execute: async () => (ran++, { ok: 1 }) };
    script = [
      () => reply({ tool_calls: [call("c1", "lookup", { id: "a", count: 99 })] }),
      () => reply({ tool_calls: [call("c2", "lookup", { id: "a", extra: "nope" })] }),
      () => reply({ tool_calls: [call("c3", "lookup", "{not json")] }),
      () => reply({ tool_calls: [call("c4", "lookup", { id: "a", count: 2 })] }),
      () => reply({ tool_calls: [call("c5", "report", { ok: true, note: "x" })] }),
    ];
    await run({ tools: [counted], maxTurns: 6 });
    expect(ran).toBe(1);
    const results = requests.at(-1)!.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
    expect(results[0].error).toMatch(/Invalid arguments: count/);
    expect(results[1].error).toMatch(/Invalid arguments/);
    expect(results[2].error).toMatch(/not valid JSON/);
    expect(events.filter((e) => e.status === "failed")).toHaveLength(3);
  });

  it("refuses unknown tools by name, listing what exists", async () => {
    script = [
      () => reply({ tool_calls: [call("c1", "delete_everything", {})] }),
      () => reply({ tool_calls: [call("c2", "report", { ok: true, note: "x" })] }),
    ];
    await run();
    const result = JSON.parse(requests[1]!.messages.at(-1).content);
    expect(result.error).toBe('There is no tool called "delete_everything". Available tools: lookup.');
    expect(events[0]).toMatchObject({ tool: "delete_everything", status: "failed" });
  });

  it("reports a tool that throws to the model as data instead of crashing the run", async () => {
    const broken: ToolDef = { ...lookup, execute: async () => { throw new Error("database is on fire"); } };
    script = [
      () => reply({ tool_calls: [call("c1", "lookup", { id: "a" })] }),
      () => reply({ tool_calls: [call("c2", "report", { ok: false, note: "tool failed" })] }),
    ];
    const out = await run({ tools: [broken] });
    expect(out.output).toMatchObject({ ok: false });
    expect(JSON.parse(requests[1]!.messages.at(-1).content)).toEqual({ error: "database is on fire" });
  });

  it("sends an invalid or semantically wrong final answer back for correction", async () => {
    script = [
      () => reply({ tool_calls: [call("c1", "report", { ok: "yes" })] }),
      () => reply({ tool_calls: [call("c2", "report", { ok: true, note: "forbidden" })] }),
      () => reply({ tool_calls: [call("c3", "report", { ok: true, note: "fine" })] }),
    ];
    const out = await run({ validate: ((o: { note: string }) => (o.note === "forbidden" ? "The note may not be 'forbidden'." : null)) as never, maxTurns: 4 });
    expect(out.output).toEqual({ ok: true, note: "fine" });
    expect(JSON.parse(requests[1]!.messages.at(-1).content).error).toMatch(/final answer was invalid/);
    expect(JSON.parse(requests[2]!.messages.at(-1).content).error).toBe("The note may not be 'forbidden'.");
  });

  it("nudges a model that answers in plain text instead of calling a tool", async () => {
    script = [
      () => reply({ content: "I think it is fine." }),
      () => reply({ tool_calls: [call("c1", "report", { ok: true, note: "x" })] }),
    ];
    await run();
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(requests[1]!.messages.at(-1).content).toMatch(/finish by calling report/);
  });

  it("gives up after the turn limit, with an error that carries the tokens already spent", async () => {
    script = [() => reply({ tool_calls: [call("c", "lookup", { id: "a" })] })];
    const err = await run({ maxTurns: 3 }).catch((e: unknown) => e as ToolLoopError);
    expect(err).toBeInstanceOf(ToolLoopError);
    expect((err as ToolLoopError).message).toBe("The agent did not finish within 3 steps.");
    expect(requests).toHaveLength(3);
    expect((err as ToolLoopError).tokensIn).toBe(30);
  });

  it("falls back to tool_choice auto when the provider rejects 'required'", async () => {
    script = [
      (_n, body) => (body.tool_choice === "required" ? { status: 400, json: { error: { code: 400, message: "tool_choice not supported" } } } : reply({ tool_calls: [call("c1", "report", { ok: true, note: "x" })] })),
    ];
    const out = await run();
    expect(out.output).toEqual({ ok: true, note: "x" });
    expect(requests.map((r) => r.tool_choice)).toEqual(["required", "auto"]);
  });

  it("surfaces provider outages as a plain-language service error", async () => {
    script = [() => ({ status: 503, json: { error: { code: 503, message: "overloaded" } } })];
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmServiceError);
    expect((err as LlmServiceError).kind).toBe("unavailable");
  });
});

describe("invokeTool and acceptFinal (no network)", () => {
  it("scopes by construction: a tool only sees the validated fields it declares", async () => {
    let seen: unknown;
    const t: ToolDef = { name: "t", description: "d", parameters: z.object({ day: z.string() }), execute: async (i) => ((seen = i), {}) };
    await invokeTool({ tools: [t] }, "t", { day: "x", tutorId: "someone-else" });
    expect(seen).toBeUndefined(); // the smuggled tutorId made the whole call invalid
    await invokeTool({ tools: [t] }, "t", { day: "x" });
    expect(seen).toEqual({ day: "x" });
  });

  it("caps oversized results so a tool cannot flood the model", async () => {
    const big: ToolDef = { name: "big", description: "d", parameters: z.object({}), execute: async () => ({ blob: "x".repeat(20_000) }) };
    const r = await invokeTool({ tools: [big] }, "big", {});
    expect(JSON.parse(r.content).error).toMatch(/too large/);
  });

  it("acceptFinal checks schema then semantics", () => {
    const req = { final: FINAL, validate: ((o: { note: string }) => (o.note === "" ? "empty note" : null)) as never };
    expect(acceptFinal(req, '{"ok":true,"note":"hi"}')).toEqual({ ok: true, output: { ok: true, note: "hi" } });
    expect(acceptFinal(req, '{"ok":true,"note":""}')).toEqual({ ok: false, error: "empty note" });
    expect(acceptFinal(req, "nope")).toMatchObject({ ok: false });
    expect(acceptFinal(req, { ok: 1 })).toMatchObject({ ok: false });
  });
});
