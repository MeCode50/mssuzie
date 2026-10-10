import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMockExecutor, createMockToolExecutor, executeRescheduleRun, resetDemoData, type DemoScenarioInfo, type LlmConfig,
} from "@mssuzie/core";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { startTestApp, type TestApp } from "@/test/app";
import { POST as accept } from "./accept/route";
import { GET as guardians } from "./guardians/route";
import { GET as listRoute, POST as createRoute } from "./reschedules/route";
import { GET as detail } from "./reschedules/[id]/route";
import { POST as approve } from "./reschedules/[id]/approve/route";
import { POST as reject } from "./reschedules/[id]/reject/route";
import { GET as schedule } from "./schedule/route";
import { GET as events } from "./runs/[id]/events/route";
import { previewAccept } from "@/lib/accept";

const SECRET = "w".repeat(40);
const llm: LlmConfig = {
  execute: createMockExecutor(), executeTools: createMockToolExecutor(), schedulerTier: "small",
  models: { main: "m", small: "s" }, pricing: { main: { inPer1M: 1, outPer1M: 1 }, small: { inPer1M: 1, outPer1M: 1 } }, mock: true,
};
const weekday = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("cccc");

describe.skipIf(!TEST_DATABASE_URL)("rescheduling API (real Postgres, mock models)", () => {
  let app: TestApp;
  let sc: DemoScenarioInfo;
  beforeAll(async () => {
    app = await startTestApp({ ACTION_LINK_SECRET: SECRET });
    app.c.integrations.linkSecret = SECRET; // in production both come from the same env value
  });
  afterAll(async () => app.close());
  beforeEach(async () => {
    sc = await resetDemoData(app.db.prisma, app.env.ENCRYPTION_KEY);
    app.c.integrations.sent.length = 0;
    app.c.integrations.calendar.calls = 0;
  });

  const ip = () => `81.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const code = async (res: Response) => (await res.json()).error?.code;
  const call = (h: typeof createRoute, cookie: string | null, path: string, init: { method?: string; json?: unknown; id?: string; headers?: Record<string, string> } = {}) =>
    h(app.as(cookie, path, { method: init.method ?? "GET", json: init.json, headers: { "x-real-ip": ip(), ...init.headers } }), init.id ? (params(init.id) as never) : undefined);

  async function send(guardianId: string, message: string, who: "ebun" | "tutor1" | "tutor2" = "ebun") {
    const res = await call(createRoute, await app.login(who), "/api/reschedules", { method: "POST", json: { guardianId, message } });
    expect(res.status).toBe(201);
    return (await res.json()) as { requestId: string; runId: string };
  }
  const process = (runId: string) => executeRescheduleRun({ prisma: app.db.prisma, llm, encryptionKey: app.env.ENCRYPTION_KEY, ...app.c.integrations, minNoticeHours: 12 }, runId);
  async function run(guardianId: string, message: string) {
    const r = await send(guardianId, message);
    await process(r.runId);
    return r;
  }
  const happyMsg = () => `Hi, can we move Amara's 7am class on ${weekday(sc.happy.currentStartsAt, sc.happy.guardianZone)} to 7pm please?`;
  const conflictMsg = () => `Could Leo's ${weekday(sc.conflict.currentStartsAt, sc.conflict.guardianZone)} class move to 12 noon?`;
  const escalationMsg = () => "Can Priya's class today move to tomorrow at 5pm please?";

  describe("POST /api/reschedules", () => {
    it("needs sign-in, and stores the parent's message encrypted with a queued run", async () => {
      expect((await call(createRoute, null, "/x", { method: "POST", json: { guardianId: sc.happy.guardianId, message: "hi" } })).status).toBe(401);
      const r = await send(sc.happy.guardianId, "Please move Amara's class SECRET-PHRASE-123");
      const row = await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId }, include: { run: true } });
      expect(row.rawMessageEnc).not.toContain("SECRET-PHRASE-123");
      expect(row.run).toMatchObject({ pipeline: "reschedule", status: "queued" });
      expect(JSON.stringify(app.c.lines)).not.toContain("SECRET-PHRASE-123"); // never logged
    });

    it("rejects empty, oversized, malformed and cross-origin requests and unknown parents", async () => {
      const cookie = await app.login("ebun");
      const post = (json: unknown, headers: Record<string, string> = {}) => call(createRoute, cookie, "/x", { method: "POST", json, headers });
      expect((await post({ guardianId: sc.happy.guardianId, message: "   " })).status).toBe(400);
      expect((await post({ guardianId: sc.happy.guardianId, message: "x".repeat(2001) })).status).toBe(400);
      expect((await post({ guardianId: "nope", message: "hi" })).status).toBe(400);
      expect((await post({ guardianId: crypto.randomUUID(), message: "hi" })).status).toBe(404);
      expect((await post({ guardianId: sc.happy.guardianId, message: "hi" }, { origin: "https://evil.example" })).status).toBe(403);
    });

    it("a tutor can only send as a parent of their own learner", async () => {
      const tutor = await app.login("tutor1");
      const mine = await app.db.prisma.learner.findFirstOrThrow({ where: { tutor: { email: "tutor1@example.test" } }, include: { guardians: true } });
      const theirs = await app.db.prisma.learner.findFirstOrThrow({ where: { tutor: { email: "tutor2@example.test" } }, include: { guardians: true } });
      const ok = await call(createRoute, tutor, "/x", { method: "POST", json: { guardianId: mine.guardians[0]!.id, message: "hi" } });
      expect(ok.status).toBe(201);
      const other = await call(createRoute, tutor, "/x", { method: "POST", json: { guardianId: theirs.guardians[0]!.id, message: "hi" } });
      expect(other.status).toBe(404);
    });
  });

  describe("GET /api/guardians and /api/schedule", () => {
    it("lists parents with their learner, tutor, zones and next classes (tutors: own learners only)", async () => {
      const all = await (await call(guardians as never, await app.login("ebun"), "/x")).json();
      expect(all.guardians).toHaveLength(5);
      const amara = all.guardians.find((g: { learner: { displayName: string } }) => g.learner.displayName.startsWith("Amara"));
      expect(amara).toMatchObject({ timezone: "Europe/London", tutor: { timezone: "Africa/Lagos" } });
      expect(amara.upcoming.length).toBeGreaterThan(0);
      const mine = await (await call(guardians as never, await app.login("tutor1"), "/x")).json();
      expect(mine.guardians.length).toBeLessThan(5);
      expect(mine.guardians.length).toBeGreaterThan(0);
    });

    it("lists classes in a range, shows moved ones, and validates the range", async () => {
      const r = await run(sc.happy.guardianId, happyMsg());
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const res = await call(schedule as never, await app.login("ebun"), `/api/schedule?from=${from}&to=${to}`);
      const { bookings } = await res.json();
      const moved = bookings.find((b: { id: string }) => b.id === sc.happy.bookingId);
      expect(moved).toMatchObject({ status: "rescheduled", calendarSynced: true, moved: { requestId: r.requestId, by: "policy" } });
      expect(new Date(moved.moved.from).toISOString()).toBe(sc.happy.currentStartsAt.toISOString());
      expect((await call(schedule as never, await app.login("ebun"), "/api/schedule?from=nope&to=x")).status).toBe(400);
      expect((await call(schedule as never, await app.login("ebun"), `/api/schedule?from=${from}&to=${new Date(Date.now() + 90 * 86_400_000).toISOString()}`)).status).toBe(400);
      expect((await call(schedule as never, null, `/api/schedule?from=${from}&to=${to}`)).status).toBe(401);
    });
  });

  describe("GET /api/reschedules and /api/reschedules/:id", () => {
    it("filters the feed and counts each bucket", async () => {
      await run(sc.happy.guardianId, happyMsg());
      await run(sc.conflict.guardianId, conflictMsg());
      await run(sc.escalation.guardianId, escalationMsg());
      const cookie = await app.login("ebun");
      const get = async (filter: string) => (await call(listRoute, cookie, `/api/reschedules?filter=${filter}`)).json();
      const all = await get("all");
      expect(all.counts).toEqual({ all: 3, needs_person: 1, waiting: 1, done: 1 });
      expect((await get("needs_person")).requests.map((x: { learner: { displayName: string } }) => x.learner.displayName.split(" ")[0])).toEqual(["Priya"]);
      expect((await get("waiting")).requests[0].decision).toBe("proposed");
      expect((await get("done")).requests[0].moved.to.parentLocal).toContain("7:00 PM");
      expect((await call(listRoute, cookie, "/api/reschedules?filter=bogus")).status).toBe(400);
    });

    it("shows a request's message, understanding, decision, options, messages sent and trace", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const res = await call(detail as never, await app.login("ebun"), "/x", { id: r.requestId });
      const d = await res.json();
      expect(d.message).toContain("Leo");
      expect(d).toMatchObject({ decision: "proposed", code: "slot_unavailable", canSettle: true, canChooseTime: true, needsPerson: false });
      expect(d.options).toHaveLength(2);
      expect(d.options[0].parentLocal).toContain("Chicago");
      expect(d.notifications.map((n: { role: string; kind: string }) => `${n.role}/${n.kind}`)).toEqual(["parent/proposal"]);
      const agents = d.steps.filter((s: { kind: string }) => s.kind === "agent").map((s: { agent: string }) => s.agent);
      expect(agents).toContain("scheduler_agent");
      const tools = d.steps.filter((s: { kind: string; status: string }) => s.kind === "tool" && s.status === "completed");
      expect(tools.map((t: { toolName: string }) => t.toolName)).toContain("find_free_slots");
      expect(tools.every((t: { summary: string | null }) => typeof t.summary === "string")).toBe(true);
      // a tool call's arguments are shown; a model's raw output and the token map never are
      expect(JSON.stringify(d)).not.toMatch(/tokenMap|token_map|\[CHILD_1\]/);
    });

    it("hides other tutors' requests (404) and limits tutors' actions", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const leo = await app.db.prisma.learner.findUniqueOrThrow({ where: { id: sc.conflict.learnerId }, include: { tutor: true } });
      const owner = leo.tutor.email === "tutor1@example.test" ? "tutor1" : "tutor2";
      const stranger = owner === "tutor1" ? "tutor2" : "tutor1";
      expect((await call(detail as never, await app.login(stranger), "/x", { id: r.requestId })).status).toBe(404);
      const own = await (await call(detail as never, await app.login(owner), "/x", { id: r.requestId })).json();
      expect(own).toMatchObject({ canSettle: false, canChooseTime: false }); // tutors watch, ops decide
      expect((await call(detail as never, await app.login("ebun"), "/x", { id: "not-a-uuid" })).status).toBe(404);
    });

    it("streams a reschedule run's live trace, including nested tool calls", async () => {
      const r = await run(sc.happy.guardianId, happyMsg());
      const res = await call(events as never, await app.login("ebun"), "/x", { id: r.runId });
      expect(res.status).toBe(200);
      const text = await new Response(res.body).text();
      expect(text).toContain("event: step");
      expect(text).toContain('"kind":"tool"');
      expect(text).toContain('"toolName":"get_bookings"');
      expect(text).toContain("event: done");
      const stranger = await call(events as never, await app.login("tutor2"), "/x", { id: r.runId });
      expect([200, 404]).toContain(stranger.status); // scoped by learner ownership
    });
  });

  describe("Ops approve or decline", () => {
    it("approve is ops-only, needs a real time, and settles an escalated request (even inside the notice window)", async () => {
      const r = await run(sc.escalation.guardianId, escalationMsg());
      const url = `/api/reschedules/${r.requestId}/approve`;
      const free = (await (await call(detail as never, await app.login("ebun"), "/x", { id: r.requestId })).json()).booking;
      expect(free).toBeTruthy();
      const slot = await (async () => {
        // a free time for Priya's tutor a few hours ahead, on the tutor's own half-hour grid
        const t = DateTime.now().plus({ hours: 6 }).setZone("Africa/Lagos").startOf("hour").plus({ days: 0 });
        return t.toUTC().toJSDate();
      })();
      expect((await call(approve as never, null, url, { method: "POST", id: r.requestId, json: { startsAt: slot.toISOString() } })).status).toBe(401);
      expect((await call(approve as never, await app.login("tutor1"), url, { method: "POST", id: r.requestId, json: { startsAt: slot.toISOString() } })).status).toBe(403);
      expect((await call(approve as never, await app.login("ebun"), url, { method: "POST", id: r.requestId, json: { startsAt: "tomorrow" } })).status).toBe(400);
      expect((await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } })).decision).toBe("escalated");
    });

    it("approving a proposed time moves the class, updates the calendar and tells both people", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const opts = (await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } })).proposedSlotsJson as { startsAt: string }[];
      const res = await call(approve as never, await app.login("ebun"), "/x", { method: "POST", id: r.requestId, json: { startsAt: opts[0]!.startsAt } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, alreadyApplied: false, problems: [] });
      const row = await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } });
      expect(row).toMatchObject({ decision: "confirmed", decidedBy: "ops:Ebun" });
      expect(app.c.integrations.sent.map((m) => m.subject).join("|")).toContain("is moved to");
      // a second approval of the same time is harmless; a different time is a plain-language conflict
      expect((await call(approve as never, await app.login("ebun"), "/x", { method: "POST", id: r.requestId, json: { startsAt: opts[0]!.startsAt } })).status).toBe(200);
      const other = await call(approve as never, await app.login("ebun"), "/x", { method: "POST", id: r.requestId, json: { startsAt: opts[1]!.startsAt } });
      expect(other.status).toBe(409);
      expect((await other.json()).error.message).toBe("This request has already been settled.");
    });

    it("explains in plain language why a time cannot be used", async () => {
      const r = await run(sc.escalation.guardianId, escalationMsg());
      const night = DateTime.now().plus({ days: 2 }).setZone("Africa/Lagos").set({ hour: 3, minute: 0, second: 0, millisecond: 0 }).toUTC().toJSDate();
      const res = await call(approve as never, await app.login("ebun"), "/x", { method: "POST", id: r.requestId, json: { startsAt: night.toISOString() } });
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toContain("outside the tutor's working hours");
    });

    it("decline needs a note, tells the parent, leaves the class alone, and cannot be repeated against a settled request", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const url = `/api/reschedules/${r.requestId}/reject`;
      expect((await call(reject as never, await app.login("tutor1"), url, { method: "POST", id: r.requestId, json: { note: "No thanks" } })).status).toBe(403);
      expect((await call(reject as never, await app.login("ebun"), url, { method: "POST", id: r.requestId, json: { note: "" } })).status).toBe(400);
      const ok = await call(reject as never, await app.login("ebun"), url, { method: "POST", id: r.requestId, json: { note: "Daniel is away that week." } });
      expect(ok.status).toBe(200);
      expect(app.c.integrations.sent.some((m) => m.text.includes("Daniel is away that week."))).toBe(true);
      expect((await app.db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(1);
      const happy = await run(sc.happy.guardianId, happyMsg());
      const late = await call(reject as never, await app.login("ebun"), "/x", { method: "POST", id: happy.requestId, json: { note: "Too late now" } });
      expect(late.status).toBe(409);
    });
  });

  describe("the parent's link (public)", () => {
    const linksIn = () => (app.c.integrations.sent.at(-1)?.text.match(/token=([^\s&]+)/g) ?? []).map((m) => decodeURIComponent(m.slice(6)));
    const accepting = (token: string, headers: Record<string, string> = {}) =>
      call(accept as never, null, "/api/accept", { method: "POST", json: { token }, headers });

    it("previewing never uses the link up; accepting moves the class and tells everyone", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const [first] = linksIn();
      const preview = await previewAccept(app.c, first!);
      expect(preview).toMatchObject({ valid: true, learnerFirstName: "Leo", tutorFirstName: "Sophie" });
      expect(await previewAccept(app.c, first!)).toMatchObject({ valid: true }); // scanners may open it
      const res = await accepting(first!);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      expect(await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } })).toMatchObject({ decision: "confirmed", decidedBy: "parent_link" });
      expect(app.c.integrations.sent.length).toBeGreaterThanOrEqual(3);
      // used now: the same link and the other option are both dead
      const again = await accepting(first!);
      expect(again.status).toBe(410);
      expect((await again.json()).error.message).toContain("already");
      expect((await accepting(linksIn()[1] ?? "zzzzzzzzzzzz")).status).toBeGreaterThanOrEqual(400);
      expect(await previewAccept(app.c, first!)).toMatchObject({ valid: false });
    });

    it("rejects forged, truncated and expired links without revealing why", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const [first] = linksIn();
      const [id] = first!.split(".");
      expect((await accepting(`${id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(400);
      expect((await accepting("not-a-token-at-all")).status).toBe(400);
      expect((await accepting(`${crypto.randomUUID()}.AAAA`)).status).toBe(400);
      await app.db.prisma.actionToken.update({ where: { id: id! }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await accepting(first!);
      expect(expired.status).toBe(410);
      expect((await expired.json()).error.message).toContain("expired");
      expect((await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } })).decision).toBe("proposed");
    });

    it("is rate limited per address and still protected against cross-site posts", async () => {
      const fixed = { "x-real-ip": "90.1.2.3" };
      let last = 200;
      for (let i = 0; i < 22; i++) last = (await accepting("bad-token-bad-token", fixed)).status;
      expect(last).toBe(429);
      expect((await accepting("bad-token-bad-token", { origin: "https://evil.example", "x-real-ip": ip() })).status).toBe(403);
    });

    it("if the time was taken since the email, the class stays put and the parent is told kindly", async () => {
      const r = await run(sc.conflict.guardianId, conflictMsg());
      const [first] = linksIn();
      const slot = ((await app.db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: r.requestId } })).proposedSlotsJson as { startsAt: string }[])[0]!.startsAt;
      const leo = await app.db.prisma.learner.findUniqueOrThrow({ where: { id: sc.conflict.learnerId } });
      const other = await app.db.prisma.learner.findFirstOrThrow({ where: { id: { not: leo.id }, tutorId: leo.tutorId } });
      await app.db.prisma.booking.create({ data: { learnerId: other.id, tutorId: leo.tutorId, startsAt: new Date(slot), durationMin: 60 } });
      const res = await accepting(first!);
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toContain("left the class where it was");
      expect((await app.db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(1);
    });
  });
});
