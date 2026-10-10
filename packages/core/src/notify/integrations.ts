import { FakeCalendar } from "../calendar/fake";
import { GoogleCalendar } from "../calendar/google";
import { CalendarError, type CalendarService } from "../calendar/port";
import type { Env } from "../env";
import { createMailer, createSmtpTransport } from "./mailer";
import type { Mailer } from "./notifier";

export interface Integrations {
  calendar: CalendarService;
  mailer: Mailer;
  linkSecret?: string;
  baseUrl: string;
  /** Plain-language summary for the startup log: never contains secrets or addresses. */
  describe: { calendar: "google" | "fake" | "unconfigured"; email: "smtp" | "dry_run" | "unconfigured" };
}

/** A calendar that fails loudly (and visibly on the trace) rather than pretending to work. */
class UnconfiguredCalendar implements CalendarService {
  async upsertEvent(): Promise<string> {
    throw new CalendarError("Google Calendar is not set up (GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 and GOOGLE_CALENDAR_ID).", false);
  }
}

/**
 * Build the calendar and the mailer from the environment. In MOCK_LLM mode (tests, demos without
 * credentials) nothing external is ever touched: an in-memory calendar and dry-run email.
 */
export function createIntegrations(env: Env): Integrations {
  const hasGoogle = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && env.GOOGLE_CALENDAR_ID);
  const hasSmtp = Boolean(env.SMTP_HOST);
  const dryRun = env.EMAIL_DRY_RUN || env.MOCK_LLM;

  const calendar: CalendarService = env.MOCK_LLM
    ? new FakeCalendar()
    : hasGoogle
      ? new GoogleCalendar({ serviceAccountJsonBase64: env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64!, calendarId: env.GOOGLE_CALENDAR_ID! })
      : new UnconfiguredCalendar();

  const mailer = createMailer({
    from: env.EMAIL_FROM ?? "MsSuzie <noreply@localhost>",
    transport: hasSmtp && !env.MOCK_LLM ? createSmtpTransport({ host: env.SMTP_HOST!, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS }) : null,
    dryRun, allowlist: env.EMAIL_ALLOWLIST, demoInbox: env.DEMO_INBOX,
  });

  return {
    calendar, mailer, linkSecret: env.ACTION_LINK_SECRET, baseUrl: env.BETTER_AUTH_URL ?? "http://localhost:3000",
    describe: {
      calendar: env.MOCK_LLM ? "fake" : hasGoogle ? "google" : "unconfigured",
      email: dryRun ? "dry_run" : hasSmtp ? "smtp" : "unconfigured",
    },
  };
}
