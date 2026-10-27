// Crypto steps of the vault flows as pure functions. The API calls
// and the fingerprint policy follow in src/sync and src/sharing.
import type { components } from "../../api/openapi.gen";
import { aad, type ObjectType } from "../aad";
import { openVaultKeyBox, sealVaultKeyBox, type KeyGrantContext } from "../box";
import { fromBase64Url, wipe, type JsonObject } from "../bytes";
import { openKey, sealKey } from "../envelope";
import { CryptoError } from "../errors";
import { KEY_BYTES } from "../kdf";
import {
  DROPPED_SEQ,
  encryptObject,
  encryptTombstone,
  reencryptObject,
} from "../objects";
import {
  bucketOf,
  isManifestId,
  manifestIds,
  objectHash,
  rootRaw,
  shardRaw,
  type ManifestEntry,
} from "../../model/manifest";
import { scoped, type Randomness } from "../random";
import {
  genesisStatement,
  roleStatementHash,
  signRoleStatement,
  successorStatement,
  type RoleOwner,
  type RolePoint,
  type SignedRoles,
  type VerifiedRoles,
} from "../roles";
import { assertUuid, isUuid } from "../uuid";

type Schemas = components["schemas"];

export interface NewObject {
  /** Names the object's randomness; unique within the call. */
  label: string;
  type: ObjectType;
  /**
   * A given ID instead of a new one, e.g. the KeePass UUID of an imported
   * root group; not for `vault_meta`, which gets the vault ID.
   */
  id?: string;
  /**
   * The content, or a function of the new IDs by label, so `vault_meta` can
   * name its root group and recycle bin.
   */
  content: JsonObject | ((ids: Readonly<Record<string, string>>) => JsonObject);
}

export interface VaultCreation {
  vaultId: string;
  vaultKey: Uint8Array;
  /** `roles` is missing for servers without roles chains. */
  request: Omit<Schemas["CreateVaultRequest"], "roles"> & {
    roles?: SignedRoles;
  };
}

/** What signs a roles statement: the own owner entry and signing key. */
export interface RolesSigner {
  owner: RoleOwner;
  /** Ed25519 secret key (64 bytes) of `owner`. */
  signingSecretKey: Uint8Array;
  created: string;
}

/**
 * Body of `POST /v1/vaults`: new vault key with key version 1; the
 * `vault_meta` object gets the vault ID, all others new IDs. With
 * `manifest`, the manifest root and the shards of these objects come along
 * (the caller sets `manifest: true` in `vault_meta`). With `roles`, the
 * first statement of the roles chain names the creator as the only owner.
 */
export function buildVaultCreation(
  randomness: Randomness,
  input: {
    userId: string;
    userKey: Uint8Array;
    objects: NewObject[];
    manifest?: boolean;
    roles?: RolesSigner;
  },
): VaultCreation {
  if (input.roles && input.roles.owner.userId !== input.userId)
    throw new CryptoError("validation", "The creator signs the first roles");
  if (
    input.objects.filter((object) => object.type === "vault_meta").length !== 1
  ) {
    throw new CryptoError(
      "validation",
      "A new vault needs exactly one vault_meta object",
    );
  }
  const labels = new Set(input.objects.map((object) => object.label));
  if (labels.size !== input.objects.length)
    throw new CryptoError("validation", "Object labels must be unique");
  const vaultId = randomness.id("vault_id");
  // All IDs first: contents may refer to each other.
  const ids: Record<string, string> = {};
  for (const object of input.objects)
    ids[object.label] =
      object.type === "vault_meta"
        ? vaultId
        : (object.id ?? randomness.id(`${object.label}.id`));
  const all = Object.values(ids);
  if (
    input.objects.some(
      (object) =>
        object.type === "manifest" ||
        (object.id !== undefined &&
          (object.type === "vault_meta" ||
            !isUuid(object.id) ||
            isManifestId(vaultId, object.id))),
    ) ||
    new Set(all).size !== all.length
  )
    throw new CryptoError("validation", "Object IDs must be valid and unique");
  const vaultKey = randomness.bytes("vault_key", KEY_BYTES);
  const objects = input.objects.map((object) => {
    const id = ids[object.label] ?? vaultId;
    const ref = { vaultId, objectId: id, type: object.type, keyVersion: 1 };
    const content =
      typeof object.content === "function"
        ? object.content(ids)
        : object.content;
    return {
      id,
      type: object.type,
      key_version: 1,
      data: encryptObject(
        scoped(randomness, object.label),
        vaultKey,
        ref,
        content,
      ),
    };
  });
  if (input.manifest === true)
    objects.push(...manifestObjects(randomness, vaultKey, vaultId, objects));
  const request: VaultCreation["request"] = {
    vault_id: vaultId,
    key_wrapped: wrapVaultKey(
      scoped(randomness, "key_wrapped"),
      input.userKey,
      vaultKey,
      vaultId,
      input.userId,
      1,
    ),
    objects,
  };
  if (input.roles)
    request.roles = signRoleStatement(
      genesisStatement({
        vaultId,
        owners: [input.roles.owner],
        signer: input.userId,
        keyVersion: 1,
        vaultKey,
        created: input.roles.created,
      }),
      input.roles.signingSecretKey,
    );
  return { vaultId, vaultKey, request };
}

/** Root and shards (`seq` 1) listing the given objects of a new vault. */
function manifestObjects(
  randomness: Randomness,
  vaultKey: Uint8Array,
  vaultId: string,
  objects: readonly { id: string; type: ObjectType; data: string }[],
): { id: string; type: ObjectType; key_version: number; data: string }[] {
  const ids = manifestIds(vaultId);
  const buckets = new Map<number, Map<string, ManifestEntry>>();
  for (const object of objects) {
    const k = bucketOf(object.id);
    const entries = buckets.get(k) ?? new Map<string, ManifestEntry>();
    entries.set(object.id, [
      object.type,
      objectHash(vaultId, object.id, object.type, 1, object.data),
    ]);
    buckets.set(k, entries);
  }
  const encrypted = (id: string, label: string, content: JsonObject) => ({
    id,
    type: "manifest" as const,
    key_version: 1,
    data: encryptObject(
      scoped(randomness, label),
      vaultKey,
      { vaultId, objectId: id, type: "manifest", keyVersion: 1 },
      content,
    ),
  });
  const shards: ([number, string] | null)[] = [];
  const result = [];
  for (let k = 0; k < ids.shards.length; k++) {
    const entries = buckets.get(k);
    const id = ids.shards[k] ?? "";
    if (!entries) {
      shards.push(null);
      continue;
    }
    const shard = encrypted(
      id,
      `manifest.shard.${String(k)}`,
      shardRaw(undefined, entries, 1),
    );
    shards.push([1, objectHash(vaultId, id, "manifest", 1, shard.data)]);
    result.push(shard);
  }
  result.push(
    encrypted(ids.root, "manifest.root", rootRaw(undefined, shards, 1)),
  );
  return result;
}

/** The own `key_wrapped` of a vault key. */
export function wrapVaultKey(
  randomness: Randomness,
  userKey: Uint8Array,
  vaultKey: Uint8Array,
  vaultId: string,
  userId: string,
  keyVersion: number,
): string {
  return sealKey(
    randomness,
    userKey,
    vaultKey,
    aad.vaultKey(vaultId, userId, keyVersion),
  );
}

export function unwrapVaultKey(
  userKey: Uint8Array,
  keyWrapped: string,
  vaultId: string,
  userId: string,
  keyVersion: number,
): Uint8Array {
  return openKey(
    userKey,
    keyWrapped,
    aad.vaultKey(vaultId, userId, keyVersion),
  );
}

export interface KeyBoxInput {
  senderId: string;
  senderPrivateKey: Uint8Array;
  recipientId: string;
  recipientPublicKey: Uint8Array;
  vaultId: string;
  keyVersion: number;
  vaultKey: Uint8Array;
  vaultName: string;
  created: string;
  /** The checked roles statement the sender vouches for. */
  roles?: RolePoint | undefined;
  /** `seq` of the manifest root the sender last synced (invitations). */
  manifest?: number | undefined;
}

/** `key_box` for an invitation or after a rotation. Fingerprint policy: caller. */
export function buildKeyBox(
  randomness: Randomness,
  input: KeyBoxInput,
): string {
  return sealVaultKeyBox(
    randomness,
    input.senderPrivateKey,
    input.recipientPublicKey,
    {
      vaultId: input.vaultId,
      keyVersion: input.keyVersion,
      vaultKey: input.vaultKey,
      senderId: input.senderId,
      recipientId: input.recipientId,
      vaultName: input.vaultName,
      created: input.created,
      roles: input.roles,
      manifest: input.manifest,
    },
  );
}

export interface KeyGrantAcceptance {
  vaultKey: Uint8Array;
  vaultName: string;
  /** The roles statement the box names, if any. */
  roles: RolePoint | undefined;
  /** When the sender made the box (the sender's clock). */
  created: string;
  /** `seq` of the sender's manifest root, in newer invitations. */
  manifest: number | undefined;
  /** Body of `POST /v1/vaults/{id}/accept` or `/key`. */
  request: Schemas["VaultKeyAcceptance"];
}

/** Opens an invitation or pending key and re-wraps it with the user key. */
export function acceptKeyGrant(
  randomness: Randomness,
  input: {
    grant: Schemas["KeyGrant"];
    vaultId: string;
    ownUserId: string;
    ownPrivateKey: Uint8Array;
    userKey: Uint8Array;
    senderPublicKey: Uint8Array;
    /** Own `member_key_version` when accepting a pending key after a rotation. */
    currentKeyVersion?: number;
  },
): KeyGrantAcceptance {
  const context: KeyGrantContext = {
    ownUserId: input.ownUserId,
    senderId: input.grant.sender_id,
    vaultId: input.vaultId,
    keyVersion: input.grant.key_version,
    ...(input.currentKeyVersion === undefined
      ? {}
      : { currentKeyVersion: input.currentKeyVersion }),
  };
  const opened = openVaultKeyBox(
    input.grant.key_box,
    input.ownPrivateKey,
    input.senderPublicKey,
    context,
  );
  return {
    vaultKey: opened.vaultKey,
    vaultName: opened.vaultName,
    roles: opened.roles,
    created: opened.created,
    manifest: opened.manifest,
    request: {
      key_version: input.grant.key_version,
      key_wrapped: wrapVaultKey(
        randomness,
        input.userKey,
        opened.vaultKey,
        input.vaultId,
        input.ownUserId,
        input.grant.key_version,
      ),
    },
  };
}

export interface StoredObject {
  id: string;
  type: ObjectType;
  key_version: number;
  deleted: boolean;
  data: string | null;
}

export interface RotationRecipient {
  userId: string;
  publicKey: Uint8Array;
}

export interface RotationInput {
  vaultId: string;
  ownerId: string;
  ownerPrivateKey: Uint8Array;
  userKey: Uint8Array;
  vaultName: string;
  created: string;
  newKeyVersion: number;
  /** Old vault keys by key version. */
  oldVaultKey: (keyVersion: number) => Uint8Array | undefined;
  /** Full state of the vault. */
  objects: StoredObject[];
  /** Objects the owner decided to drop. */
  dropObjectIds: string[];
  /** Remaining active members except the owner, and pending invitations. */
  members: RotationRecipient[];
  invites: RotationRecipient[];
  /**
   * The checked head of the roles chain and the owners after the rotation;
   * the commit then carries the next statement and the boxes name it.
   */
  roles?: { head: VerifiedRoles; owners: readonly RoleOwner[] } & Omit<
    RolesSigner,
    "owner"
  >;
}

export interface Rotation {
  vaultKey: Uint8Array;
  objects: Schemas["ObjectUpload"][];
  commit: Omit<Schemas["CommitRotationRequest"], "remove_user_ids">;
}

function liveObjects(
  input: Pick<RotationInput, "objects" | "dropObjectIds">,
): StoredObject[] {
  const drop = new Set(input.dropObjectIds);
  return input.objects.filter(
    (object) => !object.deleted && !drop.has(object.id),
  );
}

/** IDs of live objects that cannot be re-encrypted; the owner must drop them first. */
export function findUndecryptableObjects(
  input: Pick<RotationInput, "vaultId" | "objects" | "oldVaultKey">,
): string[] {
  const probeKey = new Uint8Array(KEY_BYTES);
  const failed: string[] = [];
  for (const object of liveObjects({
    objects: input.objects,
    dropObjectIds: [],
  })) {
    try {
      reencryptStored(
        probeRandomness,
        input,
        object,
        probeKey,
        object.key_version + 1,
      );
    } catch {
      failed.push(object.id);
    }
  }
  return failed;
}

const probeRandomness: Randomness = {
  bytes: (_label, length) => new Uint8Array(length),
  id: () => {
    throw new Error("not used");
  },
};

function reencryptStored(
  randomness: Randomness,
  input: Pick<RotationInput, "vaultId" | "oldVaultKey">,
  object: StoredObject,
  newKey: Uint8Array,
  newKeyVersion: number,
): string {
  const oldKey = input.oldVaultKey(object.key_version);
  if (!oldKey || object.data === null)
    throw new CryptoError("auth", "No key for this object");
  const ref = {
    vaultId: input.vaultId,
    objectId: object.id,
    type: object.type,
    keyVersion: object.key_version,
  };
  return reencryptObject(
    randomness,
    oldKey,
    ref,
    newKey,
    newKeyVersion,
    object.data,
  );
}

function assertNewKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 2)
    throw new CryptoError("validation", "Invalid new key version");
}

/** The new vault key of a rotation. */
export function rotationKey(randomness: Randomness): Uint8Array {
  return randomness.bytes("vault_key", KEY_BYTES);
}

/** One live object re-encrypted with the new vault key. */
export function rotateObject(
  randomness: Randomness,
  input: Pick<RotationInput, "vaultId" | "oldVaultKey" | "newKeyVersion">,
  object: StoredObject,
  vaultKey: Uint8Array,
): Schemas["ObjectUpload"] {
  assertNewKeyVersion(input.newKeyVersion);
  return {
    id: object.id,
    type: object.type,
    key_version: input.newKeyVersion,
    data: reencryptStored(
      scoped(randomness, `object.${object.id}`),
      input,
      object,
      vaultKey,
      input.newKeyVersion,
    ),
  };
}

/** The manifest of a vault before a rotation: root and existing shards. */
export interface RotatedManifest {
  root: { raw: JsonObject; seq: number };
  /** Shard index → its content and `seq`. */
  shards: ReadonlyMap<number, { raw: JsonObject; seq: number }>;
  /** Highest root `seq` the owner's device has seen. */
  floor: number;
}

/**
 * The manifest renewed for a rotation: every existing shard lists the
 * re-encrypted objects of its bucket (dropped ones are gone), `seq` + 1;
 * the root names the new shards. Encrypted with the new key. `objects`
 * are the uploads with their hash (`objectHash` with the new key version).
 */
export function rotateManifest(
  randomness: Randomness,
  input: Pick<RotationInput, "vaultId" | "newKeyVersion">,
  manifest: RotatedManifest,
  objects: readonly { id: string; type: string; hash: string }[],
  vaultKey: Uint8Array,
): Schemas["ObjectUpload"][] {
  assertNewKeyVersion(input.newKeyVersion);
  const { vaultId, newKeyVersion } = input;
  const ids = manifestIds(vaultId);
  const buckets = new Map<number, Map<string, ManifestEntry>>();
  for (const object of objects) {
    if (isManifestId(vaultId, object.id)) continue;
    const k = bucketOf(object.id);
    const entries = buckets.get(k) ?? new Map<string, ManifestEntry>();
    entries.set(object.id, [object.type, object.hash]);
    buckets.set(k, entries);
  }
  for (const k of buckets.keys())
    if (!manifest.shards.has(k))
      throw new CryptoError("validation", "An object outside the manifest");
  const encrypted = (id: string, label: string, content: JsonObject) => ({
    id,
    type: "manifest" as const,
    key_version: newKeyVersion,
    data: encryptObject(
      scoped(randomness, label),
      vaultKey,
      { vaultId, objectId: id, type: "manifest", keyVersion: newKeyVersion },
      content,
    ),
  });
  const shards: ([number, string] | null)[] = [];
  const result: Schemas["ObjectUpload"][] = [];
  for (let k = 0; k < ids.shards.length; k++) {
    const old = manifest.shards.get(k);
    const id = ids.shards[k] ?? "";
    if (!old) {
      shards.push(null);
      continue;
    }
    const seq = old.seq + 1;
    const shard = encrypted(
      id,
      `manifest.shard.${String(k)}`,
      shardRaw(old.raw, buckets.get(k) ?? new Map(), seq),
    );
    shards.push([
      seq,
      objectHash(vaultId, id, "manifest", newKeyVersion, shard.data),
    ]);
    result.push(shard);
  }
  const seq = Math.max(manifest.root.seq, manifest.floor) + 1;
  result.push(
    encrypted(
      ids.root,
      "manifest.root",
      rootRaw(manifest.root.raw, shards, seq),
    ),
  );
  return result;
}

/**
 * Drop tombstone of an object the owner discards at a rotation: encrypted
 * with the new key; `vault_meta` is never dropped.
 */
export function dropTombstone(
  randomness: Randomness,
  input: Pick<RotationInput, "vaultId" | "ownerId" | "newKeyVersion">,
  object: Pick<StoredObject, "id" | "type">,
  vaultKey: Uint8Array,
  now: string,
): Schemas["DroppedObject"] {
  assertNewKeyVersion(input.newKeyVersion);
  if (object.type === "vault_meta" || object.id === input.vaultId)
    throw new CryptoError("validation", "vault_meta is never dropped");
  const ref = {
    vaultId: input.vaultId,
    objectId: object.id,
    type: object.type,
    keyVersion: input.newKeyVersion,
  };
  return {
    id: object.id,
    data: encryptTombstone(
      scoped(randomness, `drop.${object.id}`),
      vaultKey,
      ref,
      {
        seq: DROPPED_SEQ,
        deletedAt: now,
        deletedBy: input.ownerId,
        dropped: true,
      },
    ),
  };
}

/** The statement of a rotation: new key version, its commitment, the owners after it. */
export function rotationRoles(
  input: Pick<RotationInput, "vaultId" | "ownerId" | "newKeyVersion"> & {
    roles: NonNullable<RotationInput["roles"]>;
  },
  vaultKey: Uint8Array,
): SignedRoles {
  const { roles } = input;
  if (roles.head.statement.vaultId !== input.vaultId)
    throw new CryptoError("validation", "Roles of another vault");
  return signRoleStatement(
    successorStatement(roles.head, {
      owners: roles.owners,
      signer: input.ownerId,
      created: roles.created,
      rotation: { keyVersion: input.newKeyVersion, vaultKey },
    }),
    roles.signingSecretKey,
  );
}

/**
 * Own `key_wrapped` and the boxes for members and invites; with `roles` also
 * the next roles statement, which every box names.
 */
export function rotationCommit(
  randomness: Randomness,
  input: Omit<RotationInput, "oldVaultKey" | "objects" | "dropObjectIds">,
  vaultKey: Uint8Array,
  dropObjects: Schemas["DroppedObject"][],
): Rotation["commit"] {
  assertUuid(input.vaultId, "vault_id");
  assertNewKeyVersion(input.newKeyVersion);
  const roles = input.roles
    ? rotationRoles({ ...input, roles: input.roles }, vaultKey)
    : undefined;
  const point =
    roles && input.roles
      ? {
          version: input.roles.head.statement.version + 1,
          hash: roleStatementHash(fromBase64Url(roles.statement)),
        }
      : undefined;
  const box = (recipient: RotationRecipient, kind: string) => ({
    user_id: recipient.userId,
    key_box: buildKeyBox(scoped(randomness, `${kind}.${recipient.userId}`), {
      senderId: input.ownerId,
      senderPrivateKey: input.ownerPrivateKey,
      recipientId: recipient.userId,
      recipientPublicKey: recipient.publicKey,
      vaultId: input.vaultId,
      keyVersion: input.newKeyVersion,
      vaultKey,
      vaultName: input.vaultName,
      created: input.created,
      roles: point,
    }),
  });
  return {
    key_wrapped: wrapVaultKey(
      scoped(randomness, "key_wrapped"),
      input.userKey,
      vaultKey,
      input.vaultId,
      input.ownerId,
      input.newKeyVersion,
    ),
    member_keys: input.members.map((member) => box(member, "member")),
    invite_keys: input.invites.map((invite) => box(invite, "invite")),
    drop_objects: dropObjects,
    ...(roles ? { roles } : {}),
  };
}

/**
 * Material of a staged key rotation in one go: new vault
 * key, every live object re-encrypted, drop tombstones, own `key_wrapped` and
 * boxes for members and invites. `now` dates the drop tombstones.
 */
export function buildRotation(
  randomness: Randomness,
  input: RotationInput,
  now?: string,
): Rotation {
  assertUuid(input.vaultId, "vault_id");
  if (input.dropObjectIds.length > 0 && now === undefined)
    throw new CryptoError("validation", "Drop tombstones need a time");
  const vaultKey = rotationKey(randomness);
  try {
    const drops = input.dropObjectIds.map((id) => {
      const object = input.objects.find((o) => o.id === id);
      if (!object)
        throw new CryptoError("validation", "Unknown dropped object");
      return dropTombstone(randomness, input, object, vaultKey, now ?? "");
    });
    const objects = liveObjects(input).map((object) =>
      rotateObject(randomness, input, object, vaultKey),
    );
    return {
      vaultKey,
      objects,
      commit: rotationCommit(randomness, input, vaultKey, drops),
    };
  } catch (error) {
    wipe(vaultKey);
    throw error;
  }
}

/** File key of a new attachment. */
export function generateFileKey(randomness: Randomness): Uint8Array {
  return randomness.bytes("file_key", KEY_BYTES);
}
