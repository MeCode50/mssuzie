import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { startTestApp, unique, type TestApp } from "@/test/app";
import { POST as approve } from "./parent-updates/[id]/approve/route";
import { GET as listAlerts } from "./alerts/route";
import { POST as resolve } from "./alerts/[id]/resolve/route";
import { POST as resetDemo } from "./demo/reset/route";
import { GET as listLearners } from "./learners/route";

describe.skipIf(!TEST_DATABASE_URL)("ops actions (real Postgres)", () => {
  let app: TestApp;
  beforeAll(async () => void (app = await startTestApp()));
  afterAll(async () => app.close());

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const ip = () => `80.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const post = (handler: typeof approve, cookie: string | null, path: string, id: string, json: unknown = {}, headers: Record<string, string> = {}) =>
    handler(app.as(cookie, path, { method: "POST", json, headers: { "x-real-ip": ip(), ...headers } }), params(id));
  const code = async (res: Response) => (await res.json()).error?.code;

  const draft = async (body = "Hi Ngozi, a draft.") => {
    const learner = await app.db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Amara" } } });
    return app.db.prisma.parentUpdate.create({ data: { learnerId: learner.id, body } });
  };
  const alert = async (over: Record<string, unknown> = {}) => {
    const learner = await app.db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Zainab" } } });
    return app.db.prisma.alert.create({
      data: { learnerId: learner.id, severity: "medium", reason: "[CHILD_1] is losing confidence.", intervention: "Call [GUARDIAN_1].", ...over },
    });
  };

  describe("POST /api/parent-updates/:id/approve", () => {
    it("is for signed-in ops only", async () => {
      const u = await draft();
      const url = `/api/parent-updates/${u.id}/approve`;
      expect((await post(approve, null, url, u.id)).status).toBe(401);
      const asTutor = await post(approve, await app.login("tutor1"), url, u.id);
      expect(asTutor.status).toBe(403);
      expect((await asTutor.json()).error.message).toBe("Only the MsSuzie ops team can do this.");
      expect((await app.db.prisma.parentUpdate.findUniqueOrThrow({ where: { id: u.id } })).status).toBe("draft");
    });

    it("approves a draft and records who and when", async () => {
      const u = await draft();
      const ops = await app.db.prisma.user.findUniqueOrThrow({ where: { email: "ebun@example.test" } });
      const res = await post(approve, await app.login("ebun"), `/api/parent-updates/${u.id}/approve`, u.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: u.id, status: "approved", approvedBy: "Ebun" });
      const row = await app.db.prisma.parentUpdate.findUniqueOrThrow({ where: { id: u.id } });
      expect(row).toMatchObject({ status: "approved", approvedBy: ops.id });
      expect(row.approvedAt).toBeInstanceOf(Date);
      expect(row.body).toBe("Hi Ngozi, a draft."); // the text is never changed by approval
    });

    it("refuses a second approval, a bad id, an unknown id and a cross-origin post", async () => {
      const u = await draft();
      const cookie = await app.login("ops2");
      const url = `/api/parent-updates/${u.id}/approve`;
      expect((await post(approve, cookie, url, u.id)).status).toBe(200);
      const again = await post(approve, cookie, url, u.id);
      expect(again.status).toBe(409);
      expect((await again.json()).error.message).toBe("This parent update has already been approved.");
      expect((await post(approve, cookie, "/x", "nope")).status).toBe(404);
      expect((await post(approve, cookie, "/x", crypto.randomUUID())).status).toBe(404);
      const u2 = await draft();
      const evil = await post(approve, cookie, url, u2.id, {}, { origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect((await app.db.prisma.parentUpdate.findUniqueOrThrow({ where: { id: u2.id } })).status).toBe("draft");
    });

    it("of six simultaneous approvals exactly one wins", async () => {
      const u = await draft();
      const cookie = await app.login("ebun");
      const results = await Promise.all(Array.from({ length: 6 }, () => post(approve, cookie, `/x`, u.id)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    });

    it("logs the approval without the message text", async () => {
      const u = await draft("Hi Ngozi, very-private-draft-text-xyz");
      await post(approve, await app.login("ebun"), "/x", u.id);
      const line = app.c.lines.find((l) => l.msg === "parent update approved" && l.parentUpdateId === u.id);
      expect(line).toBeDefined();
      expect(JSON.stringify(app.c.lines)).not.toContain("very-private-draft-text-xyz");
    });
  });

  describe("GET /api/alerts", () => {
    const get = (cookie: string | null, query = "") => listAlerts(app.as(cookie, `/api/alerts${query}`));

    it("is for ops only", async () => {
      expect((await get(null)).status).toBe(401);
      expect((await get(await app.login("tutor2"))).status).toBe(403);
      expect((await get(await app.login("ebun"))).status).toBe(200);
    });

    it("lists open alerts with learner, reason and intervention, high severity first", async () => {
      await alert({ severity: "medium" });
      const body = await (await get(await app.login("ebun"))).json();
      expect(body.alerts[0]).toMatchObject({ severity: "high", status: "open", learner: { displayName: "Leo Hartmann", status: "at_risk", tutorName: "Sophie Lindqvist" } });
      expect(body.alerts[0].reason).toMatch(/Comprehension scores have fallen/);
      expect(body.alerts[0].intervention).toMatch(/call the family/i);
      expect(body.alerts.map((a: { severity: string }) => a.severity)).toEqual(["high", "medium"]);
      expect(body.openCount).toBe(2);
    });

    it("humanizes placeholder tokens and rejects an unknown status filter", async () => {
      const body = await (await get(await app.login("ebun"))).json();
      const medium = body.alerts.find((a: { severity: string }) => a.severity === "medium");
      expect(medium.reason).toBe("the learner is losing confidence.");
      expect(medium.intervention).toBe("Call their parent.");
      const bad = await get(await app.login("ebun"), "?status=maybe");
      expect(bad.status).toBe(400);
    });
  });

  describe("POST /api/alerts/:id/resolve", () => {
    it("is for ops only and needs a real note", async () => {
      const a = await alert();
      const url = `/api/alerts/${a.id}/resolve`;
      expect((await post(resolve, null, url, a.id, { note: "done" })).status).toBe(401);
      expect((await post(resolve, await app.login("tutor2"), url, a.id, { note: "done" })).status).toBe(403);
      const ops = await app.login("ops2");
      for (const note of ["", "   ", undefined]) {
        const res = await post(resolve, ops, url, a.id, { note });
        expect(res.status).toBe(400);
      }
      const long = await post(resolve, ops, url, a.id, { note: "x".repeat(1001) });
      expect(long.status).toBe(400);
      expect((await long.json()).error.message).toMatch(/at most 1,000 characters/);
      expect((await app.db.prisma.alert.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("open");
    });

    it("resolves with the note, who and when; the learner card stops showing it", async () => {
      const learner = await app.db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Leo" } } });
      const leoAlert = await app.db.prisma.alert.findFirstOrThrow({ where: { learnerId: learner.id, status: "open" } });
      const res = await post(resolve, await app.login("ebun"), "/x", leoAlert.id, { note: "  Called Katrin; agreed smaller goals.  " });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "resolved", resolvedBy: "Ebun", resolutionNote: "Called Katrin; agreed smaller goals." });
      const row = await app.db.prisma.alert.findUniqueOrThrow({ where: { id: leoAlert.id } });
      expect(row).toMatchObject({ status: "resolved", resolutionNote: "Called Katrin; agreed smaller goals." });
      expect(row.resolvedAt).toBeInstanceOf(Date);
      const learners = await (await listLearners(app.as(await app.login("ebun"), "/api/learners"))).json();
      expect(learners.learners.find((l: { displayName: string }) => l.displayName === "Leo Hartmann").openAlert).toBeNull();
      const resolvedList = await (await listAlerts(app.as(await app.login("ebun"), "/api/alerts?status=resolved"))).json();
      expect(resolvedList.alerts.map((a: { id: string }) => a.id)).toContain(leoAlert.id);
    });

    it("refuses a second resolution and handles bad ids; six simultaneous resolves have one winner", async () => {
      const a = await alert();
      const cookie = await app.login("ebun");
      const results = await Promise.all(Array.from({ length: 6 }, () => post(resolve, cookie, "/x", a.id, { note: "handled" })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
      expect((await results.find((r) => r.status === 409)!.json()).error.message).toBe("This alert has already been resolved.");
      expect((await post(resolve, cookie, "/x", "nope", { note: "x" })).status).toBe(404);
      expect((await post(resolve, cookie, "/x", crypto.randomUUID(), { note: "x" })).status).toBe(404);
    });
  });

  describe("POST /api/demo/reset", () => {
    const reset = (cookie: string | null, body: unknown = { confirm: "reset demo data" }) =>
      resetDemo(app.as(cookie, "/api/demo/reset", { method: "POST", json: body, headers: { "x-real-ip": ip() } }));
    beforeEach(async () => void (await app.db.prisma.rateLimit.deleteMany()));

    it("is for ops only and needs the confirmation phrase", async () => {
      expect((await reset(null)).status).toBe(401);
      expect((await reset(await app.login("tutor1"))).status).toBe(403);
      const ops = await app.login("ebun");
      for (const body of [{}, { confirm: "yes" }, { confirm: "reset everything" }]) {
        const res = await reset(ops, body);
        expect(res.status).toBe(400);
      }
      expect((await (await reset(ops, { confirm: "yes" })).json()).error.message).toBe('Type "reset demo data" to confirm.');
      expect(await app.db.prisma.learner.count()).toBe(5);
    });

    it("refuses while a run is queued or running, and changes nothing", async () => {
      const session = await app.db.prisma.tutoringSession.findFirstOrThrow();
      const busy = await app.db.prisma.run.create({ data: { sessionId: session.id, idempotencyKey: unique() } });
      const res = await reset(await app.login("ebun"));
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toBe("A run is still in progress. Please wait for it to finish, then reset the demo.");
      expect(await app.db.prisma.run.count()).toBe(1);
      await app.db.prisma.run.delete({ where: { id: busy.id } });
    });

    it("restores the seed data, removes runs and edits, and keeps accounts and sign-ins", async () => {
      const cookie = await app.login("ebun");
      const learner = await app.db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Amara" } } });
      const session = await app.db.prisma.tutoringSession.findFirstOrThrow({ where: { learnerId: learner.id } });
      await app.db.prisma.run.create({ data: { sessionId: session.id, idempotencyKey: unique(), status: "completed" } });
      await app.db.prisma.learner.update({ where: { id: learner.id }, data: { currentStatus: "at_risk", displayName: "Edited Name" } });
      await app.db.prisma.alert.updateMany({ data: { status: "resolved" } });
      await app.db.prisma.parentUpdate.deleteMany();
      const usersBefore = await app.db.prisma.user.count();

      const res = await reset(cookie);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "reset", learners: 5, sessions: 25, openAlerts: 1 });
      expect(await app.db.prisma.run.count()).toBe(0);
      expect(await app.db.prisma.parentUpdate.count()).toBe(2);
      expect(await app.db.prisma.learner.findFirst({ where: { displayName: "Edited Name" } })).toBeNull();
      expect((await app.db.prisma.learner.findFirstOrThrow({ where: { displayName: { startsWith: "Amara" } } })).currentStatus).toBe("on_track");
      expect(await app.db.prisma.user.count()).toBe(usersBefore);
      // the signed-in session still works after a reset
      expect((await listLearners(app.as(cookie, "/api/learners"))).status).toBe(200);
      expect(app.c.lines.some((l) => l.msg === "demo reset finished" && l.level === "warn")).toBe(true);
    });

    it("is rate limited to 3 resets per 10 minutes per user", async () => {
      const ops = await app.login("ops2");
      expect([(await reset(ops)).status, (await reset(ops)).status, (await reset(ops)).status]).toEqual([200, 200, 200]);
      const fourth = await reset(ops);
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await reset(await app.login("ebun"))).status).toBe(200); // another user is unaffected
    });
  });
});
