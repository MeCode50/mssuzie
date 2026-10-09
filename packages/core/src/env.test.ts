import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({ ...base });
    expect(env.DAILY_SPEND_CAP_USD).toBe(5);
    expect(env.RUNS_PER_USER_PER_DAY).toBe(30);
    expect(env.MOCK_LLM).toBe(false);
  });

  it("allows MOCK_LLM outside production", () => {
    expect(loadEnv({ ...base, NODE_ENV: "test", MOCK_LLM: "1" }).MOCK_LLM).toBe(true);
  });

  it("refuses to start with MOCK_LLM in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", MOCK_LLM: "1" })).toThrow(/MOCK_LLM/);
    expect(() => loadEnv({ ...base, NODE_ENV: "production", MOCK_LLM: "true" })).toThrow(/MOCK_LLM/);
  });

  it("treats blank values as unset", () => {
    const env = loadEnv({ ...base, OPENAI_MODEL_MAIN: "", DAILY_SPEND_CAP_USD: "" });
    expect(env.OPENAI_MODEL_MAIN).toBeUndefined();
    expect(env.DAILY_SPEND_CAP_USD).toBe(5);
  });

  it("rejects a bad encryption key", () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_KEY: "short" })).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects a missing database url", () => {
    expect(() => loadEnv({ ENCRYPTION_KEY: base.ENCRYPTION_KEY })).toThrow(/DATABASE_URL/);
  });
});
