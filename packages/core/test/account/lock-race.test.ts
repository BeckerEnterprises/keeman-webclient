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

function newAccount(server: FakeServer, syncMarks?: SyncMarks) {
  const api = new ApiClient({
    baseUrl: "http://localhost:18787",
    clientId: "test/1.0.0",
    fetch: server.fetch,
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
