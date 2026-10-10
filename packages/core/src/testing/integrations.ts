import { FakeCalendar } from "../calendar/fake";
import { createMailer, type MailTransport } from "../notify/mailer";

/** Calendar and mailer stand-ins for tests: nothing leaves the process; every send is recorded. */
export function testIntegrations(over: { dryRun?: boolean; allowlist?: string[]; demoInbox?: string } = {}) {
  const calendar = new FakeCalendar();
  const sent: { to: string; subject: string; text: string }[] = [];
  const transport: MailTransport = {
    async send(m) {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
      return { messageId: `test-${sent.length}` };
    },
  };
  const mailer = createMailer({
    from: "MsSuzie <noreply@example.com>", transport, dryRun: over.dryRun ?? false,
    allowlist: over.allowlist ?? ["inbox@example.com"], demoInbox: over.demoInbox ?? "inbox@example.com",
  });
  return { calendar, mailer, sent, linkSecret: "t".repeat(40), baseUrl: "http://localhost:3000" };
}
