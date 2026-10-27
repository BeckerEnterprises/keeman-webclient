// Ed25519 signing key of an account, derived from the user key, and
// signatures bound to a context.
import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  utf8Encode,
  wipe,
} from "./bytes";
import { CryptoError } from "./errors";
import { deriveSubkey, KDF_CONTEXT, KEY_BYTES } from "./kdf";
import { sodium } from "./sodium";

export const SIGNATURE_BYTES = 64;
const SECRET_KEY_BYTES = 64;

/** Signature contexts; a signature never counts for another context. */
export const SIGNATURE_CONTEXT = {
  roles: "keeman:v1:roles",
  freshness: "keeman:v1:freshness",
} as const;

export type SignatureContext =
  (typeof SIGNATURE_CONTEXT)[keyof typeof SIGNATURE_CONTEXT];

export interface SigningKeyPair {
  publicKey: Uint8Array;
  /** libsodium form: seed ‖ public key, 64 bytes. */
  secretKey: Uint8Array;
}

/** `crypto_sign_seed_keypair(kdf(UK, 1, "keemanSG"))`; the seed is wiped. */
export function deriveSigningKeyPair(userKey: Uint8Array): SigningKeyPair {
  const seed = deriveSubkey(userKey, 1, KDF_CONTEXT.signing);
  try {
    const pair = sodium().crypto_sign_seed_keypair(seed);
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  } finally {
    wipe(seed);
  }
}

/** The public signing key that belongs to a user key. */
export function signingPublicKeyOf(userKey: Uint8Array): Uint8Array {
  const pair = deriveSigningKeyPair(userKey);
  wipe(pair.secretKey);
  return pair.publicKey;
}

function signedBytes(context: SignatureContext, message: Uint8Array) {
  return concatBytes(utf8Encode(context), Uint8Array.of(0x00), message);
}

/** Detached signature over context ‖ 0x00 ‖ message. */
export function sign(
  secretKey: Uint8Array,
  context: SignatureContext,
  message: Uint8Array,
): Uint8Array {
  if (secretKey.length !== SECRET_KEY_BYTES)
    throw new CryptoError("validation", "Signing key must be 64 bytes");
  return sodium().crypto_sign_detached(
    signedBytes(context, message),
    secretKey,
  );
}

/**
 * Checks a detached signature: `format` for wrong lengths, `auth` when it
 * does not verify (libsodium rejects non-canonical and small-order values).
 */
export function verifySignature(
  publicKey: Uint8Array,
  context: SignatureContext,
  message: Uint8Array,
  signature: Uint8Array,
): void {
  if (publicKey.length !== KEY_BYTES)
    throw new CryptoError("format", "Signing public key must be 32 bytes");
  if (signature.length !== SIGNATURE_BYTES)
    throw new CryptoError("format", "Signature must be 64 bytes");
  let valid: boolean;
  try {
    valid = sodium().crypto_sign_verify_detached(
      signature,
      signedBytes(context, message),
      publicKey,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new CryptoError("auth", "Invalid signature");
}

/**
 * Compares the locally derived public signing key with the server's value:
 * `missing` for accounts that have none yet, `integrity` on a mismatch.
 */
export function checkOwnSigningKey(
  derived: Uint8Array,
  claimed: string | null | undefined,
): "match" | "missing" {
  if (claimed === null || claimed === undefined) return "missing";
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(claimed, KEY_BYTES);
  } catch {
    throw new CryptoError(
      "integrity",
      "Server returned an invalid signing key",
    );
  }
  if (!bytesEqual(derived, bytes))
    throw new CryptoError(
      "integrity",
      "Signing key does not match the user key",
    );
  return "match";
}
