import { describe, expect, it } from "vitest";
import { Account } from "../../src/account/account";
import { AccountError } from "../../src/account/errors";
import { ApiClient } from "../../src/api/client";
import { inMemorySyncMarks, type SyncMarks } from "../../src/sync/marks";
import { FakeServer, fastWorker } from "./fake-server";

// A lock (by hand, by the timer or from another tab) while an unlock,
// login, second factor, recovery or registration waits for an answer
// ends that operation: it takes over no keys and reports `locked`.

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely different passphrase";
const EMAIL = "alice@example.com";

function newAccount(
  server: FakeServer,
  syncMarks?: SyncMarks,
  fetch: typeof globalThis.fetch = server.fetch,
) {
  const api = new ApiClient({
    baseUrl: "http://localhost:18787",
    clientId: "test/1.0.0",
    fetch,
    sleep: () => Promise.resolve(),
  });
  return new Account({
    api,
    spawnWorker: fastWorker,
    device: { name: "Test · Node", client_type: "web" },
    ...(syncMarks ? { syncMarks } : {}),
  });
}

async function registered(server = new FakeServer()) {
  server.invites.add("INVITE");
  const account = newAccount(server);
  const pending = await account.startRegistration({
    email: EMAIL,
    password: PASSWORD,
    inviteCode: "INVITE",
    language: "de",
  });
  await pending.submit();
  account.lock();
  return { server, account, recoveryKey: pending.recoveryKey };
}

/** Locks `account` once, when a request to `path` starts. */
function lockOn(server: FakeServer, account: Account, path: string): void {
  server.onRequest = (_method, requested) => {
    if (requested !== path) return;
    server.onRequest = () => undefined;
    account.lock();
  };
}

async function expectLocked(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AccountError);
  expect((error as AccountError).code).toBe("locked");
}

describe("a lock overtakes", () => {
  it("an unlock waiting for the account", async () => {
    const { server, account } = await registered();
    lockOn(server, account, "/v1/me");
    await expectLocked(account.unlock(PASSWORD));
    expect(account.isUnlocked).toBe(false);
    expect(() => account.startSync()).toThrow();
    // A later unlock works as usual.
    await account.unlock(PASSWORD);
    expect(account.isUnlocked).toBe(true);
  });

  it("an unlock reading the marks", async () => {
    const { server } = await registered();
    const marks = inMemorySyncMarks();
    const account: Account = newAccount(server, {
      ...marks,
      read: (userId) => {
        account.lock();
        return marks.read(userId);
      },
    });
    await account.login(EMAIL, PASSWORD).catch(() => undefined);
    expect(account.isUnlocked).toBe(false);
    await expectLocked(account.unlock(PASSWORD));
    expect(account.isUnlocked).toBe(false);
  });

  it("a login waiting for the account", async () => {
    const { server } = await registered();
    const account = newAccount(server);
    lockOn(server, account, "/v1/me");
    await expectLocked(account.login(EMAIL, PASSWORD));
    expect(account.isUnlocked).toBe(false);
  });

  it("a login waiting for the session", async () => {
    const { server } = await registered();
    const account = newAccount(server);
    lockOn(server, account, "/v1/auth/login");
    await expectLocked(account.login(EMAIL, PASSWORD));
    expect(account.isUnlocked).toBe(false);
    expect(server.requests("/v1/me")).toHaveLength(0);
  });

  it("a second factor, without an integrity error", async () => {
    const { server } = await registered();
    server.enableTotp(EMAIL, []);
    const account = newAccount(server);
    const result = await account.login(EMAIL, PASSWORD);
    if (result.kind !== "second_factor") throw new Error("expected 2FA");
    lockOn(server, account, "/v1/auth/2fa/totp");
    await expectLocked(result.step.totp(server.totpNow(EMAIL)));
    expect(account.isUnlocked).toBe(false);
    expect(result.step.isDiscarded).toBe(true);
  });

  it("a recovery waiting for the account, without an integrity error", async () => {
    const { server, recoveryKey } = await registered();
    const account = newAccount(server);
    const process = await account.startRecovery(EMAIL, recoveryKey);
    await process.prepare(NEW_PASSWORD);
    lockOn(server, account, "/v1/me");
    await expectLocked(process.finish());
    expect(account.isUnlocked).toBe(false);
    expect(process.isDiscarded).toBe(true);
  });

  it("a recovery waiting for its start", async () => {
    const { server, recoveryKey } = await registered();
    const account = newAccount(server);
    lockOn(server, account, "/v1/auth/recover/start");
    await expectLocked(account.startRecovery(EMAIL, recoveryKey));
  });

  it("a registration waiting for the server", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "de",
    });
    lockOn(server, account, "/v1/auth/register");
    await expectLocked(pending.submit());
    expect(account.isUnlocked).toBe(false);
    expect(pending.isDiscarded).toBe(true);
  });
});

describe("a lock overtakes a write", () => {
  it("of the settings: nothing decrypted comes back", async () => {
    const { server, account } = await registered();
    await account.unlock(PASSWORD);
    lockOn(server, account, "/v1/me/user-data");
    await expectLocked(account.updateSettings({ autoLockMinutes: 5 }));
    expect(account.userDataState).toBeUndefined();
    expect(account.settings.autoLockMinutes).toBe(15);
    expect(account.contacts).toEqual([]);
    // The server took the change; the next unlock shows it.
    await account.unlock(PASSWORD);
    expect(account.settings.autoLockMinutes).toBe(5);
  });

  it("while merging after a conflict", async () => {
    const { server, account } = await registered();
    await account.unlock(PASSWORD);
    server.failures.set("/v1/me/user-data", [
      { status: 409, code: "conflict" },
    ]);
    lockOn(server, account, "/v1/me");
    await expectLocked(account.updateSettings({ autoLockMinutes: 5 }));
    expect(account.userDataState).toBeUndefined();
  });

  it("of a reset", async () => {
    const { server, account } = await registered();
    server.tamperMe = (me) => {
      (me.user_data as { data: string }).data = "AQ" + "A".repeat(160);
    };
    await account.unlock(PASSWORD);
    server.tamperMe = () => undefined;
    expect(account.userDataState?.status).toBe("corrupt");
    lockOn(server, account, "/v1/me/user-data");
    await expectLocked(account.resetUserData("de"));
    expect(account.userDataState).toBeUndefined();
  });

  it("and another account signs in: its data stays its own", async () => {
    const server = new FakeServer();
    const bob = await registered(server).then(async () => {
      server.invites.add("INVITE-BOB");
      const other = newAccount(server);
      const pending = await other.startRegistration({
        email: "bob@example.com",
        password: PASSWORD,
        inviteCode: "INVITE-BOB",
        language: "de",
      });
      await pending.submit();
      return other;
    });
    bob.lock();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const gated: typeof globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (
        holding &&
        init?.method === "PUT" &&
        url.endsWith("/v1/me/user-data")
      ) {
        holding = false;
        await held;
      }
      return server.fetch(input, init);
    };
    const tab = newAccount(server, undefined, gated);
    await tab.login(EMAIL, PASSWORD);
    const write = tab.updateSettings({ autoLockMinutes: 5 });
    // Another tab signs in as Bob: this tab locks and logs in as Bob.
    tab.lock();
    await tab.login("bob@example.com", PASSWORD);
    release();
    await expectLocked(write);
    expect(tab.email).toBe("bob@example.com");
    expect(tab.settings.autoLockMinutes).toBe(15);
  });

  it("preparing a recovery ends it", async () => {
    const { server, recoveryKey } = await registered();
    const account = newAccount(server);
    const process = await account.startRecovery(EMAIL, recoveryKey);
    lockOn(server, account, "/v1/auth/prelogin");
    const error = await process.prepare(NEW_PASSWORD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).code).toBe("challenge_expired");
    expect(process.isDiscarded).toBe(true);
    expect(process.recoveryKey).toBeUndefined();
  });
});
