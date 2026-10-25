import { aad } from "./aad";
import { concatBytes, utf8Encode } from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import { sodium } from "./sodium";

export const FORMAT_BLOB = 0x03;
export const PLAIN_CHUNK_BYTES = 65_536;
export const STREAM_ABYTES = 17;
export const STREAM_HEADER_BYTES = 24;
export const CIPHER_CHUNK_BYTES = PLAIN_CHUNK_BYTES + STREAM_ABYTES;
const BLOB_PREFIX_BYTES = 1 + STREAM_HEADER_BYTES;
export const MIN_BLOB_BYTES = BLOB_PREFIX_BYTES + STREAM_ABYTES;

/** Encrypted size of a file: there are always floor(n / 65536) + 1 chunks. */
export function encryptedBlobSize(plainLength: number): number {
  return (
    BLOB_PREFIX_BYTES +
    plainLength +
    STREAM_ABYTES * (Math.floor(plainLength / PLAIN_CHUNK_BYTES) + 1)
  );
}

function assertFileKey(fileKey: Uint8Array): void {
  if (fileKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "File key must be 32 bytes");
}

/** Attachment blob; the header is random, so encryption is never deterministic. */
export function encryptBlob(
  fileKey: Uint8Array,
  attachmentId: string,
  plaintext: Uint8Array,
): Uint8Array {
  assertFileKey(fileKey);
  const ad = utf8Encode(aad.attachment(attachmentId));
  const s = sodium();
  const { state, header } =
    s.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const parts: Uint8Array[] = [Uint8Array.of(FORMAT_BLOB), header];
  const fullChunks = Math.floor(plaintext.length / PLAIN_CHUNK_BYTES);
  for (let i = 0; i < fullChunks; i++) {
    const chunk = plaintext.subarray(
      i * PLAIN_CHUNK_BYTES,
      (i + 1) * PLAIN_CHUNK_BYTES,
    );
    parts.push(
      s.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        ad,
        s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      ),
    );
  }
  const last = plaintext.subarray(fullChunks * PLAIN_CHUNK_BYTES);
  parts.push(
    s.crypto_secretstream_xchacha20poly1305_push(
      state,
      last,
      ad,
      s.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    ),
  );
  return concatBytes(...parts);
}

/**
 * Strict reader: chunks of min(65553, rest) bytes; every chunk but
 * the last is a full TAG_MESSAGE chunk, the last one a shorter TAG_FINAL chunk.
 * Chunks carry no length, so appended data lands in the last chunk and fails
 * authentication. Plaintext is returned only after TAG_FINAL has been verified.
 */
export function decryptBlob(
  fileKey: Uint8Array,
  attachmentId: string,
  blob: Uint8Array,
  expectedPlainLength?: number,
): Uint8Array {
  assertFileKey(fileKey);
  const ad = utf8Encode(aad.attachment(attachmentId));
  if (blob.length < MIN_BLOB_BYTES || blob[0] !== FORMAT_BLOB)
    throw new CryptoError("format", "Not an attachment blob");
  const s = sodium();
  const state = s.crypto_secretstream_xchacha20poly1305_init_pull(
    blob.subarray(1, BLOB_PREFIX_BYTES),
    fileKey,
  );
  const parts: Uint8Array[] = [];
  let offset = BLOB_PREFIX_BYTES;
  for (;;) {
    const remaining = blob.length - offset;
    if (remaining < STREAM_ABYTES)
      throw new CryptoError(
        "stream_truncated",
        "Attachment blob ends without final chunk",
      );
    const length = Math.min(CIPHER_CHUNK_BYTES, remaining);
    let result: { message: Uint8Array; tag: number } | false;
    try {
      result = s.crypto_secretstream_xchacha20poly1305_pull(
        state,
        blob.subarray(offset, offset + length),
        ad,
      );
    } catch {
      result = false;
    }
    if (result === false)
      throw new CryptoError("auth", "Attachment chunk failed authentication");
    offset += length;
    if (
      result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE &&
      length === CIPHER_CHUNK_BYTES
    ) {
      parts.push(result.message);
      continue;
    }
    if (
      result.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL &&
      length < CIPHER_CHUNK_BYTES
    ) {
      // A short chunk is always the rest of the blob, so nothing can follow it.
      parts.push(result.message);
      break;
    }
    throw new CryptoError("stream_tag", "Unexpected chunk tag or layout");
  }
  const plaintext = concatBytes(...parts);
  if (
    expectedPlainLength !== undefined &&
    plaintext.length !== expectedPlainLength
  ) {
    throw new CryptoError("validation", "Attachment size does not match");
  }
  return plaintext;
}
