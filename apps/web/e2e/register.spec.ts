import { invite, strongPassword, uniqueEmail } from "./helpers";
import { expect, test } from "./fixtures";

test.describe("registration", () => {
  test("registers with an invite and confirms the recovery key", async ({
    page,
    guard,
  }) => {
    const email = uniqueEmail("register");
    const password = strongPassword();
    guard.secrets.push(password, email);
    await page.goto("/register");
    await page.getByLabel("Einladungscode").fill(invite());
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.getByLabel("Master-Passwort", { exact: true }).fill(password);
    await page.getByLabel("Master-Passwort wiederholen").fill(password);
    await page.getByTestId("register-submit").click();

    const panel = page.getByTestId("recovery-key");
    await expect(panel).toBeVisible();
    const groups = await page.getByTestId("recovery-group").allTextContents();
    expect(groups).toHaveLength(14);
    guard.secrets.push(groups.join(" ").trim());

    await page
      .getByLabel("Letzte Gruppe zur Bestätigung eintippen")
      .fill("ZZZZ");
    await page.getByTestId("recovery-confirm").click();
    await expect(page.getByRole("alert")).toContainText("stimmt nicht");
    await page
      .getByLabel("Letzte Gruppe zur Bestätigung eintippen")
      .fill((groups.at(-1) ?? "").trim().toLowerCase());
    await page.getByTestId("recovery-confirm").click();
    await expect(page.getByTestId("main-view")).toBeVisible();
    await expect(page.getByTestId("banner-recovery")).toHaveCount(0);
    // The first database was created in the background.
    await expect(
      page.locator("[data-test=tree-row][data-kind=root]"),
    ).toHaveText(["Persönlich"]);
    await expect(
      page.locator("[data-test=tree-row][data-kind=bin]"),
    ).toHaveText(["Papierkorb"]);
  });

  test("resends the identical request after a lost answer", async ({
    page,
  }) => {
    const email = uniqueEmail("retry");
    const password = strongPassword();
    const bodies: string[] = [];
    let lose = true;
    await page.route("**/v1/auth/register", async (route) => {
      bodies.push(route.request().postData() ?? "");
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await page.goto("/register");
    await page.getByLabel("Einladungscode").fill(invite());
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.getByLabel("Master-Passwort", { exact: true }).fill(password);
    await page.getByLabel("Master-Passwort wiederholen").fill(password);
    await page.getByTestId("register-submit").click();
    await expect(page.getByText("möglicherweise schon angelegt")).toBeVisible();
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("recovery-key")).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });
});
