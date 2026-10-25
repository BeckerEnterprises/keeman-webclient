/** Password generator: entropy, passphrases, saved defaults. */
import { createAccountWithVault, loginViaUi, openVault } from "./helpers";
import { expect, test } from "./fixtures";

test("generates passwords and passphrases and saves the defaults", async ({
  page,
}) => {
  const account = await createAccountWithVault("generator");
  await loginViaUi(page, account);
  await openVault(page, "Persönlich");
  await page.getByTestId("new-entry").click();
  await page.getByTestId("editor-generate").click();
  const value = page.getByTestId("generator-value");
  await expect(value).toHaveText(/^.{24}$/);
  await expect(page.getByTestId("generator-bits")).toContainText("Bit");
  await page.getByTestId("generator-length").fill("8");
  await expect(page.getByTestId("generator-short")).toBeVisible();
  await page.getByTestId("generator-words").check();
  await page.getByTestId("generator-count").fill("4");
  await page.getByTestId("generator-separator").fill(".");
  await expect(value).toHaveText(/^[a-z]+(\.[a-z]+){3}$/);
  await expect(page.getByTestId("generator-bits")).toContainText("51 Bit");
  await page.getByTestId("generator-save").click();
  await expect(page.getByText("Als Standard gespeichert.")).toBeVisible();
  const phrase = (await value.textContent()) ?? "";
  await page.getByTestId("generator-use").click();
  await expect(page.getByTestId("editor-password")).toHaveValue(phrase);

  await account.device.account.reloadUserData();
  expect(account.device.account.settings.passwordGenerator).toMatchObject({
    mode: "words",
    words: 4,
    separator: ".",
    length: 8,
  });
});
