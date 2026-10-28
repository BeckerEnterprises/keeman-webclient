/**
 * State codes: two members compare the code of a database by QR image, a
 * change of owners the server hides from one account is found from both
 * sides, the accept dialog shows the owners and an older owner list, and
 * a typo is shown next to the own code. Test data only.
 */
import type { SyncEngine } from "@keeman/core";
import type { Page } from "@playwright/test";
import {
  createAccount,
  createAccountWithVault,
  loginViaUi,
  nodeDevice,
  openDatabases,
  openMain,
  openVault,
  unlockViaUi,
  type NodeDevice,
} from "./helpers";
import { expect, test } from "./fixtures";

async function openDatabasePage(page: Page, vaultId: string): Promise<void> {
  await openDatabases(page);
  await page
    .locator(`[data-test=vault][data-vault-id="${vaultId}"]`)
    .getByTestId("vault-settings")
    .click();
  await expect(page.getByTestId("database-view")).toBeVisible();
}

/** The host verifies and invites, the guest verifies and accepts (Node). */
async function shareNode(
  host: NodeDevice,
  guest: NodeDevice,
  guestEmail: string,
  vaultId: string,
): Promise<void> {
  const candidate = await host.engine.lookupUser(guestEmail);
  if (candidate.status !== "verified")
    await host.account.verifyContact(candidate);
  await host.engine.invite(vaultId, candidate);
  await guest.engine.refresh();
  const sender = guest.engine.snapshot.invitations.find(
    (i) => i.vaultId === vaultId,
  )?.sender;
  if (!sender) throw new Error("invitation missing");
  if (sender.status !== "verified") await guest.account.verifyContact(sender);
  await guest.engine.acceptInvitation(
    vaultId,
    await guest.engine.invitationDetails(vaultId),
  );
}

/** The state code a Node device shows for a database. */
async function codeOf(engine: SyncEngine, vaultId: string): Promise<string> {
  await engine.refresh();
  const code = engine.snapshot.vaults.find((v) => v.id === vaultId)?.roles.code;
  if (!code) throw new Error("no state code");
  return code.display;
}

/** The server keeps this page at the first statement of the owner list. */
async function hideNewerOwners(
  page: Page,
  vaultId: string,
): Promise<() => Promise<void>> {
  const roles = (url: URL) => url.pathname === `/v1/vaults/${vaultId}/roles`;
  const list = (url: URL) => url.pathname === "/v1/vaults";
  await page.route(roles, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { statements: unknown[] };
    await route.fulfill({
      response,
      json: { statements: body.statements.slice(0, 1) },
    });
  });
  await page.route(list, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      vaults: { vault_id: string; roles_version: number | null }[];
    };
    for (const v of body.vaults)
      if (v.vault_id === vaultId && v.roles_version !== null)
        v.roles_version = 1;
    await route.fulfill({ response, json: body });
  });
  return async () => {
    await page.unroute(roles);
    await page.unroute(list);
  };
}

test.describe("state code", () => {
  test("matches by QR image, and a hidden change of owners is found from both sides", async ({
    page,
    otherContext,
    guard,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("state-a");
    const bob = await createAccount("state-b");
    const carol = await createAccount("state-c");
    guard.secrets.push(alice.password, bob.password, carol.password);
    const vaultId = alice.vaultId;
    const [bobDevice, carolDevice] = await Promise.all([
      nodeDevice(bob),
      nodeDevice(carol),
    ]);
    await shareNode(alice.device, bobDevice, bob.email, vaultId);
    await shareNode(alice.device, carolDevice, carol.email, vaultId);

    // Bob compares Alice's code from a picture of her screen.
    const second = await otherContext.newPage();
    await loginViaUi(second, alice);
    await openDatabasePage(second, vaultId);
    const picture = await second.getByTestId("state-code-qr").screenshot();
    const reveal = await hideNewerOwners(page, vaultId);
    await loginViaUi(page, bob);
    await openDatabasePage(page, vaultId);
    await expect(page.getByTestId("state-code-never")).toBeVisible();
    const bobCode =
      (await page.getByTestId("state-code").textContent())?.trim() ?? "";
    expect(bobCode).toMatch(/^v1 · ([A-Z2-7]{4} ){6}[A-Z2-7]{2}$/);
    await page.getByTestId("state-code-check").click();
    const dialog = page.getByTestId("state-compare-dialog");
    await dialog.getByTestId("state-compare-qr-file").setInputFiles({
      name: "code.png",
      mimeType: "image/png",
      buffer: picture,
    });
    await expect(dialog.getByTestId("state-compare-match")).toBeVisible();
    await dialog.getByTestId("state-compare-close").click();
    await expect(page.getByTestId("state-code-last")).toBeVisible();

    // Alice makes Carol owner; the server keeps that from Bob.
    await alice.device.engine.setMemberRole(
      vaultId,
      carolDevice.account.userId ?? "",
      "owner",
    );
    const aliceCode = await codeOf(alice.device.engine, vaultId);
    expect(aliceCode).toMatch(/^v2 /);
    await page.getByTestId("state-code-check").click();
    await dialog.getByTestId("state-compare-input").fill(aliceCode);
    await dialog.getByTestId("state-compare-submit").click();
    const contradiction = dialog.getByTestId("state-compare-contradiction");
    await expect(contradiction).toContainText("neuere Eigentümerliste");
    await expect(dialog.getByTestId("state-compare-own")).toContainText("v1");
    await dialog.getByTestId("state-compare-confirm").click();
    await expect(contradiction).toHaveCount(0);
    await dialog.getByTestId("state-compare-close").click();
    const warning = page.getByTestId("vault-roles-warning");
    await expect(warning.getByTestId("vault-roles-compared")).toContainText(
      aliceCode,
    );
    await expect(page.getByTestId("state-code-none")).toBeVisible();
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeDisabled();

    // Still there after locking: kept in the account and on the device.
    await page.getByTestId("lock").click();
    await unlockViaUi(page, bob.password);
    await openDatabasePage(page, vaultId);
    await expect(warning.getByTestId("vault-roles-compared")).toBeVisible();

    // From Alice's side, Bob's code is behind.
    const behind = await alice.device.engine.compareStateCode(vaultId, bobCode);
    expect(behind).toMatchObject({ result: "behind", own: { version: 2 } });

    // Once the server delivers the newer list, the warning goes away.
    await reveal();
    await page.getByTestId("lock").click();
    await unlockViaUi(page, bob.password);
    await openDatabasePage(page, vaultId);
    await expect(page.getByTestId("vault-roles-warning")).toHaveCount(0);
    await expect(page.getByTestId("state-code")).toHaveText(aliceCode);
  });

  test("the accept dialog names the owners, and an older owner list blocks accepting", async ({
    page,
    guard,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("state-invite-a");
    const bob = await createAccount("state-invite-b");
    const carol = await createAccount("state-invite-c");
    guard.secrets.push(alice.password, bob.password, carol.password);
    const vaultId = alice.vaultId;
    const carolDevice = await nodeDevice(carol);
    await shareNode(alice.device, carolDevice, carol.email, vaultId);
    const candidate = await alice.device.engine.lookupUser(bob.email);
    await alice.device.account.verifyContact(candidate);
    await alice.device.engine.invite(vaultId, candidate);
    await alice.device.engine.setMemberRole(
      vaultId,
      carolDevice.account.userId ?? "",
      "owner",
    );
    const carolCode = await codeOf(carolDevice.engine, vaultId);

    const reveal = await hideNewerOwners(page, vaultId);
    await loginViaUi(page, bob);
    await page
      .getByTestId("banner-invitation")
      .getByTestId("invitation-accept")
      .click();
    await page
      .getByTestId("fingerprint-dialog")
      .getByTestId("fingerprint-confirm")
      .click();
    const dialog = page.getByTestId("invitation-dialog");
    await expect(dialog.getByTestId("invitation-dialog-owner")).toHaveCount(1);
    await expect(dialog.getByTestId("invitation-dialog-owner")).toContainText(
      alice.email,
    );
    await expect(dialog.getByTestId("invitation-dialog-code")).toContainText(
      "v1",
    );
    await dialog.getByTestId("invitation-dialog-check").click();
    await dialog.getByTestId("state-compare-input").fill(carolCode);
    await dialog.getByTestId("state-compare-submit").click();
    await expect(
      dialog.getByTestId("state-compare-contradiction"),
    ).toContainText("neuere Eigentümerliste");
    await dialog.getByTestId("state-compare-confirm").click();
    await expect(dialog.getByTestId("invitation-dialog-problem")).toBeVisible();
    await expect(dialog.getByTestId("invitation-dialog-accept")).toBeDisabled();
    await expect(dialog.getByTestId("invitation-dialog-decline")).toBeEnabled();
    await dialog.getByTestId("invitation-dialog-close").click();

    // With the whole list the point is satisfied, and Bob accepts.
    await reveal();
    await page
      .getByTestId("banner-invitation")
      .getByTestId("invitation-accept")
      .click();
    await expect(dialog.getByTestId("invitation-dialog-code")).toHaveText(
      carolCode,
    );
    await expect(dialog.getByTestId("invitation-dialog-problem")).toHaveCount(
      0,
    );
    await dialog.getByTestId("invitation-dialog-check").click();
    await dialog.getByTestId("state-compare-input").fill(carolCode);
    await dialog.getByTestId("state-compare-submit").click();
    await expect(dialog.getByTestId("state-compare-match")).toBeVisible();
    await dialog.getByTestId("invitation-dialog-accept").click();
    await expect(page.getByTestId("banner-invitation")).toHaveCount(0);
    await openDatabasePage(page, vaultId);
    await expect(page.getByTestId("state-code")).toHaveText(carolCode);
  });

  test("a typo is shown next to the own code, and an owner passes the code on when inviting", async ({
    page,
    guard,
  }) => {
    test.slow();
    const alice = await createAccountWithVault("state-typo-a");
    const bob = await createAccount("state-typo-b");
    const dave = await createAccount("state-typo-d");
    guard.secrets.push(alice.password, bob.password, dave.password);
    const vaultId = alice.vaultId;
    const bobDevice = await nodeDevice(bob);
    await shareNode(alice.device, bobDevice, bob.email, vaultId);
    // Dave is a verified contact already: no fingerprint dialog.
    await alice.device.account.verifyContact(
      await alice.device.engine.lookupUser(dave.email),
    );
    await loginViaUi(page, alice);
    await openDatabasePage(page, vaultId);
    const own = (await page.getByTestId("state-code").textContent())?.trim();
    await page.getByTestId("invite-email").fill(dave.email);
    await page.getByTestId("invite-submit").click();
    await expect(page.getByTestId("members-invited-code")).toContainText(
      own ?? "",
    );

    // One character off: shown side by side, "correct" stores nothing.
    const code = (await codeOf(bobDevice.engine, vaultId)).replace(
      /^v1 · (.)/,
      (_, first: string) => `v1 · ${first === "A" ? "B" : "A"}`,
    );
    await page.getByTestId("state-code-check").click();
    const dialog = page.getByTestId("state-compare-dialog");
    await dialog.getByTestId("state-compare-input").fill(code);
    await dialog.getByTestId("state-compare-submit").click();
    await expect(
      dialog.getByTestId("state-compare-contradiction"),
    ).toContainText("stimmen nicht überein");
    await expect(
      dialog.getByTestId("state-compare-entered").locator(".code-diff"),
    ).toHaveCount(1);
    await dialog.getByTestId("state-compare-correct").click();
    await expect(dialog.getByTestId("state-compare-contradiction")).toHaveCount(
      0,
    );
    await dialog.getByTestId("state-compare-close").click();
    await expect(page.getByTestId("vault-roles-warning")).toHaveCount(0);

    // Matches as entered: read-only until understood.
    await page.getByTestId("state-code-check").click();
    await dialog.getByTestId("state-compare-input").fill(code);
    await dialog.getByTestId("state-compare-submit").click();
    await dialog.getByTestId("state-compare-confirm").click();
    await dialog.getByTestId("state-compare-close").click();
    const warning = page.getByTestId("vault-roles-warning");
    await expect(warning).toContainText("anderen Stand-Code");
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeDisabled();
    await openDatabasePage(page, vaultId);
    await warning.getByTestId("vault-roles-ack").click();
    await page.getByTestId("confirm-yes").click();
    await expect(warning).toHaveCount(0);
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("new-group")).toBeEnabled();
  });
});
