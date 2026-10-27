/**
 * Writing a planned KDBX import: a new vault (meta and
 * root in one request) or a subgroup, then groups top-down and entries in
 * batches. IDs taken in the target get new ones, with `parentId`,
 * `previousParentId` and `{REF}` rewritten; a final pass fixes references
 * to IDs that changed after their referrer was written. Attachments go up
 * before the batch that writes their entry. The job resumes after a
 * network error with the same bytes.
 */
import type { JsonObject } from "../crypto/bytes";
import { entryWithRefs } from "../kdbx/refs";
import type {
  KdbxImportPlan,
  KdbxImportReport,
  KdbxPlannedObject,
} from "../kdbx/plan";
import { KdbxError } from "../kdbx/types";
import type { Compression } from "../attachments/compress";
import type { AttachmentFile } from "./attachments";
import { historyOf } from "../model/history";
import { renameIconRefs } from "../model/icon";
import { clone, same, seqOf, setOwn } from "../model/json";
import { isManifestId } from "../model/manifest";
import type { Stamp } from "../model/vault";
import { SyncError } from "./errors";
import { IdMap } from "./id-map";
import { byBucket, chunks } from "./tree-ops";
import type { VaultState } from "./vault";
import type { Intent, Plan, WriteResult } from "./writer";

/** What the job needs from the engine; not part of the public API. */
export interface KdbxImportPort {
  /** Sends `POST /v1/vaults` for the plan's meta and root; network errors retry. */
  createVault(meta: JsonObject, root: KdbxPlannedObject): Promise<string>;
  state(vaultId: string): VaultState;
  /** Tombstones this device knows from its high-water marks. */
  knownTombstones(vaultId: string): Promise<ReadonlySet<string>>;
  write(state: VaultState, plan: Plan): Promise<WriteResult>;
  newId(): string;
  stamp(): Stamp;
  /**
   * Uploads and completes a file under this ID; a repeat sends the same
   * bytes. Returns what the entry stores.
   */
  uploadAttachment(
    vaultId: string,
    entryId: string,
    attachmentId: string,
    file: AttachmentFile,
  ): Promise<{ key: string; compression: Compression }>;
  /** Assigns an attachment to another entry of the same vault. */
  transferAttachment(
    vaultId: string,
    attachmentId: string,
    entryId: string,
  ): Promise<void>;
}

interface Uploaded {
  key: string;
  compression: Compression;
  entryId: string;
}

/** Fills in key and compression of uploaded attachments, also in snapshots. */
function withUploads(
  raw: JsonObject,
  uploaded: ReadonlyMap<string, Uploaded>,
): JsonObject {
  const contents: unknown[] = [raw, ...historyOf(raw)];
  for (const content of contents) {
    if (typeof content !== "object" || content === null) continue;
    const list = (content as JsonObject).attachments;
    if (!Array.isArray(list)) continue;
    for (const element of list as JsonObject[]) {
      const done = uploaded.get(String(element.id));
      if (!done) continue;
      element.key = done.key;
      element.compression = done.compression;
    }
  }
  return raw;
}

export interface KdbxImportProgress {
  done: number;
  total: number;
}

export interface KdbxImportRun {
  onProgress?: (progress: KdbxImportProgress) => void;
  /** Checked between batches; aborting ends the run with `cancelled`. */
  signal?: AbortSignal;
}

type Step =
  | { kind: "vault" }
  | { kind: "batch"; items: KdbxPlannedObject[] }
  | { kind: "refs" };

export class KdbxImportJob {
  readonly report: KdbxImportReport;
  readonly #plan: KdbxImportPlan;
  readonly #port: KdbxImportPort;
  readonly #steps: Step[];
  readonly #total: number;
  readonly #imported: ReadonlySet<string>;
  /** Group mode: where the KDBX root goes. */
  readonly #target: { groupId: string; sortKey: string } | undefined;
  #vaultId: string | undefined;
  #ids: IdMap | undefined;
  #step = 0;
  #done = 0;
  #retry: (() => Promise<unknown>) | undefined;
  #running = false;
  readonly #uploaded = new Map<string, Uploaded>();
  #notify: ((progress: KdbxImportProgress) => void) | undefined;

  constructor(
    plan: KdbxImportPlan,
    port: KdbxImportPort,
    target?: { vaultId: string; groupId: string; sortKey: string },
  ) {
    this.#plan = plan;
    this.#port = port;
    this.report = plan.report;
    this.#vaultId = target?.vaultId;
    this.#target = target && {
      groupId: target.groupId,
      sortKey: target.sortKey,
    };
    const groups =
      plan.mode === "group" ? [plan.root, ...plan.groups] : plan.groups;
    const intents = (items: KdbxPlannedObject[]): Intent[] =>
      items.map((item) => ({
        kind: "create",
        id: item.id,
        type: item.type,
        content: item.raw,
      }));
    const batches = (items: KdbxPlannedObject[]): Step[] => {
      const steps: Step[] = [];
      let offset = 0;
      for (const batch of chunks(intents(items))) {
        steps.push({
          kind: "batch",
          items: items.slice(offset, offset + batch.length),
        });
        offset += batch.length;
      }
      return steps;
    };
    // Icons and entries in any order: by manifest bucket, so a batch
    // touches few shards. Groups stay top-down.
    this.#steps = [
      ...(plan.mode === "vault" ? [{ kind: "vault" } as const] : []),
      ...batches(byBucket(plan.icons)),
      ...batches(groups),
      ...batches(byBucket(plan.entries)),
      { kind: "refs" },
    ];
    this.#total =
      1 +
      plan.icons.length +
      plan.groups.length +
      plan.entries.length +
      plan.report.attachments;
    this.#imported = new Set([
      plan.root.id,
      ...plan.groups.map((g) => g.id),
      ...plan.entries.map((e) => e.id),
    ]);
  }

  /** The vault written to; known after the first step of a new vault. */
  get vaultId(): string | undefined {
    return this.#vaultId;
  }

  get finished(): boolean {
    return this.#step >= this.#steps.length;
  }

  get progress(): KdbxImportProgress {
    return { done: this.#done, total: this.#total };
  }

  /**
   * Runs or resumes the import. A network error leaves the job resumable:
   * the next `run()` sends the interrupted request again, byte for byte.
   */
  async run(options: KdbxImportRun = {}): Promise<void> {
    if (this.#running) throw new Error("The import is already running");
    this.#running = true;
    this.#notify = options.onProgress;
    try {
      while (!this.finished) {
        if (options.signal?.aborted === true) throw new KdbxError("cancelled");
        const step = this.#steps[this.#step];
        if (step === undefined) break;
        await this.#attempt(() => this.#run(step));
        this.#step++;
        options.onProgress?.(this.progress);
      }
    } finally {
      this.#running = false;
    }
  }

  async #attempt(first: () => Promise<void>): Promise<void> {
    const retry = this.#retry;
    this.#retry = undefined;
    try {
      if (retry === undefined) await first();
      else await retry();
    } catch (error) {
      if (error instanceof SyncError && error.code === "network")
        this.#retry = error.retry;
      throw error;
    }
  }

  async #run(step: Step): Promise<void> {
    switch (step.kind) {
      case "vault":
        await this.#resumable(
          () => this.#port.createVault(this.#plan.meta ?? {}, this.#plan.root),
          (vaultId) => {
            this.#vaultId = vaultId;
            this.#done = 1;
          },
        );
        return;
      case "batch":
        await this.#batch(step.items);
        return;
      case "refs":
        await this.#fixReferences();
        return;
    }
  }

  /**
   * `finish` runs after `send` succeeds, also when a network error's
   * `retry` (the same bytes) succeeds later.
   */
  async #resumable<T>(
    send: () => Promise<T>,
    finish: (result: T) => void,
  ): Promise<void> {
    let result: T;
    try {
      result = await send();
    } catch (error) {
      const retry = error instanceof SyncError ? error.retry : undefined;
      if (retry !== undefined)
        throw new SyncError("network", () =>
          this.#resumable(retry as () => Promise<T>, finish),
        );
      throw error;
    }
    finish(result);
  }

  async #map(): Promise<IdMap> {
    if (this.#ids) return this.#ids;
    const vaultId = this.#vaultId ?? "";
    const tombstones = await this.#port.knownTombstones(vaultId);
    const ids = new IdMap(
      (id, conflicts) => {
        const state = this.#port.state(vaultId);
        return (
          id === vaultId ||
          isManifestId(vaultId, id) ||
          state.objects.has(id) ||
          state.corrupt.has(id) ||
          tombstones.has(id) ||
          conflicts.has(id)
        );
      },
      () => this.#port.newId(),
    );
    // The root of a new vault was written with the vault itself.
    if (this.#plan.mode === "vault") ids.created(this.#plan.root.id);
    this.#ids = ids;
    return ids;
  }

  #content(
    item: KdbxPlannedObject,
    ids: IdMap,
    tombstones: ReadonlySet<string>,
  ): JsonObject {
    if (item.type === "icon") return clone(item.raw);
    // Icons go first; one that got another ID is renamed in the references.
    const raw = renameIconRefs(
      item.raw,
      new Map(
        this.#plan.icons
          .filter((icon) => ids.peek(icon.id) !== icon.id)
          .map((icon) => [icon.id, ids.peek(icon.id)]),
      ),
    );
    if (item === this.#plan.root && this.#target) {
      setOwn(raw, "parentId", this.#target.groupId);
      setOwn(raw, "sortKey", this.#target.sortKey);
    } else if (typeof raw.parentId === "string") {
      setOwn(raw, "parentId", ids.map(raw.parentId, tombstones));
    }
    if (typeof raw.previousParentId === "string")
      setOwn(
        raw,
        "previousParentId",
        ids.map(raw.previousParentId, tombstones),
      );
    if (item.type !== "entry") return raw;
    return entryWithRefs(withUploads(raw, this.#uploaded), (id) =>
      this.#imported.has(id) ? ids.map(id, tombstones) : id,
    );
  }

  /** Attachments of these entries, uploaded and completed. */
  async #upload(items: KdbxPlannedObject[], ids: IdMap): Promise<void> {
    const vaultId = this.#vaultId ?? "";
    for (const item of items)
      for (const planned of item.attachments ?? []) {
        if (this.#uploaded.has(planned.id)) continue;
        const entryId = ids.map(item.id);
        const stored = await this.#port.uploadAttachment(
          vaultId,
          entryId,
          planned.id,
          {
            name: planned.name,
            mime: planned.mime,
            data: this.#plan.binaries[planned.binary] ?? new Uint8Array(0),
          },
        );
        this.#uploaded.set(planned.id, { ...stored, entryId });
        this.#done++;
        this.#notify?.(this.progress);
      }
  }

  /** An entry that got another ID while writing takes its attachments along. */
  async #reassign(items: KdbxPlannedObject[], ids: IdMap): Promise<void> {
    const vaultId = this.#vaultId ?? "";
    for (const item of items) {
      const entryId = ids.peek(item.id);
      for (const planned of item.attachments ?? []) {
        const uploaded = this.#uploaded.get(planned.id);
        if (!uploaded || uploaded.entryId === entryId) continue;
        await this.#port.transferAttachment(vaultId, planned.id, entryId);
        uploaded.entryId = entryId;
      }
    }
  }

  async #batch(items: KdbxPlannedObject[]): Promise<void> {
    const ids = await this.#map();
    const state = this.#port.state(this.#vaultId ?? "");
    await this.#upload(items, ids);
    try {
      await this.#resumable(
        () =>
          this.#port.write(state, (_state, info) =>
            items.map((item) => ({
              kind: "create",
              id: ids.map(item.id, info.tombstones),
              type: item.type,
              content: this.#content(item, ids, info.tombstones),
            })),
          ),
        () => {
          for (const item of items) ids.created(item.id);
          this.#done += items.length;
          this.report.conflicts = ids.changed;
        },
      );
    } catch (error) {
      const retry = error instanceof SyncError ? error.retry : undefined;
      if (retry === undefined) throw error;
      throw new SyncError("network", async () => {
        await retry();
        await this.#reassign(items, ids);
      });
    }
    await this.#reassign(items, ids);
  }

  /** References to IDs that changed after their referrer was written. */
  async #fixReferences(): Promise<void> {
    const ids = await this.#map();
    const state = this.#port.state(this.#vaultId ?? "");
    const map = (id: string) => (this.#imported.has(id) ? ids.peek(id) : id);
    const stamp = this.#port.stamp();
    const intents: Intent[] = [];
    for (const item of this.#plan.entries) {
      const current = state.objects.get(ids.peek(item.id));
      if (!current) continue;
      const fixed = entryWithRefs(current.raw, map);
      if (same(fixed, current.raw)) continue;
      // Like the repair of invalid elements: no new history state.
      setOwn(fixed, "seq", seqOf(current.raw) + 1);
      setOwn(fixed, "modified", stamp.now);
      setOwn(fixed, "modifiedBy", stamp.userId);
      intents.push({
        kind: "update",
        id: current.id,
        baseRaw: current.raw,
        baseRevision: current.revision,
        local: fixed,
      });
    }
    for (const batch of chunks(intents))
      await this.#resumable(
        () => this.#port.write(state, () => batch),
        () => undefined,
      );
  }
}
