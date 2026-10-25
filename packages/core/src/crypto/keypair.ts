import { bytesEqual, fromBase64Url } from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import type { Randomness } from "./random";
import { sodium } from "./sodium";

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Same construction as `crypto_box_keypair`: 32 random bytes and their X25519 public key. */
export function generateKeyPair(randomness: Randomness): KeyPair {
  const privateKey = randomness.bytes("private_key", KEY_BYTES);
  return { privateKey, publicKey: derivePublicKey(privateKey) };
}

export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Private key must be 32 bytes");
  return sodium().crypto_scalarmult_base(privateKey);
}

/**
 * Compares the locally derived public key with the one the server returned
 * and returns the derived key pk'.
 */
export function verifyOwnPublicKey(
  privateKey: Uint8Array,
  publicKeyB64: string,
): Uint8Array {
  const derived = derivePublicKey(privateKey);
  let claimed: Uint8Array;
  try {
    claimed = fromBase64Url(publicKeyB64, KEY_BYTES);
  } catch {
    throw new CryptoError("integrity", "Server returned an invalid public key");
  }
  if (!bytesEqual(derived, claimed)) {
    throw new CryptoError(
      "integrity",
      "Public key does not match the private key",
    );
  }
  return derived;
}
