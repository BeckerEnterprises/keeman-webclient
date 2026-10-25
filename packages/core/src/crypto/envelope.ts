import {
  concatBytes,
  decodeJsonObject,
  encodeJsonObject,
  fromBase64Url,
  toBase64Url,
  utf8Encode,
  type JsonObject,
} from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import { pad, unpad } from "./padding";
import type { Randomness } from "./random";
import { sodium } from "./sodium";

export const FORMAT_AEAD = 0x01;
export const NONCE_BYTES = 24;
export const AEAD_TAG_BYTES = 16;
/** AEAD envelope of a 32-byte key: 1 + 24 + 32 + 16. */
export const WRAPPED_KEY_BYTES = 1 + NONCE_BYTES + KEY_BYTES + AEAD_TAG_BYTES;
const MIN_ENVELOPE_BYTES = 1 + NONCE_BYTES + AEAD_TAG_BYTES;

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES)
    throw new CryptoError("validation", "Key must be 32 bytes");
}

function seal(
  randomness: Randomness,
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): string {
  assertKey(key);
  const nonce = randomness.bytes("nonce", NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES)
    throw new CryptoError("validation", "Nonce must be 24 bytes");
  const ciphertext = sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    utf8Encode(aad),
    null,
    nonce,
    key,
  );
  return toBase64Url(
    concatBytes(Uint8Array.of(FORMAT_AEAD), nonce, ciphertext),
  );
}

/** Decoding, format byte, length and decryption, in this order. */
function open(
  key: Uint8Array,
  envelope: string,
  aad: string,
  exactLength?: number,
): Uint8Array {
  assertKey(key);
  const bytes = fromBase64Url(envelope);
  if (bytes[0] !== FORMAT_AEAD)
    throw new CryptoError("format", "Unexpected envelope format");
  if (
    exactLength === undefined
      ? bytes.length < MIN_ENVELOPE_BYTES
      : bytes.length !== exactLength
  ) {
    throw new CryptoError("format", "Unexpected envelope length");
  }
  try {
    return sodium().crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      bytes.subarray(1 + NONCE_BYTES),
      utf8Encode(aad),
      bytes.subarray(1, 1 + NONCE_BYTES),
      key,
    );
  } catch {
    throw new CryptoError("auth", "Decryption failed");
  }
}

/** Wraps a raw 32-byte key, without padding. */
export function sealKey(
  randomness: Randomness,
  key: Uint8Array,
  rawKey: Uint8Array,
  aad: string,
): string {
  if (rawKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Wrapped key must be 32 bytes");
  return seal(randomness, key, rawKey, aad);
}

export function openKey(
  key: Uint8Array,
  envelope: string,
  aad: string,
): Uint8Array {
  const rawKey = open(key, envelope, aad, WRAPPED_KEY_BYTES);
  if (rawKey.length !== KEY_BYTES)
    throw new CryptoError("format", "Unexpected key length");
  return rawKey;
}

/** Pads and encrypts plaintext bytes (objects, user_data, tombstones). */
export function sealBytes(
  randomness: Randomness,
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): string {
  return seal(randomness, key, pad(plaintext), aad);
}

/** Decrypts and strictly unpads; returns the exact plaintext bytes. */
export function openBytes(
  key: Uint8Array,
  envelope: string,
  aad: string,
): Uint8Array {
  return unpad(open(key, envelope, aad));
}

export function sealJson(
  randomness: Randomness,
  key: Uint8Array,
  value: JsonObject,
  aad: string,
): string {
  return sealBytes(randomness, key, encodeJsonObject(value), aad);
}

export function openJson(
  key: Uint8Array,
  envelope: string,
  aad: string,
): JsonObject {
  return decodeJsonObject(openBytes(key, envelope, aad));
}
