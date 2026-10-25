import { createAccount, loginViaUi, nodeAccount, unlockViaUi } from "./helpers";
import { expect, test } from "./fixtures";

test.describe("login, logout, lock", () => {
  test("logs in and out", async ({ page, guard }) => {
    const account = await createAccount("login");
    guard.secrets.push(account.password, account.email);
    await loginViaUi(page, account);
    await expect(page.locator(".header-email")).toHaveText(account.email);
    await page.getByTestId("logout").click();
    await expect(page.getByTestId("login")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("login")).toBeVisible();
  });

  test("answers wrong passwords and unknown e-mails alike", async ({
    page,
  }) => {
    const account = await createAccount("wrong");
    await page.goto("/login");
    await page.getByLabel("E-Mail-Adresse").fill(account.email);
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill("Falsches Passwort 123");
    await page.getByTestId("login-submit").click();
    const message = await page
      .getByTestId("error")
      .locator("p")
      .first()
      .textContent();
    expect(message).toContain(
      "E-Mail-Adresse oder Master-Passwort ist falsch.",
    );
    await page.getByLabel("E-Mail-Adresse").fill("nobody-here@example.com");
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill("Falsches Passwort 123");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("error").locator("p").first()).toHaveText(
      message ?? "",
    );
  });

  test("shows a countdown on 429", async ({ page }) => {
    const account = await createAccount("limited");
    await page.route("**/v1/auth/login", (route) =>
      route.fulfill({
        status: 429,
        headers: {
          "retry-after": "42",
          "content-type": "application/problem+json",
        },
        body: JSON.stringify({
          title: "Too many requests",
          status: 429,
          code: "rate_limited",
          instance: "urn:uuid:0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
        }),
      }),
    );
    await page.goto("/login");
    await page.getByLabel("E-Mail-Adresse").fill(account.email);
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("error")).toContainText(/in 4[0-2] s/);
    await expect(page.getByTestId("error")).toContainText(
      "Fehler-ID: 0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    );
  });

  test("locks with the button and Shift+L, unlocks, survives a reload", async ({
    page,
  }) => {
    const account = await createAccount("lock");
    await loginViaUi(page, account);
    await page.getByTestId("lock").click();
    await unlockViaUi(page, "Falsches Passwort 123");
    await expect(page.getByTestId("error")).toContainText(
      "Das Master-Passwort ist falsch.",
    );
    await unlockViaUi(page, account.password);
    await expect(page.getByTestId("main-view")).toBeVisible();

    await page.locator("body").press("Shift+L");
    await expect(page.getByTestId("unlock")).toBeVisible();
    await page.reload();
    await unlockViaUi(page, account.password);
    await expect(page.getByTestId("main-view")).toBeVisible();
  });

  test("returns to the login when the session was revoked elsewhere", async ({
    page,
  }) => {
    const account = await createAccount("revoked");
    await loginViaUi(page, account);
    await page.getByTestId("lock").click();
    const other = await nodeAccount();
    await other.login(account.email, account.password);
    await other.revokeOtherSessions();
    await unlockViaUi(page, account.password);
    await expect(page.getByTestId("login")).toBeVisible();
    await expect(page.getByText("Die Sitzung ist abgelaufen.")).toBeVisible();
  });
});
