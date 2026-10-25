import { readFileSync } from "node:fs";
import type { WorkerLike } from "../../src/crypto/argon2-worker";
import { readKdbx } from "../../src/kdbx/file/read";
import { handleKdbxMessage } from "../../src/kdbx/file/worker";
import type {
  KdbxEntryFile,
  KdbxEntryState,
  KdbxFile,
  KdbxGroupFile,
  KdbxMetaFile,
  KdbxTimes,
} from "../../src/kdbx/types";

export const FIXTURES = new URL("../fixtures/kdbx/", import.meta.url);

export type FixtureName =
  "keepass-example" | "keepassxc-example" | "keeman-sample";

/** The bytes of a fixture; its password is `test`. */
export function fixture(name: FixtureName): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`${name}.kdbx`, FIXTURES)));
}

const read = new Map<FixtureName, Promise<KdbxFile>>();

/** A fixture read with `readKdbx`, once per test file. */
export function readFixture(name: FixtureName): Promise<KdbxFile> {
  let file = read.get(name);
  if (file === undefined) {
    file = readKdbx(arrayBufferOf(fixture(name)), {
      password: new TextEncoder().encode("test"),
      keyFile: null,
    });
    read.set(name, file);
  }
  return file;
}

export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export const utf8 = (text: string): Uint8Array =>
  new TextEncoder().encode(text);

export interface FakeWorker {
  worker: WorkerLike;
  /** Sizes of the transferred buffers and whether they were detached. */
  seen: { terminated: boolean; transferred: number[]; detached: boolean };
  /** Lets the worker fail like a crashed browser worker. */
  crash(): void;
}

/**
 * A KDBX worker on a MessageChannel, so transfers detach buffers like in a
 * browser. `handle` replaces the real handler in negative tests.
 */
export function fakeKdbxWorker(
  handle: (
    data: unknown,
    post: (message: unknown, transfer: ArrayBuffer[]) => void,
  ) => Promise<void> = handleKdbxMessage,
): FakeWorker {
  const channel = new MessageChannel();
  const seen = {
    terminated: false,
    transferred: [] as number[],
    detached: false,
  };
  const errorListeners: ((event: { data?: unknown }) => void)[] = [];
  channel.port2.onmessage = (event: MessageEvent) => {
    void handle(event.data, (message, transfer) => {
      if (!seen.terminated) channel.port2.postMessage(message, transfer);
    });
  };
  const worker: WorkerLike = {
    postMessage: (message, transfer) => {
      const buffers = transfer as ArrayBuffer[];
      seen.transferred = buffers.map((buffer) => buffer.byteLength);
      channel.port1.postMessage(message, transfer);
      seen.detached = buffers.every((buffer) => buffer.byteLength === 0);
    },
    addEventListener: (type, listener) => {
      if (type === "message")
        channel.port1.onmessage = (event: MessageEvent) => {
          listener({ data: event.data });
        };
      else errorListeners.push(listener);
    },
    terminate: () => {
      seen.terminated = true;
      channel.port1.close();
      channel.port2.close();
    },
  };
  return {
    worker,
    seen,
    crash: () => {
      for (const listener of errorListeners) listener({});
    },
  };
}

// ------------------------------------------------- synthetic KDBX models

/** A KeePass UUID (32 hex digits) from a number. */
export function hex(n: number): string {
  return `0193${n.toString(16).padStart(28, "0")}`;
}

/** The canonical form of `hex(n)`. */
export function uuid(n: number): string {
  const h = hex(n);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const NO_TIMES: KdbxTimes = {
  created: null,
  modified: null,
  expires: null,
};

export function kdbxGroup(
  n: number,
  name: string,
  more: Partial<KdbxGroupFile> = {},
): KdbxGroupFile {
  return {
    uuid: hex(n),
    name,
    notes: "",
    icon: 48,
    customIcon: null,
    times: NO_TIMES,
    previousParent: null,
    groups: [],
    entries: [],
    ...more,
  };
}

export function kdbxState(
  n: number,
  values: Record<string, string | [string, boolean]>,
  more: Partial<KdbxEntryState> = {},
): KdbxEntryState {
  return {
    uuid: hex(n),
    icon: 0,
    customIcon: null,
    strings: Object.entries(values).map(([key, value]) =>
      typeof value === "string"
        ? { key, value, protected: key === "Password" }
        : { key, value: value[0], protected: value[1] },
    ),
    tags: [],
    times: NO_TIMES,
    attachments: [],
    previousParent: null,
    ...more,
  };
}

export function kdbxEntry(
  n: number,
  values: Record<string, string | [string, boolean]>,
  more: Partial<KdbxEntryFile> = {},
): KdbxEntryFile {
  return { history: [], ...kdbxState(n, values), ...more };
}

export function kdbxFile(
  root: KdbxGroupFile,
  meta: Partial<KdbxMetaFile> = {},
  binaries: Uint8Array[] = [],
): KdbxFile {
  return {
    customIcons: [],
    binaries,
    header: { version: "4.1", cipher: "aes", kdf: "argon2id", memoryBytes: 1 },
    meta: {
      name: "Synthetic",
      description: "",
      color: null,
      publicColor: null,
      recycleBinEnabled: true,
      recycleBinUuid: null,
      historyMaxItems: 10,
      ...meta,
    },
    root,
    extraRoots: 0,
    ignored: {
      autoType: 0,
      customData: 0,
      colors: 0,
      overrideUrl: 0,
      qualityCheck: 0,
      groupSettings: 0,
      deletedObjects: 0,
      publicCustomData: 0,
    },
  };
}
