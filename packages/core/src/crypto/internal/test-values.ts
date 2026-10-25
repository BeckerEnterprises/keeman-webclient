// For tests and for producing test vectors only (ESLint keeps it out of src).
import { concatBytes, utf8Encode } from "../bytes";
import { sodium } from "../sodium";

/** Deterministic test input: BLAKE2b-n("keeman-testvector:" + label), as the test vectors use it. */
export function tv(label: string, length: number): Uint8Array {
  return sodium().crypto_generichash(
    length,
    utf8Encode(`keeman-testvector:${label}`),
    null,
  );
}

/** Plaintext pattern "mod251": byte i has the value i mod 251. */
export function mod251(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

export interface RawChunk {
  data: Uint8Array;
  tag: number;
}

/** Writes a blob with arbitrary chunks and tags, for non-canonical negative vectors. */
export function writeRawBlob(
  fileKey: Uint8Array,
  aad: string,
  chunks: RawChunk[],
): Uint8Array {
  const s = sodium();
  const { state, header } =
    s.crypto_secretstream_xchacha20poly1305_init_push(fileKey);
  const ad = utf8Encode(aad);
  return concatBytes(
    Uint8Array.of(0x03),
    header,
    ...chunks.map((chunk) =>
      s.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk.data,
        ad,
        chunk.tag,
      ),
    ),
  );
}
