import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer, type HealthReport } from "./health";

let server: Server | null = null;
afterEach(() => void server?.close());

async function ask(report: HealthReport, path = "/health", method = "GET") {
  server = await startHealthServer(0, () => report, "127.0.0.1");
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("worker health endpoint", () => {
  it("answers 200 while the worker is healthy", async () => {
    expect(await ask({ ok: true, state: "running", activeRuns: 1 })).toEqual({ status: 200, body: { status: "ok", ok: true, state: "running", activeRuns: 1 } });
  });
  it("answers 503 when the worker is stalled or draining, so the platform can act", async () => {
    expect((await ask({ ok: false, state: "stalled" })).status).toBe(503);
    server?.close();
    expect((await ask({ ok: false, state: "draining" })).status).toBe(503);
  });
  it("serves nothing else: other paths and methods are 404", async () => {
    expect((await ask({ ok: true }, "/runs")).status).toBe(404);
    server?.close();
    expect((await ask({ ok: true }, "/health", "POST")).status).toBe(404);
  });
});
