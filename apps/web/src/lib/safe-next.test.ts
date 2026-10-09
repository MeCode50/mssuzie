import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site paths, including query strings", () => {
    expect(safeNext("/runs/abc?tab=plan")).toBe("/runs/abc?tab=plan");
    expect(safeNext("/sessions/new")).toBe("/sessions/new");
  });
  it.each([
    null, undefined, "", "runs/abc", "//evil.example", "/\\evil.example", "https://evil.example", "/x?u=https://evil.example",
    "javascript:alert(1)", "/login", "/login?next=/x",
  ])("falls back to home for %s", (bad) => {
    expect(safeNext(bad as string | null | undefined)).toBe("/");
  });
});
