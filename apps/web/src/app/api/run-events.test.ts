import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockExecutor, executeRun, loadLlmConfig, type LlmConfig, type PrismaClient } from "@mssuzie/core";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { startTestApp, unique, type TestApp, type Who } from "@/test/app";
import { createEventStream, openStreamCount } from "@/lib/sse";
import { POST as createSession } from "./sessions/route";
import { POST as retryRun } from "./runs/[id]/retry/route";
import { GET as events } from "./runs/[id]/events/route";

interface Sse { id?: string; event?: string; data?: unknown; comment?: string }

function parse(block: string): Sse {
  const out: Sse = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) out.comment = line.slice(1).trim();
    else if (line.startsWith("id: ")) out.id = line.slice(4);
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
    else if (line.startsWith("retry: ")) out.event = "retry-hint";
  }
  return out;
}

/** Read a stream until it ends, `stop` says so, or `limitMs` passes. Returns what was received. */
async function collect(
  body: ReadableStream<Uint8Array>,
  opts: { stop?: (e: Sse[]) => boolean; limitMs?: number } = {},
): Promise<{ events: Sse[]; ended: boolean; raw: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  const received: Sse[] = [];
  const deadline = Date.now() + (opts.limitMs ?? 15_000);
  let ended = false;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
    if (next === null) continue;
    if (next.done) { ended = true; break; }
    const text = decoder.decode(next.value, { stream: true });
    raw += text;
    buffer += text;
    let i: number;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      received.push(parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 2);
    }
    if (opts.stop?.(received)) break;
  }
  await reader.cancel().catch(() => undefined);
  return { events: received, ended, raw };
}

const NOTES = "Amara Okafor did well at Oakfield Academy in Leeds. Ngozi was pleased. Daniel Reyes set 5 fraction questions. Amara got 4/5.";
const steps = (e: Sse[]) => e.filter((x) => x.event === "step").map((x) => x.data as { seq: number; agent: string; status: string; attempt: number });

describe.skipIf(!TEST_DATABASE_URL)("GET /api/runs/:id/events (real Postgres)", () => {
  let app: TestApp;
  const learners: Record<string, string> = {};
  beforeAll(async () => {
    app = await startTestApp({ RUNS_PER_USER_PER_DAY: "1000", RUNS_PER_IP_PER_10_MIN: "1000" });
    for (const l of await app.db.prisma.learner.findMany()) learners[l.displayName.split(" ")[0]!] = l.id;
  });
  afterAll(async () => app.close());

  const llm = (): LlmConfig => loadLlmConfig(app.c.env);
  const newRun = async (who: Who = "tutor1", learner = "Amara") => {
    const res = await createSession(app.as(await app.login(who), "/api/sessions", {
      method: "POST", json: { learnerId: learners[learner], notes: NOTES },
      headers: { "idempotency-key": `key-${unique()}`, "x-real-ip": "60.0.0.1" },
    }));
    return (await res.json()).runId as string;
  };
  const exec = (runId: string, config = llm()) => executeRun({ prisma: app.db.prisma, llm: config, encryptionKey: app.env.ENCRYPTION_KEY }, runId);
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const open = (cookie: string | null, id: string, init: RequestInit & { json?: unknown } = {}) =>
    events(app.as(cookie, `/api/runs/${id}/events`, init), params(id));

  it("requires sign-in and hides other tutors' runs", async () => {
    const id = await newRun("tutor1");
    expect((await open(null, id)).status).toBe(401);
    expect((await open(await app.login("tutor2"), id)).status).toBe(404);
    expect((await open(await app.login("tutor1"), "nope")).status).toBe(404);
    expect((await open(await app.login("ebun"), id)).status).toBe(200);
  });

  it("sends event-stream headers that prevent buffering and caching", async () => {
    const id = await newRun("tutor1");
    const res = await open(await app.login("tutor1"), id);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body!.cancel();
  });

  it("replays a finished run in order, reports the final status, then says done and closes", async () => {
    const id = await newRun();
    await exec(id);
    const res = await open(await app.login("tutor1"), id);
    const { events: got, ended } = await collect(res.body!);
    expect(ended).toBe(true);
    expect(steps(got).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(got.filter((e) => e.event === "step").map((e) => e.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(got.at(-1)).toMatchObject({ event: "done", data: { status: "completed" } });
    expect(got.at(-2)).toMatchObject({ event: "run", data: { status: "completed" } });
    const finalRun = got.at(-2)!.data as { startedAt: string; finishedAt: string; totalTokens: number };
    expect(new Date(finalRun.startedAt).getTime()).toBeLessThanOrEqual(new Date(finalRun.finishedAt).getTime());
    expect(finalRun.totalTokens).toBeGreaterThan(0);
  });

  it("resumes after Last-Event-ID or ?after= without repeating or skipping steps", async () => {
    const id = await newRun();
    await exec(id);
    const cookie = await app.login("tutor1");
    const viaHeader = await collect((await open(cookie, id, { headers: { "last-event-id": "4" } })).body!);
    expect(steps(viaHeader.events).map((s) => s.seq)).toEqual([5, 6, 7, 8, 9, 10]);
    const viaQuery = await collect((await events(app.as(cookie, `/api/runs/${id}/events?after=8`), params(id))).body!);
    expect(steps(viaQuery.events).map((s) => s.seq)).toEqual([9, 10]);
    const junk = await collect((await open(cookie, id, { headers: { "last-event-id": "banana" } })).body!);
    expect(steps(junk.events)).toHaveLength(10);
  });

  it("streams a live run as it happens, with Monitor and Planner running side by side", async () => {
    const id = await newRun();
    const controller = new AbortController();
    const stream = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: controller.signal, pollMs: 15 });
    const reading = collect(stream);
    await new Promise((r) => setTimeout(r, 80)); // the viewer is already watching before anything runs
    await exec(id, { ...llm(), execute: createMockExecutor({ delayMs: 25 }) });
    const { events: got, ended } = await reading;
    expect(ended).toBe(true);
    const s = steps(got);
    expect(s.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const at = (agent: string, status: string) => s.findIndex((x) => x.agent === agent && x.status === status);
    const firstDone = Math.min(at("progress_monitor", "completed"), at("learning_planner", "completed"));
    expect(at("progress_monitor", "running")).toBeLessThan(firstDone);
    expect(at("learning_planner", "running")).toBeLessThan(firstDone);
    expect(got.filter((e) => e.event === "run").map((e) => (e.data as { status: string }).status)).toEqual(["queued", "running", "completed"]);
    expect(got.at(-1)).toMatchObject({ event: "done" });
  });

  it("a dropped and resumed connection receives every step exactly once", async () => {
    const id = await newRun();
    const stream1 = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: new AbortController().signal, pollMs: 15 });
    const running = exec(id, { ...llm(), execute: createMockExecutor({ delayMs: 25 }) });
    const first = await collect(stream1, { stop: (e) => steps(e).length >= 4 });
    const lastSeen = steps(first.events).at(-1)!.seq;
    const stream2 = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: lastSeen, signal: new AbortController().signal, pollMs: 15 });
    const second = await collect(stream2);
    await running;
    const all = [...steps(first.events), ...steps(second.events)].map((s) => s.seq);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(second.events.at(-1)).toMatchObject({ event: "done" });
  });

  it("stops polling the database once the client disconnects", async () => {
    const id = await newRun();
    let polls = 0;
    const counting = new Proxy(app.db.prisma, {
      get(target, prop, receiver) {
        if (prop === "runStep") {
          return new Proxy(target.runStep, { get: (t, p, r) => (p === "findMany" ? (...a: unknown[]) => (polls++, (t.findMany as (...x: unknown[]) => unknown)(...a)) : Reflect.get(t, p, r)) });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    const controller = new AbortController();
    const stream = createEventStream({ prisma: counting, runId: id, afterSeq: 0, signal: controller.signal, pollMs: 10 });
    const reading = collect(stream, { limitMs: 3000 });
    await new Promise((r) => setTimeout(r, 120));
    expect(polls).toBeGreaterThan(3);
    controller.abort();
    const result = await reading;
    expect(result.ended).toBe(true);
    const after = polls;
    await new Promise((r) => setTimeout(r, 150));
    expect(polls).toBe(after);
  });

  it("sends heartbeat comments while idle and closes (without done) at its maximum lifetime", async () => {
    const id = await newRun();
    const stream = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: new AbortController().signal, pollMs: 10, heartbeatMs: 30, maxMs: 200 });
    const { events: got, ended, raw } = await collect(stream);
    expect(ended).toBe(true);
    expect(raw).toContain(": ping");
    expect(got.some((e) => e.event === "done")).toBe(false);
    expect(got.find((e) => e.event === "run")).toMatchObject({ data: { status: "queued" } });
  });

  it("ends cleanly if the run disappears (e.g. a demo reset)", async () => {
    const id = await newRun();
    const stream = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: new AbortController().signal, pollMs: 10 });
    const reading = collect(stream, { limitMs: 3000 });
    await new Promise((r) => setTimeout(r, 60));
    await app.db.prisma.run.delete({ where: { id } });
    const { ended, events: got } = await reading;
    expect(ended).toBe(true);
    expect(got.some((e) => e.event === "done")).toBe(false);
  });

  it("limits simultaneous live views per user and frees the slot when one closes", async () => {
    const id = await newRun("tutor2", "Leo");
    const cookie = await app.login("tutor2");
    const who = (await app.db.prisma.user.findUniqueOrThrow({ where: { email: "tutor2@example.test" } })).id;
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const opened = [];
    for (const c of controllers) opened.push(await open(cookie, id, { signal: c.signal }));
    expect(opened.every((r) => r.status === 200)).toBe(true);
    const seventh = await open(cookie, id);
    expect(seventh.status).toBe(429);
    expect((await seventh.json()).error.message).toMatch(/too many live views/);
    controllers[0]!.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(openStreamCount(who)).toBe(5);
    const again = await open(cookie, id, { signal: controllers[1]!.signal });
    expect(again.status).toBe(200);
    controllers.forEach((c) => c.abort());
    await new Promise((r) => setTimeout(r, 100));
    expect(openStreamCount(who)).toBe(0);
  });

  it("follows a retry: done on the partial run, then only the new attempt's steps after resuming", async () => {
    const id = await newRun();
    const cookie = await app.login("tutor1");
    await exec(id, { ...llm(), execute: createMockExecutor({ failAgents: new Set(["progress_monitor"]) }) });
    const first = await collect(createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: new AbortController().signal, pollMs: 15 }));
    expect(first.events.at(-1)).toMatchObject({ event: "done", data: { status: "partial" } });
    const lastSeq = steps(first.events).at(-1)!.seq;

    const retry = await retryRun(app.as(cookie, `/api/runs/${id}/retry`, { method: "POST", json: {}, headers: { "x-real-ip": "61.0.0.1" } }), params(id));
    expect(retry.status).toBe(202);
    const resumed = createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: lastSeq, signal: new AbortController().signal, pollMs: 15 });
    const reading = collect(resumed);
    await new Promise((r) => setTimeout(r, 60));
    await exec(id);
    const { events: got } = await reading;
    expect(got.find((e) => e.event === "run")).toMatchObject({ data: { status: "queued" } });
    const fresh = steps(got);
    expect(fresh.every((s) => s.seq > lastSeq && s.attempt === 2)).toBe(true);
    expect(fresh.map((s) => s.agent)).toEqual(["progress_monitor", "progress_monitor", "parent_reporter", "parent_reporter"]);
    expect(got.at(-1)).toMatchObject({ event: "done", data: { status: "completed" } });
  });

  it("delivers a backlog larger than one poll batch completely and in order before saying done", async () => {
    const id = await newRun();
    const agents = ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"] as const;
    await app.db.prisma.runStep.createMany({
      data: Array.from({ length: 450 }, (_, i) => ({ runId: id, seq: i + 1, agent: agents[i % 5]!, status: "running" as const })),
    });
    await app.db.prisma.run.update({ where: { id }, data: { status: "completed" } });
    const { events: got, ended } = await collect(createEventStream({ prisma: app.db.prisma, runId: id, afterSeq: 0, signal: new AbortController().signal, pollMs: 10 }), { limitMs: 10_000 });
    expect(ended).toBe(true);
    expect(steps(got).map((x) => x.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(got.at(-1)).toMatchObject({ event: "done" });
  });

  it("never puts real names or raw notes on the wire", async () => {
    const id = await newRun();
    await exec(id);
    const { raw } = await collect((await open(await app.login("tutor1"), id)).body!);
    expect(raw).not.toMatch(/Amara|Okafor|Ngozi|Oakfield|Leeds|Daniel|Reyes/);
    expect(raw).not.toMatch(/\[[A-Z]+_\d+\]/); // summaries are plain language, never tokens
  });
});
