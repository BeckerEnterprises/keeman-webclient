// Pairing of two devices of an account: a short code carries a one-time
// secret, and the high-water marks of the giving device travel through the
// server in an envelope sealed with a key derived from it.
import { aad } from "./aad";
import { fromBase32, toBase32 } from "./base32";
import {
  concatBytes,
  fromBase64Url,
  isJsonObject,
  utf8Encode,
  wipe,
  type JsonObject,
} from "./bytes";
import { openJson, sealJson } from "./envelope";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import type { Randomness } from "./random";
import type { RolePoint } from "./roles";
import { sodium } from "./sodium";
import { isTimestamp } from "./time";
import { isUuid } from "./uuid";

export const PAIRING_SECRET_BYTES = 15;
const CODE_CHARS = 24;
const IGNORED = /[ \t\r\n-]/g;
/** Most vaults one pairing carries. */
export const PAIRING_MAX_VAULTS = 10_000;

/** High-water marks of one vault, as the giving device holds them. */
export interface PairingVault {
  vaultId: string;
  rev: number;
  kv: number | null;
  mf: number | null;
  rl: RolePoint | null;
  /** Last confirmation of the vault by the giving device; `null` = never. */
  at: string | null;
}

export interface PairingContent {
  /** The period the giving device last confirmed. */
  fd: number | null;
  userData: { rev: number; seq: number; at: string | null } | null;
  vaults: readonly PairingVault[];
}

export function generatePairingSecret(randomness: Randomness): Uint8Array {
  return randomness.bytes("pairing_secret", PAIRING_SECRET_BYTES);
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length !== PAIRING_SECRET_BYTES)
    throw new CryptoError("validation", "Pairing secret must be 15 bytes");
}

/** 24 Base32 characters in 6 groups of 4. */
export function formatPairingCode(secret: Uint8Array): string {
  assertSecret(secret);
  return toBase32(secret).match(/.{4}/g)?.join(" ") ?? "";
}

/**
 * Parses user input: a–z count as A–Z; spaces, tabs, line breaks and
 * hyphens are ignored. There are no check characters; a typo shows when
 * the envelope does not open.
 */
export function parsePairingCode(input: string): Uint8Array {
  const text = input
    .replace(IGNORED, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
  if (!/^[A-Z2-7]*$/.test(text) || text.length !== CODE_CHARS)
    throw new CryptoError(
      "validation",
      "Pairing code has invalid characters or length",
    );
  return fromBase32(text);
}

/** BLAKE2b-256("keeman:v1:pairing-key" ‖ 0x00 ‖ P). */
export function pairingKey(secret: Uint8Array): Uint8Array {
  assertSecret(secret);
  return sodium().crypto_generichash(
    KEY_BYTES,
    concatBytes(
      utf8Encode("keeman:v1:pairing-key"),
      Uint8Array.of(0x00),
      secret,
    ),
    null,
  );
}

function fail(reason: string): never {
  throw new CryptoError("validation", `Invalid pairing content: ${reason}`);
}

function isCount(value: unknown, min = 1): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= min
  );
}

function isOptionalCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isOptionalTime(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function rolePoint(value: unknown): RolePoint | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) fail("rl");
  const [version, hash] = value as unknown[];
  if (!isCount(version) || typeof hash !== "string") fail("rl");
  try {
    fromBase64Url(hash, KEY_BYTES);
  } catch {
    fail("rl");
  }
  return { version, hash };
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Checks the decrypted content; every deviation rejects the whole. */
export function validatePairingContent(value: JsonObject): PairingContent {
  if (value.schema !== 1) fail("schema");
  if (!has(value, "fd") || !(value.fd === null || isCount(value.fd)))
    fail("fd");
  const fd = value.fd;
  if (fd !== null && fd > 90) fail("fd");
  if (!has(value, "user_data")) fail("user_data");
  let userData: PairingContent["userData"] = null;
  if (value.user_data !== null) {
    const ud = value.user_data;
    if (
      !isJsonObject(ud) ||
      !isCount(ud.rev) ||
      !isCount(ud.seq) ||
      !has(ud, "at") ||
      !isOptionalTime(ud.at)
    )
      fail("user_data");
    userData = { rev: ud.rev, seq: ud.seq, at: ud.at };
  }
  if (!isJsonObject(value.vaults)) fail("vaults");
  const ids = Object.keys(value.vaults);
  if (ids.length > PAIRING_MAX_VAULTS) fail("too many vaults");
  const vaults = ids.map((vaultId): PairingVault => {
    const v = (value.vaults as JsonObject)[vaultId];
    if (!isUuid(vaultId) || !isJsonObject(v)) fail("vault");
    if (
      !isCount(v.rev, 0) ||
      !has(v, "kv") ||
      !isOptionalCount(v.kv) ||
      !has(v, "mf") ||
      !isOptionalCount(v.mf) ||
      !has(v, "rl") ||
      !has(v, "at") ||
      !isOptionalTime(v.at)
    )
      fail("vault");
    return {
      vaultId,
      rev: v.rev,
      kv: v.kv,
      mf: v.mf,
      rl: rolePoint(v.rl),
      at: v.at,
    };
  });
  return { fd, userData, vaults };
}

function encodeContent(content: PairingContent): JsonObject {
  const vaults: JsonObject = {};
  for (const v of content.vaults)
    vaults[v.vaultId] = {
      rev: v.rev,
      kv: v.kv,
      mf: v.mf,
      rl: v.rl && [v.rl.version, v.rl.hash],
      at: v.at,
    };
  const json: JsonObject = {
    schema: 1,
    fd: content.fd,
    user_data: content.userData && {
      rev: content.userData.rev,
      seq: content.userData.seq,
      at: content.userData.at,
    },
    vaults,
  };
  validatePairingContent(JSON.parse(JSON.stringify(json)) as JsonObject);
  return json;
}

/** Seals the content for the own account; the derived key is wiped. */
export function sealPairing(
  randomness: Randomness,
  secret: Uint8Array,
  userId: string,
  content: PairingContent,
): string {
  const json = encodeContent(content);
  const key = pairingKey(secret);
  try {
    return sealJson(randomness, key, json, aad.pairing(userId));
  } finally {
    wipe(key);
  }
}

/**
 * Opens an envelope with the code's secret and the own user ID: `auth`
 * for a wrong code or another account, `validation` for bad content.
 */
export function openPairing(
  secret: Uint8Array,
  userId: string,
  envelope: string,
): PairingContent {
  const key = pairingKey(secret);
  try {
    return validatePairingContent(openJson(key, envelope, aad.pairing(userId)));
  } finally {
    wipe(key);
  }
}
