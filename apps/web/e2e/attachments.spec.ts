/**
 * Attachments: files of 0 B to 45 MiB come
 * back bit for bit, previews only for images and plain text, discarded
 * uploads are deleted, removed attachments stay in the history, and
 * attachments survive a move to another database. Test data only.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, emptyDraft } from "@keeman/core";
import type { Page } from "@playwright/test";
import {
  createAccountWithVault,
  entryRow,
  loginViaUi,
  openVault,
  rootOf,
  treeRow,
  type NodeDevice,
} from "./helpers";
import { expect, test } from "./fixtures";

const dir = mkdtempSync(join(tmpdir(), "keeman-attachments-"));
// /tmp may live in memory: the files of up to 45 MiB do not stay.
test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A PNG of one transparent pixel. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function nodeEntryWithFile(
  device: NodeDevice,
  vaultId: string,
  title: string,
  file: { name: string; mime: string; data: Uint8Array },
): Promise<string> {
  const id = device.engine.newEntryId();
  const info = await device.engine.stageAttachment(vaultId, id, file);
  await device.engine.createEntry(
    vaultId,
    rootOf(device, vaultId),
    { ...emptyDraft(), title, attachments: [info.id] },
    id,
  );
  return id;
}

async function downloaded(page: Page, index: number): Promise<Uint8Array> {
  const waiting = page.waitForEvent("download");
  await page.getByTestId("attachment-download").nth(index).click();
  const download = await waiting;
  const path = join(
    dir,
    `${String(Date.now())}-${download.suggestedFilename()}`,
  );
  await download.saveAs(path);
  return new Uint8Array(readFileSync(path));
}

test.describe("attachments", () => {
  test("files from 0 B to 45 MiB come back bit for bit", async ({ page }) => {
    test.setTimeout(240_000);
    const account = await createAccountWithVault("attachments");
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");
    const sizes = [0, 1, 65_536, 65_537, 45 * 1024 * 1024];
    const files = sizes.map((size) => {
      const path = join(dir, `file-${String(size)}.bin`);
      writeFileSync(path, randomBytes(size));
      return path;
    });

    await page.getByTestId("new-entry").click();
    await page.getByTestId("editor-title").fill("Dateien");
    await page.getByTestId("editor-tab-attachments").click();
    await page.getByTestId("attachments-file").setInputFiles(files);
    await expect(page.getByTestId("editor-attachment")).toHaveCount(5, {
      timeout: 180_000,
    });
    await expect(page.getByTestId("attachment-upload")).toHaveCount(0);
    await page.getByTestId("editor-save").click();

    const detail = page.getByTestId("entry-detail");
    await expect(detail.getByTestId("attachment-name")).toHaveText(
      sizes.map((size) => `file-${String(size)}.bin`),
    );
    for (const [index, path] of files.entries()) {
      const bytes = await downloaded(page, index);
      expect(bytes.length, path).toBe(sizes[index]);
      expect(sha256(bytes), path).toBe(sha256(readFileSync(path)));
    }
  });

  test("previews images and plain text only", async ({ page }) => {
    const account = await createAccountWithVault("attachments");
    const { device, vaultId } = account;
    await nodeEntryWithFile(device, vaultId, "Bild", {
      name: "punkt.png",
      mime: "image/png",
      data: PNG,
    });
    await nodeEntryWithFile(device, vaultId, "Text", {
      name: "notiz.txt",
      mime: "text/plain",
      data: new TextEncoder().encode("Fantasie-Notiz <b>kein HTML</b>"),
    });
    await nodeEntryWithFile(device, vaultId, "Seite", {
      name: "seite.html",
      mime: "text/html",
      data: new TextEncoder().encode("<script>alert(1)</script>"),
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    await entryRow(page, "Bild").click();
    await page.getByTestId("attachment-preview").click();
    const image = page.getByTestId("attachment-preview-image");
    await expect(image).toBeVisible();
    expect(await image.getAttribute("src")).toMatch(/^blob:/);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);

    await entryRow(page, "Text").click();
    await page.getByTestId("attachment-preview").click();
    await expect(page.getByTestId("attachment-preview-text")).toHaveText(
      "Fantasie-Notiz <b>kein HTML</b>",
    );

    // HTML is never shown, only downloaded.
    await entryRow(page, "Seite").click();
    await expect(page.getByTestId("attachment")).toHaveCount(1);
    await expect(page.getByTestId("attachment-preview")).toHaveCount(0);
    const bytes = await downloaded(page, 0);
    expect(new TextDecoder().decode(bytes)).toBe("<script>alert(1)</script>");
  });

  test("deletes discarded uploads and keeps removed ones in the history", async ({
    page,
  }) => {
    const account = await createAccountWithVault("attachments");
    const { device, vaultId } = account;
    await nodeEntryWithFile(device, vaultId, "Vertrag", {
      name: "vertrag.txt",
      mime: "text/plain",
      data: new TextEncoder().encode("Fantasie-Vertrag"),
    });
    await loginViaUi(page, account);
    await openVault(page, "Persönlich");

    // An upload of a new entry that is never saved is deleted again.
    await page.getByTestId("new-entry").click();
    await page.getByTestId("editor-tab-attachments").click();
    const created = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith("/attachments"),
    );
    await page.getByTestId("attachments-file").setInputFiles({
      name: "entwurf.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Entwurf"),
    });
    const { attachment_id: staged } = (await created).postDataJSON() as {
      attachment_id: string;
    };
    await expect(page.getByTestId("editor-attachment")).toHaveCount(1);
    const deleted = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" && request.url().endsWith(`/${staged}`),
    );
    // Leaving asks first, because the draft changed.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("editor-cancel").click();
    await deleted;
    const error: unknown = await device.api
      .completeAttachment(vaultId, staged)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);

    // Removed from the entry, the attachment stays in its history.
    await entryRow(page, "Vertrag").click();
    await page.getByTestId("detail-edit").click();
    await page.getByTestId("editor-tab-attachments").click();
    await page.getByTestId("editor-attachment-remove").click();
    await page.getByTestId("editor-save").click();
    const detail = page.getByTestId("entry-detail");
    await expect(detail.getByTestId("detail-username")).toBeVisible();
    await expect(detail.getByTestId("attachments")).toHaveCount(0);
    await page.getByTestId("tab-history").click();
    await expect(detail.getByTestId("attachment-name")).toHaveText([
      "vertrag.txt",
    ]);
    const bytes = await downloaded(page, 0);
    expect(new TextDecoder().decode(bytes)).toBe("Fantasie-Vertrag");
  });

  test("attachments survive a move to another database", async ({ page }) => {
    const account = await createAccountWithVault("attachments");
    const { device, vaultId } = account;
    const data = randomBytes(100_000);
    await nodeEntryWithFile(device, vaultId, "Umzug", {
      name: "umzug.bin",
      mime: "application/octet-stream",
      data,
    });
    await device.engine.createVault({
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
    await entryRow(page, "Umzug").click();
    const bytes = await downloaded(page, 0);
    expect(sha256(bytes)).toBe(sha256(data));
  });
});
