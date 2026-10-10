import { createSign } from "node:crypto";
import { z } from "zod";
import { CalendarError, eventEnd, type CalendarEventInput, type CalendarService } from "./port";

const KeySchema = z.object({ client_email: z.string().email(), private_key: z.string().min(1), token_uri: z.string().url().default("https://oauth2.googleapis.com/token") });
export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export interface GoogleCalendarOptions {
  serviceAccountJsonBase64: string;
  calendarId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function parseServiceAccount(base64: string): z.infer<typeof KeySchema> {
  try {
    return KeySchema.parse(JSON.parse(Buffer.from(base64, "base64").toString("utf8")));
  } catch {
    // Never echo the value: it contains a private key.
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not a valid base64-encoded service-account key file");
  }
}

const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/**
 * Google Calendar v3 over REST with a service account (OAuth 2.0 JWT bearer grant, RFC 7523).
 * Docs: developers.google.com/identity/protocols/oauth2/service-account#httprest and
 * developers.google.com/calendar/api/v3/reference/events (insert / patch).
 */
export class GoogleCalendar implements CalendarService {
  private readonly key: z.infer<typeof KeySchema>;
  private readonly http: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly o: GoogleCalendarOptions) {
    this.key = parseServiceAccount(o.serviceAccountJsonBase64);
    this.http = o.fetchImpl ?? fetch;
  }

  private now = () => (this.o.now ?? Date.now)();

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const iat = Math.floor(this.now() / 1000);
    const claims = { iss: this.key.client_email, scope: SCOPE, aud: this.key.token_uri, iat, exp: iat + 3600 };
    const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key).toString("base64url");
    const res = await this.send(this.key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new CalendarError(`Google sign-in failed (${res.status}). Check the service account key.`, res.status >= 500);
    const body = z.object({ access_token: z.string(), expires_in: z.number() }).parse(await res.json());
    this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    } catch {
      throw new CalendarError("Could not reach Google Calendar (network or timeout).", true);
    }
  }

  /** One authorised call with retry on 429/5xx (exponential backoff). */
  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const attempts = this.o.maxAttempts ?? 3;
    const sleep = this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 1; ; i++) {
      try {
        const res = await this.send(`${API}/calendars/${encodeURIComponent(this.o.calendarId)}${path}`, {
          method,
          headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if ((res.status === 429 || res.status >= 500) && i < attempts) {
          await sleep(500 * 2 ** (i - 1));
          continue;
        }
        if (res.status === 401) this.token = null;
        return res;
      } catch (err) {
        if (err instanceof CalendarError && err.retryable && i < attempts) {
          await sleep(500 * 2 ** (i - 1));
          continue;
        }
        throw err;
      }
    }
  }

  async upsertEvent(event: CalendarEventInput): Promise<string> {
    const times = {
      start: { dateTime: event.startsAt.toISOString(), timeZone: "UTC" },
      end: { dateTime: eventEnd(event).toISOString(), timeZone: "UTC" },
    };
    const id = encodeURIComponent(event.eventId);
    // Update first (the common case: the class is already on the calendar). status:confirmed also
    // revives an event someone deleted by hand.
    const patched = await this.call("PATCH", `/events/${id}`, { summary: event.title, ...times, status: "confirmed" });
    if (patched.ok) return event.eventId;
    if (patched.status !== 404) throw this.failure("update", patched);
    const created = await this.call("POST", "/events", { id: event.eventId, summary: event.title, ...times });
    if (created.ok) return event.eventId;
    throw this.failure("create", created);
  }

  private failure(what: string, res: Response): CalendarError {
    const hint = res.status === 403 || res.status === 404 ? " Is the calendar shared with the service account with “Make changes to events”?" : "";
    return new CalendarError(`Google Calendar refused to ${what} the event (${res.status}).${hint}`, res.status === 429 || res.status >= 500);
  }
}
