import { DEFAULT_KDF_PARAMS, type KdfParams } from "../crypto/argon2";

export interface KdfCost {
  ops: number;
  mem: number;
}

/**
 * Last seen KDF parameters per account. The web app keeps them in
 * `keeman.kdfSeen`; they are not secret.
 */
export interface KdfMemory {
  get(userId: string): KdfCost | undefined;
  set(userId: string, cost: KdfCost): void;
  /** After the account was deleted on this device. */
  forget(userId: string): void;
}

export function inMemoryKdfMemory(): KdfMemory {
  const seen = new Map<string, KdfCost>();
  return {
    get: (userId) => seen.get(userId),
    set: (userId, cost) => {
      seen.set(userId, { ops: cost.ops, mem: cost.mem });
    },
    forget: (userId) => {
      seen.delete(userId);
    },
  };
}

export function isBelowDefault(kdf: KdfCost): boolean {
  return kdf.ops < DEFAULT_KDF_PARAMS.ops || kdf.mem < DEFAULT_KDF_PARAMS.mem;
}

/** Parameters for a new password: never weaker than now or than the default. */
export function strongerOf(current: KdfParams): KdfParams {
  return {
    alg: "argon2id13",
    ops: Math.max(current.ops, DEFAULT_KDF_PARAMS.ops),
    mem: Math.max(current.mem, DEFAULT_KDF_PARAMS.mem),
  };
}
