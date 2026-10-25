/**
 * Test helpers: invites from the server CLI and accounts created in Node
 * with the real core (the same Argon2id as in the browser). Only synthetic
 * test data, never real passwords.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import {
  Account,
  ApiClient,
  emptyDraft,
  initCrypto,
  totpFromUri,
  type EntryDraft,
  type SyncEngine,
} from "@keeman/core";
import {
  handleArgon2Message,
  type WorkerLike,
} from "@keeman/core/argon2-worker";
import { expect, type Locator, type Page } from "@playwright/test";
import { API_URL } from "./env";

export interface TestAccount {
  email: string;
  password: string;
  recoveryKey: string;
  /** Account TOTP (Base32), if turned on. */
  totpSecret?: string;
  backupCodes?: string[];
}

/** Runs a command of the server CLI against the test server. */
function cli(args: string[]): string {
  const { KEEMAN_E2E_BIN, KEEMAN_E2E_CONFIG, KEEMAN_E2E_SECRET } = process.env;
  if (!KEEMAN_E2E_BIN || !KEEMAN_E2E_CONFIG || !KEEMAN_E2E_SECRET)
    throw new Error("global setup did not run");
  return execFileSync(
    KEEMAN_E2E_BIN,
    [...args, "--config", KEEMAN_E2E_CONFIG],
    { env: { KEEMAN_SERVER_SECRET: KEEMAN_E2E_SECRET }, encoding: "utf8" },
  ).trim();
}

export function invite(): string {
  return cli(["invite", "create"]);
}

/** `user reset-2fa`: the account logs in without second factor. */
export function resetTwoFactor(email: string): void {
  cli(["user", "reset-2fa", email]);
}

/** Current and next code of an account TOTP secret (SHA1, 6, 30 s). */
export async function totpCodes(
  secret: string,
): Promise<{ code: string; next: string }> {
  const result = await totpFromUri(
    `otpauth://totp/KeeMan:test?secret=${secret}&issuer=KeeMan`,
    Date.now(),
  );
  if (!result.ok) throw new Error("bad TOTP secret");
  return { code: result.value.code, next: result.value.next };
}

/**
 * Turns on TOTP from a Node device, as the two-factor page would; the
 * returned account carries secret and backup codes.
 */
export async function enableTotpViaNode(
  account: TestAccount,
): Promise<TestAccount> {
  const device = await nodeAccount();
  await device.login(account.email, account.password);
  const setup = await device.startTotpSetup(account.password);
  const { code } = await totpCodes(setup.secret);
  const backupCodes = (await setup.enable(code)) ?? [];
  await device.logout();
  return { ...account, totpSecret: setup.secret, backupCodes };
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}@example.com`;
}

/** A password that passes the strength rule; test data only. */
export function strongPassword(): string {
  return `Kiesel Wolke ${randomBytes(4).toString("hex")} Laterne`;
}

/** Runs Argon2id in this thread, answering like the browser worker. */
function inThreadWorker(): WorkerLike {
  let listener: ((event: { data?: unknown }) => void) | undefined;
  return {
    postMessage(message) {
      void handleArgon2Message(message).then(({ response }) => {
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

/** A Node client of the API with its own session (e.g. "another device"). */
export async function nodeAccount(api?: ApiClient): Promise<Account> {
  await initCrypto();
  return new Account({
    api: api ?? new ApiClient({ baseUrl: API_URL, clientId: "e2e/1.0.0" }),
    spawnWorker: inThreadWorker,
    device: { name: "E2E · Node", client_type: "cli" },
  });
}

export interface NodeDevice {
  account: Account;
  api: ApiClient;
  engine: SyncEngine;
}

/**
 * Another device of the account in Node: logged in, syncing on demand. An
 * account with TOTP uses the next code (the browser may use the current).
 */
export async function nodeDevice(account: TestAccount): Promise<NodeDevice> {
  const api = new ApiClient({ baseUrl: API_URL, clientId: "e2e/1.0.0" });
  const device = await nodeAccount(api);
  const result = await device.login(account.email, account.password);
  if (result.kind === "second_factor") {
    if (!account.totpSecret) throw new Error("second factor without TOTP");
    await result.step.totp((await totpCodes(account.totpSecret)).next);
  }
  const engine = device.startSync();
  await engine.refresh();
  return { account: device, api, engine };
}

/** An account with the database "Persönlich", created by a Node device. */
export async function createAccountWithVault(
  prefix = "user",
): Promise<TestAccount & { vaultId: string; device: NodeDevice }> {
  const account = await createAccount(prefix);
  const device = await nodeDevice(account);
  const vaultId = await device.engine.createVault({
    name: "Persönlich",
    rootName: "Persönlich",
    recycleBinName: "Papierkorb",
  });
  return { ...account, vaultId, device };
}

/** A row of the tree by its exact name. */
export function treeRow(page: Page, name: string): Locator {
  return page.getByTestId("tree-row").filter({
    has: page.getByTestId("tree-name").getByText(name, { exact: true }),
  });
}

/** An entry row of the list by its exact title. */
export function entryRow(page: Page, title: string): Locator {
  return page.getByTestId("entry-row").filter({
    has: page.getByTestId("entry-title").getByText(title, { exact: true }),
  });
}

/** Selects a database's root group in the tree of the main view. */
export async function openVault(page: Page, name: string): Promise<void> {
  const row = page.locator("[data-test=tree-row][data-kind=root]").filter({
    has: page.getByTestId("tree-name").getByText(name, { exact: true }),
  });
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
}

/** The database page, reached through the header like a user. */
export async function openDatabases(page: Page): Promise<void> {
  await page.getByTestId("nav-databases").click();
  await expect(page.getByTestId("databases")).toBeVisible();
}

/** The main view, reached through the header. */
export async function openMain(page: Page): Promise<void> {
  await page.getByTestId("nav-entries").click();
  await expect(page.getByTestId("main-view")).toBeVisible();
}

/** Root group of a vault as the Node device sees it. */
export function rootOf(device: NodeDevice, vaultId: string): string {
  return (
    device.engine.snapshot.vaults.find((v) => v.id === vaultId)?.tree.rootId ??
    ""
  );
}

/** A group below the root, created by the Node device. */
export async function nodeGroup(
  device: NodeDevice,
  vaultId: string,
  name: string,
  parentId?: string,
): Promise<string> {
  const { id } = await device.engine.createGroup(
    vaultId,
    parentId ?? rootOf(device, vaultId),
    { name },
  );
  return id;
}

/** Registers an account through the API, recovery key confirmed. */
export async function createAccount(prefix = "user"): Promise<TestAccount> {
  const account = await nodeAccount();
  const email = uniqueEmail(prefix);
  const password = strongPassword();
  const pending = await account.startRegistration({
    email,
    password,
    inviteCode: invite(),
    language: "de",
  });
  await pending.submit();
  await account.confirmRecoveryKey();
  return { email, password, recoveryKey: pending.recoveryKey };
}

export async function loginViaUi(
  page: Page,
  account: TestAccount,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-Mail-Adresse").fill(account.email);
  await page
    .getByLabel("Master-Passwort", { exact: true })
    .fill(account.password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("main-view")).toBeVisible();
}

export async function unlockViaUi(page: Page, password: string): Promise<void> {
  await expect(page.getByTestId("unlock")).toBeVisible();
  await page.getByLabel("Master-Passwort", { exact: true }).fill(password);
  await page.getByTestId("unlock-submit").click();
}

const SECTIONS = {
  password: "Master-Passwort",
  kdf: "Schlüsselableitung",
  "recovery-key": "Recovery Key",
  "two-factor": "Zwei-Faktor",
  sessions: "Sitzungen",
  contacts: "Kontakte",
  settings: "Einstellungen",
  about: "Über KeeMan",
  delete: "Konto löschen",
} as const;

/**
 * Opens an account page inside the app: a reload would lock the tab, so
 * tests navigate with links like a user.
 */
export async function openAccount(
  page: Page,
  section: keyof typeof SECTIONS,
): Promise<void> {
  await page
    .locator(".header-nav")
    .getByRole("link", { name: "Konto" })
    .click();
  await page
    .locator(".account-nav")
    .getByRole("link", { name: SECTIONS[section], exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/account/${section}$`));
}

/** An entry created by the Node device. */
export async function nodeEntry(
  device: NodeDevice,
  vaultId: string,
  groupId: string,
  draft: Partial<EntryDraft>,
): Promise<string> {
  const { id } = await device.engine.createEntry(vaultId, groupId, {
    ...emptyDraft(),
    ...draft,
  });
  return id;
}

/** Records clipboard writes of the page (both browsers). */
export async function spyClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { __clipboard: string[] }).__clipboard = writes;
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard) {
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = async (text: string) => {
        writes.push(text);
        return original(text);
      };
    }
    // Bubbles after the app's handler on document: what it put in.
    window.addEventListener("copy", (event) => {
      const data = event.clipboardData?.getData("text/plain");
      if (data) writes.push(data);
    });
  });
}

export async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __clipboard: string[] }).__clipboard,
  );
}

/** A real PNG in one colour, built in Node (tests have no canvas here). */
export function pngBytes(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgba).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(Array.from({ length: height }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The custom icons a page shows: every one must be a PNG data URL. */
export async function customIconSources(
  scope: Locator | Page,
): Promise<string[]> {
  return scope
    .locator("[data-test=custom-icon]")
    .evaluateAll((elements) =>
      elements.map((element) =>
        element instanceof HTMLImageElement
          ? element.src
          : `not an img: ${element.tagName}`,
      ),
    );
}
