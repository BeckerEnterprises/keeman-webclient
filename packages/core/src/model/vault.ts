/**
 * Decrypted vault objects: validation with defaults, changes that
 * keep unknown fields, the three-way merge after `409 conflict` and the
 * location of groups in the tree. The raw JSON stays the source of truth.
 */
import { isJsonObject, type JsonObject } from "../crypto/bytes";
import { isTimestamp } from "../crypto/time";
import { isUuid } from "../crypto/uuid";
import { LOCATION_FIELDS } from "./history";
import {
  clone,
  hasOwn,
  isPositiveInteger,
  own,
  same,
  seqOf,
  setOwn,
} from "./json";

export const OBJECT_SCHEMA = 1;

export type IconRef =
  { type: "builtin"; name: string } | { type: "custom"; id: string };

export interface VaultMeta {
  name: string;
  description: string;
  icon: IconRef;
  color: string | null;
  rootGroupId: string;
  recycleBinGroupId: string | null;
  recycleBinEnabled: boolean;
  historyMaxItems: number;
}

export interface Group {
  name: string;
  parentId: string | null;
  sortKey: string;
  icon: IconRef;
  /** Copied into new entries of this group; `null`: inherited. */
  defaultEntryIcon: IconRef | null;
  notes: string;
  /** Only meaningful in the recycle bin. */
  previousParentId: string | undefined;
}

export type CorruptReason =
  | "no_key"
  | "no_data"
  | "dropped"
  | "format"
  | "auth"
  | "padding"
  | "encoding"
  | "validation";

export type Inspected<T> =
  | { status: "ok"; raw: JsonObject; value: T; seq: number; readOnly: boolean }
  | { status: "corrupt"; reason: CorruptReason };

/** Bookkeeping fields: never part of a merge or a content comparison. */
const BOOKKEEPING = new Set([
  "schema",
  "seq",
  "created",
  "modified",
  "modifiedBy",
]);

const COLOR = /^#[0-9A-Fa-f]{6}$/;

/** A valid `IconRef` or `undefined`. */
export function parseIconRef(value: unknown): IconRef | undefined {
  if (!isJsonObject(value)) return undefined;
  const type = own(value, "type");
  const name = own(value, "name");
  const id = own(value, "id");
  if (type === "builtin" && typeof name === "string" && name !== "")
    return { type, name };
  if (type === "custom" && isUuid(id)) return { type, id };
  return undefined;
}

function iconRef(value: unknown, fallback: string): IconRef {
  return parseIconRef(value) ?? { type: "builtin", name: fallback };
}

function string(raw: JsonObject, key: string, fallback: string): string {
  const value = own(raw, key);
  return typeof value === "string" ? value : fallback;
}

/** `schema` and `seq` of any object, then the type's own reading. */
export function inspectBase<T>(
  raw: JsonObject,
  read: (raw: JsonObject) => T | undefined,
): Inspected<T> {
  const schema = own(raw, "schema");
  if (!isPositiveInteger(schema) || !isPositiveInteger(own(raw, "seq")))
    return { status: "corrupt", reason: "validation" };
  const value = read(raw);
  if (value === undefined) return { status: "corrupt", reason: "validation" };
  return {
    status: "ok",
    raw,
    value,
    seq: seqOf(raw),
    readOnly: schema > OBJECT_SCHEMA,
  };
}

/** `vault_meta`; its object ID must be the vault ID. */
export function inspectVaultMeta(
  raw: JsonObject,
  objectId: string,
  vaultId: string,
): Inspected<VaultMeta> {
  if (objectId !== vaultId) return { status: "corrupt", reason: "validation" };
  return inspectBase(raw, (r) => {
    const name = own(r, "name");
    const rootGroupId = own(r, "rootGroupId");
    if (typeof name !== "string" || !isUuid(rootGroupId)) return undefined;
    const bin = own(r, "recycleBinGroupId");
    const history = own(r, "historyMaxItems");
    const color = own(r, "color");
    const enabled = own(r, "recycleBinEnabled");
    return {
      name,
      description: string(r, "description", ""),
      icon: iconRef(own(r, "icon"), "database"),
      color: typeof color === "string" && COLOR.test(color) ? color : null,
      rootGroupId,
      recycleBinGroupId: isUuid(bin) ? bin : null,
      recycleBinEnabled: typeof enabled === "boolean" ? enabled : true,
      historyMaxItems:
        typeof history === "number" &&
        Number.isInteger(history) &&
        history >= 0 &&
        history <= 100
          ? history
          : 10,
    };
  });
}

/** `group`. */
export function inspectGroup(raw: JsonObject): Inspected<Group> {
  return inspectBase(raw, (r) => {
    const name = own(r, "name");
    const parentId = own(r, "parentId");
    if (typeof name !== "string" || !hasOwn(r, "parentId")) return undefined;
    if (parentId !== null && !isUuid(parentId)) return undefined;
    const previous = own(r, "previousParentId");
    return {
      name,
      parentId,
      sortKey: string(r, "sortKey", ""),
      icon: iconRef(own(r, "icon"), "folder"),
      defaultEntryIcon: parseIconRef(own(r, "defaultEntryIcon")) ?? null,
      notes: string(r, "notes", ""),
      previousParentId: isUuid(previous) ? previous : undefined,
    };
  });
}

/** Who changes what when. */
export interface Stamp {
  now: string;
  userId: string;
}

/**
 * A copy with the changed fields; `undefined` removes a field. Sets
 * `modified`, `modifiedBy` and increases `seq`.
 */
export function applyObjectChange(
  raw: JsonObject,
  change: Readonly<Record<string, unknown>>,
  stamp: Stamp,
): JsonObject {
  const next = clone(raw);
  for (const [key, value] of Object.entries(change)) {
    if (BOOKKEEPING.has(key)) throw new Error(`Cannot change ${key}`);
    if (value === undefined) Reflect.deleteProperty(next, key);
    else setOwn(next, key, value);
  }
  setOwn(next, "modified", stamp.now);
  setOwn(next, "modifiedBy", stamp.userId);
  setOwn(next, "seq", seqOf(raw) + 1);
  return next;
}

export interface DiscardedChange {
  field: string;
  /** The local value that lost; `undefined` if the field was removed. */
  value: unknown;
}

/**
 * Three-way merge of `vault_meta` and `group`: local changes on
 * top of the server copy; where both changed a field, the server wins.
 */
export function mergeObject(
  baseRaw: JsonObject,
  local: JsonObject,
  server: JsonObject,
  stamp: Stamp,
): { merged: JsonObject; discarded: DiscardedChange[] } {
  const merged = clone(server);
  const discarded: DiscardedChange[] = [];
  // The location counts as one field; a lost move gives no notice.
  const where = (raw: JsonObject) => LOCATION_FIELDS.map((k) => own(raw, k));
  if (
    !same(where(local), where(baseRaw)) &&
    same(where(server), where(baseRaw))
  )
    for (const key of LOCATION_FIELDS) {
      const value = own(local, key);
      if (value === undefined) Reflect.deleteProperty(merged, key);
      else setOwn(merged, key, value);
    }
  const keys = new Set([...Object.keys(baseRaw), ...Object.keys(local)]);
  for (const key of keys) {
    if (BOOKKEEPING.has(key) || LOCATION_FIELDS.includes(key)) continue;
    const before = own(baseRaw, key);
    const after = own(local, key);
    if (same(before, after)) continue;
    const current = own(server, key);
    if (same(current, after)) continue;
    if (!same(current, before)) {
      discarded.push({ field: key, value: after });
      continue;
    }
    if (after === undefined) Reflect.deleteProperty(merged, key);
    else setOwn(merged, key, after);
  }
  setOwn(merged, "seq", Math.max(seqOf(baseRaw), seqOf(server)) + 1);
  setOwn(merged, "modified", stamp.now);
  setOwn(merged, "modifiedBy", stamp.userId);
  return { merged, discarded };
}

/** Same content apart from bookkeeping. */
export function sameContent(a: JsonObject, b: JsonObject): boolean {
  const strip = (raw: JsonObject) =>
    Object.fromEntries(
      Object.keys(raw)
        .filter((key) => !BOOKKEEPING.has(key))
        .sort()
        .map((key) => [key, own(raw, key)]),
    );
  return same(strip(a), strip(b));
}

/** Names of vaults and groups as entered: trimmed, 1–256 code points. */
export function normalizeName(text: string): string | undefined {
  const name = text.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 256 ? name : undefined;
}

export function newVaultMeta(
  input: {
    name: string;
    rootGroupId: string;
    recycleBinGroupId: string;
  },
  stamp: Stamp,
): JsonObject {
  return {
    schema: OBJECT_SCHEMA,
    seq: 1,
    name: input.name,
    description: "",
    icon: { type: "builtin", name: "database" },
    color: null,
    rootGroupId: input.rootGroupId,
    recycleBinGroupId: input.recycleBinGroupId,
    recycleBinEnabled: true,
    historyMaxItems: 10,
    created: stamp.now,
    modified: stamp.now,
    modifiedBy: stamp.userId,
  };
}

export function newGroup(
  input: {
    name: string;
    parentId: string | null;
    sortKey?: string;
    icon?: IconRef | null;
    defaultEntryIcon?: IconRef | null;
    notes?: string;
  },
  stamp: Stamp,
): JsonObject {
  return {
    schema: OBJECT_SCHEMA,
    seq: 1,
    parentId: input.parentId,
    sortKey: input.sortKey ?? "",
    name: input.name,
    icon: input.icon ?? { type: "builtin", name: "folder" },
    defaultEntryIcon: input.defaultEntryIcon ?? null,
    notes: input.notes ?? "",
    created: stamp.now,
    modified: stamp.now,
    modifiedBy: stamp.userId,
  };
}

/** Validates a timestamp field for display; anything else is unknown. */
export function timestampOf(raw: JsonObject, key: string): string | undefined {
  const value = own(raw, key);
  return isTimestamp(value) ? value : undefined;
}
