/**
 * The tree: keyboard, context menu, reordering, the move
 * dialog, the stored tree state and the repair of cycles.
 */
import { nodeDevice } from "./helpers";
import {
  createAccountWithVault,
  loginViaUi,
  nodeGroup,
  openVault,
  rootOf,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

const groupNames = (page: import("@playwright/test").Page) =>
  page.locator("[data-test=tree-row][data-kind=group] [data-test=tree-name]");

test.describe("tree", () => {
  test("works with the keyboard: menu, new group, rename, reorder, move", async ({
    page,
  }) => {
    const account = await createAccountWithVault("treekeys");
    await nodeGroup(account.device, account.vaultId, "Alpha");
    await nodeGroup(account.device, account.vaultId, "Beta");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    const root = page.locator("[data-test=tree-row][data-kind=root]");
    await root.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.getByTestId("group-dialog-name").fill("Gamma");
    await page.getByTestId("group-dialog-name").press("Enter");
    await expect(treeRow(page, "Gamma")).toBeVisible();
    await expect(groupNames(page)).toHaveText(["Alpha", "Beta", "Gamma"]);

    // Arrow keys and F2.
    await root.focus();
    await page.keyboard.press("ArrowDown");
    await expect(treeRow(page, "Papierkorb")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(treeRow(page, "Alpha")).toBeFocused();
    await page.keyboard.press("F2");
    await page.getByTestId("tree-rename").fill("Alpha 2");
    await page.getByTestId("tree-rename").press("Enter");
    await expect(treeRow(page, "Alpha 2")).toBeFocused();

    // Down via the menu, up via the menu.
    await page.keyboard.press("ContextMenu");
    await page.getByTestId("menu-down").click();
    await expect(groupNames(page)).toHaveText(["Beta", "Alpha 2", "Gamma"]);
    await treeRow(page, "Gamma").click({ button: "right" });
    await page.getByTestId("menu-up").click();
    await expect(groupNames(page)).toHaveText(["Beta", "Gamma", "Alpha 2"]);

    // Move to… with the keyboard.
    await treeRow(page, "Gamma").click({ button: "right" });
    await page.getByTestId("menu-move").click();
    const options = page.getByTestId("move-option");
    await expect(options.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("move-dialog")).toHaveCount(0);
    const gamma = treeRow(page, "Gamma");
    await expect(gamma).toHaveAttribute("aria-level", "3");
  });

  test("keeps the collapsed state across lock and unlock", async ({
    page,
    guard,
  }) => {
    const account = await createAccountWithVault("treestate");
    guard.secrets.push(account.password);
    const parent = await nodeGroup(account.device, account.vaultId, "Eltern");
    await nodeGroup(account.device, account.vaultId, "Kind", parent);
    await loginViaUi(page, account);
    // The vault node and the first level are open by default.
    await expect(treeRow(page, "Kind")).toBeVisible();
    await treeRow(page, "Eltern").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(treeRow(page, "Kind")).toHaveCount(0);
    await page.keyboard.press("Shift+L");
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("unlock-submit").click();
    await expect(treeRow(page, "Eltern")).toBeVisible();
    await expect(treeRow(page, "Kind")).toHaveCount(0);
    await treeRow(page, "Eltern").focus();
    await page.keyboard.press("ArrowRight");
    await expect(treeRow(page, "Kind")).toBeVisible();
    const stored = await page.evaluate(() =>
      localStorage.getItem("keeman.view"),
    );
    expect(stored).not.toContain("Eltern");
  });

  test("shows a cycle from two devices and repairs it", async ({ page }) => {
    const account = await createAccountWithVault("cycle");
    const p = await nodeGroup(account.device, account.vaultId, "P");
    const q = await nodeGroup(account.device, account.vaultId, "Q");
    const other = await nodeDevice(account);
    const vaultId = account.vaultId;
    await account.device.engine.move(vaultId, [{ kind: "group", id: p }], {
      vaultId,
      groupId: q,
    });
    await other.engine.move(vaultId, [{ kind: "group", id: q }], {
      vaultId,
      groupId: p,
    });
    await loginViaUi(page, account);
    await expect(page.getByText("Zyklus")).toBeVisible();
    await page
      .locator("[data-test=tree-row][data-kind=root]")
      .click({ button: "right" });
    await page.getByTestId("menu-repair").click();
    await expect(page.getByText("Zyklus")).toHaveCount(0);
    await account.device.engine.pull(vaultId);
    expect(account.device.engine.snapshot.vaults[0]?.tree.repairs).toEqual([]);
    expect(rootOf(account.device, vaultId)).not.toBe("");
  });
});
