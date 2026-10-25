import { describe, expect, it } from "vitest";
import { aad } from "../../src/crypto/aad";
import { concatBytes } from "../../src/crypto/bytes";
import { mod251, writeRawBlob } from "../../src/crypto/internal/test-values";
import {
  CIPHER_CHUNK_BYTES,
  decryptBlob,
  encryptBlob,
  encryptedBlobSize,
  MIN_BLOB_BYTES,
  PLAIN_CHUNK_BYTES,
} from "../../src/crypto/secretstream";
import { sodium } from "../../src/crypto/sodium";
import { expectCryptoError, IDS, tv } from "../helpers";

const fk = tv("file-key", 32);
const id = IDS.attachment;
const TAG = { message: 0, push: 1, rekey: 2, final: 3 } as const;

describe("attachment blobs", () => {
  it.each([0, 1, 65_535, 65_536, 65_537, 131_072, 200_000])(
    "round-trips %i bytes",
    (length) => {
      const plaintext = mod251(length);
      const blob = encryptBlob(fk, id, plaintext);
      expect(blob).toHaveLength(encryptedBlobSize(length));
      expect(decryptBlob(fk, id, blob, length)).toEqual(plaintext);
    },
  );

  it("matches the size formula of attachment blobs", () => {
    expect(encryptedBlobSize(0)).toBe(MIN_BLOB_BYTES);
    expect(encryptedBlobSize(52_428_800)).toBe(52_442_442);
  });

  it("detects truncation, trailing data, reordering and tampering", () => {
    const blob = encryptBlob(fk, id, mod251(200_000));
    const boundary = 25 + 3 * CIPHER_CHUNK_BYTES;
    expectCryptoError(
      () => decryptBlob(fk, id, blob.subarray(0, boundary)),
      "stream_truncated",
    );
    expectCryptoError(
      () => decryptBlob(fk, id, blob.subarray(0, boundary + 5)),
      "stream_truncated",
    );
    expectCryptoError(
      () => decryptBlob(fk, id, blob.subarray(0, boundary - 100)),
      "auth",
    );
    // Chunks carry no length: appended bytes become part of the last chunk.
    expectCryptoError(
      () => decryptBlob(fk, id, concatBytes(blob, Uint8Array.of(0))),
      "auth",
    );
    expectCryptoError(
      () =>
        decryptBlob(
          fk,
          id,
          concatBytes(blob, new Uint8Array(CIPHER_CHUNK_BYTES)),
        ),
      "auth",
    );
    const swapped = blob.slice();
    swapped.set(
      blob.subarray(25 + CIPHER_CHUNK_BYTES, 25 + 2 * CIPHER_CHUNK_BYTES),
      25,
    );
    swapped.set(
      blob.subarray(25, 25 + CIPHER_CHUNK_BYTES),
      25 + CIPHER_CHUNK_BYTES,
    );
    expectCryptoError(() => decryptBlob(fk, id, swapped), "auth");
    const flipped = blob.with(100, (blob[100] ?? 0) ^ 1);
    expectCryptoError(() => decryptBlob(fk, id, flipped), "auth");
    expectCryptoError(() => decryptBlob(fk, IDS.object, blob), "auth");
    expectCryptoError(() => decryptBlob(tv("other", 32), id, blob), "auth");
    expectCryptoError(() => decryptBlob(fk, id, blob.with(0, 1)), "format");
    expectCryptoError(
      () => decryptBlob(fk, id, blob.subarray(0, 41)),
      "format",
    );
    expectCryptoError(() => decryptBlob(fk, id, blob, 199_999), "validation");
  });

  it("rejects non-canonical chunk layouts", () => {
    const ad = aad.attachment(id);
    const full = mod251(PLAIN_CHUNK_BYTES);
    const cases = [
      [{ data: full, tag: TAG.final }],
      [
        { data: full, tag: TAG.push },
        { data: new Uint8Array(0), tag: TAG.final },
      ],
      [
        { data: full, tag: TAG.rekey },
        { data: new Uint8Array(0), tag: TAG.final },
      ],
      [
        { data: new Uint8Array(0), tag: TAG.message },
        { data: new Uint8Array(0), tag: TAG.final },
      ],
      [
        { data: Uint8Array.of(1), tag: TAG.final },
        { data: Uint8Array.of(2), tag: TAG.final },
      ],
    ];
    for (const chunks of cases) {
      expect(() => decryptBlob(fk, id, writeRawBlob(fk, ad, chunks))).toThrow();
    }
    // Full-size chunks with the wrong tag are recognisable as such ...
    expectCryptoError(
      () => decryptBlob(fk, id, writeRawBlob(fk, ad, cases[0] ?? [])),
      "stream_tag",
    );
    expectCryptoError(
      () => decryptBlob(fk, id, writeRawBlob(fk, ad, cases[1] ?? [])),
      "stream_tag",
    );
    expectCryptoError(
      () => decryptBlob(fk, id, writeRawBlob(fk, ad, cases[2] ?? [])),
      "stream_tag",
    );
    // ... short ones merge with the following bytes and fail authentication.
    expectCryptoError(
      () => decryptBlob(fk, id, writeRawBlob(fk, ad, cases[3] ?? [])),
      "auth",
    );
    expectCryptoError(
      () => decryptBlob(fk, id, writeRawBlob(fk, ad, cases[4] ?? [])),
      "auth",
    );
  });

  it("validates the file key", () => {
    expectCryptoError(
      () => encryptBlob(new Uint8Array(16), id, new Uint8Array(1)),
      "validation",
    );
    expectCryptoError(
      () => decryptBlob(new Uint8Array(16), id, new Uint8Array(42)),
      "validation",
    );
    expect(sodium().crypto_secretstream_xchacha20poly1305_TAG_FINAL).toBe(
      TAG.final,
    );
  });
});
