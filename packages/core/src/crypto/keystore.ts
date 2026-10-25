import { wipe } from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import { assertUuid } from "./uuid";

export interface AccountKeyMaterial {
  /** user_id as authenticated by the user key AAD. */
  userId: string;
  userKey: Uint8Array;
  privateKey: Uint8Array;
  /** pk', derived locally from the private key. */
  publicKey: Uint8Array;
}

function assertKey(key: Uint8Array, what: string): void {
  if (key.length !== KEY_BYTES)
    throw new CryptoError("validation", `${what} must be 32 bytes`);
}

function assertSynchronous<T>(result: T): T {
  if (result instanceof Promise)
    throw new Error("KeyStore callbacks must be synchronous");
  return result;
}

/** What the sync engine and sharing use of the keys. */
export interface Keys {
  useUserKey<T>(use: (userKey: Uint8Array) => T): T;
  usePrivateKey<T>(use: (privateKey: Uint8Array) => T): T;
  setVaultKey(vaultId: string, keyVersion: number, vaultKey: Uint8Array): void;
  hasVaultKey(vaultId: string, keyVersion: number): boolean;
  useVaultKey<T>(
    vaultId: string,
    keyVersion: number,
    use: (vaultKey: Uint8Array) => T,
  ): T;
  forgetVault(vaultId: string): void;
}

/**
 * The only holder of long-lived keys. It takes ownership of the
 * buffers passed in, lends keys only to synchronous callbacks, never returns
 * secret key bytes and wipes everything on `lock()`.
 */
export class KeyStore implements Keys {
  #account: AccountKeyMaterial | undefined;
  readonly #vaultKeys = new Map<string, Map<number, Uint8Array>>();
  /** Raised by every lock (and so by every unlock). */
  #generation = 0;

  get isUnlocked(): boolean {
    return this.#account !== undefined;
  }

  unlock(material: AccountKeyMaterial): void {
    assertUuid(material.userId, "user_id");
    assertKey(material.userKey, "User key");
    assertKey(material.privateKey, "Private key");
    assertKey(material.publicKey, "Public key");
    this.lock();
    this.#account = material;
  }

  get userId(): string {
    return this.#unlocked().userId;
  }

  /** pk' is public, so a copy may leave the store. */
  get publicKey(): Uint8Array {
    return this.#unlocked().publicKey.slice();
  }

  useUserKey<T>(use: (userKey: Uint8Array) => T): T {
    return assertSynchronous(use(this.#unlocked().userKey));
  }

  usePrivateKey<T>(use: (privateKey: Uint8Array) => T): T {
    return assertSynchronous(use(this.#unlocked().privateKey));
  }

  /** Stores a vault key; a previous key for the same version is wiped. */
  setVaultKey(vaultId: string, keyVersion: number, vaultKey: Uint8Array): void {
    this.#unlocked();
    assertUuid(vaultId, "vault_id");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1)
      throw new CryptoError("validation", "Invalid key version");
    assertKey(vaultKey, "Vault key");
    let versions = this.#vaultKeys.get(vaultId);
    if (!versions) {
      versions = new Map();
      this.#vaultKeys.set(vaultId, versions);
    }
    const previous = versions.get(keyVersion);
    if (previous !== vaultKey) wipe(previous);
    versions.set(keyVersion, vaultKey);
  }

  hasVaultKey(vaultId: string, keyVersion: number): boolean {
    this.#unlocked();
    return this.#vaultKeys.get(vaultId)?.has(keyVersion) ?? false;
  }

  vaultKeyVersions(vaultId: string): number[] {
    this.#unlocked();
    return [...(this.#vaultKeys.get(vaultId)?.keys() ?? [])].sort(
      (a, b) => a - b,
    );
  }

  useVaultKey<T>(
    vaultId: string,
    keyVersion: number,
    use: (vaultKey: Uint8Array) => T,
  ): T {
    const key =
      (this.#unlocked(), this.#vaultKeys.get(vaultId)?.get(keyVersion));
    if (!key)
      throw new CryptoError(
        "validation",
        "No key for this vault and key version",
      );
    return assertSynchronous(use(key));
  }

  /** Wipes and removes all keys of a vault. */
  forgetVault(vaultId: string): void {
    const versions = this.#vaultKeys.get(vaultId);
    if (!versions) return;
    wipe(...versions.values());
    this.#vaultKeys.delete(vaultId);
  }

  /**
   * The keys of the current unlock only. After a lock every call fails with
   * `locked`, also once the store is unlocked again: a task of a stopped
   * engine that still finishes never adds a key to a later unlock.
   */
  scope(): Keys {
    const generation = this.#generation;
    const current = (): this => {
      if (this.#generation !== generation)
        throw new CryptoError("locked", "Key store was locked");
      return this;
    };
    return {
      useUserKey: (use) => current().useUserKey(use),
      usePrivateKey: (use) => current().usePrivateKey(use),
      setVaultKey: (vaultId, keyVersion, vaultKey) => {
        try {
          current();
        } catch (error) {
          wipe(vaultKey);
          throw error;
        }
        this.setVaultKey(vaultId, keyVersion, vaultKey);
      },
      hasVaultKey: (vaultId, keyVersion) =>
        current().hasVaultKey(vaultId, keyVersion),
      useVaultKey: (vaultId, keyVersion, use) =>
        current().useVaultKey(vaultId, keyVersion, use),
      forgetVault: (vaultId) => {
        current().forgetVault(vaultId);
      },
    };
  }

  /** Wipes every key; safe to call repeatedly. */
  lock(): void {
    this.#generation += 1;
    for (const vaultId of [...this.#vaultKeys.keys()])
      this.forgetVault(vaultId);
    if (this.#account) wipe(this.#account.userKey, this.#account.privateKey);
    this.#account = undefined;
  }

  toJSON(): never {
    throw new Error("KeyStore must not be serialized");
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[KeyStore]";
  }

  #unlocked(): AccountKeyMaterial {
    if (!this.#account) throw new CryptoError("locked", "Key store is locked");
    return this.#account;
  }
}
