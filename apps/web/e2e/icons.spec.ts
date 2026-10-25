/**
 * Custom icons and favicons: upload with
 * re-encoding, SVG without scripts, deduplication, favicons through a
 * replaced proxy answer (the real fetch is tested on the server), sync,
 * removing unused icons and moving to another database. Every custom icon
 * on the page is an <img> of a PNG data URL.
 */
import type { Page } from "@playwright/test";
import {
  createAccountWithVault,
  customIconSources,
  entryRow,
  loginViaUi,
  nodeEntry,
  nodeGroup,
  openDatabases,
  openVault,
  pngBytes,
  rootOf,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

const RED: [number, number, number, number] = [220, 38, 38, 255];
const BLUE: [number, number, number, number] = [37, 99, 235, 255];
const GREEN: [number, number, number, number] = [22, 163, 74, 255];
const PNG_PREFIX = "data:image/png;base64,";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="window.__iconScript = 'onload'">
  <script>window.__iconScript = "script";</script>
  <rect width="20" height="20" fill="#16a34a"/>
</svg>`;

async function expectPngIcons(page: Page): Promise<void> {
  for (const src of await customIconSources(page))
    expect(src.startsWith(PNG_PREFIX), src.slice(0, 40)).toBe(true);
}

async function openDatabasePage(page: Page, vaultId: string): Promise<void> {
  await openDatabases(page);
  await page
    .locator(`[data-test=vault][data-vault-id="${vaultId}"]`)
    .getByTestId("vault-settings")
    .click();
  await expect(page.getByTestId("database-view")).toBeVisible();
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

test.describe("custom icons", () => {
  test("uploads PNG and SVG, reuses the same image and shows them everywhere", async ({
    page,
  }) => {
    const account = await createAccountWithVault("icons");
    const { device, vaultId } = account;
    const root = rootOf(device, vaultId);
    await nodeEntry(device, vaultId, root, { title: "Mail" });
    await nodeEntry(device, vaultId, root, { title: "Shop" });
    await nodeGroup(device, vaultId, "Kunden");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    const png = pngBytes(100, 50, RED);
    const editor = page.getByTestId("entry-editor");
    for (const title of ["Mail", "Shop"]) {
      await entryRow(page, title).click();
      await page.getByTestId("detail-edit").click();
      await editor.getByTestId("editor-tab-icon").click();
      await editor.getByTestId("icon-upload-file").setInputFiles({
        name: "Firma Logo.png",
        mimeType: "image/png",
        buffer: png,
      });
      // The second upload of the same image chooses the known icon.
      const custom = editor.getByTestId("icon-custom");
      await expect(custom).toHaveCount(1);
      await expect(custom.first()).toBeChecked();
      await expect(
        editor.getByTestId("icon-custom-grid").locator("label"),
      ).toHaveAttribute("title", "Firma Logo");
      await editor.getByTestId("editor-save").click();
      await expect(editor).toHaveCount(0);
      await expect(
        entryRow(page, title).getByTestId("custom-icon"),
      ).toBeVisible();
    }
    await expect(
      page.getByTestId("entry-detail").getByTestId("custom-icon"),
    ).toBeVisible();

    // An SVG becomes a PNG; its scripts never run.
    await treeRow(page, "Kunden").click({ button: "right" });
    await page.getByTestId("menu-properties").click();
    const dialog = page.getByTestId("group-dialog");
    await dialog
      .getByTestId("icon-upload-file")
      .first()
      .setInputFiles({
        name: "kunden.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(SVG),
      });
    const picker = dialog.getByTestId("icon-picker").first();
    await expect(picker.getByTestId("icon-custom")).toHaveCount(2);
    await expect(picker.getByTestId("icon-custom").nth(1)).toBeChecked();
    await page.getByTestId("group-dialog-save").click();
    await expect(
      treeRow(page, "Kunden").getByTestId("custom-icon"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __iconScript?: string }).__iconScript,
      ),
    ).toBeUndefined();
    await expectPngIcons(page);

    // Another device sees the same library and references.
    await device.engine.pull(vaultId);
    const vault = device.engine.snapshot.vaults.find((v) => v.id === vaultId);
    expect(vault?.icons.size).toBe(2);
    for (const icon of vault?.icons.values() ?? [])
      expect(icon.src.startsWith(PNG_PREFIX)).toBe(true);
    const names = [...(vault?.icons.values() ?? [])].map((i) => i.name).sort();
    expect(names).toEqual(["Firma Logo", "kunden"]);
    const entries = [...(vault?.entries.values() ?? [])];
    expect(entries.every((e) => e.customIcon !== undefined)).toBe(true);
    const kunden = [...(vault?.tree.nodes.values() ?? [])].find(
      (n) => n.name === "Kunden",
    );
    expect(kunden?.customIcon).toBeDefined();
  });

  test("fetches a favicon with only the origin and shows errors", async ({
    page,
  }) => {
    const account = await createAccountWithVault("favicon");
    const { device, vaultId } = account;
    await nodeEntry(device, vaultId, rootOf(device, vaultId), {
      title: "Beispiel",
      url: "https://nutzer:{PASSWORD}@www.example.com/login?token=abc",
      password: "Fantasie-Passwort 7",
    });
    await nodeEntry(device, vaultId, rootOf(device, vaultId), {
      title: "Geheimer Host",
      url: "https://{PASSWORD}.example.org/",
      password: "hostteil",
    });
    const sent: string[] = [];
    let found = false;
    await page.route("**/v1/favicon", async (route) => {
      sent.push(
        (JSON.parse(route.request().postData() ?? "{}") as { url: string }).url,
      );
      if (found)
        await route.fulfill({
          json: {
            mime: "image/png",
            data: base64url(pngBytes(64, 64, BLUE)),
            width: 64,
            height: 64,
            origin: "https://www.example.com",
          },
        });
      else
        await route.fulfill({
          status: 422,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify({
            title: "Favicon not found",
            status: 422,
            code: "favicon_not_found",
            instance: "urn:uuid:0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
          }),
        });
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    // A secret placeholder in the host: nothing is pre-filled.
    await entryRow(page, "Geheimer Host").click();
    await page.getByTestId("detail-edit").click();
    const editor = page.getByTestId("entry-editor");
    await editor.getByTestId("editor-tab-icon").click();
    await expect(editor.getByTestId("icon-favicon-url")).toHaveValue("");
    await expect(editor.getByTestId("icon-favicon")).toBeDisabled();
    await editor.getByTestId("editor-cancel").click();

    await entryRow(page, "Beispiel").click();
    await page.getByTestId("detail-edit").click();
    await editor.getByTestId("editor-tab-icon").click();
    const url = editor.getByTestId("icon-favicon-url");
    await expect(url).toHaveValue("https://www.example.com/");
    await editor.getByTestId("icon-favicon").click();
    await expect(editor).toContainText(
      "Für diese Website wurde kein Icon gefunden.",
    );
    await expect(editor.getByTestId("icon-custom")).toHaveCount(0);

    found = true;
    await editor.getByTestId("icon-favicon").click();
    await expect(editor.getByTestId("icon-custom")).toHaveCount(1);
    await expect(editor.getByTestId("icon-custom")).toBeChecked();
    await expect(
      editor.getByTestId("icon-custom-grid").locator("label"),
    ).toHaveAttribute("title", "www.example.com");
    await editor.getByTestId("editor-save").click();
    await expect(
      entryRow(page, "Beispiel").getByTestId("custom-icon"),
    ).toBeVisible();
    await expectPngIcons(page);
    // Only scheme, host and port left the browser.
    expect(sent).toEqual([
      "https://www.example.com/",
      "https://www.example.com/",
    ]);

    await device.engine.pull(vaultId);
    const vault = device.engine.snapshot.vaults.find((v) => v.id === vaultId);
    const icon = [...(vault?.icons.values() ?? [])][0];
    expect(icon?.source).toEqual({
      type: "favicon",
      origin: "https://www.example.com",
    });
  });

  test("removes unused icons, but not those of earlier states", async ({
    page,
  }) => {
    const account = await createAccountWithVault("iconclean");
    const { device, vaultId } = account;
    const root = rootOf(device, vaultId);
    const add = (color: [number, number, number, number], name: string) =>
      device.engine.addIcon(vaultId, pngBytes(64, 64, color), name, {
        type: "upload",
      });
    const old = await add(RED, "alt");
    await add(BLUE, "unbenutzt");
    const current = await add(GREEN, "aktuell");
    const id = await nodeEntry(device, vaultId, root, {
      title: "Mit Verlauf",
      icon: { type: "custom", id: old },
    });
    const opened = device.engine.editEntry(vaultId, id);
    if (!opened) throw new Error("entry missing");
    await device.engine.saveEntry(opened.base, {
      ...opened.draft,
      title: "Mit Verlauf 2",
      icon: { type: "custom", id: current },
    });
    await loginViaUi(page, account);
    await openDatabasePage(page, vaultId);
    const section = page.getByTestId("icons-section");
    await expect(section.getByTestId("icons-count")).toHaveText(
      "3 eigene Icons. Davon unbenutzt: 1.",
    );
    await section.getByTestId("icons-remove-unused").click();
    await expect(page.getByTestId("confirm-text")).toContainText("1 Icons");
    await page.getByTestId("confirm-yes").click();
    await expect(section.getByTestId("icons-removed")).toHaveText(
      "1 Icons wurden entfernt.",
    );
    await expect(section.getByTestId("icons-count")).toHaveText(
      "2 eigene Icons. Davon unbenutzt: 0.",
    );
    await expect(section.getByTestId("icons-remove-unused")).toBeDisabled();

    await device.engine.pull(vaultId);
    const vault = device.engine.snapshot.vaults.find((v) => v.id === vaultId);
    expect([...(vault?.icons.keys() ?? [])].sort()).toEqual(
      [old, current].sort(),
    );
  });

  test("moves an entry with its icon to another database", async ({ page }) => {
    const account = await createAccountWithVault("iconmove");
    const { device, vaultId } = account;
    const icon = await device.engine.addIcon(
      vaultId,
      pngBytes(64, 64, RED),
      "Umzug",
      { type: "upload" },
    );
    await nodeEntry(device, vaultId, rootOf(device, vaultId), {
      title: "Umzug",
      icon: { type: "custom", id: icon },
    });
    const other = await device.engine.createVault({
      name: "Zweite",
      rootName: "Zweite",
      recycleBinName: "Papierkorb",
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await entryRow(page, "Umzug").dragTo(treeRow(page, "Zweite"));
    await page.getByTestId("confirm-yes").click();
    await expect(entryRow(page, "Umzug")).toHaveCount(0);
    await openVault(page, "Zweite");
    await expect(
      entryRow(page, "Umzug").getByTestId("custom-icon"),
    ).toBeVisible();

    await device.engine.refresh();
    await device.engine.pull(other);
    const target = device.engine.snapshot.vaults.find((v) => v.id === other);
    expect(target?.icons.get(icon)?.name).toBe("Umzug");
  });
});
