import { describe, expect, it } from "vitest";
import config, { apiSecurityHeaders, baseSecurityHeaders } from "../next.config";

describe("security headers", () => {
  it("applies the baseline to every route and the strict CSP to the API", async () => {
    const rules = await config.headers!();
    expect(rules).toEqual([
      { source: "/:path*", headers: baseSecurityHeaders },
      { source: "/api/:path*", headers: apiSecurityHeaders },
    ]);
  });

  it("sets the headers a security review looks for", () => {
    const map = Object.fromEntries(baseSecurityHeaders.map((h) => [h.key, h.value]));
    expect(map["Strict-Transport-Security"]).toMatch(/max-age=63072000; includeSubDomains/);
    expect(map["X-Content-Type-Options"]).toBe("nosniff");
    expect(map["X-Frame-Options"]).toBe("DENY");
    expect(map["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(map["Permissions-Policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(map["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("denies everything by default for API responses and forbids framing", () => {
    const csp = apiSecurityHeaders[0]!.value;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it("does not advertise the framework", () => {
    expect(config.poweredByHeader).toBe(false);
  });
});
