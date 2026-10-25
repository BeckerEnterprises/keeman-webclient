import { describe, expect, it } from "vitest";
import { aad } from "../../src/crypto/aad";
import { deriveLoginKeys } from "../../src/crypto/argon2";
import { fromBase64Url, toBase64Url } from "../../src/crypto/bytes";
import { openJson, openKey } from "../../src/crypto/envelope";
import {
  buildPasswordChange,
  buildRecoveryFinish,
  buildRecoveryMaterial,
  buildRegistration,
  newPasswordSetup,
  startRecovery,
  unlockAccount,
  unwrapRecoveredUserKey,
  type MeKeys,
} from "../../src/crypto/flows/account";
import {
  acceptKeyGrant,
  buildKeyBox,
  buildRotation,
  buildVaultCreation,
  dropTombstone,
  findUndecryptableObjects,
  generateFileKey,
  unwrapVaultKey,
  type StoredObject,
} from "../../src/crypto/flows/vault";
import { generateKeyPair } from "../../src/crypto/keypair";
import {
  decryptChange,
  decryptObject,
  DROPPED_SEQ,
  encryptObject,
  encryptTombstone,
} from "../../src/crypto/objects";
import { systemRandomness } from "../../src/crypto/random";
import {
  CREATED,
  expectCryptoError,
  IDS,
  labelRandomness,
  MIN_KDF,
} from "../helpers";

function register(
  password = "correct horse battery staple",
  prefix = "register",
) {
  const rnd = labelRandomness(prefix);
  const setup = newPasswordSetup(rnd, MIN_KDF);
  const loginKeys = deriveLoginKeys(password, setup.salt, setup.kdf);
  const registration = buildRegistration(rnd, {
    ...setup,
    email: " Alice@Example.com ",
    loginKeys,
    userData: { schema: 1, seq: 1, contacts: [] },
  });
  const me: MeKeys = {
    user_id: registration.request.user_id,
    user_key_wrapped: registration.request.user_key_wrapped,
    private_key_wrapped: registration.request.private_key_wrapped,
    public_key: registration.request.public_key,
    user_data: { revision: 1, data: registration.request.user_data },
  };
  return { registration, loginKeys, me, setup };
}

describe("account flows", () => {
  it("registers and unlocks again with the password", () => {
    const { registration, loginKeys, me } = register();
    expect(registration.request.email).toBe("alice@example.com");
    expect(registration.recoveryKeyDisplay).toMatch(
      /^([A-Z2-7]{4} ){13}[A-Z2-7]{4}$/,
    );
    const unlocked = unlockAccount(me, loginKeys.wrapKey);
    expect(unlocked.account.userId).toBe(registration.account.userId);
    expect(unlocked.account.userKey).toEqual(registration.account.userKey);
    expect(unlocked.account.publicKey).toEqual(registration.account.publicKey);
    expect(unlocked.userData).toEqual({ schema: 1, seq: 1, contacts: [] });
  });

  it("separates wrong passwords, integrity failures and corrupt user data", () => {
    const { me, loginKeys, setup } = register();
    const wrong = deriveLoginKeys("wrong", setup.salt, setup.kdf);
    expectCryptoError(() => unlockAccount(me, wrong.wrapKey), "auth");
    const otherPk = toBase64Url(generateKeyPair(systemRandomness).publicKey);
    expectCryptoError(
      () => unlockAccount({ ...me, public_key: otherPk }, loginKeys.wrapKey),
      "integrity",
    );
    const other = register("other password", "register-other");
    expectCryptoError(
      () =>
        unlockAccount(
          { ...me, private_key_wrapped: other.me.private_key_wrapped },
          loginKeys.wrapKey,
        ),
      "integrity",
    );
    const corrupt = unlockAccount(
      { ...me, user_data: { revision: 1, data: other.me.user_data.data } },
      loginKeys.wrapKey,
    );
    expect(corrupt.userData).toBeUndefined();
    expectCryptoError(
      () => unlockAccount({ ...me, user_id: "x" }, loginKeys.wrapKey),
      "validation",
    );
  });

  it("changes the password without touching the user key", () => {
    const { registration } = register();
    const rnd = labelRandomness("change");
    const setup = newPasswordSetup(rnd, MIN_KDF);
    const loginKeys = deriveLoginKeys("new password", setup.salt, setup.kdf);
    const request = buildPasswordChange(
      rnd,
      {
        ...setup,
        userId: registration.account.userId,
        userKey: registration.account.userKey,
        loginKeys,
      },
      true,
    );
    expect(request.revoke_other_sessions).toBe(true);
    expect(
      openKey(
        loginKeys.wrapKey,
        request.user_key_wrapped,
        aad.userKey(registration.account.userId),
      ),
    ).toEqual(registration.account.userKey);
  });

  it("recovers the user key with the recovery key and sets a new password", () => {
    const { registration } = register();
    const start = startRecovery(registration.recoveryKeyDisplay.toLowerCase());
    expect(start.recoveryAuthKey).toBe(registration.request.recovery.auth_key);
    const userKey = unwrapRecoveredUserKey(
      start.recoveryWrapKey,
      registration.account.userId,
      registration.request.recovery.user_key_wrapped,
    );
    expect(userKey).toEqual(registration.account.userKey);

    const rnd = labelRandomness("recover");
    const setup = newPasswordSetup(rnd, MIN_KDF);
    const loginKeys = deriveLoginKeys("after recovery", setup.salt, setup.kdf);
    const input = {
      ...setup,
      userId: registration.account.userId,
      userKey,
      loginKeys,
    };
    const keep = buildRecoveryFinish(rnd, input, false);
    expect(keep.request.recovery).toBeUndefined();
    expect(keep.recoveryKeyDisplay).toBeUndefined();
    expect(keep.request).not.toHaveProperty("revoke_other_sessions");
    const renewed = buildRecoveryFinish(
      labelRandomness("recover2"),
      input,
      true,
    );
    expect(renewed.request.recovery?.auth_key).toBe(
      startRecovery(renewed.recoveryKeyDisplay ?? "").recoveryAuthKey,
    );

    const material = buildRecoveryMaterial(
      labelRandomness("rk"),
      registration.account.userId,
      userKey,
    );
    expect(material.request.user_key_wrapped).not.toBe(
      registration.request.recovery.user_key_wrapped,
    );
  });
});

describe("vault flows", () => {
  const owner = {
    id: IDS.user,
    ...generateKeyPair(labelRandomness("owner")),
    userKey: labelRandomness("owner").bytes("uk", 32),
  };
  const member = {
    id: IDS.other,
    ...generateKeyPair(labelRandomness("member")),
    userKey: labelRandomness("member").bytes("uk", 32),
  };

  function createVault() {
    return buildVaultCreation(labelRandomness("vault"), {
      userId: owner.id,
      userKey: owner.userKey,
      objects: [
        {
          label: "meta",
          type: "vault_meta",
          content: { schema: 1, seq: 1, name: "Privat" },
        },
        {
          label: "root",
          type: "group",
          content: { schema: 1, seq: 1, name: "Root" },
        },
        {
          label: "trash",
          type: "group",
          content: { schema: 1, seq: 1, name: "Trash" },
        },
      ],
    });
  }

  it("creates a vault with key version 1 and vault_meta under the vault ID", () => {
    const vault = createVault();
    const meta = vault.request.objects[0];
    expect(meta?.id).toBe(vault.vaultId);
    expect(
      vault.request.objects.every((object) => object.key_version === 1),
    ).toBe(true);
    expect(
      unwrapVaultKey(
        owner.userKey,
        vault.request.key_wrapped,
        vault.vaultId,
        owner.id,
        1,
      ),
    ).toEqual(vault.vaultKey);
    const ref = {
      vaultId: vault.vaultId,
      objectId: meta?.id ?? "",
      type: "vault_meta" as const,
      keyVersion: 1,
    };
    expect(decryptObject(vault.vaultKey, ref, meta?.data ?? "")).toEqual({
      schema: 1,
      seq: 1,
      name: "Privat",
    });
    expectCryptoError(
      () =>
        buildVaultCreation(labelRandomness("x"), {
          userId: owner.id,
          userKey: owner.userKey,
          objects: [],
        }),
      "validation",
    );
  });

  it("lets contents refer to the new IDs and rejects duplicate labels", () => {
    const vault = buildVaultCreation(systemRandomness, {
      userId: owner.id,
      userKey: owner.userKey,
      objects: [
        {
          label: "meta",
          type: "vault_meta",
          content: (ids) => ({
            schema: 1,
            seq: 1,
            rootGroupId: ids.root ?? "",
          }),
        },
        { label: "root", type: "group", content: { schema: 1, seq: 1 } },
      ],
    });
    const [meta, root] = vault.request.objects;
    const content = decryptObject(
      vault.vaultKey,
      {
        vaultId: vault.vaultId,
        objectId: vault.vaultId,
        type: "vault_meta",
        keyVersion: 1,
      },
      meta?.data ?? "",
    );
    expect(content.rootGroupId).toBe(root?.id);
    expectCryptoError(
      () =>
        buildVaultCreation(systemRandomness, {
          userId: owner.id,
          userKey: owner.userKey,
          objects: [
            { label: "a", type: "vault_meta", content: { schema: 1, seq: 1 } },
            { label: "a", type: "group", content: { schema: 1, seq: 1 } },
          ],
        }),
      "validation",
    );
  });

  it("keeps given object IDs and rejects invalid or repeated ones", () => {
    const rootId = "0123abcd-0000-1111-2222-333344445555";
    const meta = {
      label: "meta",
      type: "vault_meta" as const,
      content: (ids: Readonly<Record<string, string>>) => ({
        schema: 1,
        seq: 1,
        rootGroupId: ids.root ?? "",
      }),
    };
    const build = (
      objects: Parameters<typeof buildVaultCreation>[1]["objects"],
    ) =>
      buildVaultCreation(systemRandomness, {
        userId: owner.id,
        userKey: owner.userKey,
        objects,
      });
    const vault = build([
      meta,
      {
        label: "root",
        type: "group",
        id: rootId,
        content: { schema: 1, seq: 1 },
      },
    ]);
    expect(vault.request.objects[1]?.id).toBe(rootId);
    const content = decryptObject(
      vault.vaultKey,
      {
        vaultId: vault.vaultId,
        objectId: vault.vaultId,
        type: "vault_meta",
        keyVersion: 1,
      },
      vault.request.objects[0]?.data ?? "",
    );
    expect(content.rootGroupId).toBe(rootId);
    for (const objects of [
      [
        meta,
        { label: "root", type: "group" as const, id: "ROOT", content: {} },
      ],
      [{ ...meta, id: rootId }],
      [
        meta,
        { label: "a", type: "group" as const, id: rootId, content: {} },
        { label: "b", type: "group" as const, id: rootId, content: {} },
      ],
    ])
      expectCryptoError(() => build(objects), "validation");
  });

  it("invites and accepts, including a pending key after rotation", () => {
    const vault = createVault();
    const keyBox = buildKeyBox(labelRandomness("box"), {
      senderId: owner.id,
      senderPrivateKey: owner.privateKey,
      recipientId: member.id,
      recipientPublicKey: member.publicKey,
      vaultId: vault.vaultId,
      keyVersion: 1,
      vaultKey: vault.vaultKey,
      vaultName: "Privat",
      created: CREATED,
    });
    const grant = { key_box: keyBox, key_version: 1, sender_id: owner.id };
    const accepted = acceptKeyGrant(labelRandomness("accept"), {
      grant,
      vaultId: vault.vaultId,
      ownUserId: member.id,
      ownPrivateKey: member.privateKey,
      userKey: member.userKey,
      senderPublicKey: owner.publicKey,
    });
    expect(accepted.vaultKey).toEqual(vault.vaultKey);
    expect(
      unwrapVaultKey(
        member.userKey,
        accepted.request.key_wrapped,
        vault.vaultId,
        member.id,
        1,
      ),
    ).toEqual(vault.vaultKey);
    expectCryptoError(
      () =>
        acceptKeyGrant(labelRandomness("accept"), {
          grant,
          vaultId: vault.vaultId,
          ownUserId: member.id,
          ownPrivateKey: member.privateKey,
          userKey: member.userKey,
          senderPublicKey: owner.publicKey,
          currentKeyVersion: 1,
        }),
      "validation",
    );
  });

  it("rotates: re-encrypts live objects, keeps tombstones out and boxes the new key", () => {
    const vault = createVault();
    const ref = (id: string) => ({
      vaultId: vault.vaultId,
      objectId: id,
      type: "entry" as const,
      keyVersion: 1,
    });
    const entry = {
      id: IDS.object,
      type: "entry" as const,
      key_version: 1,
      deleted: false,
      data: encryptObject(systemRandomness, vault.vaultKey, ref(IDS.object), {
        schema: 1,
        seq: 5,
      }),
    };
    const tombstone = {
      id: IDS.attachment,
      type: "entry" as const,
      key_version: 1,
      deleted: true,
      data: encryptTombstone(
        systemRandomness,
        vault.vaultKey,
        ref(IDS.attachment),
        { seq: 2, deletedAt: CREATED, deletedBy: owner.id },
      ),
    };
    const broken: StoredObject = {
      id: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a70",
      type: "entry",
      key_version: 1,
      deleted: false,
      data: entry.data,
    };
    const objects: StoredObject[] = [
      ...vault.request.objects.map((object) => ({ ...object, deleted: false })),
      entry,
      tombstone,
      broken,
    ];
    const oldVaultKey = (version: number) =>
      version === 1 ? vault.vaultKey : undefined;
    expect(
      findUndecryptableObjects({
        vaultId: vault.vaultId,
        objects,
        oldVaultKey,
      }),
    ).toEqual([broken.id]);
    const input = {
      vaultId: vault.vaultId,
      ownerId: owner.id,
      ownerPrivateKey: owner.privateKey,
      userKey: owner.userKey,
      vaultName: "Privat",
      created: CREATED,
      newKeyVersion: 2,
      oldVaultKey,
      objects,
      dropObjectIds: [],
      members: [{ userId: member.id, publicKey: member.publicKey }],
      invites: [],
    };
    expectCryptoError(
      () => buildRotation(labelRandomness("rot"), input),
      "auth",
    );
    // Drop tombstones need a time; vault_meta and unknown IDs are refused.
    expectCryptoError(
      () =>
        buildRotation(labelRandomness("rot"), {
          ...input,
          dropObjectIds: [broken.id],
        }),
      "validation",
    );
    expectCryptoError(
      () =>
        buildRotation(
          labelRandomness("rot"),
          { ...input, dropObjectIds: [vault.vaultId] },
          CREATED,
        ),
      "validation",
    );
    expectCryptoError(
      () =>
        buildRotation(
          labelRandomness("rot"),
          { ...input, dropObjectIds: [IDS.vault] },
          CREATED,
        ),
      "validation",
    );
    expectCryptoError(
      () =>
        dropTombstone(
          labelRandomness("drop"),
          { ...input, newKeyVersion: 1 },
          broken,
          vault.vaultKey,
          CREATED,
        ),
      "validation",
    );
    const rotation = buildRotation(
      labelRandomness("rot"),
      { ...input, dropObjectIds: [broken.id] },
      CREATED,
    );
    expect(rotation.objects.map((object) => object.id)).toEqual([
      ...vault.request.objects.map((o) => o.id),
      IDS.object,
    ]);
    expect(rotation.objects.every((object) => object.key_version === 2)).toBe(
      true,
    );
    expect(rotation.commit.drop_objects.map((drop) => drop.id)).toEqual([
      broken.id,
    ]);
    // The drop tombstone is authenticated with the new key.
    expect(
      decryptChange(
        rotation.vaultKey,
        { ...ref(broken.id), keyVersion: 2 },
        rotation.commit.drop_objects[0]?.data ?? "",
        true,
      ),
    ).toEqual({
      deleted: true,
      tombstone: {
        schema: 1,
        deleted: true,
        dropped: true,
        seq: DROPPED_SEQ,
        deletedAt: CREATED,
        deletedBy: owner.id,
      },
    });
    const rotatedEntry = rotation.objects.at(-1);
    expect(
      decryptObject(
        rotation.vaultKey,
        { ...ref(IDS.object), keyVersion: 2 },
        rotatedEntry?.data ?? "",
      ),
    ).toEqual({ schema: 1, seq: 5 });
    expect(
      unwrapVaultKey(
        owner.userKey,
        rotation.commit.key_wrapped,
        vault.vaultId,
        owner.id,
        2,
      ),
    ).toEqual(rotation.vaultKey);
    const pending = acceptKeyGrant(labelRandomness("pending"), {
      grant: {
        key_box: rotation.commit.member_keys[0]?.key_box ?? "",
        key_version: 2,
        sender_id: owner.id,
      },
      vaultId: vault.vaultId,
      ownUserId: member.id,
      ownPrivateKey: member.privateKey,
      userKey: member.userKey,
      senderPublicKey: owner.publicKey,
      currentKeyVersion: 1,
    });
    expect(pending.vaultKey).toEqual(rotation.vaultKey);
    expect(generateFileKey(systemRandomness)).toHaveLength(32);
    expect(fromBase64Url(rotation.commit.key_wrapped)).toHaveLength(73);
    expect(openJson).toBeTypeOf("function");
  });
});
