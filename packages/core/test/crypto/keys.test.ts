import { describe, expect, it } from "vitest";
import { aad, isObjectType } from "../../src/crypto/aad";
import {
  DEFAULT_KDF_PARAMS,
  deriveLoginKeys,
  deriveMasterKey,
  isWeakerThan,
  validateKdfParams,
} from "../../src/crypto/argon2";
import { toBase64Url, toHex, utf8Encode } from "../../src/crypto/bytes";
import {
  fingerprint,
  fingerprintHex,
  formatFingerprint,
} from "../../src/crypto/fingerprint";
import {
  deriveAccountKeys,
  derivePrfWrapKey,
  deriveRecoveryKeys,
  deriveSubkey,
  KDF_CONTEXT,
  prfEvalFirst,
} from "../../src/crypto/kdf";
import {
  derivePublicKey,
  generateKeyPair,
  verifyOwnPublicKey,
} from "../../src/crypto/keypair";
import {
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
} from "../../src/crypto/recovery-key";
import { systemRandomness } from "../../src/crypto/random";
import {
  expectCryptoError,
  IDS,
  labelRandomness,
  MIN_KDF,
  tv,
} from "../helpers";

describe("KDF subkeys", () => {
  const key = tv("kdf-key", 32);

  it("derives distinct keys per context and ID", () => {
    const account = deriveAccountKeys(key);
    const recovery = deriveRecoveryKeys(key);
    const all = [
      account.authKey,
      account.wrapKey,
      recovery.recoveryAuthKey,
      recovery.recoveryWrapKey,
      derivePrfWrapKey(key),
    ];
    expect(new Set(all.map(toHex)).size).toBe(5);
    expect(deriveSubkey(key, 1, KDF_CONTEXT.account)).toEqual(account.authKey);
    expect(deriveSubkey(key, 258, KDF_CONTEXT.account)).toHaveLength(32);
  });

  it("validates key, context and ID", () => {
    expectCryptoError(
      () => deriveSubkey(new Uint8Array(31), 1, "keeman01"),
      "validation",
    );
    expectCryptoError(() => deriveSubkey(key, 1, "keeman1"), "validation");
    expectCryptoError(() => deriveSubkey(key, -1, "keeman01"), "validation");
    expectCryptoError(() => deriveSubkey(key, 1.5, "keeman01"), "validation");
  });

  it("has a fixed PRF input", () => {
    expect(prfEvalFirst()).toEqual(prfEvalFirst());
    expect(prfEvalFirst()).toHaveLength(32);
  });
});

describe("Argon2id parameters", () => {
  it("accepts the range inclusively and drops unknown fields", () => {
    expect(validateKdfParams({ ...MIN_KDF, extra: true })).toEqual(MIN_KDF);
    expect(
      validateKdfParams({ alg: "argon2id13", ops: 10, mem: 1_073_741_824 }),
    ).toEqual({
      alg: "argon2id13",
      ops: 10,
      mem: 1_073_741_824,
    });
    expect(validateKdfParams(DEFAULT_KDF_PARAMS)).toEqual(DEFAULT_KDF_PARAMS);
  });

  it.each([
    null,
    [],
    { alg: "argon2i13", ops: 3, mem: 67_108_864 },
    { alg: "argon2id13", ops: 1, mem: 67_108_864 },
    { alg: "argon2id13", ops: 11, mem: 67_108_864 },
    { alg: "argon2id13", ops: 2.5, mem: 67_108_864 },
    { alg: "argon2id13", ops: "3", mem: 67_108_864 },
    { alg: "argon2id13", ops: 3, mem: 19_922_943 },
    { alg: "argon2id13", ops: 3, mem: 1_073_742_848 },
    { alg: "argon2id13", ops: 3, mem: 67_108_865 },
    { alg: "argon2id13", ops: 3 },
  ])("rejects %j", (params) => {
    expectCryptoError(() => validateKdfParams(params), "validation");
  });

  it("detects weaker parameters", () => {
    expect(isWeakerThan(MIN_KDF, DEFAULT_KDF_PARAMS)).toBe(true);
    expect(
      isWeakerThan(
        { ...DEFAULT_KDF_PARAMS, ops: 4, mem: 19_922_944 },
        DEFAULT_KDF_PARAMS,
      ),
    ).toBe(true);
    expect(isWeakerThan(DEFAULT_KDF_PARAMS, MIN_KDF)).toBe(false);
  });
});

describe("Argon2id derivation", () => {
  const salt = tv("salt", 16);

  it("gives NFC and NFD passwords the same keys", () => {
    const nfc = deriveLoginKeys("Grüße", salt, MIN_KDF);
    const nfd = deriveLoginKeys("Grüße", salt, MIN_KDF);
    expect(nfd).toEqual(nfc);
    expect(deriveLoginKeys(" Grüße", salt, MIN_KDF).authKey).not.toEqual(
      nfc.authKey,
    );
  });

  it("validates salt and parameters", () => {
    expectCryptoError(
      () => deriveMasterKey(utf8Encode("pw"), new Uint8Array(15), MIN_KDF),
      "validation",
    );
    expectCryptoError(
      () => deriveMasterKey(utf8Encode("pw"), salt, { ...MIN_KDF, ops: 1 }),
      "validation",
    );
    expectCryptoError(
      () => deriveLoginKeys("pw\uD800", salt, MIN_KDF),
      "validation",
    );
  });
});

describe("AAD", () => {
  it("builds every row", () => {
    expect(aad.userKey(IDS.user)).toBe(`keeman:v1:user-key:${IDS.user}`);
    expect(aad.recovery(IDS.user)).toBe(`keeman:v1:recovery:${IDS.user}`);
    expect(aad.prf(IDS.user, "AQID")).toBe(`keeman:v1:prf:${IDS.user}:AQID`);
    expect(aad.privateKey(IDS.user)).toBe(`keeman:v1:private-key:${IDS.user}`);
    expect(aad.userData(IDS.user)).toBe(`keeman:v1:user-data:${IDS.user}`);
    expect(aad.vaultKey(IDS.vault, IDS.user, 3)).toBe(
      `keeman:v1:vault-key:${IDS.vault}:${IDS.user}:3`,
    );
    expect(aad.object(IDS.vault, IDS.object, "entry", 12)).toBe(
      `keeman:v1:object:${IDS.vault}:${IDS.object}:entry:12`,
    );
    expect(aad.attachment(IDS.attachment)).toBe(
      `keeman:v1:attachment:${IDS.attachment}`,
    );
  });

  it("rejects invalid inputs", () => {
    expectCryptoError(() => aad.userKey(IDS.user.toUpperCase()), "validation");
    expectCryptoError(() => aad.vaultKey(IDS.vault, IDS.user, 0), "validation");
    expectCryptoError(
      () => aad.vaultKey(IDS.vault, IDS.user, 1.5),
      "validation",
    );
    expectCryptoError(
      () => aad.object(IDS.vault, IDS.object, "note", 1),
      "validation",
    );
    expectCryptoError(() => aad.prf(IDS.user, "AQI="), "validation");
    expectCryptoError(() => aad.prf(IDS.user, ""), "validation");
    expect(isObjectType("icon")).toBe(true);
    expect(isObjectType(1)).toBe(false);
  });
});

describe("key pairs and fingerprints", () => {
  it("derives pk' and checks the server's public key", () => {
    const { privateKey, publicKey } = generateKeyPair(labelRandomness());
    expect(derivePublicKey(privateKey)).toEqual(publicKey);
    expect(verifyOwnPublicKey(privateKey, toBase64Url(publicKey))).toEqual(
      publicKey,
    );
    const other = generateKeyPair(systemRandomness).publicKey;
    expectCryptoError(
      () => verifyOwnPublicKey(privateKey, toBase64Url(other)),
      "integrity",
    );
    const highBit = publicKey.slice();
    highBit[31] = (highBit[31] ?? 0) | 0x80;
    expectCryptoError(
      () => verifyOwnPublicKey(privateKey, toBase64Url(highBit)),
      "integrity",
    );
    expectCryptoError(() => verifyOwnPublicKey(privateKey, "AA"), "integrity");
    expectCryptoError(() => derivePublicKey(new Uint8Array(31)), "validation");
  });

  it("formats fingerprints", () => {
    const publicKey = tv("fingerprint-pk", 32);
    const hex = fingerprintHex(publicKey);
    expect(hex).toMatch(/^[0-9A-F]{64}$/);
    expect(toHex(fingerprint(publicKey)).toUpperCase()).toBe(hex);
    expect(formatFingerprint(hex)).toBe(
      hex.slice(0, 40).match(/.{4}/g)?.join(" "),
    );
    expectCryptoError(() => formatFingerprint(hex.toLowerCase()), "validation");
    expectCryptoError(() => fingerprint(new Uint8Array(1)), "validation");
  });
});

describe("recovery key", () => {
  it("formats with checksum and parses user input", () => {
    const rk = generateRecoveryKey(labelRandomness());
    const display = formatRecoveryKey(rk);
    expect(display).toMatch(/^([A-Z2-7]{4} ){13}[A-Z2-7]{4}$/);
    expect(parseRecoveryKey(display)).toEqual(rk);
    expect(
      parseRecoveryKey(display.toLowerCase().replaceAll(" ", "-")),
    ).toEqual(rk);
    expect(parseRecoveryKey(display.replaceAll(" ", "\n\t"))).toEqual(rk);
    expect(display.charAt(51 + 12)).toMatch(/[AQ]/);
  });

  it("rejects typos, wrong lengths and non-canonical keys", () => {
    const display = formatRecoveryKey(tv("rk", 32));
    const typo = (display.startsWith("A") ? "B" : "A") + display.slice(1);
    expectCryptoError(() => parseRecoveryKey(typo), "validation");
    expectCryptoError(
      () => parseRecoveryKey(display.slice(0, -1)),
      "validation",
    );
    expectCryptoError(
      () => parseRecoveryKey(display.replace(/^./, "1")),
      "validation",
    );
    expectCryptoError(
      () => parseRecoveryKey(display.replace(/^./, "ſ")),
      "validation",
    );
    const compact = display.replaceAll(" ", "");
    const nonCanonical = `${compact.slice(0, 51)}${compact.charAt(51) === "A" ? "B" : "R"}${compact.slice(52)}`;
    expectCryptoError(() => parseRecoveryKey(nonCanonical), "validation");
    expectCryptoError(
      () => formatRecoveryKey(new Uint8Array(31)),
      "validation",
    );
  });
});
