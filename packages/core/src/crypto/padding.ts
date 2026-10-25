import { CryptoError } from "./errors";
import { sodium } from "./sodium";

export const PAD_BLOCK_SIZE = 256;

/** ISO/IEC 7816-4 padding to a multiple of 256; always adds 1–256 bytes. */
export function pad(bytes: Uint8Array): Uint8Array {
  return sodium().pad(bytes, PAD_BLOCK_SIZE);
}

/**
 * Strict unpadding: `sodium.unpad` only inspects the last block, so the
 * length is checked to be a positive multiple of the block size first.
 */
export function unpad(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || bytes.length % PAD_BLOCK_SIZE !== 0) {
    throw new CryptoError("padding", "Invalid padded length");
  }
  try {
    return sodium().unpad(bytes, PAD_BLOCK_SIZE);
  } catch {
    throw new CryptoError("padding", "Invalid padding");
  }
}
