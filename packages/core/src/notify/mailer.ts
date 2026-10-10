import { createTransport } from "nodemailer";
import { z } from "zod";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(mail: OutgoingMail & { from: string }): Promise<{ messageId: string }>;
}

export interface MailResult {
  status: "sent" | "dry_run" | "failed";
  /** Where it actually went (or would have gone, in a dry run). Null when blocked. */
  deliveredTo: string | null;
  /** Set when the allowlist redirected the message: who it was meant for. */
  intendedTo: string | null;
  subject: string;
  body: string;
  messageId: string | null;
  error: string | null;
}

export interface MailerOptions {
  from: string;
  transport: MailTransport | null;
  dryRun: boolean;
  /** Lower-case addresses that may receive real mail. */
  allowlist: readonly string[];
  /** Everything not on the allowlist is redirected here. Must itself be on the allowlist. */
  demoInbox?: string;
}

const Address = z.string().email().max(254).refine((v) => !/[\r\n]/.test(v), "no line breaks in an address");

export function createSmtpTransport(o: { host: string; port: number; user?: string; pass?: string }): MailTransport {
  const t = createTransport({
    host: o.host, port: o.port, secure: o.port === 465,
    auth: o.user && o.pass ? { user: o.user, pass: o.pass } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return { send: async (m) => ({ messageId: (await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text })).messageId }) };
}

/**
 * The only way mail leaves the system. The allowlist decides the real recipient: a message for
 * anyone else is delivered to the demo inbox (clearly marked), or blocked if there is none, so a
 * demo can never reach a real parent. With dryRun nothing is sent at all.
 */
export function createMailer(o: MailerOptions): { send(mail: OutgoingMail): Promise<MailResult> } {
  const allow = new Set(o.allowlist.map((a) => a.toLowerCase()));
  const demo = o.demoInbox?.toLowerCase();
  if (demo && !allow.has(demo)) throw new Error("The demo inbox must be on the email allowlist");

  return {
    async send(mail) {
      const wanted = Address.safeParse(mail.to.trim());
      if (!wanted.success) {
        return { status: "failed", deliveredTo: null, intendedTo: null, subject: mail.subject, body: mail.text, messageId: null, error: "The recipient is not a valid email address." };
      }
      const intended = wanted.data.toLowerCase();
      const redirected = !allow.has(intended);
      const target = redirected ? demo : intended;
      if (!target) {
        return { status: "failed", deliveredTo: null, intendedTo: intended, subject: mail.subject, body: mail.text, messageId: null, error: "Blocked: the recipient is not on the email allowlist and there is no demo inbox to redirect to." };
      }
      const subject = (redirected ? `[demo: for ${intended}] ` : "") + mail.subject.replace(/[\r\n]+/g, " ");
      const text = redirected ? `(Demo mode: this message was meant for ${intended}.)\n\n${mail.text}` : mail.text;
      const base = { deliveredTo: target, intendedTo: redirected ? intended : null, subject, body: text };
      if (o.dryRun) return { ...base, status: "dry_run", messageId: null, error: null };
      if (!o.transport) return { ...base, status: "failed", messageId: null, error: "Email is not configured (SMTP settings are missing)." };
      try {
        const { messageId } = await o.transport.send({ from: o.from, to: target, subject, text });
        return { ...base, status: "sent", messageId, error: null };
      } catch (err) {
        // The provider's message can include the address or host; keep a safe, useful summary.
        const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "ERROR";
        return { ...base, status: "failed", messageId: null, error: `The mail server did not accept the message (${code}).` };
      }
    },
  };
}
