import { CryptoError } from "./errors";

/** Format check only; version and variant are not checked. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function assertUuid(
  value: unknown,
  what: string,
): asserts value is string {
  if (!isUuid(value))
    throw new CryptoError("validation", `${what} is not a canonical UUID`);
}

/**
 * UUIDv7 per RFC 9562 §5.7: 48-bit Unix milliseconds, version 7,
 * variant 10, and 74 bits taken from `random` (10 bytes).
 */
export function uuidv7(
  random: Uint8Array,
  unixMs: number = Date.now(),
): string {
  if (random.length !== 10)
    throw new CryptoError("validation", "UUIDv7 needs 10 random bytes");
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) {
    throw new CryptoError("validation", "UUIDv7 timestamp out of range");
  }
  const bytes = new Uint8Array(16);
  let ms = unixMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  const r = (i: number): number => random[i] ?? 0;
  bytes[6] = 0x70 | (r(0) & 0x0f);
  bytes[7] = r(1);
  bytes[8] = 0x80 | (r(2) & 0x3f);
  bytes.set(random.subarray(3), 9);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
