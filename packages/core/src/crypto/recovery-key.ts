import { fromBase32, toBase32 } from "./base32";
import { concatBytes, utf8Encode } from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import type { Randomness } from "./random";
import { sodium } from "./sodium";

const KEY_CHARS = 52;
const CHECK_CHARS = 4;
const IGNORED = /[ \t\r\n-]/g;

export function generateRecoveryKey(randomness: Randomness): Uint8Array {
  return randomness.bytes("recovery_key", KEY_BYTES);
}

function checksum(recoveryKey: Uint8Array): string {
  const digest = sodium().crypto_generichash(
    32,
    concatBytes(utf8Encode("keeman:v1:recovery-check"), recoveryKey),
    null,
  );
  return toBase32(digest).slice(0, CHECK_CHARS);
}

/** 52 Base32 characters plus 4 check characters, in 14 groups of 4. */
export function formatRecoveryKey(recoveryKey: Uint8Array): string {
  if (recoveryKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Recovery key must be 32 bytes");
  const text = toBase32(recoveryKey) + checksum(recoveryKey);
  return text.match(/.{4}/g)?.join(" ") ?? "";
}

/**
 * Parses user input: a–z count as A–Z; spaces, tabs, line breaks
 * and hyphens are ignored; the check characters must match.
 */
export function parseRecoveryKey(input: string): Uint8Array {
  const text = input
    .replace(IGNORED, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
  if (!/^[A-Z2-7]*$/.test(text) || text.length !== KEY_CHARS + CHECK_CHARS) {
    throw new CryptoError(
      "validation",
      "Recovery key has invalid characters or length",
    );
  }
  let recoveryKey: Uint8Array;
  try {
    recoveryKey = fromBase32(text.slice(0, KEY_CHARS));
  } catch {
    throw new CryptoError("validation", "Recovery key is not canonical");
  }
  if (checksum(recoveryKey) !== text.slice(KEY_CHARS)) {
    throw new CryptoError("validation", "Recovery key checksum does not match");
  }
  return recoveryKey;
}
