import {
  concatBytes,
  decodeJsonObject,
  encodeJsonObject,
  fromBase64Url,
  toBase64Url,
  type JsonObject,
} from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import { pad, unpad } from "./padding";
import type { Randomness } from "./random";
import { isRolePoint, type RolePoint } from "./roles";
import { sodium } from "./sodium";
import { isTimestamp } from "./time";
import { assertUuid, isUuid } from "./uuid";

export const FORMAT_BOX = 0x02;
const NONCE_BYTES = 24;
const BOX_MAC_BYTES = 16;
const MIN_BOX_BYTES = 1 + NONCE_BYTES + BOX_MAC_BYTES;
export const VAULT_NAME_MAX_CHARS = 256;

export interface VaultKeyMessage {
  vaultId: string;
  keyVersion: number;
  vaultKey: Uint8Array;
  senderId: string;
  recipientId: string;
  vaultName: string;
  created: string;
  /** Version and hash of the newest roles statement the sender checked. */
  roles?: RolePoint | undefined;
}

function assertKeyVersion(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new CryptoError("validation", "Invalid key version");
  }
}

/** Box envelope with a vault key; the message is padded like objects. */
export function sealVaultKeyBox(
  randomness: Randomness,
  senderPrivateKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  message: VaultKeyMessage,
): string {
  assertUuid(message.vaultId, "vault_id");
  assertUuid(message.senderId, "sender_id");
  assertUuid(message.recipientId, "recipient_id");
  assertKeyVersion(message.keyVersion);
  if (message.vaultKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Vault key must be 32 bytes");
  if (!isTimestamp(message.created))
    throw new CryptoError("validation", "Invalid created timestamp");
  if (message.roles !== undefined && !isRolePoint(message.roles))
    throw new CryptoError("validation", "Invalid roles");
  if (
    senderPrivateKey.length !== KEY_BYTES ||
    recipientPublicKey.length !== KEY_BYTES
  ) {
    throw new CryptoError("validation", "Keys must be 32 bytes");
  }
  const json: JsonObject = {
    v: 1,
    type: "vault_key",
    vault_id: message.vaultId,
    key_version: message.keyVersion,
    vault_key: toBase64Url(message.vaultKey),
    sender_id: message.senderId,
    recipient_id: message.recipientId,
    vault_name: Array.from(message.vaultName)
      .slice(0, VAULT_NAME_MAX_CHARS)
      .join(""),
    created: message.created,
  };
  if (message.roles)
    json.roles = { version: message.roles.version, hash: message.roles.hash };
  const nonce = randomness.bytes("nonce", NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES)
    throw new CryptoError("validation", "Nonce must be 24 bytes");
  const ciphertext = sodium().crypto_box_easy(
    pad(encodeJsonObject(json)),
    nonce,
    recipientPublicKey,
    senderPrivateKey,
  );
  return toBase64Url(concatBytes(Uint8Array.of(FORMAT_BOX), nonce, ciphertext));
}

/** What the receiver knows independently of the box. */
export interface KeyGrantContext {
  /** Own user_id as authenticated by the user key AAD. */
  ownUserId: string;
  /** `sender_id` of the invitation or pending key; its public key opens the box. */
  senderId: string;
  vaultId: string;
  /** `key_version` of the invitation or pending key. */
  keyVersion: number;
  /** For pending keys after a rotation: the own current `member_key_version`. */
  currentKeyVersion?: number;
}

export interface OpenedVaultKey {
  vaultKey: Uint8Array;
  vaultName: string;
  created: string;
  /** The roles statement the sender vouches for; missing in older boxes. */
  roles: RolePoint | undefined;
}

function validateMessage(
  message: JsonObject,
  context: KeyGrantContext,
): OpenedVaultKey {
  const fail = (reason: string): never => {
    throw new CryptoError("validation", `Invalid key box: ${reason}`);
  };
  if (message.v !== 1) fail("v");
  if (message.type !== "vault_key") fail("type");
  if (!isUuid(message.vault_id) || message.vault_id !== context.vaultId)
    fail("vault_id");
  const keyVersion = message.key_version;
  if (
    typeof keyVersion !== "number" ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion !== context.keyVersion
  ) {
    fail("key_version");
  }
  if (
    context.currentKeyVersion !== undefined &&
    context.keyVersion <= context.currentKeyVersion
  ) {
    fail("key_version is not newer than the current one");
  }
  if (!isUuid(message.sender_id) || message.sender_id !== context.senderId)
    fail("sender_id");
  if (
    !isUuid(message.recipient_id) ||
    message.recipient_id !== context.ownUserId
  )
    fail("recipient_id");
  if (!isTimestamp(message.created)) fail("created");
  if (typeof message.vault_name !== "string") fail("vault_name");
  let roles: RolePoint | undefined;
  if (message.roles !== undefined) {
    if (!isRolePoint(message.roles)) return fail("roles");
    roles = { version: message.roles.version, hash: message.roles.hash };
  }
  let vaultKey: Uint8Array | undefined;
  try {
    vaultKey =
      typeof message.vault_key === "string"
        ? fromBase64Url(message.vault_key, KEY_BYTES)
        : undefined;
  } catch {
    vaultKey = undefined;
  }
  if (!vaultKey) return fail("vault_key");
  return {
    vaultKey,
    vaultName: message.vault_name as string,
    created: message.created as string,
    roles,
  };
}

/** Opens and validates a key box: format, length and authentication first, then the message rules. */
export function openVaultKeyBox(
  envelope: string,
  recipientPrivateKey: Uint8Array,
  senderPublicKey: Uint8Array,
  context: KeyGrantContext,
): OpenedVaultKey {
  assertUuid(context.ownUserId, "own user_id");
  assertUuid(context.senderId, "sender_id");
  assertUuid(context.vaultId, "vault_id");
  assertKeyVersion(context.keyVersion);
  const bytes = fromBase64Url(envelope);
  if (bytes[0] !== FORMAT_BOX)
    throw new CryptoError("format", "Unexpected envelope format");
  if (bytes.length < MIN_BOX_BYTES)
    throw new CryptoError("format", "Unexpected envelope length");
  let padded: Uint8Array;
  try {
    padded = sodium().crypto_box_open_easy(
      bytes.subarray(1 + NONCE_BYTES),
      bytes.subarray(1, 1 + NONCE_BYTES),
      senderPublicKey,
      recipientPrivateKey,
    );
  } catch {
    throw new CryptoError("auth", "Decryption failed");
  }
  return validateMessage(decodeJsonObject(unpad(padded)), context);
}
