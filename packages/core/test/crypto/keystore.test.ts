import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { KeyStore } from "../../src/crypto/keystore";
import { expectCryptoError, IDS, tv } from "../helpers";

function material() {
  return {
    userId: IDS.user,
    userKey: tv("uk", 32),
    privateKey: tv("sk", 32),
    publicKey: tv("pk", 32),
  };
}

describe("KeyStore", () => {
  it("lends keys to synchronous callbacks only", () => {
    const store = new KeyStore();
    store.unlock(material());
    expect(store.isUnlocked).toBe(true);
    expect(store.userId).toBe(IDS.user);
    expect(store.useUserKey((uk) => uk.length)).toBe(32);
    expect(store.usePrivateKey((sk) => sk[0])).toBe(tv("sk", 32)[0]);
    expect(() => store.useUserKey(async () => Promise.resolve(1))).toThrow(
      /synchronous/,
    );
    const pk = store.publicKey;
    pk.fill(0);
    expect(store.publicKey).toEqual(tv("pk", 32));
  });

  it("manages vault keys per version and wipes replaced keys", () => {
    const store = new KeyStore();
    store.unlock(material());
    const v1 = tv("vk1", 32);
    const v1b = tv("vk1b", 32);
    store.setVaultKey(IDS.vault, 1, v1);
    store.setVaultKey(IDS.vault, 2, tv("vk2", 32));
    store.setVaultKey(IDS.vault, 1, v1);
    expect(v1).toEqual(tv("vk1", 32));
    store.setVaultKey(IDS.vault, 1, v1b);
    expect(v1).toEqual(new Uint8Array(32));
    expect(store.vaultKeyVersions(IDS.vault)).toEqual([1, 2]);
    expect(store.vaultKeyVersions(IDS.other)).toEqual([]);
    expect(store.hasVaultKey(IDS.vault, 2)).toBe(true);
    expect(store.hasVaultKey(IDS.other, 2)).toBe(false);
    expect(store.useVaultKey(IDS.vault, 1, (vk) => vk[0])).toBe(
      tv("vk1b", 32)[0],
    );
    expectCryptoError(
      () => store.useVaultKey(IDS.vault, 3, () => 0),
      "validation",
    );
    expectCryptoError(() => {
      store.setVaultKey(IDS.vault, 0, tv("x", 32));
    }, "validation");
    expectCryptoError(() => {
      store.setVaultKey(IDS.vault, 1, new Uint8Array(31));
    }, "validation");
    store.forgetVault(IDS.vault);
    store.forgetVault(IDS.vault);
    expect(v1b).toEqual(new Uint8Array(32));
    expect(store.hasVaultKey(IDS.vault, 1)).toBe(false);
  });

  it("wipes everything on lock and refuses access afterwards", () => {
    const store = new KeyStore();
    const keys = material();
    store.unlock(keys);
    const vk = tv("vk", 32);
    store.setVaultKey(IDS.vault, 1, vk);
    store.lock();
    store.lock();
    expect(keys.userKey).toEqual(new Uint8Array(32));
    expect(keys.privateKey).toEqual(new Uint8Array(32));
    expect(vk).toEqual(new Uint8Array(32));
    expect(store.isUnlocked).toBe(false);
    expectCryptoError(() => store.userId, "locked");
    expectCryptoError(() => store.useUserKey(() => 0), "locked");
    expectCryptoError(() => {
      store.setVaultKey(IDS.vault, 1, tv("vk", 32));
    }, "locked");
  });

  it("validates material and is never serialised", () => {
    const store = new KeyStore();
    expectCryptoError(() => {
      store.unlock({ ...material(), userId: "x" });
    }, "validation");
    expectCryptoError(() => {
      store.unlock({ ...material(), userKey: new Uint8Array(1) });
    }, "validation");
    expect(() => JSON.stringify(store)).toThrow(/serialized/);
    expect(inspect(store)).toBe("[KeyStore]");
  });
});
