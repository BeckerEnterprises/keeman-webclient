import { concatBytes, toHex, utf8Encode } from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import { sodium } from "./sodium";

const FINGERPRINT_PATTERN = /^[0-9A-F]{64}$/;

/** BLAKE2b-256 over "keeman:v1:fingerprint" ‖ public key. */
export function fingerprint(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Public key must be 32 bytes");
  return sodium().crypto_generichash(
    32,
    concatBytes(utf8Encode("keeman:v1:fingerprint"), publicKey),
    null,
  );
}

/** Full fingerprint as stored in contacts: 64 uppercase hex characters. */
export function fingerprintHex(publicKey: Uint8Array): string {
  return toHex(fingerprint(publicKey)).toUpperCase();
}

/** Display form: the first 20 bytes in 10 groups of 4, separated by single spaces. */
export function formatFingerprint(fullHex: string): string {
  if (!FINGERPRINT_PATTERN.test(fullHex))
    throw new CryptoError("validation", "Invalid fingerprint");
  return fullHex.slice(0, 40).match(/.{4}/g)?.join(" ") ?? "";
}
