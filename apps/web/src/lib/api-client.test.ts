import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiClientError, createRun, makeKeyKeeper } from "./api-client";

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());

/** Await a request that must fail and return its error. */
async function failure(p: Promise<unknown>): Promise<ApiClientError> {
  try {
    await p;
  } catch (e) {
    return e as ApiClientError;
  }
  throw new Error("expected the request to fail");
}

describe("apiFetch", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", respond(200, { ok: 1 }));
    await expect(apiFetch("/api/x")).resolves.toEqual({ ok: 1 });
  });

  it("sends JSON, the idempotency key and same-origin credentials", async () => {
    const f = respond(201, { runId: "r" });
    vi.stubGlobal("fetch", f);
    await createRun({ learnerId: "l", notes: "n" }, "key-12345678");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sessions");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ learnerId: "l", notes: "n" }) });
    const h = new Headers(init.headers);
    expect(h.get("idempotency-key")).toBe("key-12345678");
    expect(h.get("content-type")).toBe("application/json");
  });

  it("turns the server's error envelope into an ApiClientError with its plain-language message", async () => {
    vi.stubGlobal("fetch", respond(429, { error: { code: "rate_limited", message: "You've reached today's limit of 30 session runs. Please try again tomorrow." } }));
    const err = await failure(apiFetch("/api/x"));
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 429, code: "rate_limited", message: "You've reached today's limit of 30 session runs. Please try again tomorrow." });
  });

  it("says the session ended on a 401, whatever the body", async () => {
    vi.stubGlobal("fetch", respond(401, { error: { code: "unauthenticated", message: "Please sign in to continue." } }));
    expect((await failure(apiFetch("/api/x"))).message).toBe("Your session has ended. Please sign in again.");
  });

  it("copes with a non-JSON error body and with being offline", async () => {
    vi.stubGlobal("fetch", respond(502, "<html>Bad gateway</html>"));
    expect(await failure(apiFetch("/api/x"))).toMatchObject({ status: 502, message: "Something went wrong. Please try again." });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await failure(apiFetch("/api/x"))).toMatchObject({ status: 0, code: "offline" });
  });
});

describe("makeKeyKeeper", () => {
  it("reuses the key for the same content and issues a new one when the content changes", () => {
    let n = 0;
    const keyFor = makeKeyKeeper(() => `k${++n}`);
    expect(keyFor("a", "notes")).toBe("k1");
    expect(keyFor("a", "notes")).toBe("k1");
    expect(keyFor("a", "notes!")).toBe("k2");
    expect(keyFor("b", "notes!")).toBe("k3");
    expect(keyFor("b", "notes!")).toBe("k3");
  });
});
