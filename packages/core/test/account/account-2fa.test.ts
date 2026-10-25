import { describe, expect, it } from "vitest";
import { Account, type SecondFactorLogin } from "../../src/account/account";
import { AccountError } from "../../src/account/errors";
import { ApiClient } from "../../src/api/client";
import { ApiError, NetworkError } from "../../src/api/errors";
import {
  echoCredential,
  FakeServer,
  fastWorker,
  totpCode,
  totpStep,
} from "./fake-server";

const PASSWORD = "correct horse battery staple";
const EMAIL = "alice@example.com";
const CODES = ["AAAAAAAAAA", "BBBBBBBBBB", "CCCCCCCCCC"];

function newAccount(server: FakeServer, now?: () => number) {
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
    ...(now ? { now } : {}),
  });
}

async function registered() {
  const server = new FakeServer();
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
  return server;
}

async function secondFactor(
  account: Account,
  password = PASSWORD,
): Promise<SecondFactorLogin> {
  const result = await account.login(EMAIL, password);
  if (result.kind !== "second_factor") throw new Error("expected 2FA");
  return result.step;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("login with a second factor", () => {
  it("logs in with TOTP after a wrong code", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    const account = newAccount(server);
    const step = await secondFactor(account);
    expect(step.methods).toEqual(["totp", "backup_code"]);
    expect(account.isUnlocked).toBe(false);
    const login = server.requests("/v1/auth/login");
    expect(login).toHaveLength(1);

    const wrong = await rejection(step.totp("000000"));
    expect(wrong).toBeInstanceOf(ApiError);
    expect((wrong as ApiError).code).toBe("invalid_second_factor");
    expect(step.isDiscarded).toBe(false);

    const report = await step.totp(server.totpNow(EMAIL));
    expect(report.recoveryKeyUnconfirmed).toBe(true);
    expect(report.backupCodesRemaining).toBeUndefined();
    expect(account.isUnlocked).toBe(true);
    expect(account.email).toBe(EMAIL);
    expect(step.isDiscarded).toBe(true);
    // The auth key went out only once, with the login.
    expect(server.requests("/v1/auth/login")).toHaveLength(1);
    const body = JSON.parse(
      server.requests("/v1/auth/2fa/totp")[1]?.body ?? "",
    ) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["challenge_token", "code"]);
  });

  it("reports the backup codes left after a backup code", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    const account = newAccount(server);
    const step = await secondFactor(account);
    const report = await step.backupCode("bbbbb-bbbbb");
    expect(report.backupCodesRemaining).toBe(2);
    expect(account.isUnlocked).toBe(true);
  });

  it("logs in with a passkey", async () => {
    const server = await registered();
    const user = server.userByEmail(EMAIL);
    user?.twoFactor.passkeys.push({
      id: "0192b3a4-5c6d-7e8f-9a0b-00000000aaaa",
      credentialId: "cred-1",
      name: "Laptop",
      created: "2026-10-23T08:00:00.000Z",
      lastUsed: null,
    });
    const account = newAccount(server);
    const step = await secondFactor(account);
    expect(step.methods).toEqual(["webauthn"]);
    const options = await step.passkeyOptions();
    expect(options.userVerification).toBe("required");
    await step.passkey(echoCredential(options, "cred-1"));
    expect(account.isUnlocked).toBe(true);
  });

  it("ends the step after five failures, on account_disabled and on lock", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    const account = newAccount(server);
    let step = await secondFactor(account);
    for (let i = 0; i < 4; i++) await rejection(step.totp("000000"));
    const fifth = await rejection(step.totp("000000"));
    expect((fifth as ApiError).code).toBe("invalid_second_factor");
    expect(step.isDiscarded).toBe(false);
    const ended = await rejection(step.totp(server.totpNow(EMAIL)));
    expect((ended as ApiError).code).toBe("challenge_invalid");
    expect(step.isDiscarded).toBe(true);
    const again = await rejection(step.totp(server.totpNow(EMAIL)));
    expect(again).toBeInstanceOf(AccountError);
    expect((again as AccountError).code).toBe("challenge_expired");

    step = await secondFactor(account);
    server.failures.set("/v1/auth/2fa/totp", [
      { status: 403, code: "account_disabled" },
    ]);
    await rejection(step.totp(server.totpNow(EMAIL)));
    expect(step.isDiscarded).toBe(true);

    step = await secondFactor(account);
    account.lock();
    expect(step.isDiscarded).toBe(true);
    step = await secondFactor(account);
    step.discard();
    expect(step.isDiscarded).toBe(true);
  });

  it("expires by the account clock without asking the server", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    let now = 1_000_000;
    const account = newAccount(server, () => now);
    const step = await secondFactor(account);
    expect(step.expiresAt).toBe(1_000_000 + 300_000);
    now += 300_000;
    const error = await rejection(step.totp(server.totpNow(EMAIL)));
    expect((error as AccountError).code).toBe("challenge_expired");
    expect(server.requests("/v1/auth/2fa/totp")).toHaveLength(0);
    await rejection(step.passkeyOptions());
    expect(server.requests("/v1/auth/2fa/webauthn/options")).toHaveLength(0);
  });

  it("keeps the step after a server error, not after a lost answer", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    const account = newAccount(server);
    let step = await secondFactor(account);
    server.failures.set("/v1/auth/2fa/totp", [
      { status: 503, code: "internal_error" },
    ]);
    const code = server.totpNow(EMAIL);
    expect(((await rejection(step.totp(code))) as ApiError).status).toBe(503);
    expect(step.isDiscarded).toBe(false);
    await step.totp(code);
    expect(account.isUnlocked).toBe(true);

    // A lost answer: the server used the challenge, a retry ends the step.
    account.lock();
    step = await secondFactor(account);
    server.dropResponse = (path) => path === "/v1/auth/2fa/totp";
    const lost = await rejection(step.totp(server.totpNow(EMAIL, 1)));
    expect(lost).toBeInstanceOf(NetworkError);
    expect(step.isDiscarded).toBe(false);
    const retry = await rejection(step.totp(server.totpNow(EMAIL, 1)));
    expect((retry as ApiError).code).toBe("challenge_invalid");
    expect(step.isDiscarded).toBe(true);
  });

  it("treats a session of another account as an integrity error", async () => {
    const server = await registered();
    server.enableTotp(EMAIL, CODES);
    const account = newAccount(server);
    const step = await secondFactor(account);
    server.tamperMe = (me) => {
      me.user_id = "0192b3a4-5c6d-7e8f-9a0b-00000000ffff";
    };
    const error = await rejection(step.totp(server.totpNow(EMAIL)));
    expect((error as AccountError).code).toBe("integrity");
    expect(step.isDiscarded).toBe(true);
    expect(account.isUnlocked).toBe(false);
  });
});

describe("managing the own second factors", () => {
  async function unlocked() {
    const server = await registered();
    const account = newAccount(server);
    await account.login(EMAIL, PASSWORD);
    return { server, account };
  }

  it("checks the password locally before any reauth", async () => {
    const { server, account } = await unlocked();
    const error = await rejection(account.startTotpSetup("wrong password!"));
    expect((error as AccountError).code).toBe("wrong_password");
    expect(server.requests("/v1/me/reauth")).toHaveLength(0);
    expect(server.requests("/v1/me/totp/setup")).toHaveLength(0);
  });

  it("sets up TOTP, replaces backup codes and turns TOTP off", async () => {
    const { server, account } = await unlocked();
    const setup = await account.startTotpSetup(PASSWORD);
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    const wrong = await rejection(setup.enable("000000"));
    expect((wrong as ApiError).code).toBe("invalid_second_factor");
    const codes = await setup.enable(
      totpCode(setup.secret, totpStep(Date.now())),
    );
    expect(codes).toHaveLength(10);
    expect(await account.twoFactorStatus()).toEqual({
      totp: true,
      passkeys: 0,
      backupCodesRemaining: 10,
    });

    const fresh = await account.regenerateBackupCodes(PASSWORD);
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(codes);

    // Login now needs the second factor; a fresh code works.
    const other = newAccount(server);
    const result = await other.login(EMAIL, PASSWORD);
    expect(result.kind).toBe("second_factor");
    if (result.kind === "second_factor")
      await result.step.backupCode(fresh[0] ?? "");
    expect(other.isUnlocked).toBe(true);

    await account.disableTotp(PASSWORD);
    expect(await account.twoFactorStatus()).toEqual({
      totp: false,
      passkeys: 0,
      backupCodesRemaining: 0,
    });
  });

  it("registers, lists and removes passkeys", async () => {
    const { server, account } = await unlocked();
    const registration = await account.startPasskeyRegistration(
      PASSWORD,
      "Firefox · Linux",
    );
    expect(registration.publicKey.rp).toEqual({
      id: "localhost",
      name: "KeeMan",
    });
    const added = await registration.finish(
      echoCredential(registration.publicKey, "cred-9"),
    );
    expect(added.backupCodes).toHaveLength(10);
    const second = await account.startPasskeyRegistration(PASSWORD, "Phone");
    expect(second.publicKey.excludeCredentials).toEqual([
      { type: "public-key", id: "cred-9" },
    ]);
    const more = await second.finish(
      echoCredential(second.publicKey, "cred-10"),
    );
    expect(more.backupCodes).toBeUndefined();
    const list = await account.passkeys();
    expect(list.map((p) => p.name)).toEqual(["Firefox · Linux", "Phone"]);
    await account.removePasskey(PASSWORD, added.id);
    await account.removePasskey(PASSWORD, more.id);
    expect(await account.passkeys()).toEqual([]);
    expect((await account.twoFactorStatus()).backupCodesRemaining).toBe(0);
    expect(server.requests("/v1/me/reauth").length).toBe(4);
  });

  it("needs an unlocked account", async () => {
    const server = await registered();
    const account = newAccount(server);
    await expect(account.twoFactorStatus()).rejects.toMatchObject({
      code: "locked",
    });
    expect(() => account.passkeys()).toThrow(AccountError);
  });
});
