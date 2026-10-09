import { beforeEach, describe, expect, it } from "vitest";
import { fakeContainer, req } from "@/test/fake-container";
import { setContainer } from "@/lib/container";
import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => setContainer(null));

  it("reports ok when the database answers, with no auth and no version details", async () => {
    setContainer(fakeContainer({ $queryRaw: async () => [{ "?column?": 1 }] }));
    const res = await GET(req("/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", db: "ok" });
    expect(Object.keys(body).sort()).toEqual(["db", "status", "time"]);
  });

  it("reports 503 degraded when the database is down, without leaking the error", async () => {
    setContainer(fakeContainer({ $queryRaw: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); } }));
    const res = await GET(req("/api/health"));
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("degraded");
    expect(text).not.toContain("10.0.0.5");
  });
});
