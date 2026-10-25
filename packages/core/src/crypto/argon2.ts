import { isJsonObject, wipe } from "./bytes";
import { CryptoError } from "./errors";
import { deriveAccountKeys, type AccountKeys } from "./kdf";
import { normalizePassword } from "./normalize";
import { sodium } from "./sodium";

export interface KdfParams {
  alg: "argon2id13";
  ops: number;
  mem: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  alg: "argon2id13",
  ops: 3,
  mem: 67_108_864,
};

/** Allowed range, bounds inclusive. */
export const KDF_LIMITS = {
  minOps: 2,
  maxOps: 10,
  minMem: 19_922_944,
  maxMem: 1_073_741_824,
} as const;

export const SALT_BYTES = 16;

function isIntegerInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Accepts only argon2id13 with integer parameters in range; unknown fields are dropped. */
export function validateKdfParams(value: unknown): KdfParams {
  if (!isJsonObject(value) || value.alg !== "argon2id13") {
    throw new CryptoError("validation", "Unsupported KDF algorithm");
  }
  const { ops, mem } = value;
  if (!isIntegerInRange(ops, KDF_LIMITS.minOps, KDF_LIMITS.maxOps)) {
    throw new CryptoError("validation", "KDF ops out of range");
  }
  if (
    !isIntegerInRange(mem, KDF_LIMITS.minMem, KDF_LIMITS.maxMem) ||
    mem % 1024 !== 0
  ) {
    throw new CryptoError("validation", "KDF mem out of range");
  }
  return { alg: "argon2id13", ops, mem };
}

/** True if the server now offers weaker parameters than seen before. */
export function isWeakerThan(params: KdfParams, previous: KdfParams): boolean {
  return params.ops < previous.ops || params.mem < previous.mem;
}

/** Argon2id. Blocks the calling thread; browsers use argon2-worker.ts. */
export function deriveMasterKey(
  password: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Uint8Array {
  const { ops, mem } = validateKdfParams(params);
  if (salt.length !== SALT_BYTES)
    throw new CryptoError("validation", "Salt must be 16 bytes");
  const s = sodium();
  return s.crypto_pwhash(
    32,
    password,
    salt,
    ops,
    mem,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** auth_key and wrap_key from the master password; the master key never leaves this function. */
export function deriveLoginKeys(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
): AccountKeys {
  const passwordBytes = normalizePassword(password);
  let masterKey: Uint8Array | undefined;
  try {
    masterKey = deriveMasterKey(passwordBytes, salt, params);
    return deriveAccountKeys(masterKey);
  } finally {
    wipe(passwordBytes, masterKey);
  }
}
