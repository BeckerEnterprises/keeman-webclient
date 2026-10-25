/**
 * Three-way merge of entries after `409 conflict`: the location
 * as a unit, content per field; where both sides changed a field, the
 * server wins and the local version becomes a conflict snapshot.
 */
import type { JsonObject } from "../crypto/bytes";
import {
  historyOf,
  LOCATION_FIELDS,
  sameEntryContent,
  setHistory,
  snapshotOf,
} from "./history";
import { clone, own, same, seqOf, setOwn } from "./json";
import type { Stamp } from "./vault";

const SKIPPED: ReadonlySet<string> = new Set([
  "schema",
  "seq",
  "created",
  "modified",
  "modifiedBy",
  "history",
  ...LOCATION_FIELDS,
]);

function location(raw: JsonObject): unknown[] {
  return LOCATION_FIELDS.map((key) => own(raw, key));
}

function put(target: JsonObject, key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(target, key);
  else setOwn(target, key, value);
}

export interface EntryMerge {
  merged: JsonObject;
  /** Fields where the local value lost; never values. */
  conflicts: string[];
}

/** Throws `EntryTooLarge` if a needed conflict snapshot cannot be stored. */
export function mergeEntry(
  baseRaw: JsonObject,
  local: JsonObject,
  server: JsonObject,
  stamp: Stamp,
  historyMaxItems: number,
): EntryMerge {
  const merged = clone(server);
  const localMoved = !same(location(local), location(baseRaw));
  const serverMoved = !same(location(server), location(baseRaw));
  if (localMoved && !serverMoved)
    for (const key of LOCATION_FIELDS) put(merged, key, own(local, key));
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(baseRaw), ...Object.keys(local)]);
  for (const key of keys) {
    if (SKIPPED.has(key)) continue;
    const before = own(baseRaw, key);
    const after = own(local, key);
    if (same(before, after)) continue;
    const current = own(server, key);
    if (same(current, after)) continue;
    if (!same(current, before)) {
      conflicts.push(key);
      continue;
    }
    put(merged, key, clone({ value: after }).value);
  }
  conflicts.sort();
  const snapshots: unknown[] = [];
  if (conflicts.length > 0) {
    const conflict = snapshotOf(local);
    setOwn(conflict, "conflict", true);
    snapshots.push(conflict);
  }
  if (!sameEntryContent(merged, server)) snapshots.push(snapshotOf(server));
  setHistory(
    merged,
    [...snapshots, ...historyOf(server)],
    historyMaxItems,
    conflicts.length > 0 ? 1 : 0,
  );
  setOwn(merged, "seq", Math.max(seqOf(baseRaw), seqOf(server)) + 1);
  setOwn(merged, "modified", stamp.now);
  setOwn(merged, "modifiedBy", stamp.userId);
  return { merged, conflicts };
}
