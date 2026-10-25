/** Narrow screens: tree, list and detail one after another. */
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 800, height: 900 } });

test("navigates stacked with back buttons", async ({ page }) => {
  const account = await createAccountWithVault("narrow");
  const group = await nodeGroup(account.device, account.vaultId, "Gruppe");
  await nodeEntry(account.device, account.vaultId, group, { title: "Schmal" });
  await loginViaUi(page, account);
  await expect(page.getByTestId("tree")).toBeVisible();
  await expect(page.getByTestId("entry-list")).toBeHidden();
  await treeRow(page, "Gruppe").click();
  await expect(page.getByTestId("tree")).toBeHidden();
  await expect(entryRow(page, "Schmal")).toBeVisible();
  await entryRow(page, "Schmal").click();
  await expect(page.getByTestId("entry-detail")).toBeVisible();
  await expect(page.getByTestId("entry-list")).toBeHidden();
  await page.getByTestId("detail-edit").click();
  await expect(page.getByTestId("entry-editor")).toBeVisible();
  await page.getByTestId("editor-cancel").click();
  await page.getByTestId("main-back").click();
  await expect(entryRow(page, "Schmal")).toBeVisible();
  await page.getByTestId("main-back").click();
  await expect(page.getByTestId("tree")).toBeVisible();
});
