/**
 * Recovery with the recovery key: a typo stays
 * local; afterwards the data is readable, the other session is signed
 * out, only the new password works; also with TOTP.
 */
import type { Page } from "@playwright/test";
import { ApiError } from "@keeman/core";
import {
  createAccountWithVault,
  enableTotpViaNode,
  entryRow,
  nodeAccount,
  nodeEntry,
  openVault,
  rootOf,
  strongPassword,
  totpCodes,
  type TestAccount,
} from "./helpers";
import { expect, test } from "./fixtures";

async function openRecovery(page: Page, account: TestAccount) {
  await page.goto("/login");
  await page.getByTestId("to-recover").click();
  await expect(page.getByTestId("recover")).toBeVisible();
  await page.getByLabel("E-Mail-Adresse").fill(account.email);
}

/** New password, then the new recovery key confirmed with its last group. */
async function finishRecovery(page: Page, password: string): Promise<string> {
  await page
    .getByLabel("Neues Master-Passwort", { exact: true })
    .fill(password);
  await page.getByLabel("Neues Master-Passwort wiederholen").fill(password);
  await page.getByTestId("recover-password").click();
  const groups = page.getByTestId("recovery-group");
  await expect(groups).toHaveCount(14);
  const all = await groups.allTextContents();
  await page
    .getByLabel("Letzte Gruppe zur Bestätigung eintippen")
    .fill(all[13]?.trim() ?? "");
  await page.getByTestId("recovery-confirm").click();
  await expect(page.getByTestId("main-view")).toBeVisible();
  await expect(page.getByTestId("banner-recovered")).toBeVisible();
  return all.map((g) => g.trim()).join(" ");
}

test.describe("recovery", () => {
  test("a typo in the key is reported without a request", async ({ page }) => {
    const account = await createAccountWithVault("recovertypo");
    const starts: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/auth/recover/"))
        starts.push(request.url());
    });
    await openRecovery(page, account);
    const typo = account.recoveryKey.replace(/^(.)/, (c) =>
      c === "A" ? "B" : "A",
    );
    await page.getByTestId("recover-key").fill(typo);
    await page.getByTestId("recover-start").click();
    await expect(page.getByTestId("error")).toContainText(
      "Recovery Key ist nicht korrekt",
    );
    expect(starts).toEqual([]);
  });

  test("new password and new key; the other session is signed out", async ({
    page,
    guard,
  }) => {
    const account = await createAccountWithVault("recover");
    guard.secrets.push(account.password, account.recoveryKey);
    await nodeEntry(
      account.device,
      account.vaultId,
      rootOf(account.device, account.vaultId),
      {
        title: "Nach der Wiederherstellung",
        password: "geheim-123",
      },
    );
    await openRecovery(page, account);
    await page
      .getByTestId("recover-key")
      .fill(account.recoveryKey.toLowerCase());
    await page.getByTestId("recover-start").click();
    const newPassword = strongPassword();
    guard.secrets.push(newPassword);
    const newKey = await finishRecovery(page, newPassword);
    expect(newKey).not.toBe(account.recoveryKey);
    guard.secrets.push(newKey);

    // The data is readable with the recovered key.
    await openVault(page, "Persönlich");
    await expect(entryRow(page, "Nach der Wiederherstellung")).toBeVisible();

    // The Node session is revoked; old password and key are gone.
    const revoked = await account.device.api.me().catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(ApiError);
    expect((revoked as ApiError).code).toBe("session_invalid");
    const old = await nodeAccount();
    await expect(
      old.login(account.email, account.password),
    ).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    const fresh = await nodeAccount();
    const result = await fresh.login(account.email, newPassword);
    expect(result.kind).toBe("unlocked");
    await expect(
      (await nodeAccount()).startRecovery(account.email, account.recoveryKey),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  test("recovery with TOTP asks for the second factor", async ({
    page,
    guard,
  }) => {
    const account = await enableTotpViaNode(
      await createAccountWithVault("recovertotp"),
    );
    guard.secrets.push(account.password, account.recoveryKey);
    await openRecovery(page, account);
    await page.getByTestId("recover-key").fill(account.recoveryKey);
    await page.getByTestId("recover-start").click();
    await expect(page.getByTestId("second-factor")).toBeVisible();
    const { next } = await totpCodes(account.totpSecret ?? "");
    await page.getByTestId("totp-code").fill(next);
    await page.getByTestId("second-factor-submit").click();
    const newPassword = strongPassword();
    guard.secrets.push(newPassword);
    await finishRecovery(page, newPassword);
    await openVault(page, "Persönlich");
  });
});
