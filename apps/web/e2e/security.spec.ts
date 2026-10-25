import {
  createAccount,
  loginViaUi,
  nodeAccount,
  openAccount,
  unlockViaUi,
} from "./helpers";
import { expect, test } from "./fixtures";

test.describe("security checks", () => {
  test("manipulated account data ends in the integrity screen", async ({
    page,
  }) => {
    const account = await createAccount("integrity");
    await page.route("**/v1/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.public_key = "A".repeat(43);
      await route.fulfill({ response, json: body });
    });
    await page.goto("/login");
    await page.getByLabel("E-Mail-Adresse").fill(account.email);
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("login-submit").click();
    await expect(page.getByText("Daten passen nicht zusammen")).toBeVisible();
  });

  test("warns about weaker KDF parameters than seen on this device", async ({
    page,
  }) => {
    const account = await createAccount("weaker");
    await loginViaUi(page, account);
    await page.getByTestId("lock").click();
    const device = await nodeAccount();
    await device.login(account.email, account.password);
    await device.upgradeKdf(account.password, {
      alg: "argon2id13",
      ops: 2,
      mem: 33554432,
    });

    await unlockViaUi(page, account.password);
    const dialog = page.getByTestId("kdf-warning");
    await expect(dialog).toContainText("3 / 64 MiB → 2 / 32 MiB");
    await dialog.getByRole("button", { name: "Verstanden" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("banner-kdf")).toBeVisible();
    const stored = await page.evaluate(
      () => localStorage.getItem("keeman.kdfSeen") ?? "",
    );
    expect(stored).toContain('"ops":2');
  });

  test("hints at manipulated parameters when unlocking fails with weaker ones", async ({
    page,
  }) => {
    const account = await createAccount("tampered");
    await loginViaUi(page, account);
    await page.getByTestId("lock").click();
    await page.route("**/v1/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.kdf = { alg: "argon2id13", ops: 2, mem: 19922944 };
      await route.fulfill({ response, json: body });
    });
    await unlockViaUi(page, account.password);
    await expect(page.getByTestId("error")).toContainText(
      "manipulierte Parameter",
    );
  });

  test("every page renders without CSP violations and with the security headers", async ({
    page,
  }) => {
    const response = await page.goto("/login");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(headers["content-security-policy"]).toContain(
      "connect-src 'self' http://localhost:18787",
    );
    expect(headers["x-content-type-options"]).toBe("nosniff");
    await page.goto("/register");
    await expect(page.getByTestId("register")).toBeVisible();
    await loginViaUi(page, await createAccount("csp"));
    for (const path of [
      "password",
      "kdf",
      "recovery-key",
      "sessions",
      "contacts",
      "settings",
      "about",
    ] as const) {
      await openAccount(page, path);
      await expect(page.locator(".account-content section")).toBeVisible();
    }
  });

  test("theme, language and source links", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByTestId("locale").selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    const links = page.locator(".footer-source a");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute(
      "href",
      "https://github.com/BeckerEnterprises/keeman-webclient",
    );
    await expect(links.nth(1)).toHaveAttribute(
      "href",
      "https://github.com/BeckerEnterprises/keeman-server",
    );
    for (const link of await links.all())
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const stored = await page.evaluate(() => Object.keys(localStorage).sort());
    expect(stored).toEqual(["keeman.locale", "keeman.theme"]);
  });
});
