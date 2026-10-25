import { describe, expect, it } from "vitest";
import { Account, type RecoveryProcess } from "../../src/account/account";
import { AccountError } from "../../src/account/errors";
import { ApiClient } from "../../src/api/client";
import { ApiError, NetworkError } from "../../src/api/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import { sodium } from "../../src/crypto/sodium";
import { FakeServer, fastWorker } from "./fake-server";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a completely new passphrase";
const EMAIL = "alice@example.com";

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

/** A registered account with its recovery key; the device is locked. */
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
  const recoveryKey = pending.recoveryKey;
  account.lock();
  return { server, recoveryKey };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

function finishBody(server: FakeServer, index = 0): Record<string, unknown> {
  return JSON.parse(
    server.requests("/v1/auth/recover/finish")[index]?.body ?? "{}",
  ) as Record<string, unknown>;
}

describe("recovery", () => {
  it("rejects a mistyped key locally", async () => {
    const { server, recoveryKey } = await registered();
    const account = newAccount(server);
    const typo = recoveryKey.replace(/^(.)/, (c) => (c === "A" ? "B" : "A"));
    const error = await rejection(account.startRecovery(EMAIL, typo));
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).code).toBe("recovery_key_malformed");
    expect(server.requests("/v1/auth/recover/start")).toHaveLength(0);
  });

  it("sets a new password and a new recovery key", async () => {
    const { server, recoveryKey } = await registered();
    const before = server.userByEmail(EMAIL)?.salt;
    const other = newAccount(server);
    await other.login(EMAIL, PASSWORD);
    const account = newAccount(server);
    const process = await account.startRecovery(
      " Alice@Example.com ",
      recoveryKey.toLowerCase(),
    );
    expect(process.stage).toBe("password");
    expect(process.email).toBe(EMAIL);
    const newKey = await process.prepare(NEW_PASSWORD);
    expect(newKey).toMatch(/^([A-Z2-7]{4} ){13}[A-Z2-7]{4}$/);
    expect(newKey).not.toBe(recoveryKey);
    expect(process.recoveryKey).toBe(newKey);
    expect(process.stage).toBe("confirm");
    expect(server.requests("/v1/auth/recover/finish")).toHaveLength(0);

    const step = await process.finish();
    if (step.stage !== "done") throw new Error("expected done");
    expect(step.report.recoveryKeyUnconfirmed).toBe(false);
    expect(account.isUnlocked).toBe(true);
    expect(account.recoveryKeyConfirmed).toBe(true);
    expect(process.isDiscarded).toBe(true);
    const body = finishBody(server);
    expect(Object.keys(body).sort()).toEqual([
      "auth_key",
      "device",
      "kdf",
      "recovery",
      "recovery_token",
      "salt",
      "user_key_wrapped",
    ]);
    expect(server.userByEmail(EMAIL)?.salt).not.toBe(before);
    // The other device was signed out; the old password and key are gone.
    await expect(other.unlock(PASSWORD)).rejects.toMatchObject({
      code: "session_invalid",
    });
    const third = newAccount(server);
    await expect(third.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(ApiError);
    await third.login(EMAIL, NEW_PASSWORD);
    expect(third.isUnlocked).toBe(true);
    await expect(
      newAccount(server).startRecovery(EMAIL, recoveryKey),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    const again = await newAccount(server).startRecovery(EMAIL, newKey);
    expect(again.stage).toBe("password");
  });

  it("keeps stronger KDF parameters of the account", async () => {
    const { server, recoveryKey } = await registered();
    const user = server.userByEmail(EMAIL);
    if (user) user.kdf = { alg: "argon2id13", ops: 4, mem: 67108864 };
    const process = await newAccount(server).startRecovery(EMAIL, recoveryKey);
    await process.prepare(NEW_PASSWORD);
    await process.finish();
    expect(finishBody(server).kdf).toEqual({
      alg: "argon2id13",
      ops: 4,
      mem: 67108864,
    });
  });

  it("asks for the second factor first", async () => {
    const { server, recoveryKey } = await registered();
    server.enableTotp(EMAIL, ["AAAAAAAAAA"]);
    const account = newAccount(server);
    const process = await account.startRecovery(EMAIL, recoveryKey);
    expect(process.stage).toBe("second_factor");
    expect(process.methods).toEqual(["totp", "backup_code"]);
    await expect(process.prepare(NEW_PASSWORD)).rejects.toThrow();
    const wrong = await rejection(process.totp("000000"));
    expect((wrong as ApiError).code).toBe("invalid_second_factor");
    expect(await process.totp(server.totpNow(EMAIL))).toEqual({
      stage: "password",
    });
    await process.prepare(NEW_PASSWORD);
    const step = await process.finish();
    expect(step.stage).toBe("done");
    expect(account.isUnlocked).toBe(true);
    // The second factor stays.
    expect(server.userByEmail(EMAIL)?.twoFactor.totpSecret).toBeDefined();
  });

  it("recognises a lost answer by the new salt", async () => {
    const { server, recoveryKey } = await registered();
    const account = newAccount(server);
    const process = await account.startRecovery(EMAIL, recoveryKey);
    await process.prepare(NEW_PASSWORD);
    server.dropResponse = (path) => path === "/v1/auth/recover/finish";
    expect(await rejection(process.finish())).toBeInstanceOf(NetworkError);
    expect(process.isDiscarded).toBe(false);
    const step = await process.finish();
    expect(step.stage).toBe("done");
    expect(account.isUnlocked).toBe(true);
    // The retry sent the same bytes.
    expect(finishBody(server, 1)).toEqual(finishBody(server, 0));
    expect(server.requests("/v1/auth/login")).toHaveLength(1);
  });

  it("logs in with the second factor after a lost answer", async () => {
    const { server, recoveryKey } = await registered();
    server.enableTotp(EMAIL, []);
    const account = newAccount(server);
    const process = await account.startRecovery(EMAIL, recoveryKey);
    await process.totp(server.totpNow(EMAIL));
    await process.prepare(NEW_PASSWORD);
    server.dropResponse = (path) => path === "/v1/auth/recover/finish";
    await rejection(process.finish());
    expect(await process.finish()).toEqual({ stage: "second_factor" });
    expect(process.stage).toBe("second_factor");
    const step = await process.totp(server.totpNow(EMAIL, 1));
    expect(step.stage).toBe("done");
    expect(account.isUnlocked).toBe(true);
  });

  it("retries after server errors and gives up on final ones", async () => {
    const { server, recoveryKey } = await registered();
    let process = await newAccount(server).startRecovery(EMAIL, recoveryKey);
    await process.prepare(NEW_PASSWORD);
    server.failures.set("/v1/auth/recover/finish", [
      { status: 503, code: "internal_error" },
    ]);
    await rejection(process.finish());
    expect(process.isDiscarded).toBe(false);
    expect((await process.finish()).stage).toBe("done");

    const { server: other, recoveryKey: key } = await registered();
    process = await newAccount(other).startRecovery(EMAIL, key);
    await process.prepare(NEW_PASSWORD);
    other.failures.set("/v1/auth/recover/finish", [
      { status: 422, code: "kdf_params_invalid" },
    ]);
    await rejection(process.finish());
    expect(process.isDiscarded).toBe(true);
  });

  it("ends with the recovery token, on lock and on discard", async () => {
    const { server, recoveryKey } = await registered();
    let now = 5_000_000;
    let account = newAccount(server, () => now);
    let process: RecoveryProcess = await account.startRecovery(
      EMAIL,
      recoveryKey,
    );
    expect(process.expiresAt).toBe(5_000_000 + 600_000);
    await process.prepare(NEW_PASSWORD);
    now += 600_000;
    const error = await rejection(process.finish());
    expect((error as AccountError).code).toBe("challenge_expired");
    expect(server.requests("/v1/auth/recover/finish")).toHaveLength(0);
    expect(process.isDiscarded).toBe(true);

    account = newAccount(server);
    process = await account.startRecovery(EMAIL, recoveryKey);
    account.lock();
    expect(process.isDiscarded).toBe(true);
    process = await account.startRecovery(EMAIL, recoveryKey);
    process.discard();
    expect(process.isDiscarded).toBe(true);
  });

  it("treats a wrong recovery-wrapped key as an integrity error", async () => {
    const { server, recoveryKey } = await registered();
    const user = server.userByEmail(EMAIL);
    const bytes = sodium().randombytes_buf(73);
    bytes[0] = 1;
    if (user) user.recovery.user_key_wrapped = toBase64Url(bytes);
    const error = await rejection(
      newAccount(server).startRecovery(EMAIL, recoveryKey),
    );
    expect((error as AccountError).code).toBe("integrity");
  });
});
