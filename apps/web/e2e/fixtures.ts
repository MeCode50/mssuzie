import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { AUTH_DIR } from "./global-setup";

type Cookie = Parameters<BrowserContext["addCookies"]>[0][number];

export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-password-1";

/**
 * Put the fictional learners and this week's timetable back as they started. Runs the same code as the
 * Reset demo button in a child process (the core package ships ES modules, which this loader cannot import).
 */
export function resetDemo(): void {
  execFileSync("pnpm", ["--dir", path.resolve(__dirname, "../../../packages/core"), "reset-demo"], { stdio: "pipe", env: process.env });
}

/** Become one of the demo people, using the session saved by global-setup (sign-in itself is rate limited). */
export async function signIn(page: Page, who: "ebun" | "ops2" | "daniel" | "sophie"): Promise<void> {
  const state = JSON.parse(readFileSync(path.join(AUTH_DIR, `${who}.json`), "utf8")) as { cookies: Cookie[] };
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
  await page.goto("/reschedules");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

/** Send a message as a parent from the simulator and wait for the agents to finish. */
export async function sendAs(page: Page, learner: string, exampleId: string): Promise<void> {
  await page.goto("/reschedules");
  const select = page.getByTestId("parent-select");
  await expect(select.locator("option")).not.toHaveCount(1);
  const label = (await select.locator("option").allTextContents()).find((o) => o.includes(learner));
  if (!label) throw new Error(`no parent for ${learner}`);
  await select.selectOption({ label });
  await page.getByTestId(`example-${exampleId}`).click();
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("outcome-card")).toBeVisible({ timeout: 60_000 });
}

export const test = base.extend<{ fresh: void }>({
  fresh: [async ({}, use) => {
    resetDemo();
    await use();
  }, { auto: true }],
});
export { expect };
