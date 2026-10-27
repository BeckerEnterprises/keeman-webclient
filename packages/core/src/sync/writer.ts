/**
 * Writing to a vault: a plan becomes one batch with a new
 * Idempotency-Key; after `409 conflict` the vault is synced, the plan runs
 * again on the new state and changes are merged per type, at
 * most three attempts. Every batch of a vault with a manifest also writes
 * the root and the shards it touches; conflicts only on those are planned
 * again without counting. The caller holds the vault's lock.
 */
import { ApiError, NetworkError } from "../api/errors";
import type { BatchResult } from "../api/schemas";
import type { ObjectType } from "../crypto/aad";
import type { JsonObject } from "../crypto/bytes";
import { encryptObject, encryptTombstone } from "../crypto/objects";
import { systemRandomness } from "../crypto/random";
import { EntryTooLarge, utf8Length } from "../model/history";
import { seqOf } from "../model/json";
import {
  bucketOf,
  isManifestId,
  MANIFEST_SHARDS,
  manifestIds,
  nextRoot,
  nextShards,
  objectHash,
  rootRaw,
  shardRaw,
  type CurrentShard,
  type ManifestEntry,
} from "../model/manifest";
import { mergeEntry } from "../model/merge";
import {
  inspectVaultMeta,
  mergeObject,
  sameContent,
  type Stamp,
} from "../model/vault";
import { SyncError } from "./errors";
import {
  currentRoot,
  currentShard,
  servedEntries,
  verifyManifest,
} from "./manifest";
import { objectMark } from "./marks";
import type { ObjectEntry, SyncContext, VaultState } from "./vault";

export type Intent =
  | { kind: "create"; id: string; type: ObjectType; content: JsonObject }
  | {
      kind: "update";
      id: string;
      /** The version the change is based on. */
      baseRaw: JsonObject;
      baseRevision: number;
      /** `baseRaw` with the change applied (bookkeeping included). */
      local: JsonObject;
      /** The repair of invalid list elements may write such an entry. */
      allowInvalid?: boolean;
    }
  | { kind: "delete"; id: string; baseRevision: number };

/** What happened to parts of a change after a conflict. */
export type Notice =
  | { kind: "discarded"; objectId: string; field: string; value: unknown }
  /** Entries: the local version is in the history; field names only. */
  | { kind: "entry_conflict"; objectId: string; fields: string[] }
  | { kind: "deleted_meanwhile"; objectId: string }
  | { kind: "changed_meanwhile"; objectId: string }
  | { kind: "exists"; objectId: string };

export interface WriteResult {
  notices: Notice[];
}

export interface PlanInfo {
  /** 1 for the first attempt. */
  attempt: number;
  /** IDs a conflict reported as tombstones: a new object needs another ID. */
  tombstones: ReadonlySet<string>;
}

/** Evaluated before every attempt, against the current state. */
export type Plan = (state: VaultState, info: PlanInfo) => Intent[];

interface Planned {
  id: string;
  type: ObjectType;
  op: Record<string, unknown>;
  /** New content; `undefined` for a deletion. */
  raw: JsonObject | undefined;
  seq: number;
  /** Manifest hash of a put. */
  hash?: string;
}

/**
 * How a write treats the manifest: kept up to date (the default, once the
 * vault has one), created from what the server delivered, or rebuilt to
 * match it after the user accepted a mismatch.
 */
export type ManifestMode = "update" | "create" | "rebuild";

export interface Pending {
  key: string;
  body: string;
  planned: Planned[];
  notices: Notice[];
}

const MAX_ATTEMPTS = 3;
/** Including retries after conflicts on the manifest alone. */
const MAX_TOTAL_ATTEMPTS = 6;
const MAX_OPS = 500;
/** The server takes 16 MiB; the client plans 12 MiB plus the manifest. */
const MAX_BODY_CHARS = 15 * 1024 * 1024;

/** Plaintext limits in UTF-8 bytes. */
const SIZE_LIMITS: Record<ObjectType, number> = {
  vault_meta: 16 * 1024,
  group: 64 * 1024,
  entry: 1024 * 1024,
  icon: 64 * 1024,
  // A shard; the root stays far below its 16 KiB.
  manifest: 1024 * 1024,
};

/** Worth sending again unchanged; `507 quota_exceeded` does not pass by waiting. */
export function isTransient(error: unknown): boolean {
  return (
    (error instanceof NetworkError && error.reason !== "response") ||
    (error instanceof ApiError &&
      ((error.status >= 500 && error.status !== 507) || error.status === 408))
  );
}

/**
 * The vault as a whole may be written. A mismatch with the manifest or an
 * unreadable manifest blocks writing, except for the rebuild itself.
 */
export function vaultWritable(state: VaultState, rebuild = false): boolean {
  const meta = state.meta;
  const root = state.objects.get(manifestIds(state.id).root);
  const manifest = state.manifest.status;
  return (
    state.keyOk &&
    state.keyStatus === "ok" &&
    state.synced &&
    !state.rollback &&
    meta !== undefined &&
    !meta.readOnly &&
    !meta.rollback &&
    !meta.superseded &&
    (rebuild ||
      (manifest !== "mismatch" &&
        manifest !== "unknown" &&
        !(root?.rollback ?? false)))
  );
}

export function objectWritable(
  entry: ObjectEntry,
  allowInvalid = false,
): boolean {
  return (
    !entry.readOnly &&
    !entry.rollback &&
    !entry.superseded &&
    (allowInvalid || !entry.invalid)
  );
}

function historyMaxItems(state: VaultState): number {
  const meta = state.meta;
  const inspected = meta && inspectVaultMeta(meta.raw, meta.id, state.id);
  return inspected?.status === "ok" ? inspected.value.historyMaxItems : 10;
}

/** The entries of a shard with the planned ops applied. */
function withOps(
  entries: Map<string, ManifestEntry>,
  planned: readonly Planned[],
): Map<string, ManifestEntry> {
  for (const p of planned) {
    if (p.hash === undefined) entries.delete(p.id);
    else entries.set(p.id, [p.type, p.hash]);
  }
  return entries;
}

function sameEntries(
  a: ReadonlyMap<string, ManifestEntry>,
  b: ReadonlyMap<string, ManifestEntry>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, [type, hash]] of a) {
    const other = b.get(id);
    if (!other || other[0] !== type || other[1] !== hash) return false;
  }
  return true;
}

export class WriteOperation {
  readonly #context: SyncContext;
  readonly #state: VaultState;
  readonly #plan: Plan;
  readonly #pull: () => Promise<void>;
  readonly #now: () => string;
  readonly #mode: ManifestMode;
  readonly #tombstones = new Set<string>();
  #attempts = 0;
  /** Conflicts that needed more than recomputing the manifest. */
  #conflicts = 0;

  constructor(
    context: SyncContext,
    state: VaultState,
    plan: Plan,
    pull: () => Promise<void>,
    now: () => string,
    mode: ManifestMode = "update",
  ) {
    this.#context = context;
    this.#state = state;
    this.#plan = plan;
    this.#pull = pull;
    this.#now = now;
    this.#mode = mode;
  }

  async run(pending?: Pending): Promise<WriteResult> {
    let current = pending;
    for (;;) {
      if (!current) {
        if (
          this.#conflicts >= MAX_ATTEMPTS ||
          this.#attempts >= MAX_TOTAL_ATTEMPTS
        )
          throw new SyncError("conflict_unresolved");
        this.#attempts++;
        const notices: Notice[] = [];
        const planned = this.#build(notices);
        if (planned.length === 0) return { notices };
        current = {
          key: systemRandomness.id("idempotency_key"),
          body: JSON.stringify({ ops: planned.map((p) => p.op) }),
          planned,
          notices,
        };
      }
      let result: BatchResult;
      try {
        result = await this.#context.api.batch(
          this.#state.id,
          current.key,
          current.body,
        );
      } catch (error) {
        // A conflict only on the manifest, or a root this device did not
        // know about: sync and compute the manifest again, uncounted.
        if (error instanceof ApiError && error.code === "manifest_required") {
          current = undefined;
          await this.#pull();
          continue;
        }
        if (error instanceof ApiError && error.code === "conflict") {
          const conflicts = error.details.conflicts ?? [];
          for (const conflict of conflicts)
            if (conflict.deleted) this.#tombstones.add(conflict.id);
          if (
            conflicts.length === 0 ||
            !conflicts.every((c) => isManifestId(this.#state.id, c.id))
          )
            this.#conflicts++;
          current = undefined;
          await this.#pull();
          continue;
        }
        throw this.#translate(error, current);
      }
      await this.#apply(current.planned, result);
      return { notices: current.notices };
    }
  }

  /** For `network`: the same request again, run by the caller. */
  #translate(error: unknown, pending: Pending): unknown {
    if (isTransient(error)) return new RetryableWrite(pending);
    if (error instanceof ApiError) {
      if (error.code === "stale_key_version") return new SyncError("stale_key");
      if (error.code === "not_found") return new SyncError("not_found");
      if (error.code === "forbidden") return new SyncError("read_only");
    }
    return error;
  }

  #build(notices: Notice[]): Planned[] {
    const state = this.#state;
    // After a conflict another device may have done it already.
    if (
      (this.#mode === "create" && state.manifest.status !== "unverified") ||
      (this.#mode === "rebuild" && state.manifest.status !== "mismatch")
    )
      return [];
    if (!vaultWritable(state, this.#mode === "rebuild"))
      throw new SyncError("read_only");
    const stamp: Stamp = { now: this.#now(), userId: this.#context.userId };
    const intents = this.#plan(state, {
      attempt: this.#attempts,
      tombstones: this.#tombstones,
    });
    const planned: Planned[] = [];
    for (const intent of intents) {
      const current = state.objects.get(intent.id);
      switch (intent.kind) {
        case "create": {
          if (
            current ||
            state.corrupt.has(intent.id) ||
            this.#tombstones.has(intent.id)
          ) {
            // A repetition that already arrived counts as done.
            if (!(current && sameContent(current.raw, intent.content)))
              notices.push({ kind: "exists", objectId: intent.id });
            continue;
          }
          planned.push(this.#put(intent.id, intent.type, intent.content, null));
          break;
        }
        case "update": {
          if (!current) {
            notices.push({ kind: "deleted_meanwhile", objectId: intent.id });
            continue;
          }
          if (!objectWritable(current, intent.allowInvalid))
            throw new SyncError("read_only");
          const raw =
            current.revision === intent.baseRevision
              ? intent.local
              : this.#merge(current, intent, stamp, notices);
          planned.push(
            this.#put(intent.id, current.type, raw, current.revision),
          );
          break;
        }
        case "delete": {
          if (!current) continue;
          if (current.revision !== intent.baseRevision) {
            notices.push({ kind: "changed_meanwhile", objectId: intent.id });
            continue;
          }
          if (!objectWritable(current)) throw new SyncError("read_only");
          planned.push(this.#delete(current, stamp));
          break;
        }
      }
    }
    if (planned.length === 0 && this.#mode !== "rebuild") return planned;
    const manifest =
      this.#mode === "update"
        ? state.manifest.status === "verified"
          ? this.#updated(planned)
          : []
        : this.#rebuilt(planned, this.#mode === "create");
    const all = [...planned, ...manifest];
    if (
      all.length > MAX_OPS ||
      JSON.stringify(all.map((p) => p.op)).length > MAX_BODY_CHARS
    )
      throw new SyncError("too_large");
    return all;
  }

  /** Root and touched shards for a vault whose manifest checked out. */
  #updated(planned: readonly Planned[]): Planned[] {
    const state = this.#state;
    const ids = manifestIds(state.id);
    const root = currentRoot(state);
    if (!root) throw new SyncError("read_only");
    const shards = new Map<number, CurrentShard>();
    const revisions = new Map<number, number>();
    for (const p of planned) {
      const k = bucketOf(p.id);
      const shard = currentShard(state, k);
      if (root.value.shards[k] && !shard) throw new SyncError("read_only");
      if (shard) {
        shards.set(k, {
          raw: shard.entry.raw,
          seq: shard.entry.seq,
          objects: shard.value.objects,
        });
        revisions.set(k, shard.entry.revision);
      }
    }
    const ops: Planned[] = [];
    const written = nextShards(
      shards,
      planned.map((p) => ({ id: p.id, type: p.type, hash: p.hash })),
    ).map((shard) => {
      const op = this.#put(
        ids.shards[shard.index] ?? "",
        "manifest",
        shard.raw,
        revisions.get(shard.index) ?? null,
      );
      ops.push(op);
      return { index: shard.index, seq: shard.seq, hash: op.hash ?? "" };
    });
    const next = nextRoot(
      { raw: root.entry.raw, seq: root.entry.seq, value: root.value },
      state.manifestFloor,
      written,
    );
    ops.push(this.#put(ids.root, "manifest", next.raw, root.entry.revision));
    return ops;
  }

  /**
   * The manifest of what the server delivered plus the planned ops: every
   * shard on creating, the ones that differ on a rebuild. An object whose
   * `seq` is unknown (corrupt) goes above the vault revision, which no
   * honest manifest `seq` exceeds.
   */
  #rebuilt(planned: readonly Planned[], create: boolean): Planned[] {
    const state = this.#state;
    const ids = manifestIds(state.id);
    const buckets = servedEntries(state.served, state.id);
    for (const p of planned) {
      const k = bucketOf(p.id);
      buckets.set(
        k,
        withOps(buckets.get(k) ?? new Map<string, ManifestEntry>(), [p]),
      );
    }
    const unknownSeq = Math.max(state.manifestFloor, state.since) + 1;
    const shards: ([number, string] | null)[] = [];
    const ops: Planned[] = [];
    for (let k = 0; k < MANIFEST_SHARDS; k++) {
      const id = ids.shards[k] ?? "";
      const entries = buckets.get(k) ?? new Map<string, ManifestEntry>();
      const served = create ? undefined : state.served.get(id);
      const shard = create ? undefined : currentShard(state, k);
      if (!served && entries.size === 0) {
        shards.push(null);
        continue;
      }
      if (served && shard && sameEntries(shard.value.objects, entries)) {
        shards.push([shard.entry.seq, served.hash]);
        continue;
      }
      const seq = shard ? shard.entry.seq + 1 : served ? unknownSeq : 1;
      const op = this.#put(
        id,
        "manifest",
        shardRaw(shard?.entry.raw, entries, seq),
        served?.revision ?? null,
      );
      shards.push([seq, op.hash ?? ""]);
      ops.push(op);
    }
    const root = create ? undefined : currentRoot(state);
    const served = create ? undefined : state.served.get(ids.root);
    const seq = root
      ? Math.max(root.entry.seq, state.manifestFloor) + 1
      : served
        ? unknownSeq
        : state.manifestFloor + 1;
    ops.push(
      this.#put(
        ids.root,
        "manifest",
        rootRaw(root?.entry.raw, shards, seq),
        served?.revision ?? null,
      ),
    );
    return ops;
  }

  /** The resolver of the object's type. */
  #merge(
    current: ObjectEntry,
    intent: Extract<Intent, { kind: "update" }>,
    stamp: Stamp,
    notices: Notice[],
  ): JsonObject {
    if (current.type === "entry") {
      let result;
      try {
        result = mergeEntry(
          intent.baseRaw,
          intent.local,
          current.raw,
          stamp,
          historyMaxItems(this.#state),
        );
      } catch (error) {
        if (error instanceof EntryTooLarge)
          throw new SyncError("conflict_unresolved");
        throw error;
      }
      if (result.conflicts.length > 0)
        notices.push({
          kind: "entry_conflict",
          objectId: intent.id,
          fields: result.conflicts,
        });
      return result.merged;
    }
    const merged = mergeObject(
      intent.baseRaw,
      intent.local,
      current.raw,
      stamp,
    );
    for (const d of merged.discarded)
      notices.push({
        kind: "discarded",
        objectId: intent.id,
        field: d.field,
        value: d.value,
      });
    return merged.merged;
  }

  #ref(id: string, type: ObjectType) {
    const keyVersion = this.#state.summary.vault_key_version;
    // Never encrypt with a key older than one this device already held.
    if (keyVersion < this.#state.keyFloor) throw new SyncError("read_only");
    return { vaultId: this.#state.id, objectId: id, type, keyVersion };
  }

  #put(
    id: string,
    type: ObjectType,
    raw: JsonObject,
    expected: number | null,
  ): Planned {
    if (utf8Length(JSON.stringify(raw)) > SIZE_LIMITS[type])
      throw new SyncError("too_large");
    const ref = this.#ref(id, type);
    const data = this.#context.keys.useVaultKey(
      ref.vaultId,
      ref.keyVersion,
      (key) => encryptObject(systemRandomness, key, ref, raw),
    );
    return {
      id,
      type,
      raw,
      seq: seqOf(raw),
      hash: objectHash(ref.vaultId, id, type, ref.keyVersion, data),
      op: {
        op: "put",
        id,
        type,
        key_version: ref.keyVersion,
        expected_revision: expected,
        data,
      },
    };
  }

  #delete(current: ObjectEntry, stamp: Stamp): Planned {
    const ref = this.#ref(current.id, current.type);
    const seq = current.seq + 1;
    const data = this.#context.keys.useVaultKey(
      ref.vaultId,
      ref.keyVersion,
      (key) =>
        encryptTombstone(systemRandomness, key, ref, {
          seq,
          deletedAt: stamp.now,
          deletedBy: stamp.userId,
        }),
    );
    return {
      id: current.id,
      type: current.type,
      raw: undefined,
      seq,
      op: {
        op: "delete",
        id: current.id,
        key_version: ref.keyVersion,
        expected_revision: current.revision,
        data,
      },
    };
  }

  async #apply(planned: Planned[], result: BatchResult): Promise<void> {
    const state = this.#state;
    const obj: Record<string, number> = {};
    const root = manifestIds(state.id).root;
    for (const item of planned) {
      const known = this.#state.objects.get(item.id);
      const served = state.served.get(item.id);
      if (!served || served.revision <= result.vault_revision) {
        if (item.hash === undefined) state.served.delete(item.id);
        else
          state.served.set(item.id, {
            type: item.type,
            revision: result.vault_revision,
            hash: item.hash,
            bucket: bucketOf(item.id),
          });
      }
      // A sync may have brought something newer meanwhile.
      if (known && known.revision > result.vault_revision) continue;
      // A rebuild replaces corrupt manifest objects.
      state.corrupt.delete(item.id);
      if (item.id === root)
        state.manifestFloor = Math.max(state.manifestFloor, item.seq);
      if (item.raw === undefined) {
        this.#state.objects.delete(item.id);
      } else {
        this.#state.objects.set(item.id, {
          id: item.id,
          type: item.type,
          revision: result.vault_revision,
          keyVersion: this.#state.summary.vault_key_version,
          raw: item.raw,
          seq: item.seq,
          readOnly: false,
          rollback: false,
          invalid: false,
        });
      }
      obj[item.id] = objectMark(item.seq, item.raw === undefined);
    }
    // The batch matched the root's revision, so nothing came in between:
    // what the server holds now is known and can be checked at once.
    if (this.#mode !== "update")
      state.manifest = verifyManifest(state, undefined);
    const mf = state.manifestFloor;
    await this.#context.marks.raise(this.#context.userId, {
      vaults: { [state.id]: { rev: 0, obj, ...(mf > 0 ? { mf } : {}) } },
    });
  }

  /** Sends a pending request again; the caller holds the lock. */
  resend(pending: Pending): Promise<WriteResult> {
    return this.run(pending);
  }
}

/** A transient failure; `pending` is sent again unchanged. */
export class RetryableWrite extends Error {
  override readonly name = "RetryableWrite";
  readonly pending: Pending;

  constructor(pending: Pending) {
    super("Write can be repeated");
    this.pending = pending;
  }
}
