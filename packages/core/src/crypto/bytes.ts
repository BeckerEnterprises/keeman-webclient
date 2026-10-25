import { CryptoError } from "./errors";
import { sodium } from "./sodium";

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

export function toBase64Url(bytes: Uint8Array): string {
  const s = sodium();
  return s.to_base64(bytes, s.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Strict Base64url decoding: only the canonical unpadded form is
 * accepted, and the decoded length is checked when `length` is given.
 */
export function fromBase64Url(text: string, length?: number): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new CryptoError("format", "Invalid Base64url");
  }
  const s = sodium();
  let bytes: Uint8Array;
  try {
    bytes = s.from_base64(text, s.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new CryptoError("format", "Invalid Base64url");
  }
  if (toBase64Url(bytes) !== text)
    throw new CryptoError("format", "Non-canonical Base64url");
  if (length !== undefined && bytes.length !== length) {
    throw new CryptoError("format", "Unexpected decoded length");
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return sodium().to_hex(bytes);
}

/** Lowercase hex only; used for test vectors and fingerprints. */
export function fromHex(text: string): Uint8Array {
  if (!HEX.test(text)) throw new CryptoError("format", "Invalid hex");
  return sodium().from_hex(text);
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading BOM as U+FEFF, so JSON.parse rejects it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 encoding that refuses strings with lone surrogates. */
export function utf8Encode(text: string): Uint8Array {
  if (!text.isWellFormed())
    throw new CryptoError("validation", "String is not well-formed Unicode");
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CryptoError("encoding", "Invalid UTF-8");
  }
}

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `JSON.stringify` writes lone surrogates as `\udXXX` escapes that other
 * clients reject, so every key and string value is checked first.
 */
export function encodeJsonObject(value: JsonObject): Uint8Array {
  const json = JSON.stringify(value, (key, item: unknown) => {
    if (
      !key.isWellFormed() ||
      (typeof item === "string" && !item.isWellFormed())
    ) {
      throw new CryptoError("validation", "String is not well-formed Unicode");
    }
    return item;
  });
  return encoder.encode(json);
}

/** Strict UTF-8, then JSON; the top-level value must be an object. */
export function decodeJsonObject(bytes: Uint8Array): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError("encoding", "Invalid JSON");
  }
  if (!isJsonObject(value))
    throw new CryptoError("encoding", "JSON value is not an object");
  return value;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time comparison for equal-length inputs. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && sodium().memcmp(a, b);
}

/** Overwrites every given buffer with zeros. */
export function wipe(...buffers: (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) if (buffer) sodium().memzero(buffer);
}
