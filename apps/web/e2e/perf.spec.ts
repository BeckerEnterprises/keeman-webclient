/**
 * Performance: a tree with 5 levels and 2000 entries stays fluid.
 * Times are measured from the test side, so they include Playwright's own
 * round trips; the bounds are the ones of the plan.
 */
import { emptyDraft } from "@keeman/core";
import { createAccountWithVault, loginViaUi, rootOf, treeRow } from "./helpers";
import { expect, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("5 levels, 363 groups and 2000 entries stay fluid", async ({ page }) => {
  test.setTimeout(300_000);
  const account = await createAccountWithVault("perf");
  const engine = account.device.engine;
  const vaultId = account.vaultId;
  let parents = [rootOf(account.device, vaultId)];
  const levels: string[][] = [];
  for (let depth = 1; depth <= 5; depth++) {
    const specs = parents.flatMap((parentId) =>
      [0, 1, 2].map((i) => ({
        name: `Ebene ${String(depth)} · ${String(i)} · ${parentId.slice(-4)}`,
        parentId,
      })),
    );
    parents = await engine.createGroups(vaultId, specs);
    levels.push(parents);
  }
  expect(levels.flat()).toHaveLength(363);
  // 2000 entries spread over the 9 groups of level 2.
  const level2 = levels[1] ?? [];
  for (const [index, groupId] of level2.entries()) {
    const count = index < 2 ? 223 : 222;
    await engine.createEntries(
      vaultId,
      groupId,
      Array.from({ length: count }, (_, i) => ({
        ...emptyDraft(),
        title: `Eintrag ${String(index)}-${String(i)}`,
        username: `user${String(i)}`,
        url: `https://host${String(i)}.example`,
        tags: ["kunde"],
      })),
    );
  }

  const results: Record<string, number> = {};
  const time = async (name: string, run: () => Promise<void>) => {
    const start = Date.now();
    await run();
    results[name] = Date.now() - start;
  };

  await time("unlock", async () => {
    await loginViaUi(page, account);
    await expect(
      page.locator("[data-test=tree-row][data-kind=group]").first(),
    ).toBeVisible();
  });

  await page.getByTestId("subgroups").check();
  const root = page.locator("[data-test=tree-row][data-kind=root]");
  await time("groupSwitch", async () => {
    await treeRow(
      page,
      `Ebene 1 · 0 · ${rootOf(account.device, vaultId).slice(-4)}`,
    ).click();
    await root.click();
    await expect(page.getByTestId("entry-list")).toHaveAttribute(
      "aria-rowcount",
      "2001",
    );
  });
  // Only visible rows are in the DOM.
  expect(await page.getByTestId("entry-row").count()).toBeLessThanOrEqual(100);

  await time("search", async () => {
    await page.getByTestId("search").fill("Eintrag 5-221");
    await expect(page.getByTestId("entry-row")).toHaveCount(1);
  });
  await page.getByTestId("search").fill("");

  await time("collapse", async () => {
    await root.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.locator("[data-test=tree-row][data-kind=group]"),
    ).toHaveCount(0);
  });
  await time("expand", async () => {
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator("[data-test=tree-row][data-kind=group]").first(),
    ).toBeVisible();
  });

  // Scrolling the list: the largest gap between two frames.
  results.scrollFrameGap = await page.evaluate(async () => {
    const scroller = document.querySelector(".virtual-scroller");
    if (!scroller) return -1;
    let last = performance.now();
    let worst = 0;
    for (let step = 0; step < 60; step++) {
      scroller.scrollTop += 400;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }
    return Math.round(worst);
  });

  test
    .info()
    .annotations.push({ type: "perf", description: JSON.stringify(results) });
  console.log("perf", JSON.stringify(results));
  expect(results.unlock).toBeLessThan(5000);
  expect(results.groupSwitch).toBeLessThan(500);
  expect(results.search).toBeLessThan(300);
  expect(results.collapse).toBeLessThan(200);
  expect(results.expand).toBeLessThan(200);
  expect(results.scrollFrameGap).toBeGreaterThan(0);
  expect(results.scrollFrameGap).toBeLessThan(150);
});
