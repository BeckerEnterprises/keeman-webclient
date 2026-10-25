import { CryptoError } from "./errors";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32 without padding. */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return out;
}

/**
 * Strict decoding of unpadded uppercase Base32: the length must be a valid
 * unpadded length and the trailing fill bits must be zero.
 */
export function fromBase32(text: string): Uint8Array {
  if (![0, 2, 4, 5, 7].includes(text.length % 8))
    throw new CryptoError("format", "Invalid Base32 length");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new CryptoError("format", "Invalid Base32 character");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw new CryptoError("format", "Non-canonical Base32");
  return Uint8Array.from(out);
}
