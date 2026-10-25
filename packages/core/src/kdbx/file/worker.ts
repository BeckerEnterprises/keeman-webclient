/**
 * KDBX worker side: one operation per worker. The app's worker file
 * forwards messages to `handleKdbxMessage`; the main thread uses
 * `readKdbxInWorker` and `writeKdbxInWorker`.
 */
import {
  KDBX_MESSAGE_KIND,
  type KdbxRequest,
  type KdbxResponse,
} from "../protocol";
import { KdbxError } from "../types";
import { readKdbx } from "./read";
import { writeKdbx } from "./write";

export type KdbxPost = (message: KdbxResponse, transfer: ArrayBuffer[]) => void;

function bytesOrNull(value: unknown): value is Uint8Array | null {
  return value === null || value instanceof Uint8Array;
}

function isRequest(data: unknown): data is KdbxRequest {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message.kind !== KDBX_MESSAGE_KIND || !Number.isSafeInteger(message.id))
    return false;
  if (message.op === "read")
    return (
      message.data instanceof Uint8Array &&
      bytesOrNull(message.password) &&
      bytesOrNull(message.keyFile)
    );
  return (
    message.op === "write" &&
    message.password instanceof Uint8Array &&
    typeof message.model === "object" &&
    message.model !== null
  );
}

function wipe(...buffers: (Uint8Array | null)[]): void {
  for (const buffer of buffers)
    if (buffer !== null && buffer.byteLength > 0) buffer.fill(0);
}

/** Handles one request; answers with `post` and wipes the secrets it got. */
export async function handleKdbxMessage(
  data: unknown,
  post: KdbxPost,
): Promise<void> {
  const id =
    typeof data === "object" &&
    data !== null &&
    Number.isSafeInteger((data as { id?: unknown }).id)
      ? (data as { id: number }).id
      : -1;
  const base = { kind: KDBX_MESSAGE_KIND, id } as const;
  if (!isRequest(data)) {
    post({ ...base, stage: "done", ok: false, code: "failed" }, []);
    return;
  }
  try {
    if (data.op === "read") {
      const bytes = data.data;
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : bytes.slice().buffer;
      const file = await readKdbx(
        buffer,
        { password: data.password, keyFile: data.keyFile },
        (header) => {
          post({ ...base, stage: "header", header }, []);
        },
      );
      post(
        { ...base, stage: "done", ok: true, file },
        [...file.binaries, ...file.customIcons.map((icon) => icon.data)].map(
          (bytes) => bytes.buffer as ArrayBuffer,
        ),
      );
    } else {
      const bytes = await writeKdbx(data.model, data.password);
      post({ ...base, stage: "done", ok: true, data: bytes }, [
        bytes.buffer as ArrayBuffer,
      ]);
    }
  } catch (error) {
    const code = error instanceof KdbxError ? error.code : "failed";
    post({ ...base, stage: "done", ok: false, code }, []);
  } finally {
    wipe(data.password, data.op === "read" ? data.keyFile : null);
  }
}
