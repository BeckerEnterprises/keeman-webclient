// Argon2id in a web worker. The app's worker file only
// forwards messages to `handleArgon2Message`; the main thread calls
// `deriveLoginKeysInWorker`.
import { deriveMasterKey, validateKdfParams, type KdfParams } from "./argon2";
import { wipe } from "./bytes";
import { CryptoError } from "./errors";
import { deriveAccountKeys, type AccountKeys } from "./kdf";
import { normalizePassword } from "./normalize";
import { initCrypto } from "./sodium";

export const ARGON2_MESSAGE_KIND = "keeman.argon2.v1";

export interface Argon2Request {
  kind: typeof ARGON2_MESSAGE_KIND;
  id: number;
  /** NFC-normalised UTF-8 password; transferred, not copied. */
  password: Uint8Array;
  salt: Uint8Array;
  kdf: KdfParams;
}

export type Argon2Response = {
  kind: typeof ARGON2_MESSAGE_KIND;
  id: number;
} & (
  | { ok: true; authKey: Uint8Array; wrapKey: Uint8Array }
  | { ok: false; code: "validation" | "internal" }
);

/** Copies into a fresh, transferable ArrayBuffer and wipes the source. */
function transferable(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  wipe(bytes);
  return copy;
}

function isRequest(data: unknown): data is Argon2Request {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Partial<Argon2Request>;
  return (
    message.kind === ARGON2_MESSAGE_KIND &&
    Number.isSafeInteger(message.id) &&
    message.password instanceof Uint8Array &&
    message.salt instanceof Uint8Array
  );
}

/**
 * Worker side: derives auth_key and wrap_key. The master key never leaves
 * the worker; the password buffer is wiped.
 */
export async function handleArgon2Message(
  data: unknown,
): Promise<{ response: Argon2Response; transfer: ArrayBuffer[] }> {
  const id =
    typeof data === "object" &&
    data !== null &&
    Number.isSafeInteger((data as { id?: unknown }).id)
      ? (data as { id: number }).id
      : -1;
  if (!isRequest(data)) {
    return {
      response: {
        kind: ARGON2_MESSAGE_KIND,
        id,
        ok: false,
        code: "validation",
      },
      transfer: [],
    };
  }
  let masterKey: Uint8Array | undefined;
  try {
    await initCrypto();
    masterKey = deriveMasterKey(
      data.password,
      data.salt,
      validateKdfParams(data.kdf),
    );
    const keys = deriveAccountKeys(masterKey);
    const authKey = transferable(keys.authKey);
    const wrapKey = transferable(keys.wrapKey);
    return {
      response: { kind: ARGON2_MESSAGE_KIND, id, ok: true, authKey, wrapKey },
      transfer: [authKey.buffer, wrapKey.buffer],
    };
  } catch (error) {
    const code =
      error instanceof CryptoError && error.code === "validation"
        ? "validation"
        : "internal";
    return {
      response: { kind: ARGON2_MESSAGE_KIND, id, ok: false, code },
      transfer: [],
    };
  } finally {
    wipe(data.password, masterKey);
  }
}

/** The part of a DOM `Worker` this module needs. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown }) => void,
  ): void;
  terminate(): void;
}

let nextRequestId = 1;

/**
 * Main-thread side: runs one derivation in a fresh worker and terminates it
 * afterwards, which also frees its WASM memory (at least `mem` bytes).
 */
export async function deriveLoginKeysInWorker(
  spawn: () => WorkerLike,
  password: string,
  salt: Uint8Array,
  kdf: KdfParams,
): Promise<AccountKeys> {
  const params = validateKdfParams(kdf);
  if (salt.length !== 16)
    throw new CryptoError("validation", "Salt must be 16 bytes");
  const passwordBytes = transferable(normalizePassword(password));
  const id = nextRequestId++;
  const worker = spawn();
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      worker.addEventListener("message", (event) => {
        resolve(event.data);
      });
      worker.addEventListener("error", () => {
        reject(new Error("Argon2 worker failed"));
      });
      const request: Argon2Request = {
        kind: ARGON2_MESSAGE_KIND,
        id,
        password: passwordBytes,
        salt: new Uint8Array(salt),
        kdf: params,
      };
      worker.postMessage(request, [passwordBytes.buffer]);
    });
    const result = (response ?? {}) as Record<string, unknown>;
    if (
      result.kind !== ARGON2_MESSAGE_KIND ||
      result.id !== id ||
      typeof result.ok !== "boolean"
    ) {
      throw new Error("Unexpected answer from the Argon2 worker");
    }
    if (!result.ok) {
      if (result.code === "validation")
        throw new CryptoError("validation", "Argon2 parameters rejected");
      throw new Error("Argon2 worker failed");
    }
    const { authKey, wrapKey } = result;
    if (
      !(authKey instanceof Uint8Array) ||
      !(wrapKey instanceof Uint8Array) ||
      authKey.length !== 32 ||
      wrapKey.length !== 32
    ) {
      throw new Error("Unexpected answer from the Argon2 worker");
    }
    return { authKey, wrapKey };
  } finally {
    worker.terminate();
    wipe(passwordBytes);
  }
}
