/**
 * The vault manifest: a root and up to 64 shards that list every live
 * object of a vault by type and hash. Fixed IDs derived from the vault ID,
 * the bucket of an object, the object hash, and reading and building the
 * plaintext. No I/O; the sync code checks and writes it.
 */
import { aad } from "../crypto/aad";
import {
  fromBase64Url,
  isJsonObject,
  toBase64Url,
  toHex,
  utf8Encode,
  type JsonObject,
} from "../crypto/bytes";
import { sodium } from "../crypto/sodium";
import { isUuid } from "../crypto/uuid";
import { clone, isPositiveInteger, own, seqOf, setOwn } from "./json";
import { OBJECT_SCHEMA, type CorruptReason, type Inspected } from "./vault";

export const MANIFEST_SHARDS = 64;

/** Type names a shard may list; later types must not break older readers. */
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** `[type, hash]` of one listed object. */
export type ManifestEntry = readonly [type: string, hash: string];

export interface ManifestRoot {
  kind: "root";
  /** Per shard `[seq, hash]`; `null` when the shard does not exist. */
  shards: readonly (readonly [seq: number, hash: string] | null)[];
}

export interface ManifestShard {
  kind: "shard";
  index: number;
  objects: ReadonlyMap<string, ManifestEntry>;
}

/** Written by a newer client: not readable here. */
export interface ManifestNewer {
  kind: "newer";
}

export type ManifestValue = ManifestRoot | ManifestShard | ManifestNewer;

export interface ManifestIds {
  root: string;
  shards: readonly string[];
  /** Shard index by ID; the root is not in it. */
  index: ReadonlyMap<string, number>;
}

function uuid8(label: string): string {
  const b = sodium().crypto_generichash(16, utf8Encode(label), null);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const idCache = new Map<string, ManifestIds>();

/** The 65 manifest IDs of a vault. */
export function manifestIds(vaultId: string): ManifestIds {
  const cached = idCache.get(vaultId);
  if (cached) return cached;
  const shards = Array.from({ length: MANIFEST_SHARDS }, (_, k) =>
    uuid8(`keeman:v1:manifest:${vaultId}:shard:${String(k)}`),
  );
  const ids: ManifestIds = {
    root: uuid8(`keeman:v1:manifest:${vaultId}:root`),
    shards,
    index: new Map(shards.map((id, k) => [id, k])),
  };
  idCache.set(vaultId, ids);
  return ids;
}

export function isManifestId(vaultId: string, id: string): boolean {
  const ids = manifestIds(vaultId);
  return id === ids.root || ids.index.has(id);
}

const bucketCache = new Map<string, number>();

/** The shard an object belongs to. */
export function bucketOf(objectId: string): number {
  const cached = bucketCache.get(objectId);
  if (cached !== undefined) return cached;
  const digest = sodium().crypto_generichash(
    32,
    utf8Encode(`keeman:v1:manifest-bucket:${objectId}`),
    null,
  );
  const bucket = (digest[0] ?? 0) & (MANIFEST_SHARDS - 1);
  bucketCache.set(objectId, bucket);
  return bucket;
}

/**
 * Hash of an object as delivered or sent: its AAD, a zero byte and the
 * Base64url text of `data` (`""` for `null`). Needs no key, so corrupt
 * objects can be listed too.
 */
export function objectHash(
  vaultId: string,
  objectId: string,
  type: string,
  keyVersion: number,
  data: string | null,
): string {
  const head = utf8Encode(aad.object(vaultId, objectId, type, keyVersion));
  const body = utf8Encode(data ?? "");
  const input = new Uint8Array(head.length + 1 + body.length);
  input.set(head);
  input.set(body, head.length + 1);
  return toBase64Url(sodium().crypto_generichash(32, input, null));
}

function isHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    fromBase64Url(value, 32);
    return true;
  } catch {
    return false;
  }
}

function readRoot(raw: JsonObject): ManifestRoot | undefined {
  const shards = own(raw, "shards");
  if (!Array.isArray(shards) || shards.length !== MANIFEST_SHARDS)
    return undefined;
  const result: (readonly [number, string] | null)[] = [];
  for (const shard of shards as unknown[]) {
    if (shard === null) {
      result.push(null);
      continue;
    }
    if (!Array.isArray(shard) || shard.length !== 2) return undefined;
    const [seq, hash] = shard as unknown[];
    if (!isPositiveInteger(seq) || !isHash(hash)) return undefined;
    result.push([seq, hash]);
  }
  return { kind: "root", shards: result };
}

function readShard(
  raw: JsonObject,
  index: number,
  vaultId: string,
): ManifestShard | undefined {
  const objects = own(raw, "objects");
  if (!isJsonObject(objects)) return undefined;
  const result = new Map<string, ManifestEntry>();
  for (const [id, value] of Object.entries(objects)) {
    if (!isUuid(id) || isManifestId(vaultId, id) || bucketOf(id) !== index)
      return undefined;
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [type, hash] = value as unknown[];
    if (
      typeof type !== "string" ||
      !TYPE_PATTERN.test(type) ||
      type === "manifest" ||
      !isHash(hash)
    )
      return undefined;
    result.set(id, [type, hash]);
  }
  return { kind: "shard", index, objects: result };
}

/**
 * Validation of a decrypted manifest object. Its ID decides whether it is
 * the root or a shard; a higher `schema` is read no further.
 */
export function inspectManifest(
  raw: JsonObject,
  objectId: string,
  vaultId: string,
): Inspected<ManifestValue> {
  const corrupt = { status: "corrupt", reason: "validation" } as const;
  const schema = own(raw, "schema");
  if (!isPositiveInteger(schema) || !isPositiveInteger(own(raw, "seq")))
    return corrupt;
  const ids = manifestIds(vaultId);
  const index = ids.index.get(objectId);
  if (objectId !== ids.root && index === undefined) return corrupt;
  const ok = (value: ManifestValue) =>
    ({
      status: "ok",
      raw,
      value,
      seq: seqOf(raw),
      readOnly: schema > OBJECT_SCHEMA,
    }) as const;
  if (schema > OBJECT_SCHEMA) return ok({ kind: "newer" });
  const value =
    index === undefined ? readRoot(raw) : readShard(raw, index, vaultId);
  return value ? ok(value) : corrupt;
}

/**
 * A shard with the given entries: a copy of `base` (unknown fields kept)
 * or a new one, `seq` as given. Entries are sorted by ID.
 */
export function shardRaw(
  base: JsonObject | undefined,
  entries: ReadonlyMap<string, ManifestEntry>,
  seq: number,
): JsonObject {
  const raw = base ? clone(base) : {};
  setOwn(raw, "schema", OBJECT_SCHEMA);
  setOwn(raw, "seq", seq);
  const objects: JsonObject = {};
  for (const id of [...entries.keys()].sort()) {
    const entry = entries.get(id);
    if (entry) setOwn(objects, id, [entry[0], entry[1]]);
  }
  setOwn(raw, "objects", objects);
  return raw;
}

/** A root with the given shard list: a copy of `base` or a new one. */
export function rootRaw(
  base: JsonObject | undefined,
  shards: readonly (readonly [number, string] | null)[],
  seq: number,
): JsonObject {
  const raw = base ? clone(base) : {};
  setOwn(raw, "schema", OBJECT_SCHEMA);
  setOwn(raw, "seq", seq);
  setOwn(
    raw,
    "shards",
    shards.map((s) => (s ? [s[0], s[1]] : null)),
  );
  return raw;
}

/** An object the server delivered as live, as last delivered. */
export interface Served {
  type: string;
  revision: number;
  hash: string;
  bucket: number;
}

/** The latest delivered version of a manifest object. */
export type ManifestRead =
  | {
      kind: "ok";
      seq: number;
      raw: JsonObject;
      value: ManifestRoot | ManifestShard;
    }
  | { kind: "newer" }
  | { kind: "corrupt"; reason: CorruptReason }
  | { kind: "absent" };

export interface ManifestInput {
  vaultId: string;
  served: ReadonlyMap<string, Served>;
  read(id: string): ManifestRead;
  /** A valid `vault_meta` with `manifest: true` was delivered. */
  flagged: boolean;
  /** Highest root `seq` this device has seen; 0 for none. */
  floor: number;
}

export type ManifestStatus = "verified" | "unverified" | "unknown" | "mismatch";

export interface ManifestIssue {
  id: string;
  type: string;
  reason: "missing" | "differs" | "unlisted" | "corrupt";
}

export interface ManifestCheck {
  status: ManifestStatus;
  issues: ManifestIssue[];
  /** Hash of the verified root. */
  rootHash?: string;
}

/**
 * Checks what the server delivered against the manifest: every shard the
 * root names is there and has its hash, every object a shard names is
 * there with its type and hash, and no live object is missing from the
 * shard of its bucket.
 */
export function checkManifest(input: ManifestInput): ManifestCheck {
  const ids = manifestIds(input.vaultId);
  const issues: ManifestIssue[] = [];
  const issue = (id: string, type: string, reason: ManifestIssue["reason"]) =>
    issues.push({ id, type, reason });
  const root = input.read(ids.root);

  if (root.kind === "absent") {
    for (const id of ids.shards)
      if (input.served.has(id)) issue(id, "manifest", "unlisted");
    if (issues.length > 0 || input.flagged || input.floor > 0) {
      issue(ids.root, "manifest", "missing");
      return { status: "mismatch", issues };
    }
    return { status: "unverified", issues };
  }
  if (root.kind === "newer") return { status: "unknown", issues };
  if (root.kind === "corrupt") {
    if (root.reason === "no_key") return { status: "unknown", issues };
    issue(ids.root, "manifest", "corrupt");
    return { status: "mismatch", issues };
  }
  if (root.value.kind !== "root") {
    issue(ids.root, "manifest", "corrupt");
    return { status: "mismatch", issues };
  }

  const shards = root.value.shards;
  const listed = new Map<string, ManifestEntry>();
  const readable = new Set<number>();
  let unreadable = false;
  for (let k = 0; k < shards.length; k++) {
    const expected = shards[k] ?? null;
    const id = ids.shards[k] ?? "";
    const served = input.served.get(id);
    if (expected === null) {
      if (served) issue(id, "manifest", "unlisted");
      continue;
    }
    if (!served) {
      issue(id, "manifest", "missing");
      continue;
    }
    if (served.hash !== expected[1]) {
      issue(id, "manifest", "differs");
      continue;
    }
    const shard = input.read(id);
    if (
      shard.kind === "newer" ||
      (shard.kind === "corrupt" && shard.reason === "no_key")
    ) {
      unreadable = true;
      continue;
    }
    if (shard.kind !== "ok" || shard.value.kind !== "shard") {
      issue(id, "manifest", "corrupt");
      continue;
    }
    if (shard.seq !== expected[0]) {
      issue(id, "manifest", "differs");
      continue;
    }
    readable.add(k);
    for (const [objectId, entry] of shard.value.objects)
      listed.set(objectId, entry);
  }

  for (const [id, [type, hash]] of listed) {
    const served = input.served.get(id);
    if (!served) issue(id, type, "missing");
    else if (served.type !== type || served.hash !== hash)
      issue(id, served.type, "differs");
  }
  for (const [id, served] of input.served) {
    if (served.type === "manifest" || id === ids.root || ids.index.has(id))
      continue;
    const expected = shards[served.bucket];
    if (expected === null || (readable.has(served.bucket) && !listed.has(id)))
      issue(id, served.type, "unlisted");
  }

  if (issues.length > 0) return { status: "mismatch", issues };
  if (unreadable) return { status: "unknown", issues };
  const rootHash = input.served.get(ids.root)?.hash;
  return rootHash === undefined
    ? { status: "verified", issues }
    : { status: "verified", issues, rootHash };
}
