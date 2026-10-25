import { fromBase64Url } from "./bytes";
import { CryptoError } from "./errors";
import { assertUuid } from "./uuid";

export const OBJECT_TYPES = ["vault_meta", "group", "entry", "icon"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export function isObjectType(value: unknown): value is ObjectType {
  return (
    typeof value === "string" &&
    (OBJECT_TYPES as readonly string[]).includes(value)
  );
}

function id(value: string, what: string): string {
  assertUuid(value, what);
  return value;
}

function keyVersion(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new CryptoError("validation", "Invalid key version");
  return String(value);
}

function objectType(value: string): string {
  if (!isObjectType(value))
    throw new CryptoError("validation", "Invalid object type");
  return value;
}

function credentialId(value: string): string {
  if (value.length === 0)
    throw new CryptoError("validation", "Invalid credential ID");
  try {
    fromBase64Url(value);
  } catch {
    throw new CryptoError("validation", "Invalid credential ID");
  }
  return value;
}

/** Associated data strings. Builders throw `validation` on bad input. */
export const aad = {
  userKey: (userId: string) => `keeman:v1:user-key:${id(userId, "user_id")}`,
  recovery: (userId: string) => `keeman:v1:recovery:${id(userId, "user_id")}`,
  prf: (userId: string, credentialIdB64: string) =>
    `keeman:v1:prf:${id(userId, "user_id")}:${credentialId(credentialIdB64)}`,
  privateKey: (userId: string) =>
    `keeman:v1:private-key:${id(userId, "user_id")}`,
  userData: (userId: string) => `keeman:v1:user-data:${id(userId, "user_id")}`,
  vaultKey: (vaultId: string, userId: string, version: number) =>
    `keeman:v1:vault-key:${id(vaultId, "vault_id")}:${id(userId, "user_id")}:${keyVersion(version)}`,
  object: (vaultId: string, objectId: string, type: string, version: number) =>
    `keeman:v1:object:${id(vaultId, "vault_id")}:${id(objectId, "object_id")}:${objectType(type)}:${keyVersion(version)}`,
  attachment: (attachmentId: string) =>
    `keeman:v1:attachment:${id(attachmentId, "attachment_id")}`,
};
