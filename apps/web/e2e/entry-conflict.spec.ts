/** Concurrent edits of an entry: per field, conflict snapshot. */
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  openVault,
  rootOf,
} from "./helpers";
import { expect, test } from "./fixtures";

test("keeps both changes or the losing version in the history", async ({
  page,
}) => {
  const account = await createAccountWithVault("entryconflict");
  const id = await nodeEntry(
    account.device,
    account.vaultId,
    rootOf(account.device, account.vaultId),
    {
      title: "Bank",
      username: "alt",
      password: "alt",
    },
  );
  // No events: the browser stays on its stale state.
  await page.routeWebSocket(/\/v1\/events$/, () => undefined);
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  await entryRow(page, "Bank").click();
  const edit = () => {
    const result = account.device.engine.editEntry(account.vaultId, id);
    if (!result) throw new Error("missing");
    return result;
  };

  // Different fields: both stay.
  let node = edit();
  await account.device.engine.saveEntry(node.base, {
    ...node.draft,
    username: "von Node",
  });
  await page.getByTestId("detail-edit").click();
  await page.getByTestId("editor-url").fill("https://bank.example");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("detail-username-value")).toHaveText(
    "von Node",
  );
  await expect(page.getByTestId("detail-url-value")).toHaveText(
    "https://bank.example",
  );
  await expect(page.getByTestId("write-notices")).toHaveCount(0);

  // The same field: the server wins, the browser's version is in the history.
  await account.device.engine.pull(account.vaultId);
  node = edit();
  await account.device.engine.saveEntry(node.base, {
    ...node.draft,
    password: "Node gewinnt",
  });
  await page.getByTestId("detail-edit").click();
  await page.getByTestId("editor-password").fill("Browser verliert");
  await page.getByTestId("editor-save").click();
  const notice = page.getByTestId("write-notices");
  await expect(notice).toContainText("password");
  await expect(notice).not.toContainText("verliert");
  await page.getByTestId("detail-password-show").click();
  await expect(page.getByTestId("detail-password-value")).toHaveText(
    "Node gewinnt",
  );
  await page.getByTestId("tab-history").click();
  await expect(page.getByTestId("history-conflict").first()).toBeVisible();
  await page.getByTestId("history-item").first().click();
  await page.getByTestId("history-password-show").click();
  await expect(page.getByTestId("history-password-value")).toHaveText(
    "Browser verliert",
  );
});
