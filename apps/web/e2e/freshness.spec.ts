/**
 * Freshness on new devices: attestations of the own account, the stale
 * warning and "understood", a clock past the period, the confirmation by
 * another device (a Node device, a second browser, a changed answer),
 * strict mode and the period setting.
 */
import type { Page, Route } from "@playwright/test";
import {
  createAccountWithVault,
  loginViaUi,
  type NodeDevice,
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

/** The banner's button asks the other devices and opens the waiting page. */
async function askForConfirmation(page: Page): Promise<void> {
  const banner = page.getByTestId("banner-freshness");
  // Right after the sign-in a first click may meet the app's own
  // navigation; the button is clicked until the waiting page shows.
  await expect(async () => {
    await banner.getByTestId("banner-freshness-confirm").click();
    await expect(page.getByTestId("confirmation-waiting")).toBeVisible({
      timeout: 2000,
    });
  }).toPass();
}

/** The Node device confirms the open request once it sees it. */
async function confirmOnNode(device: NodeDevice): Promise<void> {
  let id: string | undefined;
  await expect(async () => {
    id = (await device.account.confirmationRequests())[0]?.requestId;
    expect(id).toBeDefined();
  }).toPass();
  await device.account.confirmRequest(id ?? "");
}

async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-group").click();
  await page.getByTestId("group-dialog-name").fill(name);
  await page.getByTestId("group-dialog-save").click();
  await expect(treeRow(page, name)).toBeVisible();
}

test.describe("freshness", () => {
  test("a second device after the first: no warning, an offer to have it confirmed", async ({
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

  test("a confirmation by another device takes over the marks and detects an older state", async ({
    page,
  }) => {
    const account = await createAccountWithVault("confirm");
    const { device } = account;
    // The account data as it was, then a change on the other device.
    const older = (await device.api.me()).user_data;
    await device.account.updateSettings({ autoLockMinutes: 9 });
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
    await askForConfirmation(page);
    await confirmOnNode(device);
    await expect(page.getByTestId("confirmation-done")).toBeVisible({
      timeout: 20_000,
    });
    // The confirmed marks are newer than what the server delivers.
    await expect(page.getByTestId("banner-user-data-rollback")).toBeVisible();
    await expect(page.getByTestId("banner-freshness")).toHaveCount(0);
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("vault-freshness")).toHaveCount(0);
  });

  test('one browser confirms another by a click; "that wasn\'t me" marks the session', async ({
    page,
    otherContext,
  }) => {
    const account = await createAccountWithVault("confirm2");
    await loginViaUi(page, account);
    const other = await otherContext.newPage();
    await withholdAttestations(other);
    await loginViaUi(other, account);
    await expect(other.getByTestId("banner-freshness")).toBeVisible();
    await askForConfirmation(other);
    const incoming = page.getByTestId("confirmation-incoming");
    await expect(incoming).toBeVisible();
    await expect(
      page.getByTestId("confirmation-incoming-device"),
    ).toContainText("Browser");
    await page.getByTestId("confirmation-accept").click();
    await expect(incoming.getByRole("status")).toBeVisible();
    await page.getByTestId("confirmation-incoming-close").click();
    await expect(incoming).toHaveCount(0);
    await expect(other.getByTestId("confirmation-done")).toBeVisible();
    await expect(other.getByTestId("banner-freshness")).toHaveCount(0);

    // Asked again, and refused on the first browser.
    await other.getByTestId("confirmation-request").click();
    await expect(other.getByTestId("confirmation-waiting")).toBeVisible();
    await expect(incoming).toBeVisible();
    await page.getByTestId("confirmation-decline").click();
    await expect(page).toHaveURL(/\/account\/sessions$/);
    await expect(page.getByTestId("sessions-declined")).toBeVisible();
    await expect(page.getByTestId("session-requesting")).toHaveCount(1);
    await expect(other.getByTestId("confirmation-failed")).toBeVisible();
  });

  test("in strict mode a new browser stays unconfirmed until another device confirms it", async ({
    page,
  }) => {
    const account = await createAccountWithVault("strict");
    const { device } = account;
    await device.account.updateSettings({ requireConfirmation: true });
    await loginViaUi(page, account);
    // The other device's attestations are fresh, but do not count here.
    await expect(page.getByTestId("banner-freshness")).toBeVisible();
    await openAccount(page, "settings");
    await expect(
      page.getByTestId("settings-require-confirmation"),
    ).toBeChecked();
    await expect(page.getByTestId("settings-strict-here")).toContainText(
      "streng",
    );
    await askForConfirmation(page);
    await confirmOnNode(device);
    await expect(page.getByTestId("confirmation-done")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("banner-freshness")).toHaveCount(0);
  });

  test("a changed answer is not taken", async ({ page }) => {
    const account = await createAccountWithVault("forged");
    await withholdAttestations(page);
    // The server changes one character of the signed statement.
    await page.route(
      (url) => /^\/v1\/me\/confirmations\/[^/]+$/.test(url.pathname),
      async (route: Route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        const body = (await response.json()) as {
          answer: { statement: string; signature: string } | null;
        };
        if (body.answer) {
          const text = body.answer.statement;
          const last = text.at(-2) === "A" ? "B" : "A";
          body.answer.statement = `${text.slice(0, -2)}${last}${text.slice(-1)}`;
        }
        await route.fulfill({ response, json: body });
      },
    );
    await loginViaUi(page, account);
    await askForConfirmation(page);
    await confirmOnNode(account.device);
    await expect(page.getByTestId("confirmation-failed")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("confirmation-failed")).toContainText(
      "ließ sich nicht prüfen",
    );
    await expect(page.getByTestId("banner-freshness")).toBeVisible();
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
