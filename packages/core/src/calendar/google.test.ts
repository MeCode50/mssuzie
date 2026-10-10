import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleCalendar, parseServiceAccount } from "./google";
import { CalendarError, eventIdForBooking } from "./port";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const b64 = Buffer.from(JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: privateKey })).toString("base64");

interface Call { url: string; method: string; body?: string; auth?: string }
function fakeGoogle(script: (c: Call, n: number) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const c: Call = { url, method: init.method ?? "GET", body: init.body?.toString(), auth: (init.headers as Record<string, string> | undefined)?.authorization };
    calls.push(c);
    if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    const r = script(c, calls.filter((x) => !x.url.includes("oauth2")).length);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const make = (g: ReturnType<typeof fakeGoogle>) =>
  new GoogleCalendar({ serviceAccountJsonBase64: b64, calendarId: "cal@group.calendar.google.com", fetchImpl: g.fetchImpl, sleep: async () => undefined });
const event = { eventId: eventIdForBooking("11111111-2222-3333-4444-555555555555"), title: "Class", startsAt: new Date("2026-10-12T18:00:00Z"), durationMin: 60 };

describe("GoogleCalendar", () => {
  it("signs a JWT assertion for the token request and patches an existing event with UTC times", async () => {
    const g = fakeGoogle(() => ({ status: 200 }));
    await make(g).upsertEvent(event);
    const tokenCall = g.calls[0]!;
    const assertion = new URLSearchParams(tokenCall.body).get("assertion")!;
    const [h, c, s] = assertion.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: "svc@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/calendar.events" });
    expect(s!.length).toBeGreaterThan(100);
    const patch = g.calls[1]!;
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toContain("/calendars/cal%40group.calendar.google.com/events/11111111222233334444555555555555");
    expect(patch.auth).toBe("Bearer tok");
    expect(JSON.parse(patch.body!)).toMatchObject({ start: { dateTime: "2026-10-12T18:00:00.000Z" }, end: { dateTime: "2026-10-12T19:00:00.000Z" }, status: "confirmed" });
  });

  it("creates the event with the booking-derived id when it does not exist yet", async () => {
    const g = fakeGoogle((c) => (c.method === "PATCH" ? { status: 404 } : { status: 200 }));
    expect(await make(g).upsertEvent(event)).toBe(event.eventId);
    const post = g.calls.at(-1)!;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body!).id).toBe(event.eventId);
  });

  it("retries 5xx and 429 with backoff, then succeeds", async () => {
    const g = fakeGoogle((_c, n) => (n < 3 ? { status: n === 1 ? 503 : 429 } : { status: 200 }));
    await make(g).upsertEvent(event);
    expect(g.calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
  });

  it("gives up after the attempt cap with a retryable error", async () => {
    const g = fakeGoogle(() => ({ status: 503 }));
    await expect(make(g).upsertEvent(event)).rejects.toMatchObject({ name: "CalendarError", retryable: true });
    expect(g.calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
  });

  it("403 is not retried and tells the operator to share the calendar", async () => {
    const g = fakeGoogle(() => ({ status: 403 }));
    const err = await make(g).upsertEvent(event).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarError);
    expect((err as CalendarError).retryable).toBe(false);
    expect((err as CalendarError).message).toContain("shared with the service account");
    expect(g.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("reuses the access token across calls", async () => {
    const g = fakeGoogle(() => ({ status: 200 }));
    const cal = make(g);
    await cal.upsertEvent(event);
    await cal.upsertEvent(event);
    expect(g.calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
  });

  it("a bad key file fails without echoing the value", () => {
    const bad = Buffer.from(JSON.stringify({ private_key: "SECRET-KEY-MATERIAL" })).toString("base64");
    expect(() => parseServiceAccount(bad)).toThrow(/not a valid/);
    try { parseServiceAccount(bad); } catch (e) { expect(String(e)).not.toContain("SECRET-KEY-MATERIAL"); }
  });
});
