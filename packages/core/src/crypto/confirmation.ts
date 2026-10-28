// Confirmation by another device of the account: the requesting device asks
// with a random nonce, and an unlocked device answers with its high-water
// marks in a statement bound to that nonce and signed with the account's
// signing key. Only the own key and the own nonce are trusted.
import {
  bytesEqual,
  decodeJsonObject,
  fromBase64Url,
  isJsonObject,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type JsonObject,
} from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import type { RolePoint } from "./roles";
import {
  sign,
  SIGNATURE_BYTES,
  SIGNATURE_CONTEXT,
  verifySignature,
} from "./signing";
import type { StateCode } from "./state-code";
import { isTimestamp } from "./time";
import { isUuid } from "./uuid";

export const CONFIRMATION_NONCE_BYTES = 32;
/** Longest statement, in bytes. */
export const CONFIRMATION_STATEMENT_MAX_BYTES = 1 << 20;
/** Longest statement text: 1 MiB as Base64url. */
const STATEMENT_MAX_CHARS = Math.ceil(
  (CONFIRMATION_STATEMENT_MAX_BYTES * 4) / 3,
);
/** Most vaults one answer carries; without points they always fit. */
export const CONFIRMATION_MAX_VAULTS = 3000;
/** Most comparison points per vault, as in the user data. */
const POINTS_MAX = 16;
const STATE_CODE = /^[A-Z2-7]{25}[AEIMQUY4]$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** High-water marks of one vault, as the confirming device holds them. */
export interface ConfirmationVault {
  vaultId: string;
  rev: number;
  kv: number | null;
  mf: number | null;
  rl: RolePoint | null;
  /** Comparison points of the state code that restrict this vault. */
  cp: readonly StateCode[];
  /** Confirmation time it passes on; `null` when it would not sign. */
  at: string | null;
}

export interface ConfirmationContent {
  userData: { rev: number; seq: number; at: string | null } | null;
  vaults: readonly ConfirmationVault[];
}

/** The signed statement; `content` is Base64url of the content JSON. */
export interface ConfirmationStatement {
  userId: string;
  nonce: string;
  time: string;
  content: string;
}

/** An answer as it travels through the API. */
export interface SignedConfirmation {
  statement: string;
  signature: string;
}

function fail(what: string, reason: string): never {
  throw new CryptoError(
    "validation",
    `Invalid confirmation ${what}: ${reason}`,
  );
}

function content(reason: string): never {
  fail("content", reason);
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

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isBase64Url(value: unknown, length?: number): value is string {
  if (typeof value !== "string") return false;
  try {
    fromBase64Url(value, length);
    return true;
  } catch {
    return false;
  }
}

function rolePoint(value: unknown): RolePoint | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) content("rl");
  const [version, hash] = value as unknown[];
  if (!isCount(version) || !isBase64Url(hash, KEY_BYTES)) content("rl");
  return { version, hash };
}

function points(value: unknown): StateCode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > POINTS_MAX) content("cp");
  return value.map((point: unknown): StateCode => {
    if (!Array.isArray(point) || point.length !== 2) content("cp");
    const [version, code] = point as unknown[];
    if (!isCount(version) || typeof code !== "string" || !STATE_CODE.test(code))
      content("cp");
    return { version, code };
  });
}

/** Checks parsed content; every deviation rejects the whole. */
export function validateConfirmationContent(
  value: JsonObject,
): ConfirmationContent {
  if (value.schema !== 1) content("schema");
  if (!has(value, "user_data")) content("user_data");
  let userData: ConfirmationContent["userData"] = null;
  if (value.user_data !== null) {
    const ud = value.user_data;
    if (
      !isJsonObject(ud) ||
      !isCount(ud.rev) ||
      !isCount(ud.seq) ||
      !has(ud, "at") ||
      !isOptionalTime(ud.at)
    )
      content("user_data");
    userData = { rev: ud.rev, seq: ud.seq, at: ud.at };
  }
  if (!isJsonObject(value.vaults)) content("vaults");
  const ids = Object.keys(value.vaults);
  if (ids.length > CONFIRMATION_MAX_VAULTS) content("too many vaults");
  const vaults = ids.map((vaultId): ConfirmationVault => {
    const v = (value.vaults as JsonObject)[vaultId];
    if (!isUuid(vaultId) || !isJsonObject(v)) content("vault");
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
      content("vault");
    return {
      vaultId,
      rev: v.rev,
      kv: v.kv,
      mf: v.mf,
      rl: rolePoint(v.rl),
      cp: points(v.cp),
      at: v.at,
    };
  });
  return { userData, vaults };
}

/** The content as UTF-8 JSON; `cp` only where there are points. */
export function encodeConfirmationContent(
  value: ConfirmationContent,
): Uint8Array {
  const vaults: JsonObject = {};
  for (const v of value.vaults) {
    const vault: JsonObject = {
      rev: v.rev,
      kv: v.kv,
      mf: v.mf,
      rl: v.rl && [v.rl.version, v.rl.hash],
    };
    if (v.cp.length > 0) vault.cp = v.cp.map((p) => [p.version, p.code]);
    vault.at = v.at;
    vaults[v.vaultId] = vault;
  }
  const json: JsonObject = {
    schema: 1,
    user_data: value.userData && {
      rev: value.userData.rev,
      seq: value.userData.seq,
      at: value.userData.at,
    },
    vaults,
  };
  const bytes = utf8Encode(JSON.stringify(json));
  validateConfirmationContent(decodeJsonObject(bytes));
  return bytes;
}

function validate(statement: ConfirmationStatement): void {
  if (!isUuid(statement.userId)) fail("statement", "user_id");
  if (!isBase64Url(statement.nonce, CONFIRMATION_NONCE_BYTES))
    fail("statement", "nonce");
  if (!isTimestamp(statement.time)) fail("statement", "time");
  if (!BASE64URL.test(statement.content) || !isBase64Url(statement.content))
    fail("statement", "content");
}

/**
 * The canonical bytes: ASCII JSON without whitespace in the fixed field
 * order. Every value is a UUID, Base64url or a timestamp, so
 * `JSON.stringify` writes no escapes.
 */
export function encodeConfirmation(
  statement: ConfirmationStatement,
): Uint8Array {
  validate(statement);
  return utf8Encode(
    JSON.stringify({
      v: 1,
      type: "device_confirmation",
      user_id: statement.userId,
      nonce: statement.nonce,
      time: statement.time,
      content: statement.content,
    }),
  );
}

/**
 * Reads statement bytes: every field must be valid and the bytes exactly
 * the canonical form, which rules out duplicate keys, other field orders,
 * unknown fields and whitespace.
 */
export function decodeConfirmation(bytes: Uint8Array): ConfirmationStatement {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    fail("statement", "JSON");
  }
  if (!isJsonObject(value) || value.v !== 1) fail("statement", "v");
  if (value.type !== "device_confirmation") fail("statement", "type");
  const statement = {
    userId: value.user_id,
    nonce: value.nonce,
    time: value.time,
    content: value.content,
  } as ConfirmationStatement;
  if (!bytesEqual(encodeConfirmation(statement), bytes))
    fail("statement", "not canonical");
  return statement;
}

/**
 * Signs the answer with the account's secret signing key; `validation`
 * when the statement would exceed 1 MiB.
 */
export function signConfirmation(
  answer: {
    userId: string;
    nonce: string;
    time: string;
    content: ConfirmationContent;
  },
  secretKey: Uint8Array,
): SignedConfirmation {
  const bytes = encodeConfirmation({
    userId: answer.userId,
    nonce: answer.nonce,
    time: answer.time,
    content: toBase64Url(encodeConfirmationContent(answer.content)),
  });
  if (bytes.length > CONFIRMATION_STATEMENT_MAX_BYTES)
    fail("statement", "too large");
  return {
    statement: toBase64Url(bytes),
    signature: toBase64Url(
      sign(secretKey, SIGNATURE_CONTEXT.confirmation, bytes),
    ),
  };
}

/**
 * Strict reading of an answer: wire form (`format`), statement
 * (`validation`), signature with the given own signing key (`auth`), then
 * account and nonce against the expected values only (`validation`) and
 * the content (`encoding` or `validation`).
 */
export function readConfirmation(
  signed: unknown,
  signingKey: Uint8Array,
  expected: { userId: string; nonce: string },
): { time: string; content: ConfirmationContent } {
  if (
    !isJsonObject(signed) ||
    typeof signed.statement !== "string" ||
    typeof signed.signature !== "string"
  )
    throw new CryptoError("format", "Invalid confirmation answer");
  if (signed.statement.length > STATEMENT_MAX_CHARS)
    throw new CryptoError("format", "Confirmation statement too long");
  const bytes = fromBase64Url(signed.statement);
  const signature = fromBase64Url(signed.signature, SIGNATURE_BYTES);
  const statement = decodeConfirmation(bytes);
  verifySignature(signingKey, SIGNATURE_CONTEXT.confirmation, bytes, signature);
  if (statement.userId !== expected.userId) fail("statement", "user_id");
  if (statement.nonce !== expected.nonce) fail("statement", "nonce");
  const json = decodeJsonObject(fromBase64Url(statement.content));
  return {
    time: statement.time,
    content: validateConfirmationContent(json),
  };
}
