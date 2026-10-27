// Freshness attestations: canonical statements by which the devices of an
// account confirm the state of a vault or of the user data, signed with the
// account's signing key. Only the own account's attestations count.
import {
  bytesEqual,
  fromBase64Url,
  isJsonObject,
  toBase64Url,
  utf8Decode,
  utf8Encode,
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
import { isTimestamp } from "./time";
import { isUuid } from "./uuid";

/** Longest statement text the server accepts. */
export const FRESHNESS_STATEMENT_MAX_CHARS = 4096;

/** `seq` and object hash of a manifest root. */
export interface RootPoint {
  seq: number;
  hash: string;
}

export interface VaultFreshness {
  type: "vault_freshness";
  vaultId: string;
  userId: string;
  time: string;
  keyVersion: number;
  manifest: RootPoint | null;
  roles: RolePoint | null;
}

export interface UserDataFreshness {
  type: "user_data_freshness";
  userId: string;
  time: string;
  seq: number;
}

export type FreshnessStatement = VaultFreshness | UserDataFreshness;

/** An attestation as it travels through the API. */
export interface SignedFreshness {
  statement: string;
  signature: string;
}

function fail(reason: string): never {
  throw new CryptoError("validation", `Invalid freshness statement: ${reason}`);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    fromBase64Url(value, KEY_BYTES);
    return true;
  } catch {
    return false;
  }
}

function validPoint(point: { n: unknown; hash: unknown } | null): boolean {
  return point === null || (isCount(point.n) && isHash(point.hash));
}

function validate(statement: FreshnessStatement): void {
  if (!isUuid(statement.userId)) fail("user_id");
  if (!isTimestamp(statement.time)) fail("time");
  if (statement.type === "user_data_freshness") {
    if (!isCount(statement.seq)) fail("seq");
    return;
  }
  if (!isUuid(statement.vaultId)) fail("vault_id");
  if (!isCount(statement.keyVersion)) fail("key_version");
  const { manifest, roles } = statement;
  if (!validPoint(manifest && { n: manifest.seq, hash: manifest.hash }))
    fail("manifest");
  if (!validPoint(roles && { n: roles.version, hash: roles.hash }))
    fail("roles");
}

/**
 * The canonical bytes: ASCII JSON without whitespace in the fixed field
 * order. Every value is a UUID, Base64url, a timestamp or a safe integer,
 * so `JSON.stringify` writes no escapes.
 */
export function encodeFreshness(statement: FreshnessStatement): Uint8Array {
  validate(statement);
  if (statement.type === "user_data_freshness")
    return utf8Encode(
      JSON.stringify({
        v: 1,
        type: statement.type,
        user_id: statement.userId,
        time: statement.time,
        seq: statement.seq,
      }),
    );
  return utf8Encode(
    JSON.stringify({
      v: 1,
      type: statement.type,
      vault_id: statement.vaultId,
      user_id: statement.userId,
      time: statement.time,
      key_version: statement.keyVersion,
      manifest: statement.manifest && [
        statement.manifest.seq,
        statement.manifest.hash,
      ],
      roles: statement.roles && [statement.roles.version, statement.roles.hash],
    }),
  );
}

function pair(value: unknown, what: string): [unknown, unknown] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) fail(what);
  return [value[0], value[1]];
}

/**
 * Reads statement bytes: every field must be valid and the bytes must be
 * exactly the canonical form, which rules out duplicate keys, other field
 * orders, unknown fields and whitespace.
 */
export function decodeFreshness(bytes: Uint8Array): FreshnessStatement {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    fail("JSON");
  }
  if (!isJsonObject(value) || value.v !== 1) fail("v");
  let statement: FreshnessStatement;
  if (value.type === "user_data_freshness") {
    statement = {
      type: "user_data_freshness",
      userId: value.user_id,
      time: value.time,
      seq: value.seq,
    } as UserDataFreshness;
  } else if (value.type === "vault_freshness") {
    const manifest = pair(value.manifest, "manifest");
    const roles = pair(value.roles, "roles");
    statement = {
      type: "vault_freshness",
      vaultId: value.vault_id,
      userId: value.user_id,
      time: value.time,
      keyVersion: value.key_version,
      manifest: manifest && { seq: manifest[0], hash: manifest[1] },
      roles: roles && { version: roles[0], hash: roles[1] },
    } as VaultFreshness;
  } else {
    fail("type");
  }
  if (!bytesEqual(encodeFreshness(statement), bytes)) fail("not canonical");
  return statement;
}

/** Signs a statement with the account's secret signing key. */
export function signFreshness(
  statement: FreshnessStatement,
  secretKey: Uint8Array,
): SignedFreshness {
  const bytes = encodeFreshness(statement);
  return {
    statement: toBase64Url(bytes),
    signature: toBase64Url(sign(secretKey, SIGNATURE_CONTEXT.freshness, bytes)),
  };
}

/**
 * Strict reading of the wire form and check of the signature with the
 * given public signing key: `format`, `validation` or `auth` on failure.
 */
export function readFreshness(
  signed: unknown,
  signingKey: Uint8Array,
): FreshnessStatement {
  if (
    !isJsonObject(signed) ||
    typeof signed.statement !== "string" ||
    typeof signed.signature !== "string"
  )
    throw new CryptoError("format", "Invalid freshness attestation");
  if (signed.statement.length > FRESHNESS_STATEMENT_MAX_CHARS)
    throw new CryptoError("format", "Freshness statement too long");
  const bytes = fromBase64Url(signed.statement);
  const signature = fromBase64Url(signed.signature, SIGNATURE_BYTES);
  const statement = decodeFreshness(bytes);
  verifySignature(signingKey, SIGNATURE_CONTEXT.freshness, bytes, signature);
  return statement;
}
