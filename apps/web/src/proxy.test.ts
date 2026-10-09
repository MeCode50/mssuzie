import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { buildCsp, proxy } from "./proxy";

const page = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });
const SESSION = "better-auth.session_token=abc.def";

describe("page CSP", () => {
  it("allows scripts only with a per-request nonce, and forbids framing, plugins and foreign connections", () => {
    const csp = buildCsp("NONCE123", false);
    expect(csp).toContain("script-src 'self' 'nonce-NONCE123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    for (const d of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "upgrade-insecure-requests"]) {
      expect(csp).toContain(d);
    }
  });

  it("only relaxes script-src for development tooling in dev", () => {
    expect(buildCsp("n", true)).toMatch(/script-src[^;]*unsafe-eval/);
    expect(buildCsp("n", true)).not.toContain("upgrade-insecure-requests");
    expect(buildCsp("n", false)).not.toContain("unsafe-eval");
  });
});

describe("proxy", () => {
  it("sends a signed-out visitor to /login, remembering where they were going", () => {
    const res = proxy(page("/runs/abc?tab=plan"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe("/runs/abc?tab=plan");
    expect(new URL(proxy(page("/")).headers.get("location")!).searchParams.has("next")).toBe(false);
  });

  it("lets the login page through without a session, with a CSP", () => {
    const res = proxy(page("/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
  });

  it("lets a request with a session cookie through and hands the nonce to the page via a request header", () => {
    const res = proxy(page("/sessions/new", SESSION));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("uses a different nonce for every request", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => /'nonce-([^']+)'/.exec(proxy(page("/login")).headers.get("content-security-policy")!)![1]));
    expect(nonces.size).toBe(20);
  });
});
