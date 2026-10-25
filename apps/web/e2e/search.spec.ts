/** Search: normalisation, terms, scopes, recycle bin, protected fields. */
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  openAccount,
  openMain,
  openVault,
  rootOf,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

test("finds entries without regard to case and diacritics", async ({
  page,
}) => {
  const account = await createAccountWithVault("search");
  const root = rootOf(account.device, account.vaultId);
  const work = await nodeGroup(account.device, account.vaultId, "Arbeit");
  await nodeEntry(account.device, account.vaultId, work, {
    title: "Café Straße",
    username: "jürgen",
  });
  await nodeEntry(account.device, account.vaultId, root, {
    title: "Bank",
    fields: [{ name: "Kundennummer", value: "Geheimzahl", protected: true }],
  });
  const old = await nodeEntry(account.device, account.vaultId, root, {
    title: "Alte Strasse",
  });
  await account.device.engine.trash(
    account.vaultId,
    [{ kind: "entry", id: old }],
    "Papierkorb",
  );
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  const search = page.getByTestId("search");
  await search.fill("STRASSE");
  await expect(page.getByTestId("entry-row")).toHaveCount(1);
  await expect(entryRow(page, "Café Straße")).toBeVisible();
  await expect(page.getByTestId("entry-row").first()).toContainText(
    "Persönlich › Arbeit",
  );
  await page.getByTestId("search-trash").check();
  await expect(page.getByTestId("entry-row")).toHaveCount(2);
  await page.getByTestId("search-trash").uncheck();
  await search.fill("cafe jurgen");
  await expect(entryRow(page, "Café Straße")).toBeVisible();
  // Scope "this group" from the root contains the subgroups.
  await page.getByTestId("search-scope").selectOption("group");
  await expect(page.getByTestId("entry-row")).toHaveCount(1);
  await treeRow(page, "Papierkorb").click();
  await expect(page.getByTestId("list-empty")).toBeVisible();
  await page.getByTestId("search-scope").selectOption("vault");
  // Protected values only with the setting.
  await search.fill("geheimzahl");
  await expect(page.getByTestId("list-empty")).toBeVisible();
  await search.fill("kundennummer");
  await expect(entryRow(page, "Bank")).toBeVisible();
  // Search terms are never in the URL.
  expect(page.url()).not.toContain("kunden");
  await search.press("Escape");
  await expect(search).toHaveValue("");

  await openAccount(page, "settings");
  await page.getByTestId("settings-search-protected").check();
  await page.getByTestId("settings-save").click();
  await expect(
    page.getByRole("status").filter({ hasText: "Gespeichert" }),
  ).toBeVisible();
  await openMain(page);
  await page.getByTestId("search").fill("geheimzahl");
  await expect(entryRow(page, "Bank")).toBeVisible();
});
