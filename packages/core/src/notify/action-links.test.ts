import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing";
import { ACTION_LINK_TTL_MS, checkActionToken, consumeActionToken, issueActionToken, voidActionTokens } from "./action-links";

const SECRET = "s".repeat(40);

describe.skipIf(!TEST_DATABASE_URL)("action links (real Postgres)", () => {
  let db: TestDb;
  let requestId: string;
  beforeAll(async () => {
    db = await createTestDb();
    const tutor = await db.prisma.user.create({ data: { id: randomUUID(), name: "T", email: "t@example.com", role: "tutor" } });
    const learner = await db.prisma.learner.create({
      data: { displayName: "Amara", age: 12, grade: "Y8", subjects: [], interests: [], planHoursPerWeek: 3, tutorId: tutor.id },
    });
    const g = await db.prisma.guardian.create({ data: { learnerId: learner.id, name: "G", email: "g@example.com", phone: "+10000000" } });
    requestId = (await db.prisma.rescheduleRequest.create({ data: { guardianId: g.id, rawMessageEnc: "x" } })).id;
  });
  afterAll(async () => db.drop());

  const slot = new Date("2026-10-20T10:00:00Z");

  it("accepts a fresh token and returns the request and slot it was issued for", async () => {
    const t = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: slot });
    const c = await checkActionToken(db.prisma, SECRET, t);
    expect(c).toMatchObject({ ok: true, requestId });
    if (c.ok) expect(c.slotStartsAt.toISOString()).toBe(slot.toISOString());
  });

  it("is single-use: the second consume loses", async () => {
    const t = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: slot });
    const c = await checkActionToken(db.prisma, SECRET, t);
    if (!c.ok) throw new Error("expected ok");
    const [a, b] = await Promise.all([consumeActionToken(db.prisma, c.tokenId), consumeActionToken(db.prisma, c.tokenId)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await checkActionToken(db.prisma, SECRET, t)).toEqual({ ok: false, reason: "used" });
  });

  it("expires after 48 hours", async () => {
    const issued = new Date("2026-10-10T00:00:00Z");
    const t = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: slot, now: issued });
    expect((await checkActionToken(db.prisma, SECRET, t, new Date(issued.getTime() + ACTION_LINK_TTL_MS - 1000))).ok).toBe(true);
    expect(await checkActionToken(db.prisma, SECRET, t, new Date(issued.getTime() + ACTION_LINK_TTL_MS))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered signature, a different secret, and garbage", async () => {
    const t = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: slot });
    const [id] = t.split(".");
    expect(await checkActionToken(db.prisma, SECRET, `${id}.AAAA`)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await checkActionToken(db.prisma, "o".repeat(40), t)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await checkActionToken(db.prisma, SECRET, "nope")).toEqual({ ok: false, reason: "malformed" });
    expect(await checkActionToken(db.prisma, SECRET, `${t}.extra`)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a well-signed id that does not exist is unknown (no information leak beyond that)", async () => {
    const { createHmac } = await import("node:crypto");
    const id = randomUUID();
    const sig = createHmac("sha256", SECRET).update(id).digest("base64url");
    expect(await checkActionToken(db.prisma, SECRET, `${id}.${sig}`)).toEqual({ ok: false, reason: "unknown" });
  });

  it("voiding a request's links disables all of them", async () => {
    const t1 = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: slot });
    const t2 = await issueActionToken(db.prisma, SECRET, { requestId, slotStartsAt: new Date(slot.getTime() + 3_600_000) });
    await voidActionTokens(db.prisma, requestId);
    expect(await checkActionToken(db.prisma, SECRET, t1)).toEqual({ ok: false, reason: "used" });
    expect(await checkActionToken(db.prisma, SECRET, t2)).toEqual({ ok: false, reason: "used" });
  });
});
