/**
 * Argon2 for KDBX files: hash-wasm, because KDBX uses
 * 32-byte salts and parallelism above 1, which libsodium cannot do.
 */
import { argon2d, argon2id } from "hash-wasm";
import { KDBX_LIMITS, KdbxError } from "../types";

const ARGON2_TYPE_ID = 2;
const ARGON2_VERSION_13 = 0x13;

/** Matches kdbxweb's `Argon2Fn`; `memory` is in KiB. */
export async function kdbxArgon2(
  password: ArrayBuffer,
  salt: ArrayBuffer,
  memory: number,
  iterations: number,
  length: number,
  parallelism: number,
  type: number,
  version: number,
): Promise<ArrayBuffer> {
  if (version !== ARGON2_VERSION_13) throw new KdbxError("unsupported_kdf");
  if (memory * 1024 > KDBX_LIMITS.argon2MemoryBytes)
    throw new KdbxError("kdf_limits");
  const options = {
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory,
    iterations,
    hashLength: length,
    parallelism,
    outputType: "binary" as const,
  };
  const hash =
    type === ARGON2_TYPE_ID ? await argon2id(options) : await argon2d(options);
  return hash.slice().buffer;
}
