import {
  createAccount,
  loginViaUi,
  nodeAccount,
  strongPassword,
  unlockViaUi,
  openAccount,
} from "./helpers";
import { expect, test } from "./fixtures";

test.describe("account pages", () => {
  test("changes the password and logs out other devices", async ({
    otherContext,
    page,
    guard,
  }) => {
    const account = await createAccount("password");
    const next = strongPassword();
    guard.secrets.push(account.password, next);
    await loginViaUi(page, account);
    const other = await otherContext.newPage();
    await loginViaUi(other, account);

    await openAccount(page, "password");
    await page.getByLabel("Aktuelles Master-Passwort").fill(account.password);
    await page
      .getByLabel("Neues Master-Passwort", { exact: true })
      .fill("zu kurz");
    await page.getByLabel("Neues Master-Passwort wiederholen").fill("zu kurz");
    await page.getByTestId("password-submit").click();
    await expect(page.getByTestId("password-problems")).toContainText(
      "Mindestens 12 Zeichen.",
    );

    await page.getByLabel("Aktuelles Master-Passwort").fill(account.password);
    await page.getByLabel("Neues Master-Passwort", { exact: true }).fill(next);
    await page
      .getByLabel("Neues Master-Passwort wiederholen")
      .fill(next.normalize("NFD"));
    await page.getByTestId("password-submit").click();
    await expect(
      page.getByText("Das Master-Passwort wurde geändert."),
    ).toBeVisible();

    await other.reload();
    await expect(other.getByTestId("login")).toBeVisible();

    const device = await nodeAccount();
    await expect(
      device.login(account.email, account.password),
    ).rejects.toThrow();
    await device.login(account.email, next);
  });

  test("raises the KDF parameters without logging out others", async ({
    otherContext,
    page,
  }) => {
    const account = await createAccount("kdf");
    await loginViaUi(page, account);
    const other = await otherContext.newPage();
    await loginViaUi(other, account);

    await openAccount(page, "kdf");
    await expect(page.getByTestId("kdf-current")).toHaveText(
      "Aktuell: 3 Durchläufe, 64 MiB",
    );
    await page.getByLabel("Stark (4 / 128 MiB)").check();
    await page
      .getByLabel("Master-Passwort zur Bestätigung")
      .fill(account.password);
    await page.getByTestId("kdf-submit").click();
    await expect(
      page.getByText("Die Parameter wurden geändert."),
    ).toBeVisible();
    await expect(page.getByTestId("kdf-current")).toHaveText(
      "Aktuell: 4 Durchläufe, 128 MiB",
    );

    await other.reload();
    await unlockViaUi(other, account.password);
    await expect(other.getByTestId("main-view")).toBeVisible();
  });

  test("creates a new recovery key", async ({ page, guard }) => {
    const account = await createAccount("recovery");
    await loginViaUi(page, account);
    await openAccount(page, "recovery-key");
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("renew-start").click();
    await expect(page.getByTestId("recovery-group")).toHaveCount(14);
    const groups = await page.getByTestId("recovery-group").allTextContents();
    expect(groups).toHaveLength(14);
    expect(groups.join(" ").trim()).not.toBe(account.recoveryKey);
    guard.secrets.push(groups.join(" ").trim());
    await page
      .getByLabel("Letzte Gruppe zur Bestätigung eintippen")
      .fill((groups.at(-1) ?? "").trim());
    await page.getByTestId("recovery-confirm").click();
    await expect(
      page.getByText("Der neue Recovery Key ist aktiv."),
    ).toBeVisible();
  });

  test("lists and revokes sessions", async ({ otherContext, page }) => {
    const account = await createAccount("sessions");
    await loginViaUi(page, account);
    const other = await otherContext.newPage();
    await loginViaUi(other, account);
    const device = await nodeAccount();
    await device.login(account.email, account.password);

    await openAccount(page, "sessions");
    // The registration through the API left one more session.
    await expect(page.getByTestId("session")).toHaveCount(4);
    await expect(
      page.getByTestId("session").filter({ hasText: "Dieses Gerät" }),
    ).toContainText(/^(Chrome|Firefox) · (Linux|Windows|macOS)/);
    await page
      .getByTestId("session")
      .filter({ hasText: "E2E · Node" })
      .first()
      .getByTestId("session-revoke")
      .click();
    await expect(page.getByTestId("session")).toHaveCount(3);
    await page.getByTestId("sessions-revoke-others").click();
    await expect(page.getByTestId("session")).toHaveCount(1);
    await other.reload();
    await expect(other.getByTestId("login")).toBeVisible();
  });

  test("keeps settings and merges them with another device", async ({
    page,
  }) => {
    const account = await createAccount("settings");
    await loginViaUi(page, account);
    const device = await nodeAccount();
    await device.login(account.email, account.password);
    await device.updateSettings({ lockOnHiddenMinutes: 3 });

    await openAccount(page, "settings");
    await page.getByTestId("settings-autolock").fill("7");
    await page.getByTestId("settings-language").selectOption("en");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    device.lock();
    await device.unlock(account.password);
    expect(device.settings).toMatchObject({
      autoLockMinutes: 7,
      language: "en",
      lockOnHiddenMinutes: 3,
    });
    await page.reload();
    await page
      .getByLabel("Master password", { exact: true })
      .fill(account.password);
    await page.getByTestId("unlock-submit").click();
    // The interface is English now.
    await page
      .locator(".header-nav")
      .getByRole("link", { name: "Account" })
      .click();
    await page
      .locator(".account-nav")
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByTestId("settings-autolock")).toHaveValue("7");
  });
});
