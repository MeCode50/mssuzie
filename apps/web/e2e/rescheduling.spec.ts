import { expect, sendAs, signIn, test } from "./fixtures";

test.describe("rescheduling: what the co-founder will click through", () => {
  test("lands on Reschedules and shows the main navigation", async ({ page }) => {
    await signIn(page, "ebun");
    await expect(page).toHaveURL(/\/reschedules$/);
    for (const name of ["Reschedules", "Schedule", "Learners", "Alerts", "Session Copilot"]) {
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Reschedules", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("a clear request is moved automatically, with the Scheduler's tool calls shown and times in both zones", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Amara", "evening");
    await expect(page.getByTestId("decision-badge")).toHaveText("Moved automatically");

    const scheduler = page.getByTestId("ragent-scheduler_agent");
    await expect(scheduler).toHaveAttribute("data-status", "done");
    await expect(scheduler.getByTestId("tool-get_bookings")).toBeVisible();
    await expect(scheduler.getByTestId("tool-get_tutor_availability")).toBeVisible();
    await expect(scheduler.getByTestId("tool-find_free_slots").first()).toBeVisible();
    await expect(page.getByTestId("ragent-calendar_step")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("ragent-notifier_agent")).toHaveAttribute("data-status", "done");

    const beforeAfter = page.getByTestId("before-after");
    await expect(beforeAfter).toContainText("7:00 AM");
    await expect(beforeAfter).toContainText("7:00 PM");
    await expect(beforeAfter).toContainText("London");
    await expect(beforeAfter).toContainText("Lagos");

    // both people were told; nothing real was emailed
    const messages = page.getByTestId("messages").locator("li");
    await expect(messages).toHaveCount(2);
    await expect(page.getByTestId("messages")).toContainText("Recorded (not sent)");
  });

  test("the schedule highlights the class that was moved and links back to why", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Amara", "evening");
    await page.goto("/schedule");
    await expect(page.getByTestId("week-summary")).toBeVisible();
    // the class is a few days out: it may be this week or next
    if ((await page.locator('[data-moved="yes"]').count()) === 0) {
      await page.getByRole("button", { name: "Next week" }).click();
      await expect(page.getByTestId("week-summary")).toBeVisible();
    }
    const moved = page.locator('[data-moved="yes"]').first();
    await expect(moved).toContainText("Amara");
    await expect(moved).toContainText("Moved from");
    await moved.getByRole("link", { name: "see why" }).click();
    await expect(page.getByTestId("parent-message")).toContainText("Amara");
  });

  test("a taken time gets alternatives; Ops can choose one and both people are told", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Leo", "noon");
    await expect(page.getByTestId("decision-badge")).toHaveText("Waiting for the parent");
    const options = page.getByTestId("options").locator("li");
    await expect(options).toHaveCount(2);
    await options.first().getByRole("button", { name: "Choose this time" }).click();
    await expect(page.getByTestId("decision-badge")).toHaveText("Moved (time chosen)");
    await expect(page.getByTestId("before-after")).toBeVisible();
    await expect(page.getByTestId("messages")).toContainText("Class moved");
  });

  test("a class that starts too soon goes to Ops, who can decline it with a note the parent sees", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Priya", "today");
    await expect(page.getByTestId("decision-badge")).toHaveText("Needs a person");
    await expect(page.getByTestId("decision-reason")).toContainText("hours");
    await expect(page.getByTestId("ragent-scheduler_agent")).toHaveAttribute("data-status", "skipped");

    const note = "Daniel is away today, so this one has to stay where it is.";
    await page.getByLabel("What should the parent know?").fill(note);
    await page.getByRole("button", { name: "Decline and tell the parent" }).click();
    await expect(page.getByTestId("decision-badge")).toHaveText("Declined");
    await page.getByTestId("messages").getByText("Request declined").click();
    await expect(page.getByTestId("messages")).toContainText(note);
  });

  test("an attempt to give the system orders is refused and nothing moves", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Amara", "inject");
    await expect(page.getByTestId("decision-badge")).toHaveText("Needs a person");
    await expect(page.getByTestId("decision-reason")).toContainText("instructions aimed at the system");
    await expect(page.getByTestId("before-after")).toHaveCount(0);
    await expect(page.getByTestId("messages")).not.toContainText("fee is waived");
  });

  test("the requests list filters and opens a request's detail", async ({ page }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Leo", "noon");
    await sendAs(page, "Priya", "today");
    await page.goto("/reschedules");
    await expect(page.getByTestId("request-row")).toHaveCount(2);
    await page.getByTestId("filter-needs_person").click();
    await expect(page.getByTestId("request-row")).toHaveCount(1);
    await expect(page.getByTestId("request-row")).toContainText("Priya");
    await page.getByTestId("request-row").locator("a").click();
    await expect(page.getByTestId("parent-message")).toContainText("Priya");
    await expect(page.getByTestId("outcome-card")).toHaveAttribute("data-decision", "escalated");
  });

  test("a parent chooses a time from the emailed link, once, on a phone, without signing in", async ({ page, browser }) => {
    await signIn(page, "ebun");
    await sendAs(page, "Leo", "noon");
    await page.getByTestId("messages").getByText("Options to choose from").click();
    const body = await page.getByTestId("messages").locator("pre").first().textContent();
    const link = body?.match(/https?:\/\/\S+\/r\/accept\?token=\S+/)?.[0];
    expect(link, "the proposal email contains a link").toBeTruthy();
    const url = new URL(link!);
    const local = `${page.url().split("/reschedules")[0]}${url.pathname}${url.search}`;

    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true });
    const parent = await phone.newPage();
    await parent.goto(local);
    await expect(parent.getByRole("heading", { name: /move Leo's class/ })).toBeVisible();
    await expect(parent.getByTestId("new-time")).toContainText("Chicago");
    // merely opening it again changes nothing
    await parent.reload();
    await expect(parent.getByTestId("accept-button")).toBeVisible();
    await parent.getByTestId("accept-button").click();
    await expect(parent.getByTestId("accepted")).toContainText("All done");

    await parent.goto(local);
    await expect(parent.getByTestId("accept-problem")).toContainText("already");
    await phone.close();

    await page.reload();
    await page.goto("/reschedules");
    await page.getByTestId("request-row").first().locator("a").click();
    await expect(page.getByTestId("decision-badge")).toHaveText("Moved (time chosen)");
  });

  test("a forged link is refused kindly", async ({ page }) => {
    await page.goto("/r/accept?token=not-a-real-token-at-all");
    await expect(page.getByTestId("accept-problem")).toContainText("isn't valid");
    await expect(page.getByTestId("accept-button")).toHaveCount(0);
  });
});
