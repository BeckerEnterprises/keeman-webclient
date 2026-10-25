/** Entry history: changes, highlighted fields, restore. */
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  openVault,
  rootOf,
} from "./helpers";
import { expect, test } from "./fixtures";

test("restores an earlier state that another device then sees", async ({
  page,
}) => {
  const account = await createAccountWithVault("history");
  const id = await nodeEntry(
    account.device,
    account.vaultId,
    rootOf(account.device, account.vaultId),
    {
      title: "Server",
      password: "eins",
    },
  );
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  await entryRow(page, "Server").click();
  for (const value of ["zwei", "drei", "vier"]) {
    await page.getByTestId("detail-edit").click();
    await page.getByTestId("editor-password").fill(value);
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("entry-detail")).toBeVisible();
  }
  await page.getByTestId("tab-history").click();
  const items = page.getByTestId("history-item");
  await expect(items).toHaveCount(3);
  // Second newest: the state with "zwei".
  await items.nth(1).click();
  await expect(items.nth(1)).toContainText("Passwort");
  await expect(page.getByTestId("history-password-value")).not.toContainText(
    "zwei",
  );
  await page.getByTestId("history-password-show").click();
  await expect(page.getByTestId("history-password-value")).toHaveText("zwei");
  await page.getByTestId("history-restore").click();
  await page.getByTestId("history-restore-confirm").click();
  await expect(items).toHaveCount(4);
  await page.getByTestId("tab-details").click();
  await page.getByTestId("detail-password-show").click();
  await expect(page.getByTestId("detail-password-value")).toHaveText("zwei");

  await account.device.engine.pull(account.vaultId);
  const detail = account.device.engine.entry(account.vaultId, id);
  expect(detail?.values.password).toBe("zwei");
  expect(detail?.history.map((h) => h.values.password)).toEqual([
    "vier",
    "drei",
    "zwei",
    "eins",
  ]);
});
