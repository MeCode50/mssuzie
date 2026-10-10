import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkActionToken } from "../notify/action-links";
import { llmConfig } from "../pipeline/test-fixtures";
import { resetDemoData, seedAccounts, type DemoScenarioInfo } from "../seed/index";
import { findFreeSlots } from "../scheduling/availability";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing/test-db";
import { testIntegrations } from "../testing/integrations";
import { confirmSlot, rejectRequest } from "./confirm";
import { executeRescheduleRun } from "./execute";
import { loadScheduleFor } from "./load";
import { makeContext } from "./pipeline";
import { createRescheduleRequest } from "./requests";
import { blockers } from "./tools";

const KEY = Buffer.alloc(32, 9).toString("base64");
const SECRET = "t".repeat(40);
const seedEnv = {
  SEED_EBUN_EMAIL: "ebun@example.test", SEED_EBUN_PASSWORD: "ebun-password-123",
  SEED_OPS2_NAME: "Ops Two", SEED_OPS2_EMAIL: "ops2@example.test", SEED_OPS2_PASSWORD: "ops2-password-123",
  SEED_TUTOR1_NAME: "Daniel Reyes", SEED_TUTOR1_EMAIL: "tutor1@example.test", SEED_TUTOR1_PASSWORD: "tutor1-password-123",
  SEED_TUTOR2_NAME: "Sophie Lindqvist", SEED_TUTOR2_EMAIL: "tutor2@example.test", SEED_TUTOR2_PASSWORD: "tutor2-password-123",
};
const weekday = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("cccc");

describe.skipIf(!TEST_DATABASE_URL)("settling a request: parent link, Ops approve, Ops reject (real Postgres)", () => {
  let db: TestDb;
  let sc: DemoScenarioInfo;
  let integ = testIntegrations();
  const deps = (over: Partial<ReturnType<typeof testIntegrations>> & { now?: () => Date } = {}, prisma = db.prisma) => ({ prisma, ...integ, ...over, minNoticeHours: 12 });

  beforeAll(async () => {
    db = await createTestDb();
    await seedAccounts(db.prisma, seedEnv);
  });
  beforeEach(async () => {
    sc = await resetDemoData(db.prisma, KEY);
    integ = testIntegrations();
  });
  afterAll(async () => db.drop());

  async function run(guardianId: string, message: string) {
    const { requestId, runId } = await createRescheduleRequest(db.prisma, { guardianId, message, encryptionKey: KEY });
    await executeRescheduleRun({ prisma: db.prisma, llm: llmConfig(), encryptionKey: KEY, ...integ }, runId);
    integ.sent.length = 0;
    integ.calendar.calls = 0;
    return requestId;
  }
  const proposed = () => run(sc.conflict.guardianId, `Could Leo's ${weekday(sc.conflict.currentStartsAt, sc.conflict.guardianZone)} class move to 12 noon?`);
  const escalated = () => run(sc.escalation.guardianId, "Can Priya's class today move to tomorrow at 5pm please?");
  const offered = async (requestId: string) => ((await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).proposedSlotsJson as { startsAt: string }[]).map((s) => new Date(s.startsAt));
  const tokenFor = async (requestId: string, at: Date) => {
    const t = await db.prisma.actionToken.findFirstOrThrow({ where: { requestId, slotStartsAt: at } });
    return t.id;
  };
  const notes = (requestId: string) => db.prisma.notification.findMany({ where: { requestId }, orderBy: [{ toRole: "asc" }, { kind: "asc" }] });

  /** A free slot a day or so out, found the same way the policy does. */
  async function freeSlotFor(requestId: string, hoursAhead: number) {
    const { request, base } = await loadScheduleFor(db.prisma, requestId, { now: new Date(), minNoticeHours: 12 });
    const ctx = makeContext(base, request.bookingId);
    return findFreeSlots({
      windows: ctx.windows, tutorZone: ctx.tutorZone, booked: blockers(ctx), durationMin: ctx.durationMin,
      around: new Date(Date.now() + hoursAhead * 3_600_000), count: 1, searchHours: 48, notBefore: new Date(Date.now() + 3_600_000),
    })[0]!.startsAt;
  }

  describe("a parent chooses an offered time from the email link", () => {
    it("moves the booking, updates the calendar, tells both people, and voids the other links", async () => {
      const requestId = await proposed();
      const [first, second] = await offered(requestId);
      const tokenId = await tokenFor(requestId, first!);
      const res = await confirmSlot(deps(), { requestId, startsAt: first!, actor: { kind: "parent_link", tokenId } });
      expect(res).toMatchObject({ ok: true, alreadyApplied: false });
      const req = await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(req).toMatchObject({ decision: "confirmed", decidedBy: "parent_link" });
      expect(req.appliedToAt?.toISOString()).toBe(first!.toISOString());
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).startsAt.toISOString()).toBe(first!.toISOString());
      expect(integ.calendar.events.get(sc.conflict.bookingId.replace(/-/g, ""))?.startsAt.toISOString()).toBe(first!.toISOString());
      expect((await notes(requestId)).filter((n) => n.kind === "confirmed").map((n) => n.toRole)).toEqual(["parent", "tutor"]);
      // the other option's link no longer works
      const other = await tokenFor(requestId, second!);
      const row = await db.prisma.actionToken.findUniqueOrThrow({ where: { id: other } });
      expect(row.usedAt).not.toBeNull();
      expect((await checkActionToken(db.prisma, SECRET, `${other}.x`)).ok).toBe(false);
    });

    it("clicking twice is harmless: the second call changes and sends nothing", async () => {
      const requestId = await proposed();
      const [first] = await offered(requestId);
      const actor = { kind: "parent_link", tokenId: await tokenFor(requestId, first!) } as const;
      await confirmSlot(deps(), { requestId, startsAt: first!, actor });
      const before = { sent: integ.sent.length, version: (await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version };
      const again = await confirmSlot(deps(), { requestId, startsAt: first!, actor });
      expect(again).toMatchObject({ ok: true, alreadyApplied: true });
      expect(integ.sent).toHaveLength(before.sent);
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(before.version);
    });

    it("two different links at the same moment: exactly one wins, the other is told it is already settled", async () => {
      const requestId = await proposed();
      const [a, b] = await offered(requestId);
      const pool = db.connect(6);
      const results = await Promise.all([
        confirmSlot(deps({}, pool), { requestId, startsAt: a!, actor: { kind: "parent_link", tokenId: await tokenFor(requestId, a!) } }),
        confirmSlot(deps({}, pool), { requestId, startsAt: b!, actor: { kind: "parent_link", tokenId: await tokenFor(requestId, b!) } }),
      ]);
      await pool.$disconnect();
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, reason: expect.stringMatching(/not_open|stale/) });
      const booking = await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } });
      expect([a!.toISOString(), b!.toISOString()]).toContain(booking.startsAt.toISOString());
      expect(booking.version).toBe(2);
    });

    it("refuses a time that was never offered", async () => {
      const requestId = await proposed();
      const [first] = await offered(requestId);
      const bogus = new Date(first!.getTime() + 3_600_000 * 5);
      const res = await confirmSlot(deps(), { requestId, startsAt: bogus, actor: { kind: "parent_link", tokenId: await tokenFor(requestId, first!) } });
      expect(res).toEqual({ ok: false, reason: "not_offered" });
      expect(integ.calendar.calls).toBe(0);
    });

    it("refuses an offered time that the tutor has filled since the email was sent, and moves nothing", async () => {
      const requestId = await proposed();
      const [first] = await offered(requestId);
      const leo = await db.prisma.learner.findUniqueOrThrow({ where: { id: sc.conflict.learnerId } });
      const other = await db.prisma.learner.findFirstOrThrow({ where: { id: { not: leo.id }, tutorId: leo.tutorId } });
      await db.prisma.booking.create({ data: { learnerId: other.id, tutorId: leo.tutorId, startsAt: first!, durationMin: 60 } });
      const res = await confirmSlot(deps(), { requestId, startsAt: first!, actor: { kind: "parent_link", tokenId: await tokenFor(requestId, first!) } });
      expect(res).toMatchObject({ ok: false, reason: "slot_unavailable", problems: ["tutor_busy"] });
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(1);
      expect((await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision).toBe("proposed");
    });

    it("a parent who waits too long cannot pick a time that is now inside the notice window (only Ops can)", async () => {
      const requestId = await proposed();
      const [first] = await offered(requestId);
      const lateNow = () => new Date(first!.getTime() - 2 * 3_600_000);
      const tokenId = await tokenFor(requestId, first!);
      const res = await confirmSlot(deps({ now: lateNow }), { requestId, startsAt: first!, actor: { kind: "parent_link", tokenId } });
      expect(res).toMatchObject({ ok: false, reason: "slot_unavailable", problems: ["too_soon"] });
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(1);
      const byOps = await confirmSlot(deps({ now: lateNow }), { requestId, startsAt: first!, actor: { kind: "ops", userId: "u", name: "Ebun" } });
      expect(byOps).toMatchObject({ ok: true });
    });

    it("a link cannot settle an escalated request (only Ops can)", async () => {
      const requestId = await escalated();
      const slot = await freeSlotFor(requestId, 30);
      const tokenId = (await db.prisma.actionToken.create({ data: { requestId, slotStartsAt: slot, expiresAt: new Date(Date.now() + 3_600_000) } })).id;
      expect(await confirmSlot(deps(), { requestId, startsAt: slot, actor: { kind: "parent_link", tokenId } })).toEqual({ ok: false, reason: "not_open" });
    });
  });

  describe("Ops approve a time", () => {
    const ops = { kind: "ops", userId: "u1", name: "Ebun" } as const;

    it("can settle an escalated request on a free time, even inside the notice window", async () => {
      const requestId = await escalated();
      const slot = await freeSlotFor(requestId, 5); // well inside the 12h notice
      expect(slot.getTime() - Date.now()).toBeLessThan(12 * 3_600_000);
      const res = await confirmSlot(deps(), { requestId, startsAt: slot, actor: ops });
      expect(res).toMatchObject({ ok: true, alreadyApplied: false });
      expect(await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ decision: "confirmed", decidedBy: "ops:Ebun" });
      expect(integ.calendar.events.get(sc.escalation.bookingId.replace(/-/g, ""))?.startsAt.toISOString()).toBe(slot.toISOString());
    });

    it("still refuses a time outside the tutor's hours, a clash, or the past", async () => {
      const requestId = await escalated();
      const night = DateTime.now().plus({ days: 2 }).setZone("Africa/Lagos").set({ hour: 3, minute: 0, second: 0, millisecond: 0 }).toUTC().toJSDate();
      expect(await confirmSlot(deps(), { requestId, startsAt: night, actor: ops })).toMatchObject({ ok: false, reason: "slot_unavailable", problems: expect.arrayContaining(["outside_hours"]) });
      expect(await confirmSlot(deps(), { requestId, startsAt: new Date(Date.now() - 3_600_000), actor: ops })).toEqual({ ok: false, reason: "in_the_past" });
      const clash = sc.happy.currentStartsAt; // Amara's class: the same tutor
      expect(await confirmSlot(deps(), { requestId, startsAt: clash, actor: ops })).toMatchObject({ ok: false, reason: "slot_unavailable", problems: expect.arrayContaining(["tutor_busy"]) });
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.escalation.bookingId } })).version).toBe(1);
    });

    it("cannot approve a request that has no resolved class", async () => {
      const requestId = await run(sc.happy.guardianId, "Please move the class to 7pm");
      const slot = await freeSlotFor(await run(sc.escalation.guardianId, "hi"), 30).catch(() => new Date(Date.now() + 86_400_000));
      const req = await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(req.bookingId).toBeNull();
      expect(await confirmSlot(deps(), { requestId, startsAt: slot, actor: ops })).toEqual({ ok: false, reason: "no_booking" });
    });
  });

  describe("Ops reject with a note", () => {
    it("records the note, tells the parent, leaves the booking alone, voids the links; repeating is harmless", async () => {
      const requestId = await proposed();
      const res = await rejectRequest(deps(), { requestId, userName: "Ebun", note: "Daniel is away that week." });
      expect(res).toMatchObject({ ok: true, alreadyRejected: false });
      expect(await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ decision: "rejected", decidedBy: "ops:Ebun", reason: "Daniel is away that week." });
      expect((await db.prisma.booking.findUniqueOrThrow({ where: { id: sc.conflict.bookingId } })).version).toBe(1);
      expect(await db.prisma.actionToken.count({ where: { requestId, usedAt: null } })).toBe(0);
      const mail = integ.sent.find((m) => m.subject.includes("About Leo"));
      expect(mail?.text).toContain("Daniel is away that week.");
      const sentBefore = integ.sent.length;
      expect(await rejectRequest(deps(), { requestId, userName: "Ebun", note: "again" })).toMatchObject({ ok: true, alreadyRejected: true });
      expect(integ.sent).toHaveLength(sentBefore);
      // and a rejected request can no longer be approved
      const [first] = await offered(requestId);
      expect(await confirmSlot(deps(), { requestId, startsAt: first!, actor: { kind: "ops", userId: "u", name: "Ebun" } })).toEqual({ ok: false, reason: "not_open" });
    });

    it("cannot reject a request that was already carried out", async () => {
      const requestId = await run(sc.happy.guardianId, `Hi, can we move Amara's 7am class on ${weekday(sc.happy.currentStartsAt, sc.happy.guardianZone)} to 7pm please?`);
      expect(await db.prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ decision: "auto_applied" });
      expect(await rejectRequest(deps(), { requestId, userName: "Ebun", note: "no" })).toEqual({ ok: false, reason: "not_open" });
    });
  });
});
