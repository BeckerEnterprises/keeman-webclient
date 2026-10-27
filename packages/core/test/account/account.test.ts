import { describe, expect, it } from "vitest";
import { Account, type PendingRegistration } from "../../src/account/account";
import { AccountError } from "../../src/account/errors";
import {
  inMemoryKdfMemory,
  type KdfMemory,
} from "../../src/account/kdf-memory";
import { matchesRecoveryKeyGroup } from "../../src/account/recovery-key";
import { ApiClient } from "../../src/api/client";
import { ApiError, NetworkError } from "../../src/api/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import { sodium } from "../../src/crypto/sodium";
import { FakeServer, fastWorker, totpCode, totpStep } from "./fake-server";

const PASSWORD = "correct horse battery staple";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test value");
  return value;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
const EMAIL = "alice@example.com";

function newAccount(
  server: FakeServer,
  kdfMemory: KdfMemory = inMemoryKdfMemory(),
) {
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
    kdfMemory,
  });
}

async function registered(server = new FakeServer(), memory?: KdfMemory) {
  server.invites.add("INVITE");
  const account = newAccount(server, memory);
  const pending = await account.startRegistration({
    email: EMAIL,
    password: PASSWORD,
    inviteCode: "INVITE",
    language: "de",
  });
  await pending.submit();
  return { server, account, pending };
}

async function expectAccountError(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AccountError);
  expect((error as AccountError).code).toBe(code);
  return error as AccountError;
}

function garbageEnvelope(length = 120): string {
  const bytes = sodium().randombytes_buf(length);
  bytes[0] = 1;
  return toBase64Url(bytes);
}

describe("registration", () => {
  it("registers, unlocks and keeps the recovery key unconfirmed", async () => {
    const { server, account, pending } = await registered();
    expect(account.isUnlocked).toBe(true);
    expect(account.email).toBe(EMAIL);
    expect(account.settings.language).toBe("de");
    expect(account.recoveryKeyConfirmed).toBe(false);
    expect(pending.recoveryKey).toMatch(/^([A-Z2-7]{4} ){13}[A-Z2-7]{4}$/);
    const body = JSON.parse(
      server.requests("/v1/auth/register")[0]?.body ?? "{}",
    ) as Record<string, unknown>;
    expect(body.invite_code).toBe("INVITE");
    expect(body.device).toEqual({ name: "Test · Node", client_type: "web" });

    await account.confirmRecoveryKey();
    expect(account.recoveryKeyConfirmed).toBe(true);
    expect(server.userByEmail(EMAIL)?.user_data.revision).toBe(2);
  });

  it("checks the typed last group of the recovery key", () => {
    const display =
      "AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ KKKK LLLL MMMQ 7XK2";
    expect(matchesRecoveryKeyGroup(display, "7xk2")).toBe(true);
    expect(matchesRecoveryKeyGroup(display, " 7X-K2\n")).toBe(true);
    expect(matchesRecoveryKeyGroup(display, "7XK3")).toBe(false);
    expect(matchesRecoveryKeyGroup(display, "MMMQ")).toBe(false);
  });

  it("resends the identical body after a lost response and finishes via already_registered", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "en",
    });
    const recoveryKey = pending.recoveryKey;
    server.dropResponse = (path) => path === "/v1/auth/register";
    await expect(pending.submit()).rejects.toBeInstanceOf(NetworkError);
    expect(pending.isDiscarded).toBe(false);
    await pending.submit();

    const bodies = server.requests("/v1/auth/register").map((r) => r.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(server.requests("/v1/auth/login")).toHaveLength(1);
    expect(account.isUnlocked).toBe(true);
    expect(pending.recoveryKey).toBe(recoveryKey);
    expect(account.settings.language).toBe("en");
  });

  it("discards the attempt after a final error", async () => {
    const server = new FakeServer();
    const account = newAccount(server);
    const pending: PendingRegistration = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "UNKNOWN",
      language: "de",
    });
    await expect(pending.submit()).rejects.toMatchObject({
      code: "invite_invalid",
    });
    expect(pending.isDiscarded).toBe(true);
    await expect(pending.submit()).rejects.toThrow("discarded");
    expect(account.isUnlocked).toBe(false);
  });

  it("refuses an already_registered answer that does not match the stored request", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "de",
    });
    // The first attempt arrives, its answer is lost; then the server swaps the wrapped key.
    server.dropResponse = (path) => path === "/v1/auth/register";
    await expect(pending.submit()).rejects.toBeInstanceOf(NetworkError);
    must(server.userByEmail(EMAIL)).user_key_wrapped = garbageEnvelope(73);
    await expectAccountError(pending.submit(), "integrity");
    expect(account.isUnlocked).toBe(false);
  });
});

describe("login and unlock", () => {
  it("logs in, locks and unlocks", async () => {
    const { server } = await registered();
    const account = newAccount(server);
    const result = await account.login(" Alice@Example.com ", PASSWORD);
    expect(result).toEqual({
      kind: "unlocked",
      report: {
        kdfWeakerThanSeen: false,
        kdfBelowDefault: false,
        recoveryKeyUnconfirmed: true,
        userDataCorrupt: false,
        userDataReadOnly: false,
        userDataRollback: false,
        userDataStale: false,
        // A device of its own: no marks for the account yet.
        newDevice: true,
      },
    });
    expect(
      JSON.parse(server.requests("/v1/auth/login")[0]?.body ?? "{}"),
    ).toMatchObject({
      email: EMAIL,
    });
    account.lock();
    expect(account.isUnlocked).toBe(false);
    expect(account.email).toBe(EMAIL);
    expect(account.settings.autoLockMinutes).toBe(15);
    await expectAccountError(
      account.unlock("wrong password, sadly"),
      "wrong_password",
    );
    await account.unlock(PASSWORD);
    expect(account.isUnlocked).toBe(true);
  });

  it("reports wrong credentials, second factors and bad KDF parameters", async () => {
    const { server } = await registered();
    const account = newAccount(server);
    await expect(
      account.login(EMAIL, "not the password"),
    ).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    must(server.userByEmail(EMAIL)).kdf = {
      alg: "argon2id13",
      ops: 1,
      mem: 67108864,
    };
    await expectAccountError(account.login(EMAIL, PASSWORD), "kdf_invalid");
  });

  it("detects manipulated account data as an integrity error", async () => {
    const { server } = await registered();
    const account = newAccount(server);
    server.tamperMe = (me) => {
      me.public_key = toBase64Url(sodium().randombytes_buf(32));
    };
    await expectAccountError(account.login(EMAIL, PASSWORD), "integrity");
    server.tamperMe = (me) => {
      me.user_id = "0192b3a4-5c6d-7e8f-9a0b-ffffffffffff";
    };
    await expectAccountError(account.login(EMAIL, PASSWORD), "integrity");
    server.tamperMe = (me) => {
      me.user_key_wrapped = garbageEnvelope(73);
    };
    // Right after a login a failing unwrap is an integrity problem, not a wrong password.
    await expectAccountError(account.login(EMAIL, PASSWORD), "integrity");
    expect(account.isUnlocked).toBe(false);
  });

  it("warns about weaker KDF parameters than seen before", async () => {
    const memory = inMemoryKdfMemory();
    const { server, account } = await registered(new FakeServer(), memory);
    const userId = must(account.userId);
    expect(memory.get(userId)).toEqual({ ops: 3, mem: 67108864 });

    await account.upgradeKdf(PASSWORD, {
      alg: "argon2id13",
      ops: 2,
      mem: 33554432,
    });
    const other = new Map([[userId, { ops: 3, mem: 67108864 }]]);
    const otherMemory: KdfMemory = {
      get: (id) => other.get(id),
      set: (id, cost) => other.set(id, cost),
      forget: (id) => other.delete(id),
    };
    const device = newAccount(server, otherMemory);
    const result = await device.login(EMAIL, PASSWORD);
    if (result.kind !== "unlocked") throw new Error("expected an unlock");
    expect(result.report.kdfWeakerThanSeen).toBe(true);
    expect(result.report.kdfBelowDefault).toBe(true);
    expect(other.get(userId)).toEqual({ ops: 3, mem: 67108864 });
    device.acknowledgeKdf();
    expect(other.get(userId)).toEqual({ ops: 2, mem: 33554432 });

    // A failing unlock with weaker parameters hints at manipulation.
    other.set(userId, { ops: 3, mem: 67108864 });
    device.lock();
    const error = await expectAccountError(
      device.unlock("wrong password, sadly"),
      "wrong_password",
    );
    expect(error.possiblyManipulated).toBe(true);
  });

  it("compares the prelogin parameters it derived with after a login", async () => {
    const { server, account } = await registered();
    const userId = must(account.userId);
    const seen = new Map([[userId, { ops: 3, mem: 67108864 }]]);
    const memory: KdfMemory = {
      get: (id) => seen.get(id),
      set: (id, cost) => seen.set(id, cost),
      forget: (id) => seen.delete(id),
    };
    // A lying server offers weak parameters and lets any key log in: the
    // unwrap fails, and the error names the parameters as a possible cause.
    server.tamperPrelogin = (answer) => {
      answer.kdf = { alg: "argon2id13", ops: 2, mem: 33554432 };
    };
    server.acceptAnyAuthKey = true;
    const lied = newAccount(server, memory);
    const error = await expectAccountError(
      lied.login(EMAIL, PASSWORD),
      "integrity",
    );
    expect(error.possiblyManipulated).toBe(true);
    expect(seen.get(userId)).toEqual({ ops: 3, mem: 67108864 });

    // Weak parameters only in GET /v1/me, honest prelogin: no false warning,
    // and what is remembered is what was derived with.
    server.tamperPrelogin = () => undefined;
    server.acceptAnyAuthKey = false;
    server.tamperMe = (me) => {
      me.kdf = { alg: "argon2id13", ops: 2, mem: 33554432 };
    };
    const honest = newAccount(server, memory);
    const result = await honest.login(EMAIL, PASSWORD);
    if (result.kind !== "unlocked") throw new Error("expected an unlock");
    expect(result.report.kdfWeakerThanSeen).toBe(false);
    expect(seen.get(userId)).toEqual({ ops: 3, mem: 67108864 });
  });

  it("compares the prelogin parameters also after a second factor", async () => {
    const { server, account } = await registered();
    const userId = must(account.userId);
    const secret = server.enableTotp(EMAIL);
    const seen = new Map([[userId, { ops: 3, mem: 67108864 }]]);
    const memory: KdfMemory = {
      get: (id) => seen.get(id),
      set: (id, cost) => seen.set(id, cost),
      forget: (id) => seen.delete(id),
    };
    server.tamperPrelogin = (answer) => {
      answer.kdf = { alg: "argon2id13", ops: 2, mem: 33554432 };
    };
    server.acceptAnyAuthKey = true;
    const result = await newAccount(server, memory).login(EMAIL, PASSWORD);
    if (result.kind !== "second_factor") throw new Error("expected 2FA");
    const error = await expectAccountError(
      result.step.totp(totpCode(secret, totpStep(Date.now()))),
      "integrity",
    );
    expect(error.possiblyManipulated).toBe(true);
  });

  it("marks undecryptable user data as corrupt and allows an explicit reset", async () => {
    const { server, account } = await registered();
    must(server.userByEmail(EMAIL)).user_data.data = garbageEnvelope();
    account.lock();
    const report = await account.unlock(PASSWORD);
    expect(report.userDataCorrupt).toBe(true);
    expect(account.recoveryKeyConfirmed).toBe(true);
    await expectAccountError(
      account.updateSettings({ autoLockMinutes: 5 }),
      "user_data_corrupt",
    );
    await account.resetUserData("en");
    expect(account.userDataState).toMatchObject({ status: "ok" });
    expect(account.settings.language).toBe("en");
    await expectAccountError(
      account.resetUserData("en"),
      "user_data_read_only",
    );
  });

  it("logs out and wipes everything", async () => {
    const { server, account } = await registered();
    await account.logout();
    expect(account.isUnlocked).toBe(false);
    expect(account.userId).toBeUndefined();
    expect([...server.sessions.values()].every((s) => s.revoked)).toBe(true);
    await expectAccountError(
      account.updateSettings({ autoLockMinutes: 5 }),
      "locked",
    );
  });
});

describe("password change and KDF upgrade", () => {
  it("checks the old password locally before any reauth", async () => {
    const { server, account } = await registered();
    await expectAccountError(
      account.changePassword("not the password", "a new long passphrase"),
      "wrong_password",
    );
    expect(server.requests("/v1/me/reauth")).toHaveLength(0);
  });

  it("changes the password and revokes the other sessions", async () => {
    const { server, account } = await registered();
    const other = newAccount(server);
    await other.login(EMAIL, PASSWORD);
    await account.changePassword(PASSWORD, "a new long passphrase");
    expect(
      [...server.sessions.values()].filter((s) => !s.revoked),
    ).toHaveLength(1);
    expect(server.requests("/v1/me/reauth")).toHaveLength(1);
    const third = newAccount(server);
    await expect(third.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(ApiError);
    await third.login(EMAIL, "a new long passphrase");
    expect(third.kdf).toEqual({ alg: "argon2id13", ops: 3, mem: 67108864 });
  });

  it("recognises a lost response by the new salt", async () => {
    const { server, account } = await registered();
    server.dropResponse = (path) => path === "/v1/me/password";
    await account.changePassword(PASSWORD, "a new long passphrase");
    expect(server.requests("/v1/me/password")).toHaveLength(1);
    account.lock();
    await account.unlock("a new long passphrase");
  });

  it("resends the same body when the change did not arrive", async () => {
    const { server, account } = await registered();
    let failed = false;
    const original = server.fetch;
    server.dropResponse = () => false;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!failed && urlOf(input).endsWith("/v1/me/password")) {
        failed = true;
        throw new TypeError("network error");
      }
      return original(input, init);
    }) as typeof globalThis.fetch;
    Object.defineProperty(server, "fetch", { value: flaky });
    const account2 = newAccount(server);
    await account2.login(EMAIL, PASSWORD);
    await account2.changePassword(PASSWORD, "a new long passphrase");
    const bodies = server.requests("/v1/me/password").map((r) => r.body);
    expect(bodies).toHaveLength(1);
    expect(server.requests("/v1/me/reauth")).toHaveLength(2);
    expect(account.isUnlocked).toBe(true);
  });

  it("upgrades the KDF without revoking other sessions", async () => {
    const { server, account } = await registered();
    const other = newAccount(server);
    await other.login(EMAIL, PASSWORD);
    await account.upgradeKdf(PASSWORD, {
      alg: "argon2id13",
      ops: 4,
      mem: 134217728,
    });
    expect(account.kdf).toEqual({ alg: "argon2id13", ops: 4, mem: 134217728 });
    expect(
      [...server.sessions.values()].filter((s) => !s.revoked),
    ).toHaveLength(2);
    await expectAccountError(
      account.upgradeKdf(PASSWORD, {
        alg: "argon2id13",
        ops: 11,
        mem: 134217728,
      }),
      "kdf_invalid",
    );
  });
});

describe("recovery key renewal", () => {
  it("shows the new key first and replaces it only on commit", async () => {
    const { server, account } = await registered();
    const before = must(server.userByEmail(EMAIL)).recovery;
    const renewal = await account.startRecoveryKeyRenewal(PASSWORD);
    expect(renewal.recoveryKey).toMatch(/^([A-Z2-7]{4} ){13}[A-Z2-7]{4}$/);
    expect(must(server.userByEmail(EMAIL)).recovery).toEqual(before);
    server.expireReauthTokens();
    await expectAccountError(renewal.commit(), "reauth_required");
    await renewal.reauthenticate(PASSWORD);
    await renewal.commit();
    expect(must(server.userByEmail(EMAIL)).recovery).not.toEqual(before);
    expect(account.recoveryKeyConfirmed).toBe(true);
    await expectAccountError(
      account.startRecoveryKeyRenewal("wrong password, sadly"),
      "wrong_password",
    );
  });
});

describe("settings", () => {
  it("merges with changes from another device after 409", async () => {
    const { server, account } = await registered();
    const other = newAccount(server);
    await other.login(EMAIL, PASSWORD);
    await other.updateSettings({ autoLockMinutes: 30 });
    await account.updateSettings({ language: "en", lockOnHiddenMinutes: 0 });
    expect(account.settings).toMatchObject({
      language: "en",
      autoLockMinutes: 30,
      lockOnHiddenMinutes: 0,
    });
    other.lock();
    await other.unlock(PASSWORD);
    expect(other.settings).toMatchObject({
      language: "en",
      autoLockMinutes: 30,
    });
    expect(server.requests("/v1/me/user-data")).toHaveLength(3);
  });

  it("gives up after three conflicts", async () => {
    const { server, account } = await registered();
    const original = server.fetch;
    const conflicting = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if (urlOf(input).endsWith("/v1/me/user-data"))
        must(server.userByEmail(EMAIL)).user_data.revision++;
      return original(input, init);
    }) as typeof globalThis.fetch;
    Object.defineProperty(server, "fetch", { value: conflicting });
    const flaky = newAccount(server);
    await flaky.login(EMAIL, PASSWORD);
    await expectAccountError(
      flaky.updateSettings({ autoLockMinutes: 5 }),
      "conflict_unresolved",
    );
    expect(account.isUnlocked).toBe(true);
  });

  it("lists and revokes sessions", async () => {
    const { server, account } = await registered();
    const other = newAccount(server);
    await other.login(EMAIL, PASSWORD);
    const sessions = await account.sessions();
    expect(sessions).toHaveLength(2);
    const foreign = must(sessions.find((s) => !s.current));
    await account.revokeSession(foreign.id);
    expect(await account.sessions()).toHaveLength(1);
    await other.login(EMAIL, PASSWORD);
    await account.revokeOtherSessions();
    expect(await account.sessions()).toHaveLength(1);
  });
});
