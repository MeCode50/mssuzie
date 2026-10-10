import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeContainer, ORIGIN, req } from "@/test/fake-container";
import { readJson } from "./body";
import { setContainer } from "./container";
import { ApiError, errors } from "./errors";
import { assertSameOrigin, handle, json } from "./http";
import { getClientIp } from "./ip";

describe("getClientIp", () => {
  it("uses the address the trusted proxy appended, never one the client supplied", () => {
    // behind one trusted proxy the LAST hop is the real client; anything before it was supplied by the client
    expect(getClientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(getClientIp(new Headers({ "x-forwarded-for": " 4.4.4.4 " }))).toBe("4.4.4.4");
    expect(getClientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7" }), 2)).toBe("8.8.8.8");
    expect(getClientIp(new Headers({ "x-forwarded-for": "7.7.7.7" }), 3)).toBe("7.7.7.7"); // fewer hops than expected: take what exists
    expect(getClientIp(new Headers({ "x-real-ip": "3.3.3.3, 5.5.5.5" }))).toBe("3.3.3.3"); // no proxy header: local runs and tests
    expect(getClientIp(new Headers({ "x-real-ip": "3.3.3.3", "x-forwarded-for": "6.6.6.6" }))).toBe("6.6.6.6"); // the proxy's word beats a client-sent X-Real-IP
    expect(getClientIp(new Headers({ "x-vercel-forwarded-for": "1.1.1.1" }))).toBe("unknown"); // no platform-specific header is trusted
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});

describe("assertSameOrigin", () => {
  const r = (method: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/x`, { method, headers });
  it("ignores safe methods", () => {
    expect(() => assertSameOrigin(r("GET", { origin: "https://evil.example" }), ORIGIN)).not.toThrow();
  });
  it("allows our own origin and non-browser clients (no Origin header)", () => {
    expect(() => assertSameOrigin(r("POST", { origin: ORIGIN }), ORIGIN)).not.toThrow();
    expect(() => assertSameOrigin(r("POST"), ORIGIN)).not.toThrow();
    expect(() => assertSameOrigin(r("POST", { "sec-fetch-site": "same-origin" }), ORIGIN)).not.toThrow();
  });
  it("blocks other origins and cross-site browser requests", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertSameOrigin(r(method, { origin: "https://evil.example" }), ORIGIN)).toThrow(ApiError);
    }
    expect(() => assertSameOrigin(r("POST", { "sec-fetch-site": "cross-site" }), ORIGIN)).toThrow(/didn't come from/);
  });
  it("blocks every browser POST when no allowed origin is configured", () => {
    expect(() => assertSameOrigin(r("POST", { origin: ORIGIN }), undefined)).toThrow(ApiError);
  });
});

describe("handle()", () => {
  let c: ReturnType<typeof fakeContainer>;
  beforeEach(() => setContainer((c = fakeContainer())));

  it("adds a request id and no-store, and logs one access line without bodies", async () => {
    const h = handle(async ({ fields }) => (fields.runId = "run-1", json({ ok: true })));
    const res = await h(req("/api/x?secret=1", { method: "GET", headers: { "x-request-id": "abc-12345678" } }));
    expect(res.headers.get("x-request-id")).toBe("abc-12345678");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({ msg: "request", method: "GET", path: "/api/x", status: 200, runId: "run-1", requestId: "abc-12345678" });
    expect(JSON.stringify(c.lines[0])).not.toContain("secret=1");
  });

  it("replaces a malformed incoming request id", async () => {
    const res = await handle(async () => json({}))(req("/api/x", { headers: { "x-request-id": "bad id!" } }));
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("turns ApiError into a stable JSON error with its status and headers", async () => {
    const res = await handle(async () => { throw errors.rateLimited("Slow down.", 42); })(req("/api/x"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Slow down." } });
  });

  it("turns zod errors into a readable 400", async () => {
    const res = await handle(async ({ req: r }) => json(await readJson(r, z.object({ n: z.number().min(1, "n is too small") }))))(
      req("/api/x", { method: "POST", json: { n: 0 }, headers: { origin: ORIGIN } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({ code: "validation_failed", message: "n is too small (n)." });
  });

  it("shows sentence-style validation messages as written, without the field suffix", async () => {
    const res = await handle(async ({ req: r }) => json(await readJson(r, z.object({ n: z.string().min(2, "Please enter a longer value.") }))))(
      req("/api/x", { method: "POST", json: { n: "a" }, headers: { origin: ORIGIN } }),
    );
    expect((await res.json()).error.message).toBe("Please enter a longer value.");
  });

  it("hides the details of unexpected errors from the client but logs them", async () => {
    const res = await handle(async () => { throw new Error("db password is hunter2"); })(req("/api/x"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toEqual({ code: "internal_error", message: "Something went wrong on our side. Please try again." });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(c.lines.some((l) => l.level === "error" && l.msg === "unhandled error in route")).toBe(true);
  });

  it("rejects cross-origin writes before running the handler", async () => {
    let ran = false;
    const res = await handle(async () => ((ran = true), json({})))(req("/api/x", { method: "POST", headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
    expect((await res.json()).error.code).toBe("forbidden_origin");
  });

  it("passes route params through", async () => {
    const res = await handle(async ({ params }) => json(params))(req("/api/runs/abc"), { params: Promise.resolve({ id: "abc" }) });
    expect(await res.json()).toEqual({ id: "abc" });
  });
});

describe("readJson", () => {
  const schema = z.object({ a: z.string() });
  it("requires a JSON content type", async () => {
    const r = new Request(`${ORIGIN}/x`, { method: "POST", body: '{"a":"x"}', headers: { "content-type": "text/plain" } });
    await expect(readJson(r, schema)).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
  });
  it("rejects malformed JSON and invalid shapes", async () => {
    const bad = new Request(`${ORIGIN}/x`, { method: "POST", body: "{oops", headers: { "content-type": "application/json" } });
    await expect(readJson(bad, schema)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(req("/x", { method: "POST", json: { a: 1 } }), schema)).rejects.toThrow();
  });
  it("caps the body size", async () => {
    const big = req("/x", { method: "POST", json: { a: "x".repeat(70_000) } });
    await expect(readJson(big, schema)).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
  });
  it("parses a valid body", async () => {
    await expect(readJson(req("/x", { method: "POST", json: { a: "hi" } }), schema)).resolves.toEqual({ a: "hi" });
  });
});
