/**
 * Attachments of the engine: uploads staged with their file
 * keys until the entry is saved, reading blobs back, deleting blobs no
 * version of an entry needs any more. File keys live only here, as bytes
 * only while staged or during a de- or encryption.
 */
import type { ApiClient } from "../api/client";
import { ApiError, NetworkError } from "../api/errors";
import { gunzip, packed, type Compression } from "../attachments/compress";
import { storedAttachment } from "../attachments/refs";
import {
  fromBase64Url,
  toBase64Url,
  wipe,
  type JsonObject,
} from "../crypto/bytes";
import { generateFileKey } from "../crypto/flows/vault";
import { systemRandomness } from "../crypto/random";
import {
  decryptBlob,
  encryptBlob,
  encryptedBlobSize,
} from "../crypto/secretstream";
import type { AttachmentInfo } from "../model/entry";
import { SyncError } from "./errors";

/** A file to upload; `mime` as the browser reports it, may be empty. */
export interface AttachmentFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface AttachmentProgress {
  /** Bytes sent or received so far. */
  done: number;
  total: number;
}

export interface AttachmentRun {
  onProgress?: (progress: AttachmentProgress) => void;
  signal?: AbortSignal;
  /** Reading: unpacked bytes the caller can still take (export budget). */
  maxSize?: number;
}

/** An encrypted file ready to go up again with the same bytes. */
export interface PreparedUpload {
  id: string;
  key: string;
  compression: Compression;
  blob: Uint8Array;
}

interface Staged {
  vaultId: string;
  entryId: string;
  key: Uint8Array;
  info: AttachmentInfo;
}

const FALLBACK_MIME = "application/octet-stream";

function cancelled(signal: AbortSignal | undefined, error: unknown): never {
  if (signal?.aborted) throw new SyncError("cancelled");
  throw error;
}

export class Attachments {
  readonly #api: ApiClient;
  readonly #staged = new Map<string, Staged>();
  #limit: Promise<number> | undefined;
  /** Set by `stop()` (lock): nothing more is staged or handed out. */
  #stopped = false;

  constructor(api: ApiClient) {
    this.#api = api;
  }

  /** `attachment_max_bytes` of the server, asked once. */
  limit(): Promise<number> {
    this.#limit ??= this.#api.config().then(
      (config) => config.limits.attachment_max_bytes,
      (error: unknown) => {
        this.#limit = undefined;
        throw error;
      },
    );
    return this.#limit;
  }

  /**
   * Compresses, encrypts and uploads a file for an entry; `complete`
   * follows when the entry is saved. Aborting deletes the upload.
   */
  async stage(
    vaultId: string,
    entryId: string,
    file: AttachmentFile,
    run: AttachmentRun = {},
  ): Promise<AttachmentInfo> {
    if (file.data.length > (await this.limit()))
      throw new SyncError("attachment_too_large");
    const mime = file.mime.trim() === "" ? FALLBACK_MIME : file.mime;
    const { data, compression } = await packed(file.data, mime);
    this.#live();
    const id = systemRandomness.id("attachment_id");
    const key = generateFileKey(systemRandomness);
    const info: AttachmentInfo = {
      id,
      name: file.name,
      mime,
      size: file.data.length,
      compression,
    };
    this.#staged.set(id, { vaultId, entryId, key, info });
    try {
      const blob = encryptBlob(key, id, data);
      await this.#parts(vaultId, entryId, id, blob, run);
      this.#live();
      return info;
    } catch (error) {
      this.forget([id]);
      this.#api.deleteAttachment(vaultId, id).catch(() => undefined);
      if (this.#stopped) throw new SyncError("locked");
      return cancelled(run.signal, error);
    }
  }

  /**
   * Creates the upload and sends every part. A part that finds the upload
   * complete (`409`) means an earlier attempt finished it.
   */
  async #parts(
    vaultId: string,
    entryId: string,
    id: string,
    blob: Uint8Array,
    run: AttachmentRun,
  ): Promise<void> {
    if (run.signal?.aborted) throw new SyncError("cancelled");
    const upload = await this.#api.createAttachment(
      vaultId,
      id,
      entryId,
      blob.length,
    );
    run.onProgress?.({ done: 0, total: blob.length });
    for (let part = 0; part < upload.parts; part++) {
      if (run.signal?.aborted) throw new SyncError("cancelled");
      this.#live();
      const start = part * upload.part_size;
      const chunk = blob.subarray(start, start + upload.part_size);
      try {
        await this.#api.putAttachmentPart(vaultId, id, part, chunk, run.signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return;
        throw error;
      }
      run.onProgress?.({ done: start + chunk.length, total: blob.length });
    }
  }

  /** Compresses and encrypts a file under a given ID (KDBX import). */
  async prepare(id: string, file: AttachmentFile): Promise<PreparedUpload> {
    const mime = file.mime.trim() === "" ? FALLBACK_MIME : file.mime;
    const { data, compression } = await packed(file.data, mime);
    const key = generateFileKey(systemRandomness);
    try {
      return {
        id,
        key: toBase64Url(key),
        compression,
        blob: encryptBlob(key, id, data),
      };
    } finally {
      wipe(key);
    }
  }

  /** Uploads and completes a prepared file; repeatable with the same bytes. */
  async send(
    vaultId: string,
    entryId: string,
    upload: PreparedUpload,
  ): Promise<void> {
    await this.#parts(vaultId, entryId, upload.id, upload.blob, {});
    await this.#api.completeAttachment(vaultId, upload.id);
  }

  /** Staged for this entry, so a save may reference it. */
  isStaged(id: string, vaultId: string, entryId: string): boolean {
    const staged = this.#staged.get(id);
    return staged?.vaultId === vaultId && staged.entryId === entryId;
  }

  /**
   * Completes the staged uploads among `ids` and returns their stored
   * elements, file key included. Completing again is fine.
   */
  async complete(
    vaultId: string,
    ids: readonly string[],
  ): Promise<Map<string, JsonObject>> {
    const elements = new Map<string, JsonObject>();
    for (const id of ids) {
      const staged = this.#staged.get(id);
      if (!staged) continue;
      await this.#api.completeAttachment(vaultId, id);
      elements.set(id, {
        id,
        name: staged.info.name,
        mime: staged.info.mime,
        size: staged.info.size,
        key: toBase64Url(staged.key),
        compression: staged.info.compression,
      });
    }
    return elements;
  }

  /** Zeroes the keys of these staged uploads. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      const staged = this.#staged.get(id);
      if (!staged) continue;
      wipe(staged.key);
      this.#staged.delete(id);
    }
  }

  /**
   * Drops staged uploads the user discarded and deletes them on the
   * server, unless `stored` says an entry references them meanwhile.
   */
  discard(ids: readonly string[], stored: (id: string) => boolean): void {
    for (const id of ids) {
      const staged = this.#staged.get(id);
      if (!staged) continue;
      this.forget([id]);
      if (!stored(id))
        this.#api.deleteAttachment(staged.vaultId, id).catch(() => undefined);
    }
  }

  /** Deletes blobs on the server; failures only leave a blob behind. */
  async remove(vaultId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids)
      await this.#api.deleteAttachment(vaultId, id).catch(() => undefined);
  }

  /**
   * The file of an attachment of this entry (current content or a
   * snapshot): downloaded, decrypted and unpacked.
   */
  async read(
    vaultId: string,
    raw: JsonObject,
    attachmentId: string,
    run: AttachmentRun = {},
  ): Promise<Uint8Array> {
    const stored = storedAttachment(raw, attachmentId);
    if (!stored) throw new SyncError("attachment_missing");
    // `size` comes from whoever added the attachment, so it bounds nothing
    // by itself: the server's limit for uploads does. A larger file is not
    // read at all, a larger download is not kept.
    const limit = Math.min(
      await this.limit(),
      run.maxSize ?? Number.POSITIVE_INFINITY,
    );
    this.#live();
    if (stored.size > limit) throw new SyncError("attachment_too_large");
    let blob: Uint8Array;
    try {
      blob = await this.#api.downloadAttachment(vaultId, attachmentId, {
        signal: run.signal,
        maxBytes: encryptedBlobSize(stored.size),
        onProgress: (done, total) =>
          run.onProgress?.({ done, total: total ?? done }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        throw new SyncError("attachment_missing");
      if (error instanceof NetworkError && error.reason === "response")
        throw new SyncError("attachment_corrupt");
      return cancelled(run.signal, error);
    }
    this.#live();
    let plain: Uint8Array;
    let key: Uint8Array | undefined;
    try {
      key = fromBase64Url(stored.key, 32);
      plain = decryptBlob(
        key,
        attachmentId,
        blob,
        stored.compression === "none" ? stored.size : undefined,
      );
    } catch {
      throw new SyncError("attachment_corrupt");
    } finally {
      wipe(key);
    }
    if (stored.compression === "none") return plain;
    const file = await gunzip(plain, stored.size);
    plain.fill(0);
    if (this.#stopped) {
      file?.fill(0);
      throw new SyncError("locked");
    }
    if (file?.length !== stored.size) throw new SyncError("attachment_corrupt");
    return file;
  }

  #live(): void {
    if (this.#stopped) throw new SyncError("locked");
  }

  /** On lock: zeroes every staged key and deletes those uploads. */
  stop(): void {
    this.#stopped = true;
    this.discard([...this.#staged.keys()], () => false);
  }
}
