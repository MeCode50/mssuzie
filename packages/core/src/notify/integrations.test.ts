import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../env";
import { createIntegrations } from "./integrations";

const KEY = Buffer.alloc(32, 7).toString("base64");
const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/x", ENCRYPTION_KEY: KEY, LLM_API_KEY: "x", LLM_MODEL_MAIN: "m", LLM_MODEL_SMALL: "s" };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const goodKey = Buffer.from(JSON.stringify({ client_email: "svc@p.iam.gserviceaccount.com", private_key: privateKey })).toString("base64");
const env = (extra: Record<string, string>) => loadEnv({ ...base, ...extra });
const event = { eventId: "abc12345", title: "t", startsAt: new Date("2026-10-12T18:00:00Z"), durationMin: 60 };

describe("createIntegrations: calendar", () => {
  it("uses Google when the key is valid", () => {
    expect(createIntegrations(env({ GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: goodKey, GOOGLE_CALENDAR_ID: "c@group.calendar.google.com" })).describe.calendar).toBe("google");
  });

  it("a mangled key does NOT stop the app from starting: it is reported, and each calendar step explains itself", async () => {
    const broken = createIntegrations(env({ GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: "ewogICJ0eXBlIjogIm-garbled-not-a-key", GOOGLE_CALENDAR_ID: "c@group.calendar.google.com" }));
    expect(broken.describe.calendar).toBe("invalid_key");
    const err = (await broken.calendar.upsertEvent(event).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
    expect(err.message).toContain("redeploy");
    expect(err.message).not.toContain("garbled"); // never echoes the value
  });

  it("without calendar settings it says it is not set up; email and the rest are unaffected", async () => {
    const none = createIntegrations(env({}));
    expect(none.describe.calendar).toBe("unconfigured");
    await expect(none.calendar.upsertEvent(event)).rejects.toThrow("not set up");
    expect(none.describe.email).toBe("unconfigured");
  });

  it("MOCK_LLM never touches Google, even with a key set", () => {
    expect(createIntegrations(env({ MOCK_LLM: "1", GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: goodKey, GOOGLE_CALENDAR_ID: "c" })).describe.calendar).toBe("fake");
  });
});
