import { describe, expect, it } from "vitest";
import { counterState, MAX_NOTES } from "./notes-counter";

describe("counterState", () => {
  it("is calm well under the limit, with no announcement", () => {
    expect(counterState(0)).toEqual({ tone: "ok", text: "0 / 8,000", announce: "" });
    expect(counterState(7199)).toMatchObject({ tone: "ok", announce: "" });
  });
  it("warns from 90% and says how many are left", () => {
    expect(counterState(7200)).toEqual({ tone: "near", text: "7,200 / 8,000 · 800 left", announce: "800 characters left." });
    expect(counterState(MAX_NOTES).tone).toBe("near");
    expect(counterState(MAX_NOTES).text).toBe("8,000 / 8,000 · 0 left");
  });
  it("is an error over the limit and says by how much", () => {
    expect(counterState(8001)).toEqual({ tone: "over", text: "8,001 / 8,000 · 1 over the limit", announce: "1 characters over the limit. Please shorten the notes." });
    expect(counterState(8500).tone).toBe("over");
  });
});
