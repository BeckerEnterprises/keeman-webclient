/** Everything by keyboard. */
import {
  clipboardWrites,
  createAccountWithVault,
  entryRow,
  loginViaUi,
  spyClipboard,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

test("creates, copies, searches, deletes and locks with the keyboard only", async ({
  page,
  context,
  browserName,
  guard,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const account = await createAccountWithVault("keyboard");
  guard.secrets.push(account.password);
  await spyClipboard(page);
  await loginViaUi(page, account);
  await expect(treeRow(page, "Persönlich")).toBeVisible();

  // F6 enters the tree; N opens a new entry with the title focused.
  await page.keyboard.press("F6");
  await expect(treeRow(page, "Persönlich")).toBeFocused();
  await page.keyboard.press("n");
  await expect(page.getByTestId("editor-title")).toBeFocused();
  await page.keyboard.type("Tastatur");
  await page.keyboard.press("Tab");
  await page.keyboard.type("nutzer");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Kennwort 123");
  guard.secrets.push("Kennwort 123");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("detail-title")).toHaveText("Tastatur");

  // Into the list; copy user name and password.
  await page.keyboard.press("F6");
  await page.keyboard.press("F6");
  await expect(entryRow(page, "Tastatur")).toBeFocused();
  await page.keyboard.press("Control+b");
  await expect.poll(() => clipboardWrites(page)).toContain("nutzer");
  await page.keyboard.press("Control+c");
  await expect.poll(() => clipboardWrites(page)).toContain("Kennwort 123");

  // Search with "/", clear with Escape.
  await page.keyboard.press("/");
  await expect(page.getByTestId("search")).toBeFocused();
  await page.keyboard.type("tast");
  await expect(page.getByTestId("entry-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search")).toHaveValue("");

  // The overview with "?".
  await page.keyboard.press("F6");
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts")).toBeVisible();
  await expect(page.getByTestId("shortcuts")).toContainText("Ctrl+C");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts")).toHaveCount(0);

  // Delete into the recycle bin, then lock. The focus is back in the tree.
  await page.keyboard.press("F6");
  await expect(entryRow(page, "Tastatur")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(entryRow(page, "Tastatur")).toHaveCount(0);
  await page.keyboard.press("F6");
  await page.keyboard.press("Shift+L");
  await expect(page.getByTestId("unlock")).toBeVisible();
});
