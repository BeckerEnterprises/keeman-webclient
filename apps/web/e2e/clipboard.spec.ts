/** Clipboard: copy, clear after the time, fallback, lock. */
import {
  clipboardWrites,
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  openVault,
  rootOf,
  spyClipboard,
} from "./helpers";
import { expect, test } from "./fixtures";

test("clears the clipboard after the configured time", async ({
  page,
  context,
  browserName,
  guard,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const account = await createAccountWithVault("clipboard");
  await account.device.account.updateSettings({ clipboardClearSeconds: 8 });
  await nodeEntry(
    account.device,
    account.vaultId,
    rootOf(account.device, account.vaultId),
    { title: "Kopie", password: "Kopiergeheim 9" },
  );
  guard.secrets.push("Kopiergeheim 9");
  await spyClipboard(page);
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  await entryRow(page, "Kopie").click();
  await page.getByTestId("detail-password-copy").click();
  await expect(page.getByTestId("toast").last()).toContainText("8 s");
  await expect(page.getByTestId("toasts")).not.toContainText("Kopiergeheim");
  expect(await clipboardWrites(page)).toContain("Kopiergeheim 9");
  if (browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Kopiergeheim 9",
    );

  // Real time without page.evaluate, which counts as a user action:
  // Firefox ends the user activation after 5 s.
  await page.waitForTimeout(9_000);
  if (browserName === "chromium") {
    expect(await clipboardWrites(page)).toContain("");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("");
  } else {
    // The browser refused: cleared on the next click in the tab.
    await expect(page.getByTestId("toasts")).toContainText("nächsten Klick");
    await page.getByTestId("detail-title").click();
    await expect(page.getByTestId("toasts")).toContainText("geleert");
    expect((await clipboardWrites(page)).filter((w) => w === "")).toHaveLength(
      2,
    );
  }

  // Locking clears what is still pending.
  await page.getByTestId("detail-password-copy").click();
  const count = (await clipboardWrites(page)).length;
  await page.getByTestId("lock").click();
  await expect
    .poll(async () => (await clipboardWrites(page)).slice(count))
    .toContain("");
});
