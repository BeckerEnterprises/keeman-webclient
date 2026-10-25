import { CryptoError } from "./errors";
import { sodium } from "./sodium";
import { uuidv7 } from "./uuid";

/**
 * Source of all randomness in the crypto layer. Every request is named, so
 * test vectors can supply fixed values per purpose instead of depending on
 * call order. Production code always uses `systemRandomness`.
 */
export interface Randomness {
  bytes(label: string, length: number): Uint8Array;
  /** A new UUIDv7. */
  id(label: string): string;
}

export const systemRandomness: Randomness = {
  bytes: (_label, length) => sodium().randombytes_buf(length),
  id: () => uuidv7(sodium().randombytes_buf(10)),
};

/** Uniform integers in `[0, upper)` without modulo bias. */
export interface UniformSource {
  uniform(label: string, upper: number): number;
}

export const systemUniform: UniformSource = {
  uniform: (_label, upper) => sodium().randombytes_uniform(upper),
};

/** Prefixes every label, so one flow can name its values without collisions. */
export function scoped(randomness: Randomness, prefix: string): Randomness {
  return {
    bytes: (label, length) => randomness.bytes(`${prefix}.${label}`, length),
    id: (label) => randomness.id(`${prefix}.${label}`),
  };
}

export function assertLength(
  bytes: Uint8Array,
  length: number,
  what: string,
): void {
  if (bytes.length !== length)
    throw new CryptoError(
      "validation",
      `${what} must be ${String(length)} bytes`,
    );
}
