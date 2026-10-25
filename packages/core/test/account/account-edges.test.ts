// Error paths of the Account facade that the main flow tests do not reach.
import { describe, expect, it } from "vitest";
import { Account } from "../../src/account/account";
import { AccountError } from "../../src/account/errors";
import { matchesRecoveryKeyGroup } from "../../src/account/recovery-key";
import { ApiClient } from "../../src/api/client";
import { ApiError, NetworkError } from "../../src/api/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import { sodium } from "../../src/crypto/sodium";
import { FakeServer, fastWorker } from "./fake-server";

const PASSWORD = "correct horse battery staple";
const NEXT = "a new long passphrase";
const EMAIL = "edge@example.com";

function newAccount(server: FakeServer): Account {
  // Without kdfMemory: the facade keeps its own in-memory store.
  return new Account({
    api: new ApiClient({
      baseUrl: "http://localhost:18787",
      clientId: "test/1.0.0",
      fetch: server.fetch,
      sleep: () => Promise.resolve(),
    }),
    spawnWorker: fastWorker,
    device: { name: "Test · Node", client_type: "web" },
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
  return { server, account };
}

async function accountError(promise: Promise<unknown>): Promise<AccountError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AccountError);
  return error as AccountError;
}

function fail(
  server: FakeServer,
  path: string,
  status: number,
  code: string,
  times = 1,
) {
  server.failures.set(
    path,
    Array.from({ length: times }, () => ({ status, code })),
  );
}

describe("registration edge cases", () => {
  it("registers without an invite in open mode", async () => {
    const server = new FakeServer();
    server.openRegistration = true;
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      language: "en",
    });
    await pending.submit();
    const body = JSON.parse(
      server.requests("/v1/auth/register")[0]?.body ?? "{}",
    ) as object;
    expect(body).not.toHaveProperty("invite_code");
  });

  it("keeps the attempt after 5xx and refuses parallel submits", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "de",
    });
    fail(server, "/v1/auth/register", 503, "internal_error");
    await expect(pending.submit()).rejects.toBeInstanceOf(ApiError);
    expect(pending.isDiscarded).toBe(false);
    const first = pending.submit();
    await expect(pending.submit()).rejects.toThrow("in progress");
    await first;
    pending.discard();
    pending.discard();
    expect(account.isUnlocked).toBe(true);
  });

  it("treats a second factor on already_registered as an integrity problem", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const account = newAccount(server);
    const pending = await account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "de",
    });
    server.dropResponse = (path) => path === "/v1/auth/register";
    await expect(pending.submit()).rejects.toBeInstanceOf(NetworkError);
    const user = server.userByEmail(EMAIL);
    if (user) user.twoFactor.totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    expect((await accountError(pending.submit())).code).toBe("integrity");
  });

  it("checks typed groups only against a real display", () => {
    expect(matchesRecoveryKeyGroup("", "")).toBe(false);
  });
});

describe("password change edge cases", () => {
  it("gets a new reauth token after reauth_required", async () => {
    const { server, account } = await registered();
    fail(server, "/v1/me/password", 401, "reauth_required");
    await account.changePassword(PASSWORD, NEXT);
    expect(server.requests("/v1/me/reauth")).toHaveLength(2);
  });

  it("gives up after three transient failures and on final errors", async () => {
    const { server, account } = await registered();
    fail(server, "/v1/me/password", 503, "internal_error", 3);
    await expect(account.changePassword(PASSWORD, NEXT)).rejects.toMatchObject({
      status: 503,
    });
    fail(server, "/v1/me/password", 422, "kdf_params_invalid");
    await expect(account.changePassword(PASSWORD, NEXT)).rejects.toMatchObject({
      code: "kdf_params_invalid",
    });
  });

  it("stops when the salt changed elsewhere in the meantime", async () => {
    const { server, account } = await registered();
    let calls = 0;
    server.tamperMe = (me) => {
      calls++;
      // The second GET /v1/me is the lost-response check.
      if (calls === 2) me.salt = toBase64Url(sodium().randombytes_buf(16));
    };
    fail(server, "/v1/me/password", 503, "internal_error");
    await expect(account.changePassword(PASSWORD, NEXT)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("refuses a /v1/me of another account", async () => {
    const { server, account } = await registered();
    server.tamperMe = (me) => {
      me.user_id = "0192b3a4-5c6d-7e8f-9a0b-ffffffffffff";
    };
    expect(
      (await accountError(account.changePassword(PASSWORD, NEXT))).code,
    ).toBe("integrity");
  });

  it("acknowledging KDF parameters without an account does nothing", () => {
    expect(() => {
      newAccount(new FakeServer()).acknowledgeKdf();
    }).not.toThrow();
  });
});

describe("recovery key and settings edge cases", () => {
  it("renews an already confirmed key and passes other errors on", async () => {
    const { server, account } = await registered();
    await account.confirmRecoveryKey();
    const renewal = await account.startRecoveryKeyRenewal(PASSWORD);
    server.dropResponse = (path) => path === "/v1/me/recovery";
    await expect(renewal.commit()).rejects.toBeInstanceOf(NetworkError);
    await renewal.commit();
    expect(server.requests("/v1/me/user-data")).toHaveLength(1);
  });

  it("does not merge into a corrupt server copy and passes other errors on", async () => {
    const { server, account } = await registered();
    fail(server, "/v1/me/user-data", 503, "internal_error");
    await expect(
      account.updateSettings({ autoLockMinutes: 5 }),
    ).rejects.toBeInstanceOf(ApiError);
    const user = server.userByEmail(EMAIL);
    if (!user) throw new Error("missing user");
    const garbage = sodium().randombytes_buf(120);
    garbage[0] = 1;
    user.user_data = {
      revision: user.user_data.revision + 1,
      data: toBase64Url(garbage),
    };
    expect(
      (await accountError(account.updateSettings({ autoLockMinutes: 5 }))).code,
    ).toBe("user_data_corrupt");
  });
});
