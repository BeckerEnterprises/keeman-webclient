import { describe, expect, it } from "vitest";
import { aad } from "../../src/crypto/aad";
import {
  openVaultKeyBox,
  sealVaultKeyBox,
  type KeyGrantContext,
  type VaultKeyMessage,
} from "../../src/crypto/box";
import { fromBase64Url, toBase64Url, utf8Encode } from "../../src/crypto/bytes";
import {
  openBytes,
  openJson,
  openKey,
  sealBytes,
  sealJson,
  sealKey,
  WRAPPED_KEY_BYTES,
} from "../../src/crypto/envelope";
import { generateKeyPair } from "../../src/crypto/keypair";
import {
  decryptChange,
  decryptObject,
  decryptUserData,
  encryptObject,
  encryptTombstone,
  encryptUserData,
  reencryptObject,
  type ObjectRef,
} from "../../src/crypto/objects";
import { systemRandomness } from "../../src/crypto/random";
import { sodium } from "../../src/crypto/sodium";
import {
  CREATED,
  expectCryptoError,
  IDS,
  labelRandomness,
  scriptedRandomness,
  tv,
} from "../helpers";

const key = tv("envelope-key", 32);
const label = aad.userKey(IDS.user);

function mutate(
  envelope: string,
  change: (bytes: Uint8Array) => Uint8Array,
): string {
  return toBase64Url(change(fromBase64Url(envelope)));
}

describe("AEAD envelope", () => {
  it("wraps raw keys into 73-byte envelopes with fresh nonces", () => {
    const raw = tv("raw", 32);
    const a = sealKey(systemRandomness, key, raw, label);
    const b = sealKey(systemRandomness, key, raw, label);
    expect(fromBase64Url(a)).toHaveLength(WRAPPED_KEY_BYTES);
    expect(a).not.toBe(b);
    expect(openKey(key, a, label)).toEqual(raw);
  });

  it("follows the check order for raw keys", () => {
    const envelope = sealKey(labelRandomness(), key, tv("raw", 32), label);
    expectCryptoError(() => openKey(key, `${envelope}=`, label), "format");
    expectCryptoError(
      () =>
        openKey(
          key,
          mutate(envelope, (b) => b.with(0, 0x02)),
          label,
        ),
      "format",
    );
    expectCryptoError(
      () =>
        openKey(
          key,
          mutate(envelope, (b) => b.subarray(0, 72)),
          label,
        ),
      "format",
    );
    expectCryptoError(
      () =>
        openKey(
          key,
          mutate(envelope, (b) => b.with(40, (b[40] ?? 0) ^ 1)),
          label,
        ),
      "auth",
    );
    expectCryptoError(
      () => openKey(key, envelope, aad.userKey(IDS.other)),
      "auth",
    );
    expectCryptoError(() => openKey(tv("other", 32), envelope, label), "auth");
    const bytesEnvelope = sealBytes(
      labelRandomness(),
      key,
      new Uint8Array(0),
      label,
    );
    expectCryptoError(() => openKey(key, bytesEnvelope, label), "format");
  });

  it("binds every wrapped key to its purpose, account, vault and version", () => {
    const credential = toBase64Url(tv("credential", 16));
    const labels = {
      userKey: aad.userKey(IDS.user),
      recovery: aad.recovery(IDS.user),
      prf: aad.prf(IDS.user, credential),
      privateKey: aad.privateKey(IDS.user),
      vaultKey: aad.vaultKey(IDS.vault, IDS.user, 1),
    };
    const others = {
      userKey: [aad.userKey(IDS.other)],
      recovery: [aad.recovery(IDS.other)],
      prf: [
        aad.prf(IDS.other, credential),
        aad.prf(IDS.user, toBase64Url(tv("other-credential", 16))),
      ],
      privateKey: [aad.privateKey(IDS.other)],
      vaultKey: [
        aad.vaultKey(IDS.vault, IDS.other, 1),
        aad.vaultKey(IDS.object, IDS.user, 1),
        aad.vaultKey(IDS.vault, IDS.user, 2),
      ],
    };
    const raw = tv("raw", 32);
    for (const [purpose, right] of Object.entries(labels)) {
      const envelope = sealKey(labelRandomness(), key, raw, right);
      expect(openKey(key, envelope, right)).toEqual(raw);
      const wrong = [
        ...Object.values(labels).filter((l) => l !== right),
        ...others[purpose as keyof typeof others],
      ];
      for (const label of wrong)
        expectCryptoError(() => openKey(key, envelope, label), "auth");
    }
  });

  it("pads JSON and checks padding and encoding", () => {
    const value = { schema: 1, seq: 1, title: "Grüße" };
    const envelope = sealJson(labelRandomness(), key, value, label);
    expect(openJson(key, envelope, label)).toEqual(value);
    expect(fromBase64Url(envelope).length).toBe(1 + 24 + 256 + 16);
    expectCryptoError(
      () =>
        openJson(
          key,
          mutate(envelope, (b) => b.subarray(0, 40)),
          label,
        ),
      "format",
    );

    const sealRaw = (plaintext: Uint8Array): string => {
      const nonce = tv("raw-nonce", 24);
      const ciphertext = sodium().crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        utf8Encode(label),
        null,
        nonce,
        key,
      );
      return toBase64Url(Uint8Array.of(1, ...nonce, ...ciphertext));
    };
    expectCryptoError(
      () => openBytes(key, sealRaw(utf8Encode("{}")), label),
      "padding",
    );
    expectCryptoError(
      () =>
        openJson(
          key,
          sealBytes(labelRandomness(), key, Uint8Array.of(0xff), label),
          label,
        ),
      "encoding",
    );
    expectCryptoError(
      () =>
        openJson(
          key,
          sealBytes(labelRandomness(), key, utf8Encode("[]"), label),
          label,
        ),
      "encoding",
    );
  });

  it("validates key and nonce lengths", () => {
    expectCryptoError(
      () => sealKey(systemRandomness, key, new Uint8Array(31), label),
      "validation",
    );
    expectCryptoError(
      () => sealKey(systemRandomness, new Uint8Array(16), tv("raw", 32), label),
      "validation",
    );
    expectCryptoError(
      () => openKey(new Uint8Array(16), "AA", label),
      "validation",
    );
    const badNonce = { bytes: () => new Uint8Array(12), id: () => IDS.user };
    expectCryptoError(
      () => sealKey(badNonce, key, tv("raw", 32), label),
      "validation",
    );
  });
});

describe("objects, tombstones, user data", () => {
  const vk = tv("vault-key", 32);
  const ref: ObjectRef = {
    vaultId: IDS.vault,
    objectId: IDS.object,
    type: "entry",
    keyVersion: 1,
  };

  it("binds objects to vault, ID, type and key version", () => {
    const data = encryptObject(labelRandomness(), vk, ref, {
      schema: 1,
      seq: 3,
    });
    expect(decryptObject(vk, ref, data)).toEqual({ schema: 1, seq: 3 });
    expectCryptoError(
      () => decryptObject(vk, { ...ref, type: "group" }, data),
      "auth",
    );
    expectCryptoError(
      () => decryptObject(vk, { ...ref, keyVersion: 2 }, data),
      "auth",
    );
    expectCryptoError(
      () => decryptObject(vk, { ...ref, objectId: IDS.other }, data),
      "auth",
    );
  });

  it("re-encrypts the exact plaintext bytes for a rotation", () => {
    const oldData = sealBytes(
      labelRandomness(),
      vk,
      utf8Encode('{"seq":4,"schema":9,"x":{"unknown":true}}'),
      aad.object(IDS.vault, IDS.object, "entry", 1),
    );
    const newKey = tv("vault-key-2", 32);
    const newData = reencryptObject(
      labelRandomness("r"),
      vk,
      ref,
      newKey,
      2,
      oldData,
    );
    expect(
      openBytes(newKey, newData, aad.object(IDS.vault, IDS.object, "entry", 2)),
    ).toEqual(utf8Encode('{"seq":4,"schema":9,"x":{"unknown":true}}'));
    const noSeq = encryptObject(labelRandomness(), vk, ref, { schema: 1 });
    expectCryptoError(
      () => reencryptObject(labelRandomness("r"), vk, ref, newKey, 2, noSeq),
      "validation",
    );
  });

  it("encrypts tombstones and checks the deleted flag", () => {
    const tombstone = { seq: 8, deletedAt: CREATED, deletedBy: IDS.user };
    const data = encryptTombstone(labelRandomness(), vk, ref, tombstone);
    expect(decryptChange(vk, ref, data, true)).toEqual({
      deleted: true,
      tombstone: { schema: 1, deleted: true, ...tombstone },
    });
    expectCryptoError(() => decryptChange(vk, ref, data, false), "validation");
    const live = encryptObject(labelRandomness(), vk, ref, {
      schema: 1,
      seq: 7,
    });
    expect(decryptChange(vk, ref, live, false)).toEqual({
      deleted: false,
      content: { schema: 1, seq: 7 },
    });
    expectCryptoError(() => decryptChange(vk, ref, live, true), "validation");
    const broken = encryptObject(labelRandomness(), vk, ref, {
      schema: 1,
      deleted: true,
      seq: 0,
      deletedAt: CREATED,
      deletedBy: IDS.user,
    });
    expectCryptoError(() => decryptChange(vk, ref, broken, true), "validation");
    expectCryptoError(
      () =>
        encryptTombstone(labelRandomness(), vk, ref, { ...tombstone, seq: 0 }),
      "validation",
    );
    expectCryptoError(
      () =>
        encryptTombstone(labelRandomness(), vk, ref, {
          ...tombstone,
          deletedAt: "yesterday",
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        encryptTombstone(labelRandomness(), vk, ref, {
          ...tombstone,
          deletedBy: "x",
        }),
      "validation",
    );
  });

  it("encrypts user data with the user key", () => {
    const uk = tv("uk", 32);
    const data = encryptUserData(labelRandomness(), uk, IDS.user, {
      schema: 1,
      seq: 1,
      contacts: [],
    });
    expect(decryptUserData(uk, IDS.user, data)).toEqual({
      schema: 1,
      seq: 1,
      contacts: [],
    });
    expectCryptoError(() => decryptUserData(uk, IDS.other, data), "auth");
  });
});

describe("box envelope", () => {
  const alice = generateKeyPair(labelRandomness("alice"));
  const bob = generateKeyPair(labelRandomness("bob"));
  const message: VaultKeyMessage = {
    vaultId: IDS.vault,
    keyVersion: 3,
    vaultKey: tv("box-vk", 32),
    senderId: IDS.user,
    recipientId: IDS.other,
    vaultName: "Gemeinsam",
    created: CREATED,
  };
  const context: KeyGrantContext = {
    ownUserId: IDS.other,
    senderId: IDS.user,
    vaultId: IDS.vault,
    keyVersion: 3,
  };
  const box = sealVaultKeyBox(
    labelRandomness(),
    alice.privateKey,
    bob.publicKey,
    message,
  );

  it("opens and validates a box", () => {
    expect(
      openVaultKeyBox(box, bob.privateKey, alice.publicKey, context),
    ).toEqual({
      vaultKey: message.vaultKey,
      vaultName: "Gemeinsam",
      created: CREATED,
    });
    expect((fromBase64Url(box).length - 1 - 24 - 16) % 256).toBe(0);
  });

  it("truncates long vault names to 256 characters", () => {
    const long = sealVaultKeyBox(
      systemRandomness,
      alice.privateKey,
      bob.publicKey,
      { ...message, vaultName: "🔑".repeat(300) },
    );
    expect(
      Array.from(
        openVaultKeyBox(long, bob.privateKey, alice.publicKey, context)
          .vaultName,
      ),
    ).toHaveLength(256);
  });

  it("rejects reflection, rollback and mismatching fields", () => {
    // Alice opens her own box to Bob: the MAC is valid, the IDs are not.
    expectCryptoError(
      () =>
        openVaultKeyBox(box, alice.privateKey, bob.publicKey, {
          ...context,
          ownUserId: IDS.user,
          senderId: IDS.other,
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(box, bob.privateKey, alice.publicKey, {
          ...context,
          keyVersion: 4,
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(box, bob.privateKey, alice.publicKey, {
          ...context,
          currentKeyVersion: 3,
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(box, bob.privateKey, alice.publicKey, {
          ...context,
          vaultId: IDS.object,
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(box, bob.privateKey, alice.publicKey, {
          ...context,
          senderId: IDS.vault,
        }),
      "validation",
    );
    expectCryptoError(
      () => openVaultKeyBox(box, bob.privateKey, bob.publicKey, context),
      "auth",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(
          mutate(box, (b) => b.with(0, 1)),
          bob.privateKey,
          alice.publicKey,
          context,
        ),
      "format",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(
          mutate(box, (b) => b.subarray(0, 40)),
          bob.privateKey,
          alice.publicKey,
          context,
        ),
      "format",
    );
    expectCryptoError(
      () =>
        openVaultKeyBox(box, bob.privateKey, alice.publicKey, {
          ...context,
          keyVersion: 0,
        }),
      "validation",
    );
  });

  it("validates the message fields", () => {
    const raw = (json: Record<string, unknown>, padded = true): string => {
      const nonce = tv("box-nonce", 24);
      const plaintext = utf8Encode(JSON.stringify(json));
      const body = padded ? sodium().pad(plaintext, 256) : plaintext;
      return toBase64Url(
        Uint8Array.of(
          2,
          ...nonce,
          ...sodium().crypto_box_easy(
            body,
            nonce,
            bob.publicKey,
            alice.privateKey,
          ),
        ),
      );
    };
    const valid = {
      v: 1,
      type: "vault_key",
      vault_id: IDS.vault,
      key_version: 3,
      vault_key: toBase64Url(message.vaultKey),
      sender_id: IDS.user,
      recipient_id: IDS.other,
      vault_name: "x",
      created: CREATED,
      future_field: true,
    };
    expect(
      openVaultKeyBox(raw(valid), bob.privateKey, alice.publicKey, context)
        .vaultName,
    ).toBe("x");
    expectCryptoError(
      () =>
        openVaultKeyBox(
          raw(valid, false),
          bob.privateKey,
          alice.publicKey,
          context,
        ),
      "padding",
    );
    for (const change of [
      { v: 2 },
      { type: "other" },
      { key_version: "3" },
      { vault_key: toBase64Url(new Uint8Array(31)) },
      { vault_key: 7 },
      { vault_key: "AA==" },
      { created: "today" },
      { vault_name: 5 },
      { recipient_id: IDS.object },
      { vault_id: "x" },
    ]) {
      expectCryptoError(
        () =>
          openVaultKeyBox(
            raw({ ...valid, ...change }),
            bob.privateKey,
            alice.publicKey,
            context,
          ),
        "validation",
      );
    }
  });

  it("validates sealing inputs", () => {
    expectCryptoError(
      () =>
        sealVaultKeyBox(systemRandomness, alice.privateKey, bob.publicKey, {
          ...message,
          vaultKey: new Uint8Array(1),
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        sealVaultKeyBox(systemRandomness, alice.privateKey, bob.publicKey, {
          ...message,
          created: "now",
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        sealVaultKeyBox(systemRandomness, alice.privateKey, bob.publicKey, {
          ...message,
          keyVersion: 0,
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        sealVaultKeyBox(
          systemRandomness,
          new Uint8Array(1),
          bob.publicKey,
          message,
        ),
      "validation",
    );
    const shortNonce = { bytes: () => new Uint8Array(23), id: () => IDS.user };
    expectCryptoError(
      () =>
        sealVaultKeyBox(shortNonce, alice.privateKey, bob.publicKey, message),
      "validation",
    );
    expect(() =>
      sealVaultKeyBox(
        scriptedRandomness({ nonce: new Uint8Array(24) }),
        alice.privateKey,
        bob.publicKey,
        message,
      ),
    ).not.toThrow();
  });
});
