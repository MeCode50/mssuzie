import { expect, sendAs, signIn, test } from "./fixtures";

test.describe("who can do what", () => {
  test("signed-out visitors are sent to sign in", async ({ page }) => {
    await page.goto("/reschedules");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/schedule");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a tutor sees their own learners, no Alerts, no Ops actions, no reset", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Leo", "noon");
    const requestUrl = page.url();
    await page.context().clearCookies();

    await signIn(page, "daniel"); // Leo is taught by Sophie, not Daniel
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Alerts" })).toHaveCount(0);
    await expect(page.getByTestId("reset-demo")).toHaveCount(0);
    await page.goto("/alerts");
    await expect(page).toHaveURL(/\/reschedules$/); // sent back, not shown

    // Leo's request belongs to another tutor: it is not there for Daniel
    const id = new URL(requestUrl).searchParams.get("request");
    await page.goto(`/reschedules/${id}`);
    await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
    await expect(page.getByTestId("parent-message")).toHaveCount(0); // none of the request leaks through
  });

  test("the tutor who owns the request can watch it but not decide it", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Leo", "noon");
    const id = new URL(page.url()).searchParams.get("request");
    await page.context().clearCookies();
    await signIn(page, "sophie"); // Leo's tutor
    await page.goto(`/reschedules/${id}`);
    await expect(page.getByTestId("outcome-card")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose this time" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Decline and tell the parent/ })).toHaveCount(0);
  });

  test("Reset demo needs the typed phrase and clears every request", async ({ page }) => {
    await signIn(page, "ops2");
    await sendAs(page, "Priya", "today");
    await page.goto("/reschedules");
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    await page.getByTestId("reset-demo").click();
    await expect(page.getByTestId("reset-go")).toBeDisabled();
    await page.getByTestId("reset-confirm").fill("reset demo data");
    await page.getByTestId("reset-go").click();
    await expect(page.getByTestId("request-row")).toHaveCount(0);
    await expect(page.getByTestId("outcome-card")).toHaveCount(0);
  });
});
