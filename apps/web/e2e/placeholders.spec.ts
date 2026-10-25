/**
 * Placeholders: the resolved URL with
 * encoding and masking, opening with `noopener` (recorded, nothing is
 * requested), copying, references in detail and list, cycles, schemes and
 * the editor's preview.
 */
import type { Page } from "@playwright/test";
import {
  clipboardWrites,
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeEntry,
  openAccount,
  openMain,
  openVault,
  rootOf,
  spyClipboard,
  treeRow,
} from "./helpers";
import { expect, test } from "./fixtures";

const MASK = "••••••";

/** Records window.open instead of opening anything. */
async function spyOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: string[][] = [];
    (window as unknown as { __opened: string[][] }).__opened = calls;
    window.open = (...args: unknown[]) => {
      calls.push(args.map(String));
      return null;
    };
  });
}

async function opened(page: Page): Promise<string[][]> {
  return page.evaluate(
    () => (window as unknown as { __opened: string[][] }).__opened,
  );
}

function ref(field: string, id: string): string {
  return `{REF:${field}@I:${id.replaceAll("-", "").toUpperCase()}}`;
}

test.describe("placeholders", () => {
  test("resolves, masks, opens and copies the URL", async ({
    page,
    context,
    browserName,
  }) => {
    if (browserName === "chromium")
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const account = await createAccountWithVault("placeholders");
    await nodeEntry(
      account.device,
      account.vaultId,
      rootOf(account.device, account.vaultId),
      {
        title: "Grüße #1",
        username: "alex@example.com/x",
        password: "p&ss#w?rd/%",
        url: "https://{S:Host}:8443/a b/{USERNAME}?pw={PASSWORD}&x={S:Q}#{TITLE}",
        fields: [
          { name: "Host", value: "203.0.113.10", protected: false },
          { name: "Q", value: "a b&c", protected: false },
        ],
      },
    );
    const url =
      "https://203.0.113.10:8443/a b/alex@example.com/x?pw=p%26ss%23w%3Frd%2F%25&x=a%20b%26c#Gr%C3%BC%C3%9Fe%20%231";
    await spyClipboard(page);
    await spyOpen(page);
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await entryRow(page, "Grüße #1").click();
    await expect(page.getByTestId("detail-url-value")).toHaveText(
      url.replace("p%26ss%23w%3Frd%2F%25", MASK),
    );
    await expect(page.getByTestId("detail-url-secret")).toBeVisible();
    await expect(page.getByText("p%26ss")).toHaveCount(0);

    await page.getByTestId("detail-url-open").click();
    expect(await opened(page)).toEqual([
      [url, "_blank", "noopener,noreferrer"],
    ]);
    await page.getByTestId("detail-url-copy").click();
    expect(await clipboardWrites(page)).toContain(url);

    await entryRow(page, "Grüße #1").click();
    await page.keyboard.press("u");
    await expect.poll(async () => (await opened(page)).length).toBe(2);
    expect((await opened(page))[1]?.[0]).toBe(url);
    const before = (await clipboardWrites(page)).length;
    await page.keyboard.press("Shift+U");
    await expect
      .poll(async () => (await clipboardWrites(page)).length)
      .toBeGreaterThan(before);
    expect((await clipboardWrites(page)).at(-1)).toBe(url);
  });

  test("shows references in detail and list, never a password in the list", async ({
    page,
  }) => {
    const account = await createAccountWithVault("placeholders");
    const root = rootOf(account.device, account.vaultId);
    const server = await nodeEntry(account.device, account.vaultId, root, {
      title: "Server",
      username: "root",
      password: "pw-geheim-1",
      url: "https://server.example/{USERNAME}",
    });
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Zugang",
      username: ref("U", server),
      password: ref("P", server),
      url: ref("A", server),
      notes: `Siehe ${ref("T", server)}`,
    });
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Leak",
      username: ref("P", server),
    });
    await spyClipboard(page);
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    const row = entryRow(page, "Zugang");
    await expect(row.getByTestId("entry-username")).toHaveText("root");
    await expect(row.getByTestId("entry-url")).toHaveText(
      "https://server.example/root",
    );
    await expect(
      entryRow(page, "Leak").getByTestId("entry-username"),
    ).toHaveText(ref("P", server));
    await expect(page.getByTestId("entry-list")).not.toContainText(
      "pw-geheim-1",
    );

    await row.click();
    await expect(page.getByTestId("detail-username-value")).toHaveText("root");
    await expect(page.getByTestId("detail-username-ref")).toBeVisible();
    await expect(page.getByTestId("detail-password-ref")).toBeVisible();
    await expect(page.getByTestId("detail-notes")).toHaveText("Siehe Server");
    await expect(page.getByTestId("detail-url-value")).toHaveText(
      "https://server.example/root",
    );
    await page.getByTestId("detail-password-copy").click();
    expect(await clipboardWrites(page)).toContain("pw-geheim-1");

    // A username taken from a password stays masked in the detail.
    await entryRow(page, "Leak").click();
    await expect(page.getByTestId("detail-username-value")).toHaveText(
      "••••••••••••",
    );
  });

  test("refuses cycles and schemes that are not allowed", async ({ page }) => {
    const account = await createAccountWithVault("placeholders");
    const root = rootOf(account.device, account.vaultId);
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Loop",
      url: "https://example.com/{URL}",
    });
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Script",
      url: "{S:Link}",
      fields: [
        { name: "Link", value: "javascript:alert(1)", protected: false },
      ],
    });
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Shell",
      username: "root",
      url: "ssh://{USERNAME}@203.0.113.10",
    });
    await spyOpen(page);
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await entryRow(page, "Loop").click();
    await expect(page.getByTestId("detail-url-problem")).toContainText(
      "Zirkelbezug",
    );
    await expect(page.getByTestId("detail-url-open")).toBeDisabled();

    await entryRow(page, "Script").click();
    await expect(page.getByTestId("detail-url-value")).toHaveText(
      "javascript:alert(1)",
    );
    await expect(page.getByTestId("detail-url-problem")).toContainText(
      "nie geöffnet",
    );
    await expect(page.getByTestId("detail-url-open")).toBeDisabled();
    await expect(page.getByTestId("detail-url-copy")).toBeEnabled();
    await entryRow(page, "Script").click();
    await page.keyboard.press("u");
    await expect(page.getByText("nie geöffnet").last()).toBeVisible();

    await entryRow(page, "Shell").click();
    await expect(page.getByTestId("detail-url-problem")).toContainText(
      "Einstellungen",
    );
    expect(await opened(page)).toEqual([]);

    await openAccount(page, "settings");
    const schemes = page.getByTestId("settings-url-schemes");
    await expect(schemes).toHaveValue("http, https");
    await schemes.fill("http, https, javascript");
    await expect(page.getByTestId("settings-url-schemes-hint")).toHaveClass(
      /text-error/,
    );
    await expect(page.getByTestId("settings-save")).toBeDisabled();
    await schemes.fill("http, HTTPS, ssh");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();
    await expect(schemes).toHaveValue("http, https, ssh");

    await openMain(page);
    await openVault(page, "Persönlich");
    await entryRow(page, "Shell").click();
    await expect(page.getByTestId("detail-url-problem")).toHaveCount(0);
    await page.getByTestId("detail-url-open").click();
    expect(await opened(page)).toEqual([
      ["ssh://root@203.0.113.10", "_blank", "noopener,noreferrer"],
    ]);
  });

  test("warns before references break in another vault", async ({ page }) => {
    const account = await createAccountWithVault("placeholders");
    const root = rootOf(account.device, account.vaultId);
    const target = await nodeEntry(account.device, account.vaultId, root, {
      title: "Ziel",
      username: "z",
    });
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Quelle",
      username: ref("U", target),
    });
    await account.device.engine.createVault({
      name: "Zweite",
      rootName: "Zweite",
      recycleBinName: "Papierkorb",
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await entryRow(page, "Ziel").dragTo(treeRow(page, "Zweite"));
    await expect(page.getByTestId("confirm-text")).toContainText(
      "betroffene Einträge: 1",
    );
    await page.getByTestId("confirm-no").click();
    await entryRow(page, "Quelle").dragTo(treeRow(page, "Zweite"));
    await expect(page.getByTestId("confirm-text")).toContainText(
      "betroffene Einträge: 1",
    );
    await page.getByTestId("confirm-no").click();
    await expect(entryRow(page, "Ziel")).toBeVisible();
  });

  test("previews the URL in the editor while typing", async ({ page }) => {
    const account = await createAccountWithVault("placeholders");
    await nodeEntry(
      account.device,
      account.vaultId,
      rootOf(account.device, account.vaultId),
      { title: "Other", username: "olga" },
    );
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await page.getByTestId("new-entry").click();
    await page.getByTestId("editor-title").fill("Neu");
    await page.getByTestId("editor-username").fill("a b");
    await expect(page.getByTestId("editor-url-preview")).toHaveCount(0);
    const urlField = page.getByTestId("editor-url");
    const preview = page.getByTestId("editor-url-preview-value");
    await urlField.fill("example.com/{USERNAME}");
    await expect(preview).toHaveText("https://example.com/a%20b");
    await expect(page.getByTestId("editor-url-preview-secret")).toHaveCount(0);

    await page.getByTestId("editor-password").fill("s3cret");
    await urlField.fill("example.com/{USERNAME}?p={PASSWORD}");
    await expect(preview).toHaveText(`https://example.com/a%20b?p=${MASK}`);
    await expect(page.getByTestId("editor-url-preview-secret")).toBeVisible();

    await urlField.fill("{S:Proto}://example.com");
    await expect(page.getByTestId("editor-url-preview-problem")).toContainText(
      "Platzhalter",
    );
    await urlField.fill("");
    await expect(page.getByTestId("editor-url-preview")).toHaveCount(0);
  });
});
