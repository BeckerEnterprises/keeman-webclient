/** Vault contents are untrusted: shown as text, never as HTML. */
import {
  createAccountWithVault,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  openVault,
} from "./helpers";
import { expect, test } from "./fixtures";

const PAYLOAD = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;

test("renders markup in all fields as plain text", async ({ page }) => {
  const account = await createAccountWithVault("xss");
  const group = await nodeGroup(account.device, account.vaultId, PAYLOAD);
  await nodeEntry(account.device, account.vaultId, group, {
    title: PAYLOAD,
    username: PAYLOAD,
    url: "javascript:window.__xss=3",
    notes: PAYLOAD,
    tags: ["<b>tag</b>"],
    fields: [{ name: "<i>Feld</i>", value: PAYLOAD, protected: false }],
  });
  page.on("dialog", () => {
    throw new Error("no dialog expected");
  });
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  await page.getByTestId("tree-row").filter({ hasText: "<img" }).click();
  await page.getByTestId("entry-row").first().click();
  await expect(page.getByTestId("detail-title")).toHaveText(PAYLOAD);
  await expect(page.getByTestId("detail-notes")).toHaveText(PAYLOAD);
  await expect(page.getByTestId("detail-tags")).toHaveText("<b>tag</b>");
  await expect(page.getByTestId("detail-url-value")).toHaveText(
    "javascript:window.__xss=3",
  );
  // The URL is shown as text, not as a link.
  await expect(page.locator("[data-test=entry-detail] a")).toHaveCount(0);
  await page.getByTestId("tab-history").click();
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
  await expect(page.locator("img[src=x]")).toHaveCount(0);
  await expect(page.locator("main script")).toHaveCount(0);
});
