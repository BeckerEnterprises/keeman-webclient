import {
  createAccount,
  createAccountWithVault,
  loginViaUi,
  unlockViaUi,
} from "./helpers";
import { expect, test } from "./fixtures";

test.describe("several tabs", () => {
  test("parallel refreshes do not revoke the session", async ({
    context,
    page,
  }) => {
    const account = await createAccount("tabs");
    await loginViaUi(page, account);
    const second = await context.newPage();
    await second.goto("/");
    await unlockViaUi(second, account.password);
    await expect(second.getByTestId("main-view")).toBeVisible();

    await Promise.all([page.reload(), second.reload()]);
    await unlockViaUi(page, account.password);
    await unlockViaUi(second, account.password);
    await expect(page.getByTestId("main-view")).toBeVisible();
    await expect(second.getByTestId("main-view")).toBeVisible();
  });

  test("three tabs reload and unlock at once and keep syncing", async ({
    context,
    page,
  }) => {
    const account = await createAccountWithVault("threetabs");
    await loginViaUi(page, account);
    const tabs = [page, await context.newPage(), await context.newPage()];
    for (const tab of tabs.slice(1)) {
      await tab.goto("/");
      await unlockViaUi(tab, account.password);
    }
    await Promise.all(tabs.map((tab) => tab.reload()));
    await Promise.all(tabs.map((tab) => unlockViaUi(tab, account.password)));
    for (const tab of tabs)
      await expect(tab.getByTestId("connection")).toHaveAttribute(
        "data-state",
        "online",
      );
    await account.device.engine.createVault({
      name: "Neu",
      rootName: "Neu",
      recycleBinName: "Papierkorb",
    });
    for (const tab of tabs)
      await expect(
        tab.locator("[data-test=tree-row][data-kind=root]"),
      ).toHaveText(["Persönlich", "Neu"]);
  });

  test("a tab without Web Locks recovers via refresh_superseded", async ({
    context,
    page,
  }) => {
    const account = await createAccount("nolocks");
    await loginViaUi(page, account);
    const second = await context.newPage();
    await second.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "locks", {
        get: () => undefined,
      });
    });
    await second.goto("/");
    await unlockViaUi(second, account.password);
    for (let round = 0; round < 3; round++) {
      await Promise.all([page.reload(), second.reload()]);
      await expect(page.getByTestId("unlock")).toBeVisible();
      await expect(second.getByTestId("unlock")).toBeVisible();
    }
    await unlockViaUi(page, account.password);
    await unlockViaUi(second, account.password);
    await expect(page.getByTestId("main-view")).toBeVisible();
    await expect(second.getByTestId("main-view")).toBeVisible();
  });

  test("lock and logout apply to all tabs, unlock does not", async ({
    context,
    page,
  }) => {
    const account = await createAccount("propagate");
    await loginViaUi(page, account);
    const second = await context.newPage();
    await second.goto("/");
    await unlockViaUi(second, account.password);
    await expect(second.getByTestId("main-view")).toBeVisible();

    await page.getByTestId("lock").click();
    await expect(second.getByTestId("unlock")).toBeVisible();
    await unlockViaUi(page, account.password);
    await expect(page.getByTestId("main-view")).toBeVisible();
    await expect(second.getByTestId("unlock")).toBeVisible();

    await page.getByTestId("logout").click();
    await expect(second.getByTestId("login")).toBeVisible();
  });
});
