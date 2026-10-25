/**
 * Entry history: what counts as content, snapshots, trimming by
 * count and size, restoring and the fields that differ between two states.
 */
import { isJsonObject, type JsonObject } from "../crypto/bytes";
import { clone, own, same, setOwn } from "./json";

/** Not content: bookkeeping, the location and the history itself. */
const NOT_CONTENT: ReadonlySet<string> = new Set([
  "schema",
  "seq",
  "created",
  "modified",
  "modifiedBy",
  "parentId",
  "sortKey",
  "previousParentId",
  "history",
]);

/** Fields that describe where an entry or group lies. */
export const LOCATION_FIELDS = ["parentId", "sortKey", "previousParentId"];

/** Size limit of an entry in UTF-8 bytes of its JSON. */
export const ENTRY_LIMIT = 1024 * 1024;

export class EntryTooLarge extends Error {
  override readonly name = "EntryTooLarge";
}

/** Content keys of an entry or snapshot; a snapshot's `conflict` mark is none. */
export function contentKeys(raw: JsonObject): string[] {
  return Object.keys(raw).filter(
    (key) => !NOT_CONTENT.has(key) && key !== "conflict",
  );
}

function content(raw: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of contentKeys(raw).sort()) setOwn(result, key, raw[key]);
  return result;
}

export function sameEntryContent(a: JsonObject, b: JsonObject): boolean {
  return same(content(a), content(b));
}

/** Content fields whose values differ (for highlighting changes). */
export function changedFields(a: JsonObject, b: JsonObject): string[] {
  const keys = new Set([...contentKeys(a), ...contentKeys(b)]);
  return [...keys].filter((key) => !same(own(a, key), own(b, key))).sort();
}

/** The stored state as a snapshot: everything except `history`. */
export function snapshotOf(raw: JsonObject): JsonObject {
  const snapshot = clone(raw);
  Reflect.deleteProperty(snapshot, "history");
  return snapshot;
}

export function historyOf(raw: JsonObject): unknown[] {
  const history = own(raw, "history");
  return Array.isArray(history) ? (history as unknown[]) : [];
}

export function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      length += 4;
      i++;
    } else length += 3;
  }
  return length;
}

/**
 * Sets `history` (newest first): at most `maxItems` snapshots, then the
 * oldest dropped until the entry fits 1 MiB. The first `keep` snapshots
 * are never dropped; if it still does not fit, `EntryTooLarge`.
 */
export function setHistory(
  raw: JsonObject,
  snapshots: unknown[],
  maxItems: number,
  keep = 0,
): void {
  if (keep > maxItems) throw new EntryTooLarge("History cannot hold it");
  const history = snapshots.slice(0, maxItems);
  setOwn(raw, "history", history);
  let size = utf8Length(JSON.stringify(raw));
  while (size > ENTRY_LIMIT && history.length > keep) {
    const dropped = history.pop();
    size -= utf8Length(JSON.stringify(dropped));
    if (history.length > 0) size -= 1;
  }
  if (size > ENTRY_LIMIT) throw new EntryTooLarge("Entry exceeds 1 MiB");
}

/** Restorable: an object with a schema this client understands. */
export function restorable(snapshot: unknown): snapshot is JsonObject {
  if (!isJsonObject(snapshot)) return false;
  const schema = own(snapshot, "schema");
  return schema === undefined || schema === 1;
}

/**
 * The entry with the content of `snapshot`: content keys missing in the
 * snapshot are removed; location and bookkeeping stay. No history change.
 */
export function withContentOf(
  raw: JsonObject,
  snapshot: JsonObject,
): JsonObject {
  const next = clone(raw);
  for (const key of contentKeys(next)) Reflect.deleteProperty(next, key);
  for (const key of contentKeys(snapshot))
    setOwn(next, key, clone({ value: snapshot[key] }).value);
  return next;
}
