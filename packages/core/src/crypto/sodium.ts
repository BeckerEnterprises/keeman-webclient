// The only module that imports libsodium (enforced by ESLint).
import libsodium from "libsodium-wrappers-sumo";

export type Sodium = typeof libsodium;

let readyPromise: Promise<void> | undefined;
let ready = false;

/** Loads libsodium. Every other crypto function requires this to have completed. */
export function initCrypto(): Promise<void> {
  readyPromise ??= libsodium.ready.then(() => {
    ready = true;
  });
  return readyPromise;
}

/** The loaded libsodium instance. */
export function sodium(): Sodium {
  if (!ready)
    throw new Error(
      "initCrypto() must complete before crypto functions are used",
    );
  return libsodium;
}
