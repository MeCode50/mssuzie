import { describe, expect, it } from "vitest";
import { createMailer, type MailTransport } from "./mailer";

function transport(fail?: Error) {
  const sent: { to: string; subject: string; text: string; from: string }[] = [];
  const t: MailTransport = {
    async send(m) {
      if (fail) throw fail;
      sent.push(m);
      return { messageId: `id-${sent.length}` };
    },
  };
  return { t, sent };
}
const base = { from: "MsSuzie <noreply@example.com>", allowlist: ["me@example.com", "ops@example.com"], demoInbox: "me@example.com" };
const mail = { to: "parent@real.example", subject: "Class moved", text: "Hello" };

describe("mailer", () => {
  it("delivers to an allowlisted address as is", async () => {
    const { t, sent } = transport();
    const r = await createMailer({ ...base, transport: t, dryRun: false }).send({ ...mail, to: "Ops@Example.com" });
    expect(r).toMatchObject({ status: "sent", deliveredTo: "ops@example.com", intendedTo: null, messageId: "id-1" });
    expect(sent[0]).toMatchObject({ to: "ops@example.com", subject: "Class moved", text: "Hello" });
  });

  it("redirects anyone else to the demo inbox and says who it was for", async () => {
    const { t, sent } = transport();
    const r = await createMailer({ ...base, transport: t, dryRun: false }).send(mail);
    expect(r).toMatchObject({ status: "sent", deliveredTo: "me@example.com", intendedTo: "parent@real.example" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("me@example.com");
    expect(sent[0]!.subject).toContain("parent@real.example");
    expect(sent[0]!.text).toContain("meant for parent@real.example");
  });

  it("blocks (and sends nothing) when there is no demo inbox", async () => {
    const { t, sent } = transport();
    const r = await createMailer({ from: base.from, allowlist: base.allowlist, transport: t, dryRun: false }).send(mail);
    expect(r).toMatchObject({ status: "failed", deliveredTo: null, intendedTo: "parent@real.example" });
    expect(sent).toHaveLength(0);
  });

  it("an empty allowlist never delivers to a real address", async () => {
    const { t, sent } = transport();
    const r = await createMailer({ from: base.from, allowlist: [], transport: t, dryRun: false }).send(mail);
    expect(r.status).toBe("failed");
    expect(sent).toHaveLength(0);
  });

  it("dry run records the redirect but never calls the transport", async () => {
    const { t, sent } = transport();
    const r = await createMailer({ ...base, transport: t, dryRun: true }).send(mail);
    expect(r).toMatchObject({ status: "dry_run", deliveredTo: "me@example.com", intendedTo: "parent@real.example", messageId: null });
    expect(sent).toHaveLength(0);
  });

  it("rejects header-injection and malformed recipients", async () => {
    const { t, sent } = transport();
    const m = createMailer({ ...base, transport: t, dryRun: false });
    for (const to of ["a@b.com\r\nBcc: x@y.com", "not-an-email", "", "a@b.com, c@d.com"]) {
      expect((await m.send({ ...mail, to })).status).toBe("failed");
    }
    expect(sent).toHaveLength(0);
  });

  it("strips line breaks from the subject", async () => {
    const { t, sent } = transport();
    await createMailer({ ...base, transport: t, dryRun: false }).send({ ...mail, to: "me@example.com", subject: "Hi\r\nBcc: x@y.com" });
    expect(sent[0]!.subject).toBe("Hi Bcc: x@y.com");
  });

  it("a transport failure becomes a failed result without leaking the provider's text", async () => {
    const err = Object.assign(new Error("550 rejected parent@real.example host smtp.secret"), { code: "EENVELOPE" });
    const { t } = transport(err);
    const r = await createMailer({ ...base, transport: t, dryRun: false }).send({ ...mail, to: "me@example.com" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("EENVELOPE");
    expect(r.error).not.toContain("smtp.secret");
  });

  it("reports missing SMTP configuration rather than pretending to send", async () => {
    const r = await createMailer({ ...base, transport: null, dryRun: false }).send({ ...mail, to: "me@example.com" });
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toContain("not configured");
  });

  it("refuses a demo inbox that is not on the allowlist", () => {
    expect(() => createMailer({ from: base.from, allowlist: ["a@example.com"], demoInbox: "b@example.com", transport: null, dryRun: true })).toThrow();
  });
});
