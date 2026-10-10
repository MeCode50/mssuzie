import { expect, signIn, test } from "./fixtures";

test.describe("Session Copilot (the secondary feature still works)", () => {
  test("example notes run through all five agents to a draft parent update", async ({ page }) => {
    await signIn(page, "ebun");
    await page.goto("/sessions/new");
    await page.getByLabel("Who was the session with?").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Use example notes" }).click();
    await page.getByTestId("run-button").click();
    await expect(page.getByTestId("trace-outcome")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("trace-outcome")).toContainText("All done");
    for (const id of ["privacy_guard", "session_analyst", "progress_monitor", "learning_planner", "parent_reporter"]) {
      await expect(page.getByTestId(`agent-${id}`)).toHaveAttribute("data-status", "done");
    }
    await page.getByRole("link", { name: /View full results/ }).click();
    await expect(page).toHaveURL(/\/runs\//);
  });
});
