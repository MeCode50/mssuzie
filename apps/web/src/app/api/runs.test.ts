import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decrypt, executeRun, createMockExecutor, loadLlmConfig, type Env, type LlmConfig } from "@mssuzie/core";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { startTestApp, unique, type TestApp, type Who } from "@/test/app";
import { ORIGIN } from "@/test/fake-container";
import { POST as createSession } from "./sessions/route";
import { GET as getRun } from "./runs/[id]/route";
import { POST as retryRun } from "./runs/[id]/retry/route";

const NOTES = "Amara Okafor did well at Oakfield Academy in Leeds. Ngozi was pleased. Daniel Reyes set 5 fraction questions. Amara got 4/5 and said 'I get it now'.";

describe.skipIf(!TEST_DATABASE_URL)("run endpoints (real Postgres)", () => {
  let app: TestApp;
  let baseEnv: Env;
  const learners: Record<string, string> = {};

  beforeAll(async () => {
    app = await startTestApp({ RUNS_PER_USER_PER_DAY: "1000", RUNS_PER_IP_PER_10_MIN: "1000" });
    baseEnv = app.c.env;
    for (const l of await app.db.prisma.learner.findMany()) learners[l.displayName.split(" ")[0]!] = l.id;
  });
  beforeEach(() => void (app.c.env = baseEnv));
  afterAll(async () => app.close());

  const withEnv = (over: Partial<Env>) => void (app.c.env = { ...baseEnv, ...over });
  const post = (cookie: string | null, body: unknown, o: { key?: string | null; ip?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "x-real-ip": o.ip ?? `40.0.${Math.floor(Math.random() * 250)}.1`, ...o.headers };
    if (o.key !== null) headers["idempotency-key"] = o.key ?? `key-${unique()}`;
    return createSession(app.as(cookie, "/api/sessions", { method: "POST", json: body, headers }));
  };
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const get = (cookie: string | null, id: string) => getRun(app.as(cookie, `/api/runs/${id}`), params(id));
  const retry = (cookie: string | null, id: string, ip = `41.0.${Math.floor(Math.random() * 250)}.1`) =>
    retryRun(app.as(cookie, `/api/runs/${id}/retry`, { method: "POST", json: {}, headers: { "x-real-ip": ip } }), params(id));
  const llm = (): LlmConfig => loadLlmConfig(app.c.env);
  const runPipeline = (runId: string, config = llm()) =>
    executeRun({ prisma: app.db.prisma, llm: config, encryptionKey: app.env.ENCRYPTION_KEY }, runId);
  const code = async (res: Response) => (await res.json()).error?.code;

  describe("POST /api/sessions", () => {
    it("requires sign-in", async () => {
      expect((await post(null, { learnerId: learners.Amara, notes: NOTES })).status).toBe(401);
    });

    it("requires an Idempotency-Key and validates its shape", async () => {
      const cookie = await app.login("tutor1");
      const missing = await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { key: null });
      expect(missing.status).toBe(400);
      expect(await code(missing)).toBe("idempotency_key_required");
      expect((await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { key: "short" })).status).toBe(400);
      expect((await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { key: "has spaces in it!" })).status).toBe(400);
    });

    it("validates the body: notes required, at most 8,000 characters, learner id a uuid", async () => {
      const cookie = await app.login("tutor1");
      const bad = async (body: unknown) => post(cookie, body);
      const empty = await bad({ learnerId: learners.Amara, notes: "   \n " });
      expect(empty.status).toBe(400);
      expect((await empty.json()).error.message).toMatch(/paste the session notes/i);
      const long = await bad({ learnerId: learners.Amara, notes: "x".repeat(8001) });
      expect(long.status).toBe(400);
      expect((await long.json()).error.message).toMatch(/at most 8,000 characters/);
      expect((await bad({ learnerId: "not-a-uuid", notes: NOTES })).status).toBe(400);
      expect((await bad({ learnerId: learners.Amara })).status).toBe(400);
      expect((await post(cookie, { learnerId: learners.Amara, notes: "x".repeat(8000) })).status).toBe(201);
    });

    it("rejects non-JSON content, cross-origin posts and an old session date", async () => {
      const cookie = await app.login("tutor1");
      const raw = createSession(app.as(cookie, "/api/sessions", {
        method: "POST", body: "notes=hi", headers: { "content-type": "text/plain", "idempotency-key": `key-${unique()}` },
      }));
      expect((await raw).status).toBe(415);
      const evil = await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { headers: { origin: "https://evil.example" } });
      expect(evil.status).toBe(403);
      const old = await post(cookie, { learnerId: learners.Amara, notes: NOTES, heldAt: "2020-01-01T10:00:00Z" });
      expect(old.status).toBe(400);
    });

    it("hides other tutors' learners (404, same as a missing learner); ops can use any learner", async () => {
      const tutor1 = await app.login("tutor1");
      const foreign = await post(tutor1, { learnerId: learners.Leo, notes: NOTES }); // Leo belongs to tutor2
      const missing = await post(tutor1, { learnerId: crypto.randomUUID(), notes: NOTES });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
      const ops = await post(await app.login("ebun"), { learnerId: learners.Leo, notes: NOTES });
      expect(ops.status).toBe(201);
      const session = await app.db.prisma.tutoringSession.findFirstOrThrow({ where: { id: (await ops.json()).sessionId } });
      expect(session.tutorId).toBe((await app.db.prisma.learner.findUniqueOrThrow({ where: { id: learners.Leo! } })).tutorId);
    });

    it("creates a queued run with the notes encrypted at rest", async () => {
      const tutor = await app.db.prisma.user.findUniqueOrThrow({ where: { email: "tutor1@example.test" } });
      const res = await post(await app.login("tutor1"), { learnerId: learners.Amara, notes: `  ${NOTES}  `, durationMin: 45 });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ status: "queued", idempotentReplay: false });
      const run = await app.db.prisma.run.findUniqueOrThrow({ where: { id: body.runId } });
      expect(run).toMatchObject({ status: "queued", createdById: tutor.id });
      const session = await app.db.prisma.tutoringSession.findUniqueOrThrow({ where: { id: body.sessionId } });
      expect(session.durationMin).toBe(45);
      expect(session.notesRaw).not.toContain("Amara");
      expect(session.notesRaw).toMatch(/^v1:/);
      expect(decrypt(session.notesRaw, app.env.ENCRYPTION_KEY)).toBe(NOTES);
    });

    it("replays an identical request (same key + body) without creating a second run", async () => {
      const cookie = await app.login("tutor1");
      const key = `key-${unique()}`;
      const before = await app.db.prisma.run.count();
      const first = await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { key });
      const second = await post(cookie, { learnerId: learners.Amara, notes: NOTES }, { key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      const [a, b] = [await first.json(), await second.json()];
      expect(b).toMatchObject({ runId: a.runId, sessionId: a.sessionId, idempotentReplay: true });
      expect(await app.db.prisma.run.count()).toBe(before + 1);
    });

    it("refuses the same key with different content, but another user may reuse the key", async () => {
      const key = `key-${unique()}`;
      const tutor1 = await app.login("tutor1");
      await post(tutor1, { learnerId: learners.Amara, notes: NOTES }, { key });
      const conflict = await post(tutor1, { learnerId: learners.Amara, notes: `${NOTES} Different.` }, { key });
      expect(conflict.status).toBe(409);
      expect(await code(conflict)).toBe("idempotency_conflict");
      const other = await post(await app.login("tutor2"), { learnerId: learners.Leo, notes: NOTES }, { key });
      expect(other.status).toBe(201);
    });

    it("10 simultaneous identical requests create exactly one run, and all get the same runId", async () => {
      const cookie = await app.login("tutor1");
      const key = `key-${unique()}`;
      const before = { runs: await app.db.prisma.run.count(), sessions: await app.db.prisma.tutoringSession.count() };
      const results = await Promise.all(Array.from({ length: 10 }, () => post(cookie, { learnerId: learners.Priya, notes: NOTES }, { key })));
      const bodies = await Promise.all(results.map((r) => r.json()));
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(new Set(bodies.map((b) => b.runId)).size).toBe(1);
      expect(await app.db.prisma.run.count()).toBe(before.runs + 1);
      expect(await app.db.prisma.tutoringSession.count()).toBe(before.sessions + 1);
    });

    it("enforces 30 runs per user per day (configurable), but still answers replays at the limit", async () => {
      withEnv({ RUNS_PER_USER_PER_DAY: 3 });
      const cookie = await app.login("tutor2");
      await app.db.prisma.run.deleteMany({ where: { createdById: (await app.db.prisma.user.findUniqueOrThrow({ where: { email: "tutor2@example.test" } })).id } });
      const keys = [1, 2, 3].map(() => `key-${unique()}`);
      for (const key of keys) expect((await post(cookie, { learnerId: learners["Tomás"], notes: `${NOTES} ${key}` }, { key })).status).toBe(201);
      const blocked = await post(cookie, { learnerId: learners["Tomás"], notes: `${NOTES} 4th` });
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error.message).toBe("You've reached today's limit of 3 session runs. Please try again tomorrow.");
      expect((await post(cookie, { learnerId: learners["Tomás"], notes: `${NOTES} ${keys[0]}` }, { key: keys[0] })).status).toBe(200);
    });

    it("limits run creation per IP, with Retry-After, without affecting other IPs", async () => {
      withEnv({ RUNS_PER_IP_PER_10_MIN: 2 });
      const cookie = await app.login("tutor1");
      const ip = `50.${Math.floor(Math.random() * 250)}.0.1`;
      expect((await post(cookie, { learnerId: learners.Amara, notes: "one" }, { ip })).status).toBe(201);
      expect((await post(cookie, { learnerId: learners.Amara, notes: "two" }, { ip })).status).toBe(201);
      const third = await post(cookie, { learnerId: learners.Amara, notes: "three" }, { ip });
      expect(third.status).toBe(429);
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await post(cookie, { learnerId: learners.Amara, notes: "four" }, { ip: "51.0.0.1" })).status).toBe(201);
    });

    it("refuses new runs with a friendly message once the daily AI budget is reached", async () => {
      withEnv({ DAILY_SPEND_CAP_USD: 1, ESTIMATED_RUN_COST_USD: 0.6 });
      await app.db.prisma.run.deleteMany();
      const session = await app.db.prisma.tutoringSession.findFirstOrThrow();
      await app.db.prisma.run.create({ data: { sessionId: session.id, idempotencyKey: unique(), status: "completed", costUsd: 0.5 } });
      const before = await app.db.prisma.run.count();
      const res = await post(await app.login("tutor1"), { learnerId: learners.Amara, notes: NOTES });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("daily_budget_reached");
      expect(body.error.message).toMatch(/daily AI budget.*resume tomorrow/);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await app.db.prisma.run.count()).toBe(before);
    });

    it("logs the runId without logging notes", async () => {
      const res = await post(await app.login("tutor1"), { learnerId: learners.Amara, notes: "A very distinctive private note about stranger-danger-unicorn." });
      const { runId } = await res.json();
      const line = app.c.lines.find((l) => l.msg === "request" && l.runId === runId);
      expect(line).toMatchObject({ method: "POST", path: "/api/sessions", status: 201, role: "tutor" });
      expect(JSON.stringify(app.c.lines)).not.toContain("stranger-danger-unicorn");
    });
  });

  describe("GET /api/runs/:id", () => {
    const create = async (who: Who, learner: string, notes = NOTES) =>
      (await (await post(await app.login(who), { learnerId: learners[learner], notes })).json()).runId as string;

    it("requires sign-in, and gives a bad or unknown id a plain 404", async () => {
      const id = await create("tutor1", "Amara");
      expect((await get(null, id)).status).toBe(401);
      const cookie = await app.login("tutor1");
      expect((await get(cookie, "not-a-uuid")).status).toBe(404);
      expect((await get(cookie, crypto.randomUUID())).status).toBe(404);
    });

    it("lets the owning tutor and ops see a run, and hides it from another tutor", async () => {
      const id = await create("tutor1", "Amara");
      expect((await get(await app.login("tutor1"), id)).status).toBe(200);
      expect((await get(await app.login("ops2"), id)).status).toBe(200);
      const other = await get(await app.login("tutor2"), id);
      expect(other.status).toBe(404);
      expect((await other.json()).error.code).toBe("not_found");
    });

    it("shows a queued run with every agent pending", async () => {
      const id = await create("tutor1", "Amara");
      const body = await (await get(await app.login("tutor1"), id)).json();
      expect(body.run).toMatchObject({ id, status: "queued", learner: { displayName: "Amara Okafor" } });
      expect(Object.values<{ status: string }>(body.agents).map((a) => a.status)).toEqual(Array(5).fill("pending"));
      expect(body.steps).toEqual([]);
      expect(body.parentUpdate).toBeNull();
    });

    it("after the pipeline runs: steps, summaries, results and the draft; real names only in the draft", async () => {
      const id = await create("tutor1", "Amara");
      await runPipeline(id);
      const body = await (await get(await app.login("tutor1"), id)).json();
      expect(body.run.status).toBe("completed");
      expect(body.run.totalTokens).toBeGreaterThan(0);
      expect(body.steps).toHaveLength(10);
      for (const a of Object.values<{ status: string; summary: string }>(body.agents)) {
        expect(a.status).toBe("completed");
        expect(a.summary.length).toBeGreaterThan(5);
        expect(a.summary).not.toMatch(/\[[A-Z]+_\d+\]/);
      }
      expect(body.results.analysis.skills.length).toBeGreaterThan(0);
      expect(body.results.plan.sessions.length).toBeGreaterThan(0);
      expect(body.results.privacy.log.length).toBeGreaterThan(0);
      expect(body.parentUpdate.body).toContain("Hi Ngozi,");
      // Only two places may carry real names: the draft and the learner's display name in the run header.
      expect(body.run.learner.displayName).toBe("Amara Okafor");
      const { parentUpdate: _draft, run: { learner: _name, ...runRest }, ...rest } = body;
      const leaked = JSON.stringify({ ...rest, run: runRest }).match(/Amara|Okafor|Ngozi|Oakfield|Leeds|Daniel|Reyes/g);
      expect(leaked).toBeNull();
      // the redacted notes are shown (tokens, no names); the encrypted raw notes and token map never are
      expect(body.results.privacy.redactedNotes).toContain("[CHILD_1]");
      expect(JSON.stringify(body)).not.toMatch(/tokenMap|notesRaw|token_map/);
    });

    it("creates the refund-risk alert and exposes it on the run when the learner is at risk", async () => {
      const id = await create("tutor2", "Leo", "Leo did not do homework again. He said 'I hate this'. Katrin is worried and considering whether to continue; no improvement.");
      await runPipeline(id);
      const body = await (await get(await app.login("tutor2"), id)).json();
      expect(body.results.monitor.status).toBe("at_risk");
      expect(body.alert).toMatchObject({ severity: "high", status: "open" });
    });
  });

  describe("POST /api/runs/:id/retry", () => {
    const partialRun = async (who: Who = "tutor1", learner = "Amara") => {
      const id = (await (await post(await app.login(who), { learnerId: learners[learner], notes: NOTES })).json()).runId as string;
      await runPipeline(id, { ...llm(), execute: createMockExecutor({ failAgents: new Set(["progress_monitor"]) }) });
      expect((await app.db.prisma.run.findUniqueOrThrow({ where: { id } })).status).toBe("partial");
      return id;
    };

    it("re-queues a partial run; a second retry while queued is refused", async () => {
      const id = await partialRun();
      const cookie = await app.login("tutor1");
      const res = await retry(cookie, id);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ runId: id, status: "queued" });
      expect(await app.db.prisma.run.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "queued", finishedAt: null, lockedBy: null });
      const again = await retry(cookie, id);
      expect(again.status).toBe(409);
      expect((await again.json()).error.message).toMatch(/already in progress/);
    });

    it("re-runs only the failed step when the worker picks it up again", async () => {
      const id = await partialRun();
      await retry(await app.login("tutor1"), id);
      await runPipeline(id);
      const body = await (await get(await app.login("tutor1"), id)).json();
      expect(body.run.status).toBe("completed");
      expect(body.agents.progress_monitor).toMatchObject({ status: "completed", attempt: 2 });
      expect(body.agents.session_analyst.attempt).toBe(1);
    });

    it("refuses to retry a completed run, and hides other tutors' runs", async () => {
      const id = await (async () => {
        const r = (await (await post(await app.login("tutor1"), { learnerId: learners.Amara, notes: NOTES })).json()).runId as string;
        await runPipeline(r);
        return r;
      })();
      const done = await retry(await app.login("tutor1"), id);
      expect(done.status).toBe(409);
      expect((await done.json()).error.message).toMatch(/nothing to retry/);
      const failed = await partialRun();
      expect((await retry(await app.login("tutor2"), failed)).status).toBe(404);
      expect((await retry(null, failed)).status).toBe(401);
    });

    it("of several simultaneous retries exactly one wins", async () => {
      const id = await partialRun();
      const cookie = await app.login("tutor1");
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => retry(cookie, id, `42.0.0.${i + 1}`)));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 202)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    });

    it("is blocked by the daily budget like a new run", async () => {
      const id = await partialRun();
      withEnv({ DAILY_SPEND_CAP_USD: 0.01, ESTIMATED_RUN_COST_USD: 0.05 });
      const res = await retry(await app.login("tutor1"), id);
      expect(res.status).toBe(503);
      expect((await app.db.prisma.run.findUniqueOrThrow({ where: { id } })).status).toBe("partial");
    });

    it("is blocked by the per-IP limit", async () => {
      const id = await partialRun();
      withEnv({ RUNS_PER_IP_PER_10_MIN: 1 });
      const cookie = await app.login("tutor1");
      const ip = "43.0.0.1";
      await app.db.prisma.rateLimit.deleteMany();
      expect((await retry(cookie, id, ip)).status).toBe(202);
      const second = await partialRun();
      expect((await retry(cookie, second, ip)).status).toBe(429);
    });
  });
});
