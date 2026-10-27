/**
 * Freshness on new devices: attestations of the own account, the stale
 * warning and "understood", a clock past the period, pairing by code and
 * by QR image, and the period setting.
 */
import type { Page, Route } from "@playwright/test";
import {
  createAccountWithVault,
  loginViaUi,
  openAccount,
  openMain,
  openVault,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

const DAY = 86_400_000;

/** The server withholds the own attestations (and may change the list). */
async function withholdAttestations(
  page: Page,
  change: (summary: Record<string, unknown>) => void = () => undefined,
): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/vaults",
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as {
        vaults: Record<string, unknown>[];
      };
      for (const summary of body.vaults) {
        summary.freshness = null;
        change(summary);
      }
      await route.fulfill({ response, json: body });
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/me",
    async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body.freshness = null;
      await route.fulfill({ response, json: body });
    },
  );
}

async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-group").click();
  await page.getByTestId("group-dialog-name").fill(name);
  await page.getByTestId("group-dialog-save").click();
  await expect(treeRow(page, name)).toBeVisible();
}

test.describe("freshness", () => {
  test("a second device after the first: no warning, an offer to pair", async ({
    page,
  }) => {
    const account = await createAccountWithVault("fresh");
    await loginViaUi(page, account);
    await expect(page.getByTestId("banner-new-device")).toBeVisible();
    await expect(page.getByTestId("banner-freshness")).toHaveCount(0);
    await openVault(page, "Persönlich");
    await createGroup(page, "Bestätigt");
  });

  test("without an attestation the state stays read-only until understood", async ({
    page,
  }) => {
    const account = await createAccountWithVault("stale");
    await withholdAttestations(page);
    await loginViaUi(page, account);
    await expect(page.getByTestId("banner-freshness")).toBeVisible();
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("vault-freshness")).toBeVisible();
    await expect(page.getByTestId("new-group")).toBeDisabled();
    await page.getByTestId("banner-freshness-ack").click();
    await page.getByTestId("confirm-yes").click();
    await expect(page.getByTestId("banner-freshness")).toHaveCount(0);
    await expect(page.getByTestId("vault-freshness")).toHaveCount(0);
    await createGroup(page, "Nach Bestätigung");
  });

  test("a confirmation older than the period does not count", async ({
    page,
  }) => {
    const account = await createAccountWithVault("clock");
    await page.clock.setFixedTime(new Date(Date.now() + 8 * DAY));
    await loginViaUi(page, account);
    await expect(page.getByTestId("banner-freshness")).toBeVisible();
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("vault-freshness")).toBeVisible();
    await expect(page.getByTestId("new-group")).toBeDisabled();
  });

  test("pairing by code takes over the marks and detects an older state", async ({
    page,
  }) => {
    const account = await createAccountWithVault("pairing");
    const { device } = account;
    // The account data as it was, then a change on the other device.
    const older = (await device.api.me()).user_data;
    await device.account.updateSettings({ autoLockMinutes: 9 });
    const { code } = await device.account.createPairing();
    // The server gives this browser the older account data, which is in
    // itself consistent, and no attestations.
    await withholdAttestations(page);
    await page.route(
      (url) => url.pathname === "/v1/me",
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        body.user_data = older;
        body.freshness = null;
        await route.fulfill({ response, json: body });
      },
    );
    await loginViaUi(page, account);
    await expect(page.getByTestId("banner-freshness")).toBeVisible();
    await expect(page.getByTestId("banner-user-data-rollback")).toHaveCount(0);
    await openAccount(page, "pairing");
    await page.getByTestId("pairing-input").fill(code.toLowerCase());
    await page.getByTestId("pairing-submit").click();
    await expect(page.getByTestId("pairing-done")).toBeVisible();
    // The paired marks are newer than what the server delivers.
    await expect(page.getByTestId("banner-user-data-rollback")).toBeVisible();
    await expect(page.getByTestId("banner-freshness")).toHaveCount(0);
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("vault-freshness")).toHaveCount(0);
  });

  test("pairs a second browser by the QR code of the first", async ({
    page,
    otherContext,
  }) => {
    const account = await createAccountWithVault("pairqr");
    await loginViaUi(page, account);
    await openAccount(page, "pairing");
    await page.getByTestId("pairing-show").click();
    await expect(page.getByTestId("pairing-code")).toHaveText(
      /^([A-Z2-7]{4} ){5}[A-Z2-7]{4}$/,
    );
    await expect(page.getByTestId("pairing-countdown")).toBeVisible();
    const image = await page.getByTestId("pairing-qr").screenshot();
    const other = await otherContext.newPage();
    await withholdAttestations(other);
    await loginViaUi(other, account);
    await expect(other.getByTestId("banner-freshness")).toBeVisible();
    await openAccount(other, "pairing");
    await other.getByTestId("pairing-qr-file").setInputFiles({
      name: "code.png",
      mimeType: "image/png",
      buffer: image,
    });
    await expect(other.getByTestId("pairing-done")).toBeVisible();
    await expect(other.getByTestId("banner-freshness")).toHaveCount(0);
    // A typo does not open the pairing.
    await other
      .getByTestId("pairing-input")
      .fill("AAAA AAAA AAAA AAAA AAAA AAAA");
    await other.getByTestId("pairing-submit").click();
    await expect(other.getByTestId("error")).toBeVisible();
  });

  test("stores the period", async ({ page }) => {
    const account = await createAccountWithVault("period");
    await loginViaUi(page, account);
    await openAccount(page, "settings");
    await page.getByTestId("settings-freshness").fill("30");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();
    await account.device.account.reloadUserData();
    expect(account.device.account.settings.freshnessDays).toBe(30);
  });
});
