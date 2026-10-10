import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, expect, type FullConfig } from "@playwright/test";

export const AUTH_DIR = path.resolve(__dirname, ".auth");
export const ROLES = ["ebun", "ops2", "daniel", "sophie"] as const;

/**
 * Sign in once per person and save the session. Sign-in is rate limited (10 a minute per address),
 * which is a feature, so the tests reuse these sessions instead of logging in every time.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:3100";
  const browser = await chromium.launch();
  try {
    for (const who of ROLES) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel(/email/i).fill(`${who}@example.com`);
      await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD ?? "e2e-password-1");
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible({ timeout: 60_000 });
      await context.storageState({ path: path.join(AUTH_DIR, `${who}.json`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
