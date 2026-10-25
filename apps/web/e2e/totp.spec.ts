/**
 * TOTP: codes in detail and list, copying by
 * click and T, capture by URI, by hand and from a QR screenshot or a paste,
 * refusals, the server time and the column setting.
 */
import {
  buildTotpUri,
  decodeTotpSecret,
  totpFromUri,
  type KdbxFile,
} from "@keeman/core";
import type { BrowserContext, Page } from "@playwright/test";
import qrcode from "qrcode-generator";
import {
  clipboardWrites,
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeDevice,
  nodeEntry,
  openAccount,
  openMain,
  openVault,
  rootOf,
  spyClipboard,
  type NodeDevice,
  type TestAccount,
} from "./helpers";
import { expect, test } from "./fixtures";

const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/Mail:me?secret=${SECRET}&issuer=Mail`;

/** Codes around now, so a step change during the check is tolerated. */
async function codesAround(uri: string, offsetMs = 0): Promise<string[]> {
  const now = Date.now() + offsetMs;
  const results = await Promise.all(
    [now - 4000, now, now + 4000].map((time) => totpFromUri(uri, time)),
  );
  return results.map((result) => (result.ok ? result.value.code : ""));
}

/** A real screenshot of a page that shows a QR code among other things. */
async function qrScreenshot(
  context: BrowserContext,
  text: string,
): Promise<Buffer> {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><body style="margin:40px;font-family:sans-serif;background:#eef2f7">
      <h1>Account security</h1><p>Scan this code with your authenticator app.</p>
      <img alt="" src="${qr.createDataURL(5, 16)}"><p>Can't scan it? Enter the key by hand.</p>
    </body>`,
  );
  const shot = await page.screenshot({ fullPage: true });
  await page.close();
  return shot;
}

function rawOtp(device: NodeDevice, vaultId: string, title: string) {
  const vault = device.engine.snapshot.vaults.find((v) => v.id === vaultId);
  const entry = [...(vault?.entries.values() ?? [])].find(
    (e) => e.title === title,
  );
  return device.engine.entry(vaultId, entry?.id ?? "")?.values.otp;
}

async function openEditorTab(page: Page): Promise<void> {
  await page.getByTestId("editor-tab-totp").click();
  await expect(page.getByTestId("totp-tab")).toBeVisible();
}

async function freshDevice(account: TestAccount): Promise<NodeDevice> {
  const device = await nodeDevice(account);
  await device.engine.refresh();
  return device;
}

test.describe("TOTP", () => {
  test("shows the code in the detail and the list and copies it", async ({
    page,
    context,
    browserName,
  }) => {
    if (browserName === "chromium")
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const account = await createAccountWithVault("totp");
    const root = rootOf(account.device, account.vaultId);
    await nodeEntry(account.device, account.vaultId, root, {
      title: "Mail",
      username: "me",
      otp: URI,
    });
    await nodeEntry(account.device, account.vaultId, root, { title: "Plain" });
    await spyClipboard(page);
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await expect(page.getByTestId("totp-column")).toBeVisible();
    const cell = entryRow(page, "Mail").getByTestId("totp-cell");
    expect(await codesAround(URI)).toContain(
      await cell.getAttribute("data-code"),
    );
    await expect(entryRow(page, "Plain").getByTestId("totp-cell")).toHaveCount(
      0,
    );

    await entryRow(page, "Mail").click();
    const code = page.getByTestId("totp-code");
    await expect(code).toHaveText(/^\s*\d{3}\s*\d{3}\s*$/);
    const shown = (await code.getAttribute("data-code")) ?? "";
    expect(await codesAround(URI)).toContain(shown);
    await expect(page.getByTestId("totp-ring")).toBeVisible();
    await code.click();
    expect(await clipboardWrites(page)).toContain(shown);

    await entryRow(page, "Mail").click();
    await page.keyboard.press("t");
    await expect
      .poll(async () => (await clipboardWrites(page)).length)
      .toBeGreaterThan(1);
    expect(await codesAround(URI)).toContain(
      (await clipboardWrites(page)).at(-1),
    );
  });

  test("captures TOTP by URI, by hand, from a QR screenshot and a paste", async ({
    page,
    context,
    browserName,
  }) => {
    const account = await createAccountWithVault("totp");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    // By URI, in a new entry.
    await page.getByTestId("new-entry").click();
    await page.getByTestId("editor-title").fill("Mail");
    await page.getByTestId("editor-username").fill("me");
    await openEditorTab(page);
    await expect(page.getByTestId("totp-none")).toBeVisible();
    await page
      .getByTestId("totp-uri")
      .fill(URI.replace(SECRET, "jbsw y3dp ehpk 3pxp"));
    await page.getByTestId("totp-uri-apply").click();
    const preview = page.getByTestId("totp-preview");
    expect(await codesAround(URI)).toContain(
      await preview.getAttribute("data-code"),
    );
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("totp-code")).toBeVisible();
    let device = await freshDevice(account);
    expect(rawOtp(device, account.vaultId, "Mail")).toBe(URI);

    // By hand: SHA256, 8 digits, 60 s.
    await page.getByTestId("detail-edit").click();
    await openEditorTab(page);
    await page.getByTestId("totp-secret").fill("GEZDGNBVGY3TQOJQ");
    await page.getByTestId("totp-advanced").click();
    await page.getByTestId("totp-algorithm").selectOption("SHA256");
    await page.getByTestId("totp-digits").fill("8");
    await page.getByTestId("totp-period").fill("60");
    await page.getByTestId("totp-manual-apply").click();
    await expect(page.getByTestId("totp-current")).toContainText(
      "SHA256, 8 Stellen, 60 s",
    );
    await page.getByTestId("editor-save").click();
    const manual = buildTotpUri({
      key: decodeTotpSecret("GEZDGNBVGY3TQOJQ") ?? new Uint8Array(),
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      title: "Mail",
      username: "me",
    });
    await expect(page.getByTestId("totp-code")).toHaveText(
      /^\s*\d{4}\s*\d{4}\s*$/,
    );
    device = await freshDevice(account);
    expect(rawOtp(device, account.vaultId, "Mail")).toBe(manual);

    // From a real screenshot with a QR code.
    const fromQr = "otpauth://totp/Shop:me?secret=MFRGGZDFMZTWQ2LK&issuer=Shop";
    await page.getByTestId("detail-edit").click();
    await openEditorTab(page);
    await page.getByTestId("totp-qr-file").setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: await qrScreenshot(context, fromQr),
    });
    await expect(page.getByTestId("totp-current")).toContainText(
      "SHA1, 6 Stellen, 30 s",
    );
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("totp-code")).toBeVisible();
    device = await freshDevice(account);
    expect(rawOtp(device, account.vaultId, "Mail")).toBe(fromQr);

    // Pasted with Ctrl+V.
    const pasted =
      "otpauth://totp/Bank:me?secret=ONSWG4TFOQ&issuer=Bank&digits=7";
    const image = [...(await qrScreenshot(context, pasted))];
    await page.getByTestId("detail-edit").click();
    await openEditorTab(page);
    await page.getByTestId("totp-drop").focus();
    // A synthetic paste carries no files in Firefox (a real one does), so
    // Firefox drops the image instead; both paths share the reading.
    await page.evaluate(
      ({ bytes, paste }) => {
        const data = new DataTransfer();
        data.items.add(
          new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }),
        );
        const event = paste
          ? new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
            });
        document.querySelector("[data-test=totp-drop]")?.dispatchEvent(event);
      },
      { bytes: image, paste: browserName !== "firefox" },
    );
    await expect(page.getByTestId("totp-current")).toContainText(
      "SHA1, 7 Stellen, 30 s",
    );
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("totp-code")).toHaveText(
      /^\s*\d{3}\s*\d{4}\s*$/,
    );
    device = await freshDevice(account);
    expect(rawOtp(device, account.vaultId, "Mail")).toBe(pasted);

    // Removing it.
    await page.getByTestId("detail-edit").click();
    await openEditorTab(page);
    await page.getByTestId("totp-remove").click();
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("totp")).toHaveCount(0);
  });

  test("refuses migration exports and HOTP and keeps a stored HOTP value", async ({
    page,
    context,
  }) => {
    const account = await createAccountWithVault("totp");
    const hotp = "otpauth://hotp/Old:me?secret=MFRGG&counter=3";
    const file: KdbxFile = {
      header: {
        version: "4.1",
        cipher: "aes",
        kdf: "argon2id",
        memoryBytes: 1,
      },
      meta: {
        name: "x",
        description: "",
        color: null,
        publicColor: null,
        recycleBinEnabled: true,
        recycleBinUuid: null,
        historyMaxItems: 10,
      },
      root: {
        uuid: "0193000f000040008000000000000001",
        name: "Import",
        notes: "",
        icon: 48,
        customIcon: null,
        times: { created: null, modified: null, expires: null },
        previousParent: null,
        groups: [],
        entries: [
          {
            uuid: "0193000f000040008000000000000002",
            icon: 0,
            customIcon: null,
            strings: [
              { key: "Title", value: "Counter", protected: false },
              { key: "otp", value: hotp, protected: true },
            ],
            tags: [],
            times: { created: null, modified: null, expires: null },
            attachments: [],
            previousParent: null,
            history: [],
          },
        ],
      },
      extraRoots: 0,
      ignored: {
        autoType: 0,
        customData: 0,
        colors: 0,
        overrideUrl: 0,
        qualityCheck: 0,
        groupSettings: 0,
        deletedObjects: 0,
        publicCustomData: 0,
      },
      binaries: [],
      customIcons: [],
    };
    const job = await account.device.engine.prepareKdbxImport(
      file,
      {
        kind: "group",
        vaultId: account.vaultId,
        groupId: rootOf(account.device, account.vaultId),
      },
      { emptyFieldName: "Feld" },
    );
    await job.run();
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await page
      .locator("[data-test=tree-row]")
      .filter({ hasText: "Import" })
      .click();
    await entryRow(page, "Counter").click();
    await expect(page.getByTestId("totp-problem")).toContainText("HOTP");

    await page.getByTestId("detail-edit").click();
    await page.getByTestId("editor-username").fill("changed");
    await openEditorTab(page);
    await expect(page.getByTestId("totp-kept")).toContainText("HOTP");
    await page.getByTestId("totp-qr-file").setInputFiles({
      name: "migration.png",
      mimeType: "image/png",
      buffer: await qrScreenshot(
        context,
        "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SBG1haWwaBG1haWwgASgBMAJCEzc3YmVkMjE2NjgxNjQ4MjA0NzEQAhgBIAA%3D",
      ),
    });
    await expect(page.getByTestId("totp-error")).toContainText(
      "Google Authenticator",
    );
    await page
      .getByTestId("totp-uri")
      .fill("otpauth://hotp/New:me?secret=MFRGG&counter=1");
    await page.getByTestId("totp-uri-apply").click();
    await expect(page.getByTestId("totp-error")).toContainText("HOTP");
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("detail-username-value")).toHaveText(
      "changed",
    );
    const device = await freshDevice(account);
    expect(rawOtp(device, account.vaultId, "Counter")).toBe(hotp);
  });

  test("follows the server time and points out a clock difference", async ({
    page,
  }) => {
    const account = await createAccountWithVault("totp");
    await nodeEntry(
      account.device,
      account.vaultId,
      rootOf(account.device, account.vaultId),
      {
        title: "Mail",
        otp: URI,
      },
    );
    await page.route("**/v1/time", async (route) => {
      await route.fulfill({
        json: { now_ms: Date.now() + 90_000 },
        headers: { "cache-control": "no-store" },
      });
    });
    await loginViaUi(page, account);
    await expect(page.getByTestId("banner-clock")).toBeVisible();
    await openVault(page, "Persönlich");
    await entryRow(page, "Mail").click();
    const shown = await page.getByTestId("totp-code").getAttribute("data-code");
    expect(await codesAround(URI, 90_000)).toContain(shown);
  });

  test("the setting hides the TOTP column", async ({ page }) => {
    const account = await createAccountWithVault("totp");
    await nodeEntry(
      account.device,
      account.vaultId,
      rootOf(account.device, account.vaultId),
      {
        title: "Mail",
        otp: URI,
      },
    );
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    await expect(page.getByTestId("totp-column")).toBeVisible();
    await openAccount(page, "settings");
    await page.getByTestId("settings-show-totp").uncheck();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Gespeichert.")).toBeVisible();
    await openMain(page);
    await openVault(page, "Persönlich");
    await expect(entryRow(page, "Mail")).toBeVisible();
    await expect(page.getByTestId("totp-column")).toHaveCount(0);
  });
});
