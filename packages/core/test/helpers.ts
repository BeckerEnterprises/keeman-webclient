import { expect } from "vitest";
import type { KdfParams } from "../src/crypto/argon2";
import { CryptoError, type CryptoErrorCode } from "../src/crypto/errors";
import { scriptedRandomness } from "../src/crypto/internal/scripted-randomness";
import { tv } from "../src/crypto/internal/test-values";
import type { Randomness } from "../src/crypto/random";

export function expectCryptoError(
  run: () => unknown,
  code: CryptoErrorCode,
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected CryptoError "${code}"`).toBeInstanceOf(CryptoError);
  expect((caught as CryptoError).code).toBe(code);
}

/** Fastest allowed parameters. */
export const MIN_KDF: KdfParams = {
  alg: "argon2id13",
  ops: 2,
  mem: 19_922_944,
};

export const IDS = {
  user: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
  other: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6c",
  vault: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6d",
  object: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6e",
  attachment: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6f",
} as const;

export const CREATED = "2026-10-23T08:42:00.000Z";

/** Randomness that answers every label with tv(label). */
export function labelRandomness(prefix = "test"): Randomness {
  return {
    bytes: (label, length) => tv(`${prefix}:${label}`, length),
    id: (label) => {
      const hex = Array.from(tv(`${prefix}:id:${label}`, 16), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
    },
  };
}

export { scriptedRandomness, tv };

/**
 * Bytes that pass the icon check: PNG signature, IHDR with the
 * given size, an own chunk with `seed` (so hashes differ) and IEND. Not a
 * decodable image; the core never decodes.
 */
export function iconPng(seed = 0, width = 64, height = 64): Uint8Array {
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    width >>> 24,
    (width >>> 16) & 255,
    (width >>> 8) & 255,
    width & 255,
    height >>> 24,
    (height >>> 16) & 255,
    (height >>> 8) & 255,
    height & 255,
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0x6b,
    0x6d,
    0x41,
    0x6e,
    seed & 255,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x49,
    0x45,
    0x4e,
    0x44,
    0xae,
    0x42,
    0x60,
    0x82,
  ];
  return Uint8Array.from(bytes);
}
