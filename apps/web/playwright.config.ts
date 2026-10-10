import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

/**
 * Run with `pnpm e2e` (scripts/e2e.sh sets up the throwaway database and the environment).
 * One worker: every test shares one database and starts by resetting it.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    { command: `pnpm exec next dev -p ${PORT}`, url: `http://localhost:${PORT}/login`, reuseExistingServer: false, timeout: 120_000, stdout: "ignore", stderr: "pipe" },
    { command: "pnpm --dir ../.. worker", url: undefined, port: undefined, reuseExistingServer: false, timeout: 60_000, wait: { stdout: /worker started/ }, stdout: "pipe", stderr: "pipe" },
  ],
});
