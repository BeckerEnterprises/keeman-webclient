/**
 * State and sync of one vault: full sync with a follow-up
 * delta, deltas, `410`, decryption and validation of every object, corrupt
 * objects and the rollback marks.
 */
import type { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { ChangedObject, VaultSummary } from "../api/schemas";
import type { ObjectType } from "../crypto/aad";
import type { JsonObject } from "../crypto/bytes";
import { CryptoError } from "../crypto/errors";
import type { KeyStore } from "../crypto/keystore";
import { decryptChange, type DecryptedChange } from "../crypto/objects";
import { inspectEntry } from "../model/entry";
import { inspectIcon } from "../model/icon";
import {
  inspectGroup,
  inspectVaultMeta,
  type CorruptReason,
  type Inspected,
} from "../model/vault";
import type { Candidate } from "../sharing/candidate";
import { Mutex } from "./lock";
import {
  higherMark,
  isOlder,
  objectMark,
  type SyncMarks,
  type VaultMarks,
} from "./marks";
import { Serial } from "./serial";

export interface ObjectEntry {
  id: string;
  type: ObjectType;
  revision: number;
  keyVersion: number;
  raw: JsonObject;
  seq: number;
  /** Written by a client with a higher `schema`. */
  readOnly: boolean;
  /** Older than this device has seen. */
  rollback: boolean;
  /** An entry with invalid list elements: read-only until repaired. */
  invalid: boolean;
}

export interface CorruptEntry {
  id: string;
  type: ObjectType;
  revision: number;
  reason: CorruptReason;
}

export interface SyncContext {
  api: ApiClient;
  keys: KeyStore;
  userId: string;
  marks: SyncMarks;
  /** Page size of `changes`; the server default when unset. */
  pageLimit?: number;
}

export class VaultState {
  readonly id: string;
  summary: VaultSummary;
  /** The own `key_wrapped` could be unwrapped. */
  keyOk = true;
  /**
   * The key of `vault_key_version`: `pending` waits for the user to verify
   * the sender, `invalid` failed the checks of its key box.
   */
  keyStatus: "ok" | "pending" | "missing" | "invalid" = "ok";
  /** The sender of a pending key, for the fingerprint dialog. */
  pendingSender: Candidate | undefined = undefined;
  /** Last completely seen revision. */
  since = 0;
  synced = false;
  objects = new Map<string, ObjectEntry>();
  corrupt = new Map<string, CorruptEntry>();
  /** The server delivered an older vault revision than seen before. */
  rollback = false;
  /** Tombstones older than the mark of their object: ID → tombstone `seq`. */
  rollbackDeletes = new Map<string, number>();
  error: unknown = undefined;
  /** Held by every sync and every write of this vault. */
  readonly lock = new Mutex();
  readonly #serial = new Serial();

  constructor(summary: VaultSummary) {
    this.id = summary.vault_id;
    this.summary = summary;
  }

  get meta(): ObjectEntry | undefined {
    return this.objects.get(this.id);
  }

  /** Runs syncs one at a time; a request during a run causes one more run. */
  serialize(run: () => Promise<void>): Promise<void> {
    return this.#serial.run(run);
  }
}

type Decoded =
  | { kind: "object"; entry: ObjectEntry }
  | { kind: "tombstone"; id: string; revision: number; seq: number }
  | { kind: "corrupt"; entry: CorruptEntry };

const CORRUPT_CODES: ReadonlySet<string> = new Set([
  "format",
  "auth",
  "padding",
  "encoding",
  "validation",
]);

function inspect(
  type: ObjectType,
  raw: JsonObject,
  objectId: string,
  vaultId: string,
): Inspected<unknown> {
  switch (type) {
    case "vault_meta":
      return inspectVaultMeta(raw, objectId, vaultId);
    case "group":
      return inspectGroup(raw);
    case "entry":
      return inspectEntry(raw);
    case "icon":
      return inspectIcon(raw);
  }
}

/** Decryption and validation, in this order. */
export function decode(
  keys: KeyStore,
  vaultId: string,
  object: ChangedObject,
): Decoded {
  const corrupt = (reason: CorruptReason): Decoded => ({
    kind: "corrupt",
    entry: {
      id: object.id,
      type: object.type,
      revision: object.revision,
      reason,
    },
  });
  if (!keys.hasVaultKey(vaultId, object.key_version)) return corrupt("no_key");
  if (object.data === null)
    return corrupt(object.deleted ? "dropped" : "no_data");
  const data = object.data;
  const ref = {
    vaultId,
    objectId: object.id,
    type: object.type,
    keyVersion: object.key_version,
  };
  let change: DecryptedChange;
  try {
    change = keys.useVaultKey(vaultId, object.key_version, (key) =>
      decryptChange(key, ref, data, object.deleted),
    );
  } catch (error) {
    if (error instanceof CryptoError && CORRUPT_CODES.has(error.code))
      return corrupt(error.code as CorruptReason);
    throw error;
  }
  if (change.deleted)
    return {
      kind: "tombstone",
      id: object.id,
      revision: object.revision,
      seq: change.tombstone.seq,
    };
  const inspected = inspect(object.type, change.content, object.id, vaultId);
  if (inspected.status === "corrupt") return corrupt(inspected.reason);
  return {
    kind: "object",
    entry: {
      id: object.id,
      type: object.type,
      revision: object.revision,
      keyVersion: object.key_version,
      raw: inspected.raw,
      seq: inspected.seq,
      readOnly: inspected.readOnly,
      rollback: false,
      invalid:
        object.type === "entry" &&
        (inspected.value as { invalid: number }).invalid > 0,
    },
  };
}

interface Collected {
  objects: ChangedObject[];
  first: number;
  last: number;
}

/** Applies decoded objects; keeps the marks to raise afterwards. */
class Applier {
  readonly raised: Record<string, number> = {};
  readonly #marks: VaultMarks | undefined;
  readonly #state: VaultState;
  readonly #objects: Map<string, ObjectEntry>;
  readonly #corrupt: Map<string, CorruptEntry>;

  constructor(
    state: VaultState,
    marks: VaultMarks | undefined,
    objects: Map<string, ObjectEntry>,
    corrupt: Map<string, CorruptEntry>,
  ) {
    this.#state = state;
    this.#marks = marks;
    this.#objects = objects;
    this.#corrupt = corrupt;
  }

  #revision(id: string): number {
    return (
      this.#objects.get(id)?.revision ?? this.#corrupt.get(id)?.revision ?? 0
    );
  }

  apply(decoded: Decoded): void {
    const id = decoded.kind === "tombstone" ? decoded.id : decoded.entry.id;
    const revision =
      decoded.kind === "tombstone" ? decoded.revision : decoded.entry.revision;
    // The same object can come twice while paging; the higher revision wins.
    if (revision < this.#revision(id)) return;
    const mark = this.#marks?.obj[id];
    if (decoded.kind === "corrupt") {
      // Corrupt objects never change marks.
      this.#objects.delete(id);
      this.#corrupt.set(id, decoded.entry);
      return;
    }
    if (decoded.kind === "object") {
      const entry = decoded.entry;
      if (isOlder(mark, entry.seq, false)) entry.rollback = true;
      else this.#raise(id, objectMark(entry.seq, false));
      this.#objects.set(id, entry);
      this.#corrupt.delete(id);
      this.#state.rollbackDeletes.delete(id);
      return;
    }
    if (isOlder(mark, decoded.seq, true)) {
      this.#state.rollbackDeletes.set(id, decoded.seq);
      return;
    }
    this.#raise(id, objectMark(decoded.seq, true));
    this.#objects.delete(id);
    this.#corrupt.delete(id);
    this.#state.rollbackDeletes.delete(id);
  }

  #raise(id: string, mark: number): void {
    this.raised[id] = higherMark(this.raised[id], mark);
  }
}

async function collect(
  context: SyncContext,
  state: VaultState,
  since: number,
  marks: VaultMarks | undefined,
): Promise<Collected> {
  const objects: ChangedObject[] = [];
  let cursor: string | undefined;
  let first: number | undefined;
  for (;;) {
    const page = await context.api.changes(
      state.id,
      since,
      cursor,
      context.pageLimit,
    );
    first ??= page.vault_revision;
    if (marks && page.vault_revision < marks.rev) state.rollback = true;
    objects.push(...page.objects);
    if (page.next_cursor === null)
      return { objects, first, last: page.vault_revision };
    cursor = page.next_cursor;
  }
}

/** One sync of the vault: full on the first run and after `410`, else delta. */
export async function pullVault(
  context: SyncContext,
  state: VaultState,
): Promise<void> {
  if (!state.keyOk) return;
  const marks = (await context.marks.read(context.userId)).vaults[state.id];
  const full = async (): Promise<Applier> => {
    const objects = new Map<string, ObjectEntry>();
    const corrupt = new Map<string, CorruptEntry>();
    const applier = new Applier(state, marks, objects, corrupt);
    state.rollbackDeletes.clear();
    const snapshot = await collect(context, state, 0, marks);
    // since=0 has no tombstones: a delta from the first page brings deletions.
    const delta = await collect(context, state, snapshot.first, marks);
    for (const object of [...snapshot.objects, ...delta.objects])
      applier.apply(decode(context.keys, state.id, object));
    state.objects = objects;
    state.corrupt = corrupt;
    state.since = delta.last;
    state.synced = true;
    return applier;
  };
  const delta = async (): Promise<Applier> => {
    const applier = new Applier(state, marks, state.objects, state.corrupt);
    const changes = await collect(context, state, state.since, marks);
    for (const object of changes.objects)
      applier.apply(decode(context.keys, state.id, object));
    state.since = changes.last;
    return applier;
  };
  let applier: Applier;
  try {
    applier = state.synced ? await delta() : await full();
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "resync_required"))
      throw error;
    applier = await full();
  }
  await context.marks.raise(context.userId, {
    vaults: { [state.id]: { rev: state.since, obj: applier.raised } },
  });
}

/** "Understood": the delivered values become the new marks. */
export async function acknowledgeRollback(
  context: SyncContext,
  state: VaultState,
): Promise<void> {
  const current = (await context.marks.read(context.userId)).vaults[state.id];
  const obj: Record<string, number> = { ...current?.obj };
  for (const [id, seq] of state.rollbackDeletes) {
    state.objects.delete(id);
    obj[id] = objectMark(seq, true);
  }
  for (const entry of state.objects.values()) {
    obj[entry.id] = objectMark(entry.seq, false);
    entry.rollback = false;
  }
  await context.marks.replaceVault(context.userId, state.id, {
    rev: state.since,
    obj,
  });
  state.rollback = false;
  state.rollbackDeletes.clear();
}
