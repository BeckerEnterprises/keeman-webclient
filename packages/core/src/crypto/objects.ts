import { aad, type ObjectType } from "./aad";
import { decodeJsonObject, type JsonObject } from "./bytes";
import { openBytes, openJson, sealBytes, sealJson } from "./envelope";
import { CryptoError } from "./errors";
import type { Randomness } from "./random";
import { isTimestamp } from "./time";
import { assertUuid, isUuid } from "./uuid";

/** Identifies an encrypted object and its key version (AAD). */
export interface ObjectRef {
  vaultId: string;
  objectId: string;
  type: ObjectType;
  keyVersion: number;
}

function objectAad(ref: ObjectRef): string {
  return aad.object(ref.vaultId, ref.objectId, ref.type, ref.keyVersion);
}

export function encryptObject(
  randomness: Randomness,
  vaultKey: Uint8Array,
  ref: ObjectRef,
  content: JsonObject,
): string {
  return sealJson(randomness, vaultKey, content, objectAad(ref));
}

export function decryptObject(
  vaultKey: Uint8Array,
  ref: ObjectRef,
  data: string,
): JsonObject {
  return openJson(vaultKey, data, objectAad(ref));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Re-encrypts an object for a key rotation: the exact decrypted
 * bytes are padded again, so `seq`, unknown fields and content of newer
 * clients stay untouched. Validation is limited to an integer `schema` and `seq`.
 */
export function reencryptObject(
  randomness: Randomness,
  oldKey: Uint8Array,
  ref: ObjectRef,
  newKey: Uint8Array,
  newKeyVersion: number,
  data: string,
): string {
  const plaintext = openBytes(oldKey, data, objectAad(ref));
  const content = decodeJsonObject(plaintext);
  if (
    !Number.isSafeInteger(content.schema) ||
    !isPositiveInteger(content.seq)
  ) {
    throw new CryptoError("validation", "Object needs integer schema and seq");
  }
  return sealBytes(
    randomness,
    newKey,
    plaintext,
    objectAad({ ...ref, keyVersion: newKeyVersion }),
  );
}

export interface Tombstone {
  schema: 1;
  deleted: true;
  seq: number;
  deletedAt: string;
  deletedBy: string;
  /** Drop tombstone of a key rotation. */
  dropped?: true;
}

/** `seq` of a drop tombstone: the largest safe integer. */
export const DROPPED_SEQ = Number.MAX_SAFE_INTEGER;

/** Encrypted tombstone, same AAD as the object. */
export function encryptTombstone(
  randomness: Randomness,
  vaultKey: Uint8Array,
  ref: ObjectRef,
  tombstone: Omit<Tombstone, "schema" | "deleted">,
): string {
  if (!isPositiveInteger(tombstone.seq))
    throw new CryptoError("validation", "Invalid seq");
  if (!isTimestamp(tombstone.deletedAt))
    throw new CryptoError("validation", "Invalid deletedAt");
  assertUuid(tombstone.deletedBy, "deletedBy");
  const content: Tombstone = {
    schema: 1,
    deleted: true,
    seq: tombstone.seq,
    deletedAt: tombstone.deletedAt,
    deletedBy: tombstone.deletedBy,
    ...(tombstone.dropped ? { dropped: true } : {}),
  };
  return sealJson(randomness, vaultKey, { ...content }, objectAad(ref));
}

export type DecryptedChange =
  | { deleted: false; content: JsonObject }
  | { deleted: true; tombstone: Tombstone };

/**
 * Decrypts an object from `changes` and checks that the server's `deleted`
 * flag matches the content.
 */
export function decryptChange(
  vaultKey: Uint8Array,
  ref: ObjectRef,
  data: string,
  deleted: boolean,
): DecryptedChange {
  const content = decryptObject(vaultKey, ref, data);
  const isTombstone = content.deleted === true;
  if (isTombstone !== deleted)
    throw new CryptoError(
      "validation",
      "Deleted flag does not match the content",
    );
  if (!isTombstone) return { deleted: false, content };
  const { schema, seq, deletedAt, deletedBy, dropped } = content;
  if (
    !Number.isSafeInteger(schema) ||
    !isPositiveInteger(seq) ||
    !isTimestamp(deletedAt) ||
    !isUuid(deletedBy)
  ) {
    throw new CryptoError("validation", "Invalid tombstone");
  }
  return {
    deleted: true,
    tombstone: {
      schema: 1,
      deleted: true,
      seq,
      deletedAt,
      deletedBy,
      ...(dropped === true ? { dropped: true } : {}),
    },
  };
}

export function encryptUserData(
  randomness: Randomness,
  userKey: Uint8Array,
  userId: string,
  content: JsonObject,
): string {
  return sealJson(randomness, userKey, content, aad.userData(userId));
}

export function decryptUserData(
  userKey: Uint8Array,
  userId: string,
  data: string,
): JsonObject {
  return openJson(userKey, data, aad.userData(userId));
}
