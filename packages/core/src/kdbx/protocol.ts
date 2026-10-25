/**
 * Messages between the main thread and the KDBX worker. Secrets
 * (file, password, key file) travel as transferred buffers.
 */
import type {
  KdbxErrorCode,
  KdbxExportModel,
  KdbxFile,
  KdbxHeaderInfo,
} from "./types";

export const KDBX_MESSAGE_KIND = "keeman.kdbx.v1";

export type KdbxRequest = { kind: typeof KDBX_MESSAGE_KIND; id: number } & (
  | {
      op: "read";
      data: Uint8Array;
      /** UTF-8 as typed; `null` = no password. */
      password: Uint8Array | null;
      keyFile: Uint8Array | null;
    }
  | { op: "write"; model: KdbxExportModel; password: Uint8Array }
);

export type KdbxResponse = { kind: typeof KDBX_MESSAGE_KIND; id: number } & (
  | { stage: "header"; header: KdbxHeaderInfo }
  | { stage: "done"; ok: true; file: KdbxFile }
  | { stage: "done"; ok: true; data: Uint8Array }
  | { stage: "done"; ok: false; code: KdbxErrorCode }
);
