/**
 * Helpers for untrusted decrypted JSON: own properties only, copies
 * instead of merging parsed objects, `__proto__` stays a plain key.
 */
import type { JsonObject } from "../crypto/bytes";

/** Sets an own property, also for keys like `__proto__` from untrusted data. */
export function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function own(object: JsonObject, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined;
}

export function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function seqOf(raw: JsonObject): number {
  const seq = own(raw, "seq");
  return typeof seq === "number" ? seq : 0;
}
