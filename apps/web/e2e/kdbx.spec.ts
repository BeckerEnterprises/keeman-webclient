/**
 * KDBX import and export: the fixtures of KeePass 2 and
 * KeePassXC as new databases, the export read by keepassxc-cli and imported
 * again, importing twice into a group, refusals and cancelling.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKdbxInWorker, type KdbxFile } from "@keeman/core";
import type { WorkerLike } from "@keeman/core/argon2-worker";
import { handleKdbxMessage } from "@keeman/core/kdbx-worker";
import type { Locator, Page } from "@playwright/test";
import {
  createAccount,
  createAccountWithVault,
  entryRow,
  loginViaUi,
  nodeDevice,
  openDatabases,
  strongPassword,
  treeRow,
  type NodeDevice,
} from "./helpers";
import { expect, test } from "./fixtures";

const FIXTURES = new URL(
  "../../../packages/core/test/fixtures/kdbx/",
  import.meta.url,
);
const fixture = (name: string): string =>
  new URL(`${name}.kdbx`, FIXTURES).pathname;
const keepassxc =
  spawnSync("keepassxc-cli", ["--version"], { encoding: "utf8" }).status === 0;
const TWOFISH = [
  0xad, 0x68, 0xf2, 0x9f, 0x57, 0x6f, 0x4b, 0xb9, 0xa3, 0x6a, 0xd4, 0x7a, 0xf9,
  0x65, 0x34, 0x6c,
];

/** The KDBX worker in this thread, answering like the browser worker. */
function inThreadKdbx(): WorkerLike {
  let listener: ((event: { data?: unknown }) => void) | undefined;
  return {
    postMessage(message) {
      void handleKdbxMessage(message, (response) => {
        listener?.({ data: response });
      });
    },
    addEventListener(type, l) {
      if (type === "message") listener = l;
    },
    terminate() {
      listener = undefined;
    },
  };
}

function dialog(page: Page): Locator {
  return page.getByTestId("kdbx-import");
}

async function openImport(page: Page, group = false): Promise<void> {
  await page
    .getByTestId(group ? "kdbx-import-group-open" : "kdbx-import-open")
    .click();
  await expect(dialog(page)).toHaveAttribute("data-step", "choose");
}

/** Chooses the file, types the password and waits for the preview. */
async function openFile(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
  password = "test",
): Promise<void> {
  await page.getByTestId("kdbx-file").setInputFiles(file);
  await page.getByLabel("Passwort der Datei").fill(password);
  await page.getByTestId("kdbx-open").click();
}

async function importFile(page: Page, file: string): Promise<void> {
  await openFile(page, file);
  await expect(dialog(page)).toHaveAttribute("data-step", "preview", {
    timeout: 60_000,
  });
  await page.getByTestId("kdbx-start").click();
  await expect(dialog(page)).toHaveAttribute("data-step", "done", {
    timeout: 60_000,
  });
}

async function openDatabasePage(page: Page, name: string): Promise<void> {
  await openDatabases(page);
  await page
    .getByTestId("vault")
    .filter({ hasText: name })
    .getByTestId("vault-settings")
    .click();
  await expect(page.getByTestId("database-view")).toBeVisible();
}

function vaultNamed(device: NodeDevice, name: string) {
  const vault = device.engine.snapshot.vaults.find((v) => v.name === name);
  if (!vault) throw new Error(`no vault ${name}`);
  return vault;
}

type Group = KdbxFile["root"];

function entriesOf(group: Group): Group["entries"] {
  return [...group.entries, ...group.groups.flatMap(entriesOf)];
}

test.describe("KDBX", () => {
  test("imports the KeePassXC file as a new database", async ({ page }) => {
    const account = await createAccount("kdbx");
    await loginViaUi(page, account);
    await openDatabases(page);
    await openImport(page);
    await openFile(page, fixture("keepassxc-example"));
    await expect(dialog(page)).toHaveAttribute("data-step", "preview", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("kdbx-version")).toHaveText("KDBX 4.1");
    await expect(page.getByTestId("kdbx-name")).toHaveValue(
      "keeman test kdbx 4",
    );
    await expect(page.getByTestId("kdbx-report-counts")).toHaveText(
      "Es werden 1 Gruppen und 1 Einträge importiert.",
    );
    // The browser re-encoded the file's custom icon.
    await expect(page.getByTestId("kdbx-report-icons")).toHaveText(
      "Dazu werden 1 eigene Icons übernommen.",
    );
    await page.getByTestId("kdbx-start").click();
    await expect(dialog(page)).toHaveAttribute("data-step", "done", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("kdbx-report-attachments")).toHaveText(
      "2 Anhänge wurden hochgeladen.",
    );
    await expect(page.getByTestId("kdbx-report-icons")).toHaveText(
      "1 eigene Icons wurden übernommen.",
    );
    await expect(page.getByTestId("kdbx-report")).not.toContainText(
      "ließ sich nicht lesen",
    );

    await page.getByTestId("kdbx-open-result").click();
    await expect(page.getByTestId("main-view")).toBeVisible();
    await treeRow(page, "test").click();
    await entryRow(page, "test").click();
    await expect(
      entryRow(page, "test").getByTestId("custom-icon"),
    ).toHaveAttribute("src", /^data:image\/png;base64,/);
    const detail = page.getByTestId("entry-detail");
    await expect(detail.getByTestId("detail-username-value")).toHaveText(
      "username",
    );
    await expect(detail.getByTestId("detail-password-value")).toHaveText(
      "••••••••••••",
    );
    const fields = detail.getByTestId("detail-field");
    await expect(fields).toHaveCount(2);
    // The two binaries of the file are attachments now.
    await expect(detail.getByTestId("attachment-name")).toHaveText([
      "attachment.txt",
      "square-64.png",
    ]);
    await expect(fields.nth(0)).toContainText("field1 value");
    await expect(fields.nth(1)).toContainText("••••••••••••");
    await expect(detail.getByTestId("detail-tags")).toHaveText(/tag1\s*tag2/);
    await detail.getByTestId("tab-history").click();
    await expect(detail.getByTestId("history-item")).toHaveCount(2);

    // The raw content as another device sees it.
    const device = await nodeDevice(account);
    const vault = vaultNamed(device, "keeman test kdbx 4");
    const entry = [...vault.entries.values()].find((e) => e.title === "test");
    const values = device.engine.entry(vault.id, entry?.id ?? "")?.values;
    expect(values?.fields.map((f) => [f.name, f.protected])).toEqual([
      ["field1-insecure", false],
      ["field2-secure", true],
    ]);
    expect(vault.color).toBe("#2ec27e");
    expect([...vault.icons.values()].map((icon) => icon.source)).toEqual([
      { type: "kdbx" },
    ]);
    expect(entry?.customIcon).toBe([...vault.icons.keys()][0]);
  });

  test("imports the KeePass 2 file as a new database", async ({ page }) => {
    const account = await createAccount("kdbx");
    await loginViaUi(page, account);
    await openDatabases(page);
    await openImport(page);
    await importFile(page, fixture("keepass-example"));
    await page.getByTestId("kdbx-open-result").click();
    await expect(page.getByTestId("main-view")).toBeVisible();
    for (const name of ["General", "Windows", "Network", "Internet", "eMail"])
      await expect(treeRow(page, name)).toBeVisible();
    await expect(entryRow(page, "Sample Entry #2")).toBeVisible();
  });

  test("exports a database that keepassxc-cli reads and imports it again", async ({
    page,
  }) => {
    const account = await createAccount("kdbx");
    await loginViaUi(page, account);
    await openDatabases(page);
    await openImport(page);
    await importFile(page, fixture("keeman-sample"));
    // The sample's broken icon is reported; the red one comes along.
    await expect(page.getByTestId("kdbx-report-icons")).toHaveText(
      "1 eigene Icons wurden übernommen.",
    );
    await expect(page.getByTestId("kdbx-report-items")).toContainText(
      "Mail › Odd fields: eigenes Icon ließ sich nicht lesen",
    );
    await page.getByTestId("kdbx-close").click();

    await openDatabasePage(page, "KeeMan Sample");
    await page.getByTestId("kdbx-export-open").click();
    const exportPassword = strongPassword();
    await page
      .getByLabel("Export-Passwort", { exact: true })
      .fill(exportPassword);
    await page.getByLabel("Export-Passwort wiederholen").fill(exportPassword);
    const downloading = page.waitForEvent("download");
    await page.getByTestId("kdbx-export-submit").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(
      /^KeeMan Sample-\d{4}-\d{2}-\d{2}\.kdbx$/,
    );
    await expect(page.getByTestId("kdbx-export-done")).toBeVisible();
    const dir = mkdtempSync(join(tmpdir(), "keeman-e2e-"));
    try {
      const path = join(dir, download.suggestedFilename());
      await download.saveAs(path);
      const bytes = new Uint8Array(readFileSync(path));
      const file: KdbxFile = await readKdbxInWorker(inThreadKdbx, {
        data: bytes,
        password: exportPassword,
        keyFile: null,
      });
      expect(file.header).toMatchObject({
        version: "4.0",
        cipher: "aes",
        kdf: "argon2id",
      });
      expect(entriesOf(file.root)).toHaveLength(15);
      // The red square went out as a custom icon.
      expect(file.customIcons).toHaveLength(1);
      if (keepassxc) {
        const info = spawnSync("keepassxc-cli", ["db-info", "-q", path], {
          input: `${exportPassword}\n`,
          encoding: "utf8",
          env: { ...process.env, LANGUAGE: "en", LC_ALL: "C.UTF-8" },
        });
        expect(info.stdout).toContain("Cipher: AES 256-bit");
        expect(info.stdout).toContain("KDF: Argon2id (3 rounds, 65536 KB)");
      }

      // The export imported into a group of the same database.
      await page.getByTestId("kdbx-close").click();
      await openImport(page, true);
      await openFile(page, path, exportPassword);
      await expect(dialog(page)).toHaveAttribute("data-step", "preview", {
        timeout: 60_000,
      });
      await page.getByTestId("kdbx-start").click();
      await expect(dialog(page)).toHaveAttribute("data-step", "done", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("kdbx-report-conflicts")).toBeVisible();
      await expect(page.getByTestId("kdbx-report-bin")).toBeVisible();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const device = await nodeDevice(account);
    const vault = vaultNamed(device, "KeeMan Sample");
    // 15 entries, plus 13 outside the bin of the second import.
    expect(vault.entries.size).toBe(28);
  });

  test("imports into a group twice with new IDs and rewritten references", async ({
    page,
  }) => {
    const account = await createAccountWithVault("kdbx");
    await loginViaUi(page, account);
    for (let i = 0; i < 2; i++) {
      await openDatabasePage(page, "Persönlich");
      await openImport(page, true);
      await importFile(page, fixture("keeman-sample"));
      await page.getByTestId("kdbx-close").click();
    }
    const device = await nodeDevice(account);
    const vault = vaultNamed(device, "Persönlich");
    const titled = (title: string) =>
      [...vault.entries.values()].filter((e) => e.title === title);
    const webs = titled("root web01");
    const robots = titled("Nordhost Panel");
    expect(webs).toHaveLength(2);
    const references = robots.map(
      (robot) => device.engine.entry(vault.id, robot.id)?.values.password,
    );
    const expected = webs.map(
      (web) => `{REF:P@I:${web.id.replaceAll("-", "").toUpperCase()}}`,
    );
    expect([...references].sort()).toEqual([...expected].sort());
  });

  test("explains refusals and cancels while opening", async ({ page }) => {
    const account = await createAccount("kdbx");
    await loginViaUi(page, account);
    await openDatabases(page);
    await openImport(page);

    await openFile(page, fixture("keepass-example"), "wrong");
    await expect(dialog(page).getByTestId("error")).toContainText(
      "Passwort oder Schlüsseldatei ist falsch.",
      { timeout: 60_000 },
    );

    const bytes = readFileSync(fixture("keepassxc-example"));
    // Rewrite the CipherID header field (id 2) to Twofish.
    for (let offset = 12; ;) {
      const size = bytes.readUInt32LE(offset + 1);
      if (bytes[offset] === 2) {
        bytes.set(TWOFISH, offset + 5);
        break;
      }
      offset += 5 + size;
    }
    await openFile(page, {
      name: "twofish.kdbx",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    await expect(dialog(page).getByTestId("error")).toContainText("Twofish");

    await openFile(page, {
      name: "notes.kdbx",
      mimeType: "text/plain",
      buffer: Buffer.from("just text, no database"),
    });
    await expect(dialog(page).getByTestId("error")).toContainText(
      "Das ist keine KDBX-Datei.",
    );

    await page
      .getByTestId("kdbx-file")
      .setInputFiles(fixture("keepassxc-example"));
    await page.getByLabel("Passwort der Datei").fill("test");
    await page.getByTestId("kdbx-open").click();
    await page.getByTestId("kdbx-cancel").click();
    await expect(dialog(page)).toHaveAttribute("data-step", "choose");
    await expect(dialog(page).getByTestId("error")).toHaveCount(0);
  });
});
