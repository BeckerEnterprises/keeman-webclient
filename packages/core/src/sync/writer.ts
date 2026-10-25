/**
 * Writing to a vault: a plan becomes one batch with a new
 * Idempotency-Key; after `409 conflict` the vault is synced, the plan runs
 * again on the new state and changes are merged per type, at
 * most three attempts. The caller holds the vault's lock.
 */
import { ApiError, NetworkError } from "../api/errors";
import type { BatchResult } from "../api/schemas";
import type { ObjectType } from "../crypto/aad";
import type { JsonObject } from "../crypto/bytes";
import { encryptObject, encryptTombstone } from "../crypto/objects";
import { systemRandomness } from "../crypto/random";
import { EntryTooLarge, utf8Length } from "../model/history";
import { seqOf } from "../model/json";
import { mergeEntry } from "../model/merge";
import {
  inspectVaultMeta,
  mergeObject,
  sameContent,
  type Stamp,
} from "../model/vault";
import { SyncError } from "./errors";
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
}

export interface Pending {
  key: string;
  body: string;
  planned: Planned[];
  notices: Notice[];
}

const MAX_ATTEMPTS = 3;

/** Plaintext limits in UTF-8 bytes. */
const SIZE_LIMITS: Record<ObjectType, number> = {
  vault_meta: 16 * 1024,
  group: 64 * 1024,
  entry: 1024 * 1024,
  icon: 64 * 1024,
};

/** Worth sending again unchanged; `507 quota_exceeded` does not pass by waiting. */
export function isTransient(error: unknown): boolean {
  return (
    (error instanceof NetworkError && error.reason !== "response") ||
    (error instanceof ApiError &&
      ((error.status >= 500 && error.status !== 507) || error.status === 408))
  );
}

/** The vault as a whole may be written. */
export function vaultWritable(state: VaultState): boolean {
  const meta = state.meta;
  return (
    state.keyOk &&
    state.keyStatus === "ok" &&
    state.synced &&
    !state.rollback &&
    meta !== undefined &&
    !meta.readOnly &&
    !meta.rollback &&
    !meta.superseded
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

export class WriteOperation {
  readonly #context: SyncContext;
  readonly #state: VaultState;
  readonly #plan: Plan;
  readonly #pull: () => Promise<void>;
  readonly #now: () => string;
  readonly #tombstones = new Set<string>();
  #attempts = 0;

  constructor(
    context: SyncContext,
    state: VaultState,
    plan: Plan,
    pull: () => Promise<void>,
    now: () => string,
  ) {
    this.#context = context;
    this.#state = state;
    this.#plan = plan;
    this.#pull = pull;
    this.#now = now;
  }

  async run(pending?: Pending): Promise<WriteResult> {
    let current = pending;
    for (;;) {
      if (!current) {
        if (this.#attempts >= MAX_ATTEMPTS)
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
        if (error instanceof ApiError && error.code === "conflict") {
          for (const conflict of error.details.conflicts ?? [])
            if (conflict.deleted) this.#tombstones.add(conflict.id);
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
    if (!vaultWritable(state)) throw new SyncError("read_only");
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
    return planned;
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
    const obj: Record<string, number> = {};
    for (const item of planned) {
      const known = this.#state.objects.get(item.id);
      // A sync may have brought something newer meanwhile.
      if (known && known.revision > result.vault_revision) continue;
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
    await this.#context.marks.raise(this.#context.userId, {
      vaults: { [this.#state.id]: { rev: 0, obj } },
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
