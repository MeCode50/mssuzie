import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeRun, loadLlmConfig, type LlmConfig } from "@mssuzie/core";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { startTestApp, unique, type TestApp } from "@/test/app";
import { GET as list } from "./learners/route";
import { GET as detail } from "./learners/[id]/route";
import { POST as createSession } from "./sessions/route";
import { GET as getRun } from "./runs/[id]/route";

const names = (body: { learners: { displayName: string }[] }) => body.learners.map((l) => l.displayName);

describe.skipIf(!TEST_DATABASE_URL)("learner endpoints (real Postgres)", () => {
  let app: TestApp;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    app = await startTestApp({ RUNS_PER_USER_PER_DAY: "1000", RUNS_PER_IP_PER_10_MIN: "1000" });
    for (const l of await app.db.prisma.learner.findMany()) ids[l.displayName.split(" ")[0]!] = l.id;
  });
  afterAll(async () => app.close());

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const getList = (cookie: string | null, query = "") => list(app.as(cookie, `/api/learners${query}`));
  const getDetail = (cookie: string | null, id: string) => detail(app.as(cookie, `/api/learners/${id}`), params(id));
  const llm = (): LlmConfig => loadLlmConfig(app.c.env);

  describe("GET /api/learners", () => {
    it("requires sign-in", async () => {
      expect((await getList(null)).status).toBe(401);
    });

    it("shows tutors only their own learners and ops everyone", async () => {
      expect(names(await (await getList(await app.login("tutor1"))).json()).sort()).toEqual(["Amara Okafor", "Priya Nair"]);
      expect(names(await (await getList(await app.login("tutor2"))).json()).sort()).toEqual(["Leo Hartmann", "Tomás Silva", "Zainab Bello"]);
      expect((await (await getList(await app.login("ebun"))).json()).learners).toHaveLength(5);
    });

    it("puts at-risk first, then watch, then on-track; name breaks ties", async () => {
      const body = await (await getList(await app.login("ops2"))).json();
      expect(names(body)).toEqual(["Leo Hartmann", "Priya Nair", "Zainab Bello", "Amara Okafor", "Tomás Silva"]);
      expect(body.counts).toEqual({ on_track: 2, watch: 2, at_risk: 1 });
    });

    it("filters by status, keeping the counts for the filter chips unfiltered", async () => {
      const body = await (await getList(await app.login("ops2"), "?status=at_risk")).json();
      expect(names(body)).toEqual(["Leo Hartmann"]);
      expect(body.counts).toEqual({ on_track: 2, watch: 2, at_risk: 1 });
      const bad = await getList(await app.login("ops2"), "?status=terrible");
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.message).toBe("status must be one of on_track, watch or at_risk.");
    });

    it("gives each card its plan, next exam, last session and open alert", async () => {
      const body = await (await getList(await app.login("ebun"))).json();
      const leo = body.learners.find((l: { displayName: string }) => l.displayName === "Leo Hartmann");
      expect(leo).toMatchObject({
        status: "at_risk", planHoursPerWeek: 2, grade: "Year 4", tutorName: "Sophie Lindqvist",
        nextEvent: { type: "assignment", title: "Reading journal, 3 entries" }, openAlert: { severity: "high" },
      });
      expect(new Date(leo.lastSessionAt).getTime()).toBeLessThan(Date.now());
      const priya = body.learners.find((l: { displayName: string }) => l.displayName === "Priya Nair");
      expect(priya.nextEvent.title).toBe("GCSE Chemistry mock, paper 2"); // the soonest of her two exams
      expect(priya.openAlert).toBeNull();
    });

    it("never exposes guardian contact details or notes", async () => {
      const text = JSON.stringify(await (await getList(await app.login("ebun"))).json());
      expect(text).not.toMatch(/@example\.com|\+44|7700|guardian|notes/i);
    });
  });

  describe("GET /api/learners/:id", () => {
    it("requires sign-in and treats bad or foreign ids as 404", async () => {
      expect((await getDetail(null, ids.Amara!)).status).toBe(401);
      const tutor2 = await app.login("tutor2");
      expect((await getDetail(tutor2, ids.Amara!)).status).toBe(404); // belongs to tutor1
      expect((await getDetail(tutor2, "nope")).status).toBe(404);
      expect((await getDetail(tutor2, crypto.randomUUID())).status).toBe(404);
      expect((await getDetail(await app.login("tutor1"), ids.Amara!)).status).toBe(200);
    });

    it("returns profile, skill series over time, session timeline and open alerts", async () => {
      const body = await (await getDetail(await app.login("ebun"), ids.Leo!)).json();
      expect(body.learner).toMatchObject({ displayName: "Leo Hartmann", age: 9, status: "at_risk", planHoursPerWeek: 2 });
      expect(body.sessions).toHaveLength(5);
      const heldAt = body.sessions.map((s: { heldAt: string }) => new Date(s.heldAt).getTime());
      expect(heldAt).toEqual([...heldAt].sort((a, b) => b - a)); // newest first
      expect(body.sessions[0].latestRun).toBeNull();
      const comprehension = body.skills.find((s: { skill: string }) => s.skill === "reading comprehension");
      expect(comprehension.points.map((p: { mastery: number }) => p.mastery)).toEqual([0.4, 0.42, 0.4, 0.36, 0.3]);
      expect(comprehension).toMatchObject({ latest: 0.3, change: -0.1 });
      const dates = comprehension.points.map((p: { date: string }) => new Date(p.date).getTime());
      expect(dates).toEqual([...dates].sort((a: number, b: number) => a - b)); // oldest first for charting
      expect(body.openAlerts).toHaveLength(1);
      expect(body.upcomingEvents[0].title).toBe("Reading journal, 3 entries");
      expect(body.currentPlan).toBeNull();
    });

    it("shows an improving learner's rise, and the seeded approved parent update", async () => {
      const body = await (await getDetail(await app.login("tutor1"), ids.Amara!)).json();
      const eq = body.skills.find((s: { skill: string }) => s.skill === "solving linear equations");
      expect(eq.change).toBeGreaterThan(0.15);
      expect(body.latestParentUpdate).toMatchObject({ status: "approved" });
      expect(body.latestParentUpdate.body).toContain("Hi Ngozi");
    });

    it("gives guardian names to ops only and never any contact details", async () => {
      const asOps = await (await getDetail(await app.login("ebun"), ids.Amara!)).json();
      const asTutor = await (await getDetail(await app.login("tutor1"), ids.Amara!)).json();
      expect(asOps.learner.guardianNames).toEqual(["Ngozi Okafor"]);
      expect(asTutor.learner.guardianNames).toBeUndefined();
      for (const body of [asOps, asTutor]) expect(JSON.stringify(body)).not.toMatch(/@example\.com|\+44|7700/);
    });

    it("never returns the session notes", async () => {
      const text = JSON.stringify(await (await getDetail(await app.login("ebun"), ids.Leo!)).json());
      expect(text).not.toMatch(/notes|Hartmann family|moved down a reading group/);
    });

    it("turns placeholder tokens in a stored plan into plain words (real model plans contain them)", async () => {
      const session = await app.db.prisma.tutoringSession.findFirstOrThrow({ where: { learnerId: ids["Tomás"] } });
      const run = await app.db.prisma.run.create({ data: { sessionId: session.id, idempotencyKey: unique(), status: "completed" } });
      await app.db.prisma.runStep.create({
        data: {
          runId: run.id, seq: 1, agent: "learning_planner", status: "completed",
          outputJson: {
            summary: "Build confidence for [CHILD_1] ahead of the check.",
            sessions: [{ date: "2026-10-12", durationMin: 30, focusSkill: "vowel digraphs", goal: "[CHILD_1] reads ten ou/ow words aloud", reason: "[GUARDIAN_1] asked for more phonics" }],
          },
        },
      });
      const body = await (await getDetail(await app.login("tutor2"), ids["Tomás"]!)).json();
      expect(body.currentPlan.summary).toBe("Build confidence for the learner ahead of the check.");
      expect(body.currentPlan.sessions[0]).toMatchObject({ goal: "the learner reads ten ou/ow words aloud", reason: "their parent asked for more phonics" });
    });

    it("after a real run: current plan and new draft appear, with tokens turned into plain words", async () => {
      const cookie = await app.login("tutor1");
      const res = await createSession(app.as(cookie, "/api/sessions", {
        method: "POST", headers: { "idempotency-key": `key-${unique()}`, "x-real-ip": "70.0.0.1" },
        json: { learnerId: ids.Amara, notes: "Amara Okafor did well at Oakfield Academy in Leeds. Ngozi was pleased. Daniel Reyes set homework." },
      }));
      const { runId } = await res.json();
      await executeRun({ prisma: app.db.prisma, llm: llm(), encryptionKey: app.env.ENCRYPTION_KEY }, runId);

      const body = await (await getDetail(cookie, ids.Amara!)).json();
      expect(body.currentPlan).toMatchObject({ runId });
      expect(body.currentPlan.sessions.length).toBeGreaterThan(0);
      expect(body.latestParentUpdate).toMatchObject({ runId, status: "draft" });
      expect(body.latestParentUpdate.body).toContain("Hi Ngozi,");
      const justData = JSON.stringify({ skills: body.skills, plan: body.currentPlan, alerts: body.openAlerts });
      expect(justData).not.toMatch(/\[[A-Z]+_\d+\]/);
      expect(justData).not.toMatch(/Oakfield|Okafor|Ngozi|Reyes/);
      const evidence = body.skills.flatMap((s: { points: { evidence: string }[] }) => s.points.map((p) => p.evidence));
      expect(evidence.some((e: string) => e.includes("the learner did well at their school in their town"))).toBe(true);

      // the run view humanizes results too, but the Privacy tab keeps the raw placeholders on purpose
      const run = await (await getRun(app.as(cookie, `/api/runs/${runId}`), params(runId))).json();
      expect(JSON.stringify(run.results.analysis)).not.toMatch(/\[[A-Z]+_\d+\]/);
      expect(run.results.privacy.redactedNotes).toContain("[CHILD_1]");
    });
  });
});
