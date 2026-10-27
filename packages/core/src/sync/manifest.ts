/**
 * The vault manifest in sync: what the server delivered as live (`served`),
 * the check of a vault's state against the manifest, and the current root
 * and shards a write starts from.
 */
import type { ChangedObject } from "../api/schemas";
import {
  bucketOf,
  checkManifest,
  inspectManifest,
  manifestIds,
  objectHash,
  type ManifestCheck,
  type ManifestEntry,
  type ManifestRead,
  type ManifestRoot,
  type ManifestShard,
  type Served,
} from "../model/manifest";
import type { VaultMarks } from "./marks";
import type { ObjectEntry, VaultState } from "./vault";

export type {
  ManifestCheck,
  ManifestIssue,
  ManifestStatus,
  Served,
} from "../model/manifest";

/** Takes one delivered object into `served`; the higher revision wins. */
export function serve(
  served: Map<string, Served>,
  vaultId: string,
  object: ChangedObject,
): void {
  const known = served.get(object.id);
  if (known && known.revision > object.revision) return;
  if (object.deleted) {
    served.delete(object.id);
    return;
  }
  served.set(object.id, {
    type: object.type,
    revision: object.revision,
    hash: objectHash(
      vaultId,
      object.id,
      object.type,
      object.key_version,
      object.data,
    ),
    bucket: bucketOf(object.id),
  });
}

/** The latest delivered version of a manifest object in the vault state. */
function read(state: VaultState, id: string): ManifestRead {
  const corrupt = state.corrupt.get(id);
  if (corrupt) return { kind: "corrupt", reason: corrupt.reason };
  const entry = state.objects.get(id);
  if (!entry) return { kind: "absent" };
  const inspected = inspectManifest(entry.raw, id, state.id);
  if (inspected.status === "corrupt")
    return { kind: "corrupt", reason: inspected.reason };
  if (inspected.value.kind === "newer") return { kind: "newer" };
  return {
    kind: "ok",
    seq: entry.seq,
    raw: entry.raw,
    value: inspected.value,
  };
}

/** The current root, if it can be read. */
export function currentRoot(
  state: VaultState,
): { entry: ObjectEntry; value: ManifestRoot } | undefined {
  const id = manifestIds(state.id).root;
  const root = read(state, id);
  const entry = state.objects.get(id);
  return root.kind === "ok" && root.value.kind === "root" && entry
    ? { entry, value: root.value }
    : undefined;
}

/** The current shard `k`, if it exists and can be read. */
export function currentShard(
  state: VaultState,
  k: number,
): { entry: ObjectEntry; value: ManifestShard } | undefined {
  const id = manifestIds(state.id).shards[k] ?? "";
  const shard = read(state, id);
  const entry = state.objects.get(id);
  return shard.kind === "ok" && shard.value.kind === "shard" && entry
    ? { entry, value: shard.value }
    : undefined;
}

/** Highest root `seq` this device has seen: `mf` and the object mark. */
export function rootFloor(state: VaultState, marks: VaultMarks | undefined) {
  const objectMark = marks?.obj[manifestIds(state.id).root] ?? 0;
  return Math.max(
    marks?.mf ?? 0,
    objectMark > 0 ? objectMark : 0,
    state.manifestFloor,
  );
}

/** Live delivered objects outside the manifest, by bucket. */
export function servedEntries(
  served: ReadonlyMap<string, Served>,
  vaultId: string,
): Map<number, Map<string, ManifestEntry>> {
  const ids = manifestIds(vaultId);
  const buckets = new Map<number, Map<string, ManifestEntry>>();
  for (const [id, object] of served) {
    if (object.type === "manifest" || id === ids.root || ids.index.has(id))
      continue;
    let bucket = buckets.get(object.bucket);
    if (!bucket) {
      bucket = new Map();
      buckets.set(object.bucket, bucket);
    }
    bucket.set(id, [object.type, object.hash]);
  }
  return buckets;
}

/** Checks what the server delivered for the vault against its manifest. */
export function verifyManifest(
  state: VaultState,
  marks: VaultMarks | undefined,
): ManifestCheck {
  return checkManifest({
    vaultId: state.id,
    served: state.served,
    read: (id) => read(state, id),
    flagged: !state.corrupt.has(state.id) && state.meta?.raw.manifest === true,
    floor: rootFloor(state, marks),
  });
}
