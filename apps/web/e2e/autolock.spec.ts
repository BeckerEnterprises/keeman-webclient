import { createAccount, loginViaUi, openAccount } from "./helpers";
import { expect, test } from "./fixtures";

test.describe("auto-lock", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });

  test("locks after 15 minutes without activity", async ({ page }) => {
    await loginViaUi(page, await createAccount("idle"));
    // runFor fires every 10 s tick; fastForward would look like a sleep.
    await page.clock.runFor("14:30");
    await expect(page.getByTestId("main-view")).toBeVisible();
    await page.clock.runFor("00:40");
    await expect(page.getByTestId("unlock")).toBeVisible();
  });

  test("locks after a jump of the clock (device sleep)", async ({ page }) => {
    await loginViaUi(page, await createAccount("sleep"));
    const now = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(now + 5 * 60_000);
    await page.clock.fastForward("00:11");
    await expect(page.getByTestId("unlock")).toBeVisible();
  });

  test("honours the settings for inactivity and hidden tabs", async ({
    page,
  }) => {
    await loginViaUi(page, await createAccount("settings-lock"));
    await openAccount(page, "settings");
    await page.getByTestId("settings-autolock").fill("2");
    await page.getByLabel("sofort").check();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();

    await page.clock.runFor("01:50");
    await expect(page.getByTestId("settings")).toBeVisible();
    await page.clock.runFor("00:20");
    await expect(page.getByTestId("unlock")).toBeVisible();
  });

  test("locks a hidden tab immediately when configured", async ({ page }) => {
    const account = await createAccount("hidden");
    await loginViaUi(page, account);
    await openAccount(page, "settings");
    await page.getByLabel("sofort").check();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("unlock")).toBeVisible();
  });
});
