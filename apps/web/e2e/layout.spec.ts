/** Desktop layout: the page itself never scrolls; the areas do. */
import {
  createAccountWithVault,
  loginViaUi,
  nodeEntry,
  rootOf,
} from "./helpers";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 1280, height: 720 } });

test("the main view fits the window and scrolls inside its areas", async ({
  page,
}) => {
  const account = await createAccountWithVault("layout");
  const engine = account.device.engine;
  await engine.createGroups(
    account.vaultId,
    Array.from({ length: 60 }, (_, i) => ({ name: `Gruppe ${String(i)}` })),
  );
  const root = rootOf(account.device, account.vaultId);
  for (let i = 0; i < 40; i++)
    await nodeEntry(account.device, account.vaultId, root, {
      title: `Eintrag ${String(i)}`,
    });
  await loginViaUi(page, account);
  await expect(
    page.locator("[data-test=tree-row][data-kind=group]"),
  ).toHaveCount(60);
  await expect(page.getByTestId("entry-row").first()).toBeVisible();
  const sizes = await page.evaluate(() => ({
    page: document.documentElement.scrollHeight,
    window: window.innerHeight,
    tree: (() => {
      const pane = document.querySelector(".pane-tree");
      return pane ? pane.scrollHeight > pane.clientHeight : false;
    })(),
  }));
  expect(sizes.page).toBeLessThanOrEqual(sizes.window);
  expect(sizes.tree).toBe(true);
});
