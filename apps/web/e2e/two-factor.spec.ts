/**
 * Second factor: TOTP set up in the UI and used at
 * login, replay rejected, backup codes once each, passkeys with a virtual
 * authenticator (Chromium only), `user reset-2fa`.
 */
import type { Page } from "@playwright/test";
import {
  createAccount,
  enableTotpViaNode,
  loginViaUi,
  openAccount,
  resetTwoFactor,
  totpCodes,
  type TestAccount,
} from "./helpers";
import { expect, test } from "./fixtures";

async function submitCredentials(page: Page, account: TestAccount) {
  await page.goto("/login");
  await page.getByLabel("E-Mail-Adresse").fill(account.email);
  await page
    .getByLabel("Master-Passwort", { exact: true })
    .fill(account.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("second-factor")).toBeVisible();
}

async function confirmWithPassword(page: Page, password: string) {
  await page.getByLabel("Master-Passwort", { exact: true }).fill(password);
  await page.getByTestId("two-factor-confirm").click();
}

async function logout(page: Page) {
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login")).toBeVisible();
}

test.describe("two-factor login", () => {
  test("TOTP set up in the UI, replay rejected, backup codes once", async ({
    page,
    guard,
  }) => {
    const account = await createAccount("totp2fa");
    guard.secrets.push(account.password, account.email);
    await loginViaUi(page, account);
    await openAccount(page, "two-factor");
    await expect(page.getByTestId("two-factor-none")).toBeVisible();
    await page.getByTestId("totp-setup").click();
    await confirmWithPassword(page, account.password);

    await expect(page.getByTestId("totp-qr")).toBeVisible();
    const secret = (
      (await page.getByTestId("totp-secret").textContent()) ?? ""
    ).replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    guard.secrets.push(secret);
    await page.getByTestId("totp-enable-code").fill("000000");
    await page.getByTestId("totp-enable").click();
    await expect(page.getByTestId("error")).toContainText("nicht akzeptiert");
    const { code } = await totpCodes(secret);
    await page.getByTestId("totp-enable-code").fill(code);
    await page.getByTestId("totp-enable").click();
    const items = page.getByTestId("backup-code-item");
    await expect(items).toHaveCount(10);
    const codes = (await items.allTextContents()).map((c) =>
      c.replace(/\s/g, ""),
    );
    await page.getByTestId("backup-codes-done").click();
    await expect(page.getByTestId("status-totp")).toHaveText("aktiv");
    await expect(page.getByTestId("status-codes")).toHaveText("10");

    // Login with the next code; the same code a second time is a replay.
    await logout(page);
    await submitCredentials(page, account);
    const { next } = await totpCodes(secret);
    await page.getByTestId("totp-code").fill(next);
    await page.getByTestId("second-factor-submit").click();
    await expect(page.getByTestId("main-view")).toBeVisible();

    await logout(page);
    await submitCredentials(page, account);
    await page.getByTestId("totp-code").fill(next);
    await page.getByTestId("second-factor-submit").click();
    await expect(page.getByTestId("error")).toContainText("nicht akzeptiert");
    // A backup code completes the same challenge.
    await page.getByTestId("use-backup-code").click();
    await page
      .getByTestId("backup-code")
      .fill(`${codes[0]?.slice(0, 5) ?? ""}-${codes[0]?.slice(5) ?? ""}`);
    await page.getByTestId("second-factor-submit").click();
    await expect(page.getByTestId("main-view")).toBeVisible();
    await expect(page.getByTestId("banner-backup-codes")).toContainText("9");

    // The used backup code fails later, another one works.
    await logout(page);
    await submitCredentials(page, account);
    await page.getByTestId("use-backup-code").click();
    await page.getByTestId("backup-code").fill(codes[0] ?? "");
    await page.getByTestId("second-factor-submit").click();
    await expect(page.getByTestId("error")).toContainText("nicht akzeptiert");
    await page.getByTestId("backup-code").fill(codes[1] ?? "");
    await page.getByTestId("second-factor-submit").click();
    await expect(page.getByTestId("main-view")).toBeVisible();

    // Turning TOTP off brings back the plain login.
    await openAccount(page, "two-factor");
    await page.getByTestId("totp-disable").click();
    await confirmWithPassword(page, account.password);
    await expect(page.getByTestId("status-totp")).toHaveText("aus");
    await expect(page.getByTestId("status-codes")).toHaveText("0");
    await logout(page);
    await loginViaUi(page, account);
  });

  test("passkey added, used and removed", async ({
    page,
    guard,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "virtual authenticators exist only in Chromium (CDP)",
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    const account = await createAccount("passkey2fa");
    guard.secrets.push(account.password, account.email);
    await loginViaUi(page, account);
    await openAccount(page, "two-factor");
    await page.getByTestId("passkey-add").click();
    await expect(page.getByTestId("passkey-name")).toHaveValue(/Chrome/);
    await page.getByTestId("passkey-name").fill("Testschlüssel");
    await confirmWithPassword(page, account.password);
    await expect(page.getByTestId("backup-code-item")).toHaveCount(10);
    await page.getByTestId("backup-codes-done").click();
    await expect(page.getByTestId("passkey-item")).toContainText(
      "Testschlüssel",
    );
    await expect(page.getByTestId("status-passkeys")).toHaveText("1");

    await logout(page);
    await submitCredentials(page, account);
    // Only passkey and backup codes are offered: the passkey comes first.
    await page.getByTestId("passkey-login").click();
    await expect(page.getByTestId("main-view")).toBeVisible();
    const { credentials } = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.signCount ?? 0).toBeGreaterThanOrEqual(2);

    await openAccount(page, "two-factor");
    await page.getByTestId("passkey-remove").click();
    await confirmWithPassword(page, account.password);
    await expect(page.getByTestId("passkey-item")).toHaveCount(0);
    await expect(page.getByTestId("status-passkeys")).toHaveText("0");
    await expect(page.getByTestId("status-codes")).toHaveText("0");
  });

  test("reset-2fa on the server brings back the plain login", async ({
    page,
    guard,
  }) => {
    const account = await enableTotpViaNode(await createAccount("reset2fa"));
    guard.secrets.push(account.password, ...(account.backupCodes ?? []));
    await submitCredentials(page, account);
    await page.getByTestId("second-factor-cancel").click();
    await expect(page.getByTestId("login-submit")).toBeVisible();
    resetTwoFactor(account.email);
    await loginViaUi(page, account);
  });
});
