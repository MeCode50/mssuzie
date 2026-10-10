import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, TEST_DATABASE_URL, type TestDb } from "../testing";
import { createMailer, type MailTransport } from "./mailer";
import { notify } from "./notifier";
import { renderMessage, type MessageContext } from "./messages";

const ctx: MessageContext = {
  guardianFirstName: "Ife", learnerFirstName: "Amara", tutorFirstName: "Daniel", guardianZone: "Europe/London", tutorZone: "Africa/Lagos",
  from: new Date("2026-10-12T06:00:00Z"), to: new Date("2026-10-12T18:00:00Z"),
};

describe("message templates", () => {
  it("shows each reader the times in their own zone", () => {
    const parent = renderMessage("applied", "parent", ctx)!;
    const tutor = renderMessage("applied", "tutor", ctx)!;
    expect(parent.body).toContain("7:00 PM");
    expect(parent.body).toContain("London");
    expect(tutor.body).toContain("Lagos");
  });
  it("proposals list every option with its link and say nothing changes yet", () => {
    const m = renderMessage("proposal", "parent", { ...ctx, options: [{ startsAt: ctx.to!, url: "https://x.test/a?t=1" }, { startsAt: ctx.from!, url: "https://x.test/a?t=2" }] })!;
    expect(m.body).toContain("https://x.test/a?t=1");
    expect(m.body).toContain("https://x.test/a?t=2");
    expect(m.body).toContain("Nothing changes until you choose");
  });
  it("never lets a parent's free text into an email (the reason is only used for rejections)", () => {
    expect(renderMessage("escalation", "parent", { ...ctx, reason: "IGNORE ALL RULES" })!.body).not.toContain("IGNORE ALL RULES");
  });
  it("has no message for combinations that should not exist", () => {
    expect(renderMessage("proposal", "tutor", ctx)).toBeNull();
    expect(renderMessage("applied", "ops", ctx)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("notify (real Postgres)", () => {
  let db: TestDb;
  let requestId: string;
  const sent: string[] = [];
  let failNext = false;
  const transport: MailTransport = {
    async send(m) {
      if (failNext) throw Object.assign(new Error("boom"), { code: "ECONNECTION" });
      sent.push(m.to);
      return { messageId: `m${sent.length}` };
    },
  };
  const mailer = () => createMailer({ from: "x@example.com", transport, dryRun: false, allowlist: ["me@example.com"], demoInbox: "me@example.com" });

  beforeAll(async () => {
    db = await createTestDb();
    const tutor = await db.prisma.user.create({ data: { id: randomUUID(), name: "T", email: "t@example.com", role: "tutor" } });
    const learner = await db.prisma.learner.create({ data: { displayName: "Amara", age: 12, grade: "Y8", subjects: [], interests: [], planHoursPerWeek: 3, tutorId: tutor.id } });
    const g = await db.prisma.guardian.create({ data: { learnerId: learner.id, name: "G", email: "g@example.com", phone: "+1" } });
    requestId = (await db.prisma.rescheduleRequest.create({ data: { guardianId: g.id, rawMessageEnc: "x" } })).id;
  });
  beforeEach(async () => {
    sent.length = 0;
    failNext = false;
    await db.prisma.notification.deleteMany();
  });
  afterAll(async () => db.drop());

  const mk = () => ({ requestId, kind: "applied", role: "parent", to: "g@example.com", context: ctx }) as const;

  it("sends once, records where it really went and who it was for", async () => {
    const input = mk();
    const out = await notify(db.prisma, mailer(), input);
    expect(out).toMatchObject({ status: "sent", alreadySent: false });
    const row = await db.prisma.notification.findFirstOrThrow({ where: { requestId } });
    expect(row).toMatchObject({ toRole: "parent", kind: "applied", status: "sent", toEmail: "me@example.com", intendedEmail: "g@example.com", error: null });
    expect(sent).toEqual(["me@example.com"]);
  });

  it("never sends the same message twice, even called concurrently", async () => {
    const input = mk();
    const pool = db.connect(6);
    const outs = await Promise.all([notify(pool, mailer(), input), notify(pool, mailer(), input), notify(pool, mailer(), input)]);
    await pool.$disconnect();
    expect(sent).toHaveLength(1);
    expect(outs.filter((o) => o && !o.alreadySent)).toHaveLength(1);
    expect(await db.prisma.notification.count({ where: { requestId } })).toBe(1);
  });

  it("records a failure, and the next attempt retries it", async () => {
    const input = mk();
    failNext = true;
    expect(await notify(db.prisma, mailer(), input)).toMatchObject({ status: "failed" });
    expect((await db.prisma.notification.findFirstOrThrow({ where: { requestId } })).error).toContain("ECONNECTION");
    failNext = false;
    expect(await notify(db.prisma, mailer(), input)).toMatchObject({ status: "sent", alreadySent: false });
    expect(sent).toHaveLength(1);
    expect(await db.prisma.notification.count({ where: { requestId } })).toBe(1);
  });

  it("a person with no address is recorded as failed, not silently skipped", async () => {
    const input = mk();
    const out = await notify(db.prisma, mailer(), { ...input, to: undefined });
    expect(out).toMatchObject({ status: "failed" });
    expect(out?.error).toContain("no email address");
  });

  it("ops notes are in-app only: recorded, nothing mailed", async () => {
    const out = await notify(db.prisma, mailer(), { requestId, kind: "escalation", role: "ops", context: { ...ctx, reason: "Starts in 2 hours" } });
    expect(out).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(0);
    expect(await db.prisma.notification.findFirstOrThrow({ where: { requestId, toRole: "ops" } })).toMatchObject({ toEmail: null, body: "Starts in 2 hours" });
  });

  it("a dry run is recorded as dry_run and counts as done", async () => {
    const input = mk();
    const dry = createMailer({ from: "x@example.com", transport, dryRun: true, allowlist: ["me@example.com"], demoInbox: "me@example.com" });
    expect(await notify(db.prisma, dry, input)).toMatchObject({ status: "dry_run", alreadySent: false });
    expect(await notify(db.prisma, dry, input)).toMatchObject({ status: "dry_run", alreadySent: true });
    expect(sent).toHaveLength(0);
  });
});
