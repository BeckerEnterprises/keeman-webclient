/**
 * Entries: create with fields and tags, show and
 * copy, edit, unsaved changes, recycle bin, permanent deletion.
 */
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  openVault,
  rootOf,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

test.describe("entries", () => {
  test("creates an entry with fields and tags, shows and edits it", async ({
    page,
    guard,
  }) => {
    const account = await createAccountWithVault("entries");
    await nodeGroup(account.device, account.vaultId, "Mail");
    await loginViaUi(page, account);
    await treeRow(page, "Mail").click();
    await page.getByTestId("new-entry").click();
    const editor = page.getByTestId("entry-editor");
    await editor.getByTestId("editor-title").fill("Postfach");
    await editor.getByTestId("editor-username").fill("ich@example.com");
    await editor.getByTestId("editor-password").fill("Gänseblümchen 42!");
    guard.secrets.push("Gänseblümchen 42!");
    await editor.getByTestId("editor-url").fill("https://mail.example.com");
    await editor.getByTestId("editor-tag-input").fill("privat");
    await editor.getByTestId("editor-tag-input").press("Enter");
    await editor.getByTestId("editor-notes").fill("Zeile 1\nZeile 2");
    await editor.getByTestId("editor-tab-fields").click();
    await editor.getByTestId("editor-field-add").click();
    await editor.getByTestId("editor-field-name").fill("PIN");
    await editor.getByTestId("editor-field-value").fill("4711");
    await editor.getByTestId("editor-field-protected").check();
    await editor.getByTestId("editor-save").click();

    const detail = page.getByTestId("entry-detail");
    await expect(detail.getByTestId("detail-title")).toHaveText("Postfach");
    await expect(detail.getByTestId("detail-path")).toHaveText(
      "Persönlich › Mail",
    );
    await expect(detail.getByTestId("detail-password-value")).not.toContainText(
      "Gänseblümchen",
    );
    await detail.getByTestId("detail-password-show").click();
    await expect(detail.getByTestId("detail-password-value")).toHaveText(
      "Gänseblümchen 42!",
    );
    await expect(detail.getByTestId("detail-field-value")).not.toContainText(
      "4711",
    );
    await expect(detail.getByTestId("detail-tags")).toHaveText("privat");
    await expect(detail.getByTestId("detail-notes")).toHaveText(
      "Zeile 1\nZeile 2",
    );
    await expect(entryRow(page, "Postfach")).toBeVisible();

    // The Node device reads the same content.
    await account.device.engine.pull(account.vaultId);
    const summary = [
      ...(account.device.engine.snapshot.vaults[0]?.entries.values() ?? []),
    ][0];
    const values = account.device.engine.entry(
      account.vaultId,
      summary?.id ?? "",
    )?.values;
    expect(values).toMatchObject({
      title: "Postfach",
      password: "Gänseblümchen 42!",
      tags: ["privat"],
    });
    expect(values?.fields[0]).toMatchObject({
      name: "PIN",
      value: "4711",
      protected: true,
    });

    // Edit and keep a history.
    await detail.getByTestId("detail-edit").click();
    await page.getByTestId("editor-username").fill("du@example.com");
    await page.getByTestId("editor-username").press("Enter");
    await expect(detail.getByTestId("detail-username-value")).toHaveText(
      "du@example.com",
    );
    await expect(detail.getByTestId("tab-history")).toContainText("1");
  });

  test("asks about unsaved changes but not when the tab locks", async ({
    page,
    guard,
  }) => {
    const account = await createAccountWithVault("unsaved");
    guard.secrets.push(account.password);
    const root = rootOf(account.device, account.vaultId);
    await nodeEntry(account.device, account.vaultId, root, { title: "Eins" });
    await nodeEntry(account.device, account.vaultId, root, { title: "Zwei" });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await entryRow(page, "Eins").click();
    await page.getByTestId("detail-edit").click();
    await page.getByTestId("editor-title").fill("Eins geändert");
    const asked: string[] = [];
    page.once("dialog", (dialog) => {
      asked.push(dialog.message());
      void dialog.dismiss();
    });
    await entryRow(page, "Zwei").click();
    await expect(page.getByTestId("entry-editor")).toBeVisible();
    expect(asked).toHaveLength(1);
    // Locking discards the changes without a question.
    page.on("dialog", () => {
      throw new Error("no question expected");
    });
    await page.getByTestId("lock").click();
    await expect(page.getByTestId("unlock")).toBeVisible();
    await page
      .getByLabel("Master-Passwort", { exact: true })
      .fill(account.password);
    await page.getByTestId("unlock-submit").click();
    await expect(page.getByTestId("entry-editor")).toBeVisible();
    await expect(page.getByTestId("editor-title")).toHaveValue("Eins");
  });

  test("moves entries through the recycle bin and deletes them for good", async ({
    page,
  }) => {
    const account = await createAccountWithVault("trash");
    const root = rootOf(account.device, account.vaultId);
    await nodeEntry(account.device, account.vaultId, root, { title: "Alt" });
    await nodeEntry(account.device, account.vaultId, root, { title: "Weg" });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await entryRow(page, "Alt").click();
    await page.getByTestId("detail-delete").click();
    await expect(entryRow(page, "Alt")).toHaveCount(0);
    await treeRow(page, "Papierkorb").click();
    await entryRow(page, "Alt").click();
    await page.getByTestId("detail-restore").click();
    await expect(entryRow(page, "Alt")).toHaveCount(0);
    await openVault(page, "Persönlich");
    await expect(entryRow(page, "Alt")).toBeVisible();

    // Permanently from the bin, then empty it.
    await entryRow(page, "Weg").click();
    await page.getByTestId("detail-delete").click();
    await entryRow(page, "Alt").click();
    await page.getByTestId("detail-delete").click();
    await treeRow(page, "Papierkorb").click();
    await entryRow(page, "Alt").click();
    await page.getByTestId("detail-delete").click();
    await expect(page.getByTestId("confirm-text")).toContainText("1 Einträge");
    await page.getByTestId("confirm-yes").click();
    await expect(entryRow(page, "Alt")).toHaveCount(0);
    await treeRow(page, "Papierkorb").click({ button: "right" });
    await page.getByTestId("menu-emptyBin").click();
    await page.getByTestId("confirm-yes").click();
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await account.device.engine.pull(account.vaultId);
    expect(account.device.engine.snapshot.vaults[0]?.entries.size).toBe(0);
  });
});
