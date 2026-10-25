/** Error codes, the same as in the `error` field of the test vectors. */
export type CryptoErrorCode =
  | "format"
  | "auth"
  | "padding"
  | "encoding"
  | "validation"
  | "stream_truncated"
  | "stream_tag"
  | "integrity"
  | "locked";

/**
 * Every failure of the crypto layer. Messages are fixed English strings and
 * never contain key material, plaintext or ciphertext.
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}
