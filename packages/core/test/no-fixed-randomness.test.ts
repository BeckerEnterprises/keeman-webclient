// No exported function may take a caller-supplied nonce, header, seed
// or random source, and nothing from crypto/internal may leave the package.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { aad } from "../src/crypto/aad";
import * as workerEntry from "../src/crypto/argon2-worker";
import { sealVaultKeyBox } from "../src/crypto/box";
import { sealKey } from "../src/crypto/envelope";
import { generateKeyPair } from "../src/crypto/keypair";
import { systemRandomness } from "../src/crypto/random";
import { encryptBlob } from "../src/crypto/secretstream";
import * as entry from "../src/index";
import * as kdbxWorkerEntry from "../src/kdbx/file/worker";
import { CREATED, IDS, tv } from "./helpers";

const FORBIDDEN_NAME =
  /nonce|header|seed|rng|random|scripted|deterministic|fixed|unsafe|tv$|mod251|raw/i;

async function internalExports(): Promise<Set<unknown>> {
  const dir = new URL("../src/crypto/internal/", import.meta.url);
  const values = new Set<unknown>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const module = (await import(new URL(file, dir).href)) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module)) values.add(value);
  }
  return values;
}

function reachable(
  value: unknown,
  depth = 3,
  seen = new Set<unknown>(),
): unknown[] {
  if (
    depth === 0 ||
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  ) {
    return [];
  }
  seen.add(value);
  const own = Object.getOwnPropertyNames(value).flatMap((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && "value" in descriptor
      ? [descriptor.value as unknown]
      : [];
  });
  const prototype =
    typeof value === "function"
      ? (value as { prototype?: unknown }).prototype
      : undefined;
  return [
    value,
    ...[...own, prototype].flatMap((child) =>
      reachable(child, depth - 1, seen),
    ),
  ];
}

describe("package exports", () => {
  it("exports only the allow-listed names and subpaths", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([
      ".",
      "./argon2-worker",
      "./kdbx-worker",
    ]);
    expect(Object.keys(entry).sort()).toEqual([
      "API_VERSION",
      "Account",
      "AccountError",
      "ApiClient",
      "ApiError",
      "BUILTIN_ICONS",
      "CLOCK_SKEW_HINT_MS",
      "CryptoError",
      "DEFAULT_ICONS",
      "DEFAULT_KDF_PARAMS",
      "FORBIDDEN_SCHEMES",
      "GENERATOR_DEFAULTS",
      "GENERATOR_LIMITS",
      "ICON_SIZE",
      "KDBX_LIMITS",
      "KDF_LIMITS",
      "KdbxError",
      "LANGUAGES",
      "MAX_ATTACHMENTS",
      "NetworkError",
      "SETTING_DEFAULTS",
      "SyncError",
      "TOTP_DEFAULTS",
      "TOTP_LIMITS",
      "buildTotpUri",
      "checkScheme",
      "decodeTotpSecret",
      "emptyDraft",
      "faviconIconName",
      "faviconTarget",
      "generateSecret",
      "initCrypto",
      "isUrlSchemeList",
      "kdbxFileName",
      "matchesRecoveryKeyGroup",
      "parseOtpUri",
      "readKdbxInWorker",
      "secretBits",
      "storedSyncMarks",
      "totpFromUri",
      "uploadIconName",
      "validateEntryDraft",
      "verifyKdbxExport",
      "writeKdbxInWorker",
    ]);
    expect(Object.keys(workerEntry).sort()).toEqual([
      "ARGON2_MESSAGE_KIND",
      "deriveLoginKeysInWorker",
      "handleArgon2Message",
    ]);
    expect(Object.keys(kdbxWorkerEntry)).toEqual(["handleKdbxMessage"]);
  });

  it("exposes nothing from crypto/internal and no name hinting at injected randomness", async () => {
    const internal = await internalExports();
    expect(internal.size).toBeGreaterThan(0);
    for (const module of [entry, workerEntry, kdbxWorkerEntry]) {
      for (const [name, value] of Object.entries(module)) {
        expect(name).not.toMatch(FORBIDDEN_NAME);
        for (const item of reachable(value))
          expect(internal.has(item), `${name} reaches crypto/internal`).toBe(
            false,
          );
      }
    }
  });

  it("uses a fresh nonce or header for every encryption", () => {
    const key = tv("k2-key", 32);
    const raw = tv("k2-raw", 32);
    expect(sealKey(systemRandomness, key, raw, aad.userKey(IDS.user))).not.toBe(
      sealKey(systemRandomness, key, raw, aad.userKey(IDS.user)),
    );
    const alice = generateKeyPair(systemRandomness);
    const bob = generateKeyPair(systemRandomness);
    const message = {
      vaultId: IDS.vault,
      keyVersion: 1,
      vaultKey: key,
      senderId: IDS.user,
      recipientId: IDS.other,
      vaultName: "x",
      created: CREATED,
    };
    expect(
      sealVaultKeyBox(
        systemRandomness,
        alice.privateKey,
        bob.publicKey,
        message,
      ),
    ).not.toBe(
      sealVaultKeyBox(
        systemRandomness,
        alice.privateKey,
        bob.publicKey,
        message,
      ),
    );
    expect(encryptBlob(key, IDS.attachment, raw)).not.toEqual(
      encryptBlob(key, IDS.attachment, raw),
    );
  });
});
