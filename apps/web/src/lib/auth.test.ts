import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "@mssuzie/core/testing";
import { GET as authGET, POST as authPOST } from "@/app/api/auth/[...all]/route";
import { EMAILS, PASSWORDS, startTestApp, type TestApp } from "@/test/app";
import { ORIGIN, req } from "@/test/fake-container";
import { createAuth } from "./auth";
import { handle, json } from "./http";
import { learnerScope, requireActor, requireOps } from "./session";

const whoami = handle(async (ctx) => json(await requireActor(ctx)));
const opsOnly = handle(async (ctx) => (await requireOps(ctx), json({ ok: true })));

describe.skipIf(!TEST_DATABASE_URL)("auth (real Postgres + Better Auth)", () => {
  let app: TestApp;
  beforeAll(async () => void (app = await startTestApp()));
  afterAll(async () => app.close());

  const signIn = (email: string, password: string, ip: string) =>
    authPOST(req("/api/auth/sign-in/email", { method: "POST", json: { email, password }, headers: { origin: ORIGIN, "x-real-ip": ip } }));

  it("signs a seeded user in and issues an httpOnly, SameSite=Lax session cookie", async () => {
    const res = await signIn(EMAILS.ebun, PASSWORDS.ebun, "20.0.0.1");
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // http://localhost in tests
  });

  it("marks cookies Secure (and prefixed) when the app is served over https", async () => {
    const https = createAuth(app.db.prisma, { ...app.env, BETTER_AUTH_URL: "https://copilot.example.com" });
    const res = await https.api.signInEmail({ body: { email: EMAILS.ebun, password: PASSWORDS.ebun }, headers: new Headers({ "x-real-ip": "20.0.0.2" }), asResponse: true });
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/__Secure-/);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("gives the same answer for a wrong password and an unknown email (no account enumeration)", async () => {
    const wrong = await signIn(EMAILS.ebun, "not-the-right-password", "20.0.0.3");
    const unknown = await signIn("nobody@example.test", "not-the-right-password", "20.0.0.3");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("has no public sign-up: the endpoint refuses and creates no user", async () => {
    const before = await app.db.prisma.user.count();
    const res = await authPOST(req("/api/auth/sign-up/email", {
      method: "POST", json: { email: "new@example.test", password: "a-long-enough-password", name: "New" },
      headers: { origin: ORIGIN, "x-real-ip": "20.0.0.4" },
    }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await app.db.prisma.user.count()).toBe(before);
    expect(await app.db.prisma.user.findUnique({ where: { email: "new@example.test" } })).toBeNull();
  });

  it("rejects unauthenticated requests with a plain 401", async () => {
    const res = await whoami(app.as(null, "/api/x"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toEqual({ code: "unauthenticated", message: "Please sign in to continue." });
  });

  it("resolves the actor with role from the session cookie", async () => {
    const ops = await (await whoami(app.as(await app.login("ebun"), "/api/x"))).json();
    const tutor = await (await whoami(app.as(await app.login("tutor1"), "/api/x"))).json();
    expect(ops).toMatchObject({ role: "ops", email: EMAILS.ebun });
    expect(tutor).toMatchObject({ role: "tutor", email: EMAILS.tutor1 });
  });

  it("lets ops through ops-only routes and gives tutors a 403", async () => {
    expect((await opsOnly(app.as(await app.login("ops2"), "/api/x"))).status).toBe(200);
    const res = await opsOnly(app.as(await app.login("tutor2"), "/api/x"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("Only the MsSuzie ops team can do this.");
  });

  it("scopes learners: tutors see only their own, ops see all", async () => {
    const ctx = (cookie: string) => ({ req: app.as(cookie, "/api/x"), params: {}, c: app.c, log: app.c.logger, requestId: "t", ip: "x", fields: {} });
    const tutor = await requireActor(ctx(await app.login("tutor1")));
    const ops = await requireActor(ctx(await app.login("ebun")));
    const mine = await app.db.prisma.learner.findMany({ where: learnerScope(tutor) });
    const all = await app.db.prisma.learner.findMany({ where: learnerScope(ops) });
    expect(all).toHaveLength(5);
    expect(mine.map((l) => l.displayName).sort()).toEqual(["Amara Okafor", "Priya Nair"]);
  });

  it("cannot be used to change a role: the field is not accepted as input", async () => {
    const cookie = await app.login("tutor1");
    await authPOST(app.as(cookie, "/api/auth/update-user", { method: "POST", json: { role: "ops", name: "Daniel Reyes" }, headers: { "x-real-ip": "20.0.0.5" } }));
    const u = await app.db.prisma.user.findUniqueOrThrow({ where: { email: EMAILS.tutor1 } });
    expect(u.role).toBe("tutor");
    expect((await opsOnly(app.as(cookie, "/api/x"))).status).toBe(403);
  });

  it("stops working after sign-out", async () => {
    const cookie = await app.login("tutor2");
    expect((await whoami(app.as(cookie, "/api/x"))).status).toBe(200);
    await authPOST(app.as(cookie, "/api/auth/sign-out", { method: "POST", json: {}, headers: { "x-real-ip": "20.0.0.6" } }));
    expect((await whoami(app.as(cookie, "/api/x"))).status).toBe(401);
  });

  it("throttles login attempts per IP (10 a minute) and not other IPs", async () => {
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push((await signIn(EMAILS.ebun, "wrong-password-here", "30.0.0.9")).status);
    expect(results.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(results.slice(10)).toEqual([429, 429]);
    expect((await signIn(EMAILS.ebun, PASSWORDS.ebun, "30.0.0.10")).status).toBe(200);
  });

  it("answers GET /api/auth/get-session through the mounted handler", async () => {
    const res = await authGET(app.as(await app.login("ebun"), "/api/auth/get-session"));
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe(EMAILS.ebun);
  });

  it("never logs credentials", async () => {
    await signIn(EMAILS.ebun, "super-secret-wrong-password", "20.0.0.7");
    expect(JSON.stringify(app.c.lines)).not.toContain("super-secret-wrong-password");
  });
});
