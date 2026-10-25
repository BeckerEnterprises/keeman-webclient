/** Drag and drop: before, after, into, entries, other vaults. */
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

const groupNames = (page: import("@playwright/test").Page) =>
  page.locator("[data-test=tree-row][data-kind=group] [data-test=tree-name]");

test("moves groups and entries by drag and drop, also to another vault", async ({
  page,
}) => {
  const account = await createAccountWithVault("dnd");
  const a = await nodeGroup(account.device, account.vaultId, "A");
  await nodeGroup(account.device, account.vaultId, "B");
  await nodeGroup(account.device, account.vaultId, "C");
  const entry = await nodeEntry(
    account.device,
    account.vaultId,
    rootOf(account.device, account.vaultId),
    { title: "Zettel" },
  );
  const other = await account.device.engine.createVault({
    name: "Zweite",
    rootName: "Zweite",
    recycleBinName: "Papierkorb",
  });
  await loginViaUi(page, account);
  await expect(groupNames(page)).toHaveText(["A", "B", "C"]);

  // C before A, then A after B.
  const box = async (name: string) =>
    (await treeRow(page, name).boundingBox()) ?? { height: 24, width: 100 };
  await treeRow(page, "C").dragTo(treeRow(page, "A"), {
    targetPosition: { x: 40, y: (await box("A")).height * 0.15 },
  });
  await expect(groupNames(page)).toHaveText(["C", "A", "B"]);
  const b = await box("B");
  await treeRow(page, "A").dragTo(treeRow(page, "B"), {
    targetPosition: { x: 40, y: b.height * 0.85 },
  });
  await expect(groupNames(page)).toHaveText(["C", "B", "A"]);
  // B into C.
  const c = await box("C");
  await treeRow(page, "B").dragTo(treeRow(page, "C"), {
    targetPosition: { x: 40, y: c.height / 2 },
  });
  await expect(treeRow(page, "B")).toHaveAttribute("aria-level", "3");

  // An entry from the list into group A.
  await openVault(page, "Persönlich");
  await entryRow(page, "Zettel").dragTo(treeRow(page, "A"));
  await expect(entryRow(page, "Zettel")).toHaveCount(0);
  await treeRow(page, "A").click();
  await expect(entryRow(page, "Zettel")).toBeVisible();

  // Group A to the other vault, with confirmation.
  await treeRow(page, "A").dragTo(treeRow(page, "Zweite"));
  await expect(page.getByTestId("confirm-text")).toBeVisible();
  await page.getByTestId("confirm-yes").click();
  await expect(
    treeRow(page, "A").and(page.locator(`[data-vault-id="${other}"]`)),
  ).toBeVisible();
  await expect(treeRow(page, "A")).toHaveCount(1);

  await account.device.engine.refresh();
  await account.device.engine.pull(account.vaultId);
  await account.device.engine.pull(other);
  const source = account.device.engine.snapshot.vaults.find(
    (v) => v.id === account.vaultId,
  );
  const target = account.device.engine.snapshot.vaults.find(
    (v) => v.id === other,
  );
  expect(source?.tree.nodes.has(a)).toBe(false);
  expect(source?.entries.has(entry)).toBe(false);
  expect(target?.tree.nodes.get(a)?.name).toBe("A");
  expect(target?.entries.get(entry)?.groupId).toBe(a);
});
