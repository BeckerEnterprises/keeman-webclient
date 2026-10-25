/**
 * Main-thread side of the KDBX worker: every operation runs in a
 * fresh worker that is terminated afterwards, which also frees its memory;
 * aborting terminates it at once.
 */
import type { WorkerLike } from "../crypto/argon2-worker";
import { KDBX_MESSAGE_KIND, type KdbxRequest } from "./protocol";
import {
  KdbxError,
  type KdbxErrorCode,
  type KdbxExportModel,
  type KdbxFile,
  type KdbxHeaderInfo,
} from "./types";

const ERROR_CODES: ReadonlySet<string> = new Set<KdbxErrorCode>([
  "not_kdbx",
  "unsupported_version",
  "unsupported_cipher",
  "unsupported_kdf",
  "kdf_limits",
  "wrong_key",
  "corrupt",
  "too_large",
  "no_credentials",
  "cancelled",
  "failed",
]);

let nextRequestId = 1;

/** Zeroes a buffer unless a transfer already detached it. */
function clear(bytes: Uint8Array | null): void {
  if (bytes !== null && bytes.byteLength > 0) bytes.fill(0);
}

/** A fresh, transferable copy; the source is wiped. */
function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  clear(bytes);
  return copy;
}

function run(
  spawn: () => WorkerLike,
  request: KdbxRequest,
  transfer: ArrayBuffer[],
  signal: AbortSignal | undefined,
  onHeader: ((header: KdbxHeaderInfo) => void) | undefined,
): Promise<Record<string, unknown>> {
  if (signal?.aborted === true)
    return Promise.reject(new KdbxError("cancelled"));
  const worker = spawn();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const finish = (): void => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      finish();
      reject(new KdbxError("cancelled"));
    };
    signal?.addEventListener("abort", abort);
    worker.addEventListener("message", (event) => {
      const message = (event.data ?? {}) as Record<string, unknown>;
      if (message.kind !== KDBX_MESSAGE_KIND || message.id !== request.id) {
        finish();
        reject(new KdbxError("failed"));
        return;
      }
      if (message.stage === "header") {
        onHeader?.(message.header as KdbxHeaderInfo);
        return;
      }
      finish();
      if (message.ok === true) {
        resolve(message);
        return;
      }
      const code = message.code;
      reject(
        new KdbxError(
          typeof code === "string" && ERROR_CODES.has(code)
            ? (code as KdbxErrorCode)
            : "failed",
        ),
      );
    });
    // Out of memory (e.g. a decompression bomb) ends up here.
    worker.addEventListener("error", () => {
      finish();
      reject(new KdbxError("failed"));
    });
    worker.postMessage(request, transfer);
  });
}

export interface KdbxReadInput {
  data: Uint8Array;
  /** As typed: UTF-8 without NFC or trimming; empty = none. */
  password: string;
  keyFile: Uint8Array | null;
}

export interface KdbxWorkerOptions {
  signal?: AbortSignal;
  /** Called once the header passed its checks, before the key derivation. */
  onHeader?: (header: KdbxHeaderInfo) => void;
}

/** Opens a KDBX file in a worker. Throws `KdbxError`. */
export async function readKdbxInWorker(
  spawn: () => WorkerLike,
  input: KdbxReadInput,
  options: KdbxWorkerOptions = {},
): Promise<KdbxFile> {
  if (input.password === "" && input.keyFile === null)
    throw new KdbxError("no_credentials");
  const data = new Uint8Array(input.data);
  const password =
    input.password === ""
      ? null
      : transferable(new TextEncoder().encode(input.password));
  const keyFile = input.keyFile === null ? null : new Uint8Array(input.keyFile);
  const transfer: ArrayBuffer[] = [data.buffer];
  if (password !== null) transfer.push(password.buffer);
  if (keyFile !== null) transfer.push(keyFile.buffer);
  try {
    const message = await run(
      spawn,
      {
        kind: KDBX_MESSAGE_KIND,
        id: nextRequestId++,
        op: "read",
        data,
        password,
        keyFile,
      },
      transfer,
      options.signal,
      options.onHeader,
    );
    return message.file as KdbxFile;
  } finally {
    clear(password);
    clear(keyFile);
  }
}

/**
 * Writes an export in a worker. `password` is the export password; it is
 * NFC-normalised here. Throws `KdbxError`.
 */
export async function writeKdbxInWorker(
  spawn: () => WorkerLike,
  model: KdbxExportModel,
  password: string,
  options: Pick<KdbxWorkerOptions, "signal"> = {},
): Promise<Uint8Array> {
  const bytes = transferable(
    new TextEncoder().encode(password.normalize("NFC")),
  );
  try {
    const message = await run(
      spawn,
      {
        kind: KDBX_MESSAGE_KIND,
        id: nextRequestId++,
        op: "write",
        model,
        password: bytes,
      },
      [bytes.buffer],
      options.signal,
      undefined,
    );
    const data = message.data;
    if (!(data instanceof Uint8Array)) throw new KdbxError("failed");
    return data;
  } finally {
    clear(bytes);
  }
}
