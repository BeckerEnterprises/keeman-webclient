/**
 * Databases and synchronisation: groups in the tree,
 * two browsers, conflicts, paging, rollback, corruption and deletion.
 */
import type { Page, Route } from "@playwright/test";
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  openAccount,
  openDatabases,
  openVault,
  rootOf,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

async function createGroup(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-group").click();
  await page.getByTestId("group-dialog-name").fill(name);
  await page.getByTestId("group-dialog-save").click();
  await expect(treeRow(page, name)).toBeVisible();
}

async function rename(page: Page, from: string, to: string): Promise<void> {
  await treeRow(page, from).click();
  await treeRow(page, from).press("F2");
  await page.getByTestId("tree-rename").fill(to);
  await page.getByTestId("tree-rename").press("Enter");
}

async function menu(page: Page, name: string, item: string): Promise<void> {
  await treeRow(page, name).click({ button: "right" });
  await page.getByTestId(`menu-${item}`).click();
}

async function waitOnline(page: Page): Promise<void> {
  await expect(page.getByTestId("connection")).toHaveAttribute(
    "data-state",
    "online",
  );
}

/** Changes every `changes` response before the client sees it. */
async function rewriteChanges(
  page: Page,
  change: (body: {
    vault_revision: number;
    objects: { id: string; data: string | null; revision: number }[];
  }) => void,
): Promise<void> {
  await page.route("**/v1/vaults/*/changes?**", async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Parameters<typeof change>[0];
    change(body);
    await route.fulfill({ response, json: body });
  });
}

/** Breaks the authentication tag of an object's ciphertext. */
function flipped(data: string): string {
  const i = 60;
  return data.slice(0, i) + (data[i] === "A" ? "B" : "A") + data.slice(i + 1);
}

async function unlockAfterReload(page: Page, password: string): Promise<void> {
  await page.reload();
  await page.getByLabel("Master-Passwort", { exact: true }).fill(password);
  await page.getByTestId("unlock-submit").click();
}

test.describe("databases", () => {
  test("groups: create, rename, recycle bin, restore, delete", async ({
    page,
  }) => {
    const account = await createAccountWithVault("groups");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await createGroup(page, "Server");
    await rename(page, "Server", "Server neu");
    await expect(treeRow(page, "Server neu")).toBeVisible();

    await menu(page, "Server neu", "delete");
    await expect(treeRow(page, "Server neu")).toHaveAttribute(
      "class",
      /in-trash/,
    );
    await menu(page, "Server neu", "restore");
    await expect(treeRow(page, "Server neu")).not.toHaveAttribute(
      "class",
      /in-trash/,
    );
    await menu(page, "Server neu", "delete");
    await menu(page, "Server neu", "delete");
    await page.getByTestId("confirm-yes").click();
    await expect(treeRow(page, "Server neu")).toHaveCount(0);

    // The other device sees the same state.
    await account.device.engine.refresh();
    const tree = account.device.engine.snapshot.vaults[0]?.tree;
    expect(
      [...(tree?.nodes.values() ?? [])].filter((n) => n.kind === "group"),
    ).toEqual([]);
  });

  test("creates, edits, orders and deletes databases with reauth", async ({
    page,
    guard,
  }) => {
    const account = await createAccountWithVault("databases");
    guard.secrets.push(account.password);
    await loginViaUi(page, account);
    await openDatabases(page);
    await page.getByTestId("vault-create-name").fill("Arbeit");
    await page.getByTestId("vault-create-submit").click();
    const names = page.getByTestId("vault-link");
    await expect(names).toHaveText(["Persönlich", "Arbeit"]);
    await page.getByTestId("vault-up").nth(1).click();
    await expect(names).toHaveText(["Arbeit", "Persönlich"]);

    await page.getByTestId("vault-edit-open").first().click();
    await page.getByTestId("vault-edit-name").fill("Arbeit 2");
    await page.getByTestId("vault-edit-save").click();
    await expect(names).toHaveText(["Arbeit 2", "Persönlich"]);

    // The settings page: recycle bin and history length.
    await page.getByTestId("vault-settings").first().click();
    await expect(page.getByTestId("database-view")).toBeVisible();
    await page.getByTestId("vault-edit-history").fill("3");
    await page.getByTestId("vault-edit-save").click();
    await expect(page.getByTestId("vault-edit-history")).toHaveValue("3");
    await page.getByTestId("back").click();

    await page.getByTestId("vault-delete-open").first().click();
    const dialog = page.getByTestId("vault-delete");
    await dialog.getByTestId("vault-delete-name").fill("Arbeit");
    await expect(dialog.getByTestId("vault-delete-submit")).toBeDisabled();
    await dialog.getByTestId("vault-delete-name").fill("Arbeit 2");
    await dialog.getByLabel("Master-Passwort", { exact: true }).fill("falsch");
    await dialog.getByTestId("vault-delete-submit").click();
    await expect(dialog.getByTestId("error")).toContainText("falsch");
    await dialog
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await dialog.getByTestId("vault-delete-submit").click();
    await expect(names).toHaveText(["Persönlich"]);

    // The order is stored in user_data and reaches other devices.
    await account.device.account.reloadUserData();
    expect(account.device.account.vaultOrder[0]).not.toBe(account.vaultId);
  });

  test("deletes the account", async ({ page, guard }) => {
    const account = await createAccountWithVault("deleteme");
    guard.secrets.push(account.password);
    await loginViaUi(page, account);
    await openAccount(page, "delete");
    await expect(page.getByTestId("delete-account-vaults")).toContainText(
      "Persönlich",
    );
    await page.getByTestId("delete-account-email").fill(account.email);
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("delete-account-submit").click();
    await expect(page.getByTestId("account-deleted")).toBeVisible();
    await page.getByLabel("E-Mail-Adresse").fill(account.email);
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("error")).toContainText("falsch");
  });
});

test.describe("synchronisation", () => {
  test("two browsers see each other's changes within 2 seconds", async ({
    page,
    otherContext: other,
  }) => {
    const account = await createAccountWithVault("twobrowsers");
    await nodeGroup(account.device, account.vaultId, "Alpha");
    const second = await other.newPage();
    await loginViaUi(page, account);
    await loginViaUi(second, account);
    await waitOnline(page);
    await waitOnline(second);
    await expect(treeRow(second, "Alpha")).toBeVisible();

    await rename(page, "Alpha", "Beta");
    await expect(treeRow(page, "Beta")).toBeVisible();
    await expect(treeRow(second, "Beta")).toBeVisible({ timeout: 2000 });

    // Another device as writer.
    await nodeGroup(account.device, account.vaultId, "Gamma");
    await expect(treeRow(second, "Gamma")).toBeVisible({ timeout: 2000 });
    await expect(treeRow(page, "Gamma")).toBeVisible({ timeout: 2000 });

    // Changes while offline arrive after reconnecting.
    await other.setOffline(true);
    await nodeGroup(account.device, account.vaultId, "Delta");
    await other.setOffline(false);
    await expect(treeRow(second, "Delta")).toBeVisible({ timeout: 15_000 });
  });

  test("conflicts keep both changes or report the discarded one", async ({
    page,
  }) => {
    const account = await createAccountWithVault("conflict");
    const groupId = await nodeGroup(account.device, account.vaultId, "Konto");
    // No events for this browser: it stays on its stale state.
    await page.routeWebSocket(/\/v1\/events$/, () => undefined);
    await loginViaUi(page, account);
    await expect(treeRow(page, "Konto")).toBeVisible();

    // The same field on both sides: the server wins, with a notice.
    await account.device.engine.renameGroup(
      account.vaultId,
      groupId,
      "Von Node",
    );
    await rename(page, "Konto", "Vom Browser");
    await expect(page.getByTestId("write-notices")).toContainText(
      "Vom Browser",
    );
    await expect(treeRow(page, "Von Node")).toBeVisible();

    // Different fields: both stay.
    await account.device.engine.renameGroup(
      account.vaultId,
      groupId,
      "Node zwei",
    );
    await menu(page, "Von Node", "delete");
    await expect(treeRow(page, "Node zwei")).toHaveAttribute(
      "class",
      /in-trash/,
    );
    await expect(page.getByTestId("write-notices")).toHaveCount(0);
    await account.device.engine.pull(account.vaultId);
    const node =
      account.device.engine.snapshot.vaults[0]?.tree.nodes.get(groupId);
    expect(node).toMatchObject({ name: "Node zwei", inTrash: true });
  });

  test("a full sync of 3 batches of 500 objects with limit=100 is complete", async ({
    page,
  }) => {
    const account = await createAccountWithVault("paging");
    for (let batch = 0; batch < 3; batch++)
      await account.device.engine.createGroups(
        account.vaultId,
        Array.from({ length: 500 }, (_, i) => ({
          name: `G ${String(batch * 500 + i)}`,
        })),
      );
    const pages: string[] = [];
    await page.route("**/v1/vaults/*/changes?**", async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("limit", "100");
      pages.push(url.search);
      await route.continue({ url: url.toString() });
    });
    await loginViaUi(page, account);
    await expect(
      page.locator("[data-test=tree-row][data-kind=group]"),
    ).toHaveCount(1500);
    expect(
      pages.filter((p) => p.includes("since=0")).length,
    ).toBeGreaterThanOrEqual(16);
  });
});

test.describe("rollback and corruption", () => {
  test("an older object played back by the server is flagged", async ({
    page,
  }) => {
    const account = await createAccountWithVault("rollback");
    const id = await nodeGroup(account.device, account.vaultId, "Original");
    const old = (await account.device.api.changes(account.vaultId, 0)).objects
      .filter((o) => o.id === id)
      .at(0);
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await account.device.engine.renameGroup(account.vaultId, id, "Neu");
    await expect(treeRow(page, "Neu")).toBeVisible();

    await rewriteChanges(page, (body) => {
      body.objects = body.objects.map((o) =>
        o.id === id && old ? { ...old, revision: o.revision } : o,
      );
    });
    await unlockAfterReload(page, account.password);
    await expect(page.getByTestId("vault-rollback")).toBeVisible();
    await expect(treeRow(page, "Original")).toBeVisible();
    await treeRow(page, "Original").click({ button: "right" });
    await expect(page.getByTestId("menu-rename")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.unroute("**/v1/vaults/*/changes?**");
    await page.getByTestId("vault-rollback-ack").click();
    await expect(page.getByTestId("vault-rollback")).toHaveCount(0);
  });

  test("an older vault revision makes the database read-only", async ({
    page,
  }) => {
    const account = await createAccountWithVault("oldvault");
    await nodeGroup(account.device, account.vaultId, "Eins");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await createGroup(page, "Zwei");
    await rewriteChanges(page, (body) => {
      body.vault_revision = 1;
    });
    await unlockAfterReload(page, account.password);
    await expect(page.getByTestId("vault-rollback")).toBeVisible();
    await expect(page.getByTestId("new-group")).toBeDisabled();
  });

  test("a manipulated object is shown as corrupt", async ({ page }) => {
    const account = await createAccountWithVault("corrupt");
    const id = await nodeGroup(account.device, account.vaultId, "Kaputt");
    expect(rootOf(account.device, account.vaultId)).not.toBe("");
    await rewriteChanges(page, (body) => {
      for (const o of body.objects)
        if (o.id === id && o.data) o.data = flipped(o.data);
    });
    await loginViaUi(page, account);
    await expect(page.getByTestId("tree-vault-warning")).toBeVisible();
    await expect(treeRow(page, "Kaputt")).toHaveCount(0);
    await openDatabases(page);
    await expect(page.getByTestId("vault-corrupt")).toContainText("1");
    await page.getByTestId("vault-settings").click();
    await expect(page.getByTestId("corrupt")).toContainText(id);
    await expect(page.getByTestId("corrupt")).toContainText("Prüfsumme");
  });

  test("a corrupt update keeps the last valid version, read-only", async ({
    page,
  }) => {
    const account = await createAccountWithVault("superseded");
    const { device, vaultId } = account;
    const id = await nodeEntry(device, vaultId, rootOf(device, vaultId), {
      title: "Gültig",
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await expect(entryRow(page, "Gültig")).toBeVisible();
    await rewriteChanges(page, (body) => {
      for (const o of body.objects)
        if (o.id === id && o.data) o.data = flipped(o.data);
    });
    const edit = device.engine.editEntry(vaultId, id);
    if (!edit) throw new Error("entry missing");
    await device.engine.saveEntry(edit.base, { ...edit.draft, title: "Neu" });
    await expect(page.getByTestId("tree-vault-warning")).toBeVisible();
    await entryRow(page, "Gültig").click();
    await expect(page.getByTestId("detail-superseded")).toBeVisible();
    await expect(page.getByTestId("detail-edit")).toBeDisabled();
  });

  test("an older key version makes the database read-only", async ({
    page,
  }) => {
    const account = await createAccountWithVault("oldkey");
    const { device, vaultId } = account;
    const before = (await device.api.vaults()).find(
      (v) => v.vault_id === vaultId,
    );
    const review = await device.engine.prepareRotation(vaultId);
    await device.engine.runRotation(review, { remove: [], dropCorrupt: false });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await createGroup(page, "Nach der Rotation");
    // The server plays back the vault list from before the rotation.
    await page.route("**/v1/vaults", async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as {
        vaults: Record<string, unknown>[];
      };
      for (const summary of body.vaults)
        if (summary.vault_id === vaultId)
          Object.assign(summary, {
            vault_key_version: 1,
            member_key_version: 1,
            key_wrapped: before?.key_wrapped,
            pending_key: null,
          });
      await route.fulfill({ response, json: body });
    });
    await unlockAfterReload(page, account.password);
    await expect(page.getByTestId("vault-key-rollback")).toBeVisible();
    await expect(page.getByTestId("new-group")).toBeDisabled();
  });
});
