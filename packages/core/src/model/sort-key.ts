/**
 * Order of siblings: fractional-indexing keys, then the name, then
 * the ID. Moving changes only the moved objects unless the neighbours'
 * keys are unusable; then every sibling gets a new key.
 */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export interface Sibling {
  readonly id: string;
  readonly sortKey: string;
  readonly name: string;
}

/** A key the library can work with; `""` and foreign formats are not. */
export function isSortKey(key: string): boolean {
  if (key === "") return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function siblingOrder(
  collator: Intl.Collator,
): (a: Sibling, b: Sibling) => number {
  return (a, b) =>
    compareCodeUnits(a.sortKey, b.sortKey) ||
    collator.compare(a.name, b.name) ||
    compareCodeUnits(a.id, b.id);
}

export interface Insertion {
  /** Keys for the inserted objects, in order. */
  keys: string[];
  /** New keys for siblings whose key had to change. */
  rekey: Map<string, string>;
}

/**
 * Keys for `count` objects inserted at `index` into `siblings` (sorted,
 * without the inserted objects). Falls back to new keys for all siblings
 * when a neighbour key is invalid or the neighbours are not in order.
 */
export function keysForInsert(
  siblings: readonly Sibling[],
  index: number,
  count: number,
): Insertion {
  const before = siblings[index - 1]?.sortKey;
  const after = siblings[index]?.sortKey;
  const usable =
    (before === undefined || isSortKey(before)) &&
    (after === undefined || isSortKey(after)) &&
    (before === undefined || after === undefined || before < after);
  if (usable)
    return {
      keys: generateNKeysBetween(before ?? null, after ?? null, count),
      rekey: new Map(),
    };
  const all = generateNKeysBetween(null, null, siblings.length + count);
  const rekey = new Map<string, string>();
  siblings.forEach((sibling, position) => {
    const key = all[position < index ? position : position + count] ?? "";
    if (key !== sibling.sortKey) rekey.set(sibling.id, key);
  });
  return { keys: all.slice(index, index + count), rekey };
}

/** `count` keys after every valid key; invalid keys are ignored. */
export function keysAtEnd(keys: Iterable<string>, count: number): string[] {
  let last: string | undefined;
  for (const key of keys)
    if (isSortKey(key) && (last === undefined || key > last)) last = key;
  return generateNKeysBetween(last ?? null, null, count);
}

export function keyAtEnd(keys: Iterable<string>): string {
  return keysAtEnd(keys, 1)[0] ?? "";
}
