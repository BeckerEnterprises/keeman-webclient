/**
 * Staged key rotation: a fresh full sync with the
 * ciphertexts, the owner's review, then per attempt a new vault key, parts
 * re-encrypted right before their upload, and a commit with drop
 * tombstones and boxes. The new key enters the KeyStore after the commit.
 */
import { ApiError } from "../api/errors";
import type { Member } from "../api/schemas";
import type { ObjectType } from "../crypto/aad";
import { wipe, type JsonObject } from "../crypto/bytes";
import {
  dropTombstone,
  findUndecryptableObjects,
  rotateManifest,
  rotateObject,
  rotationCommit,
  rotationKey,
  type RotatedManifest,
  type StoredObject,
} from "../crypto/flows/vault";
import { decryptObject } from "../crypto/objects";
import { systemRandomness } from "../crypto/random";
import type { RoleOwner, VerifiedRoles } from "../crypto/roles";
import {
  bucketOf,
  checkManifest,
  inspectManifest,
  manifestIds,
  objectHash,
  type ManifestCheck,
  type ManifestRead,
  type Served,
} from "../model/manifest";
import { SyncError } from "../sync/errors";
import { keyOf, statusNow, toCandidate, type Candidate } from "./candidate";
import type { SharingContext } from "./context";

/** At most this many objects and bytes per upload. */
const PART_OBJECTS = 500;
const PART_BYTES = 12 * 1024 * 1024;
/** Attempts after `409 conflict`. */
const MAX_ATTEMPTS = 3;

export interface RotationRecipient {
  readonly candidate: Candidate;
  readonly state: "active" | "pending";
}

export interface CorruptObject {
  readonly id: string;
  readonly type: ObjectType;
}

/** What the owner reviews before a rotation. */
export interface RotationReview {
  readonly vaultId: string;
  /** Active members and pending invitations, the own account excluded. */
  readonly recipients: readonly RotationRecipient[];
  /** Live objects that cannot be re-encrypted; they block until dropped. */
  readonly corrupt: readonly CorruptObject[];
  readonly objects: number;
}

/** The owner's decisions; recipients not removed must be verified. */
export interface RotationDecisions {
  /** Active members and invitees that lose access. */
  readonly remove: readonly string[];
  /** Drop the corrupt objects of the review. */
  readonly dropCorrupt: boolean;
}

export interface RotationRun {
  onProgress?: (progress: { done: number; total: number }) => void;
  /** The vault changed beyond the base revision: start over early. */
  stale?: (baseRevision: number) => boolean;
  /**
   * The checked head of the roles chain and the owners after the rotation
   * (`reload` after `roles_conflict`); `undefined` without a chain.
   */
  roles?: (
    members: readonly Member[],
    removed: ReadonlySet<string>,
    reload: boolean,
  ) => Promise<{ head: VerifiedRoles; owners: RoleOwner[] } | undefined>;
}

interface Collected {
  baseRevision: number;
  keyVersion: number;
  objects: StoredObject[];
  corrupt: CorruptObject[];
  members: Member[];
  /** The collected state against its own manifest. */
  check: ManifestCheck;
  /** The manifest to renew; absent for a vault without one. */
  manifest: RotatedManifest | undefined;
}

const plans = new WeakMap<
  RotationReview,
  { collected: Collected; vaultName: string; floor: number }
>();

/** The attempt ends and a new one starts with a fresh full sync. */
class Restart extends Error {
  readonly reason: "conflict" | "invalid";

  constructor(reason: "conflict" | "invalid") {
    super(`Rotation restarts: ${reason}`);
    this.reason = reason;
  }
}

/** Decrypted content of a collected object, `undefined` if it fails. */
function decrypted(
  ctx: SharingContext,
  vaultId: string,
  object: StoredObject | undefined,
): JsonObject | undefined {
  const data = object?.data;
  if (!object || !data || !ctx.keys.hasVaultKey(vaultId, object.key_version))
    return undefined;
  const ref = {
    vaultId,
    objectId: object.id,
    type: object.type,
    keyVersion: object.key_version,
  };
  try {
    return ctx.keys.useVaultKey(vaultId, object.key_version, (key) =>
      decryptObject(key, ref, data),
    );
  } catch {
    return undefined;
  }
}

/**
 * The collected objects against their manifest, so a rotation never
 * writes a withheld or replayed state with the new key.
 */
function manifestOf(
  ctx: SharingContext,
  vaultId: string,
  live: readonly (StoredObject & { revision: number })[],
  floor: number,
): { check: ManifestCheck; manifest: RotatedManifest | undefined } {
  const byId = new Map(live.map((o) => [o.id, o]));
  const served = new Map<string, Served>();
  for (const o of live)
    served.set(o.id, {
      type: o.type,
      revision: o.revision,
      hash: objectHash(vaultId, o.id, o.type, o.key_version, o.data),
      bucket: bucketOf(o.id),
    });
  const read = (id: string): ManifestRead => {
    const object = byId.get(id);
    if (!object) return { kind: "absent" };
    if (!ctx.keys.hasVaultKey(vaultId, object.key_version))
      return { kind: "corrupt", reason: "no_key" };
    const raw = decrypted(ctx, vaultId, object);
    if (!raw) return { kind: "corrupt", reason: "auth" };
    const inspected = inspectManifest(raw, id, vaultId);
    if (inspected.status === "corrupt")
      return { kind: "corrupt", reason: inspected.reason };
    if (inspected.value.kind === "newer") return { kind: "newer" };
    return { kind: "ok", seq: inspected.seq, raw, value: inspected.value };
  };
  const check = checkManifest({
    vaultId,
    served,
    read,
    flagged: decrypted(ctx, vaultId, byId.get(vaultId))?.manifest === true,
    floor,
  });
  if (check.status !== "verified") return { check, manifest: undefined };
  const ids = manifestIds(vaultId);
  const root = read(ids.root);
  if (root.kind !== "ok") return { check, manifest: undefined };
  const shards = new Map<number, { raw: JsonObject; seq: number }>();
  ids.shards.forEach((id, k) => {
    const shard = read(id);
    if (shard.kind === "ok") shards.set(k, { raw: shard.raw, seq: shard.seq });
  });
  return {
    check,
    manifest: { root: { raw: root.raw, seq: root.seq }, shards, floor },
  };
}

/** Full state with ciphertexts: since=0, then a delta from the first page. */
async function collect(
  ctx: SharingContext,
  vaultId: string,
  floor: number,
): Promise<Collected> {
  const objects = new Map<string, StoredObject & { revision: number }>();
  const read = async (
    since: number,
  ): Promise<{ first: number; last: number; keyVersion: number }> => {
    let cursor: string | undefined;
    let first: number | undefined;
    for (;;) {
      const page = await ctx.api.changes(vaultId, since, cursor);
      first ??= page.vault_revision;
      for (const o of page.objects) {
        const known = objects.get(o.id);
        if (known && known.revision > o.revision) continue;
        objects.set(o.id, {
          id: o.id,
          type: o.type,
          key_version: o.key_version,
          deleted: o.deleted,
          data: o.data,
          revision: o.revision,
        });
      }
      if (page.next_cursor === null)
        return {
          first,
          last: page.vault_revision,
          keyVersion: page.key_version,
        };
      cursor = page.next_cursor;
    }
  };
  const full = await read(0);
  const delta = await read(full.first);
  const collected = [...objects.values()].filter((o) => !o.deleted);
  const live = collected.map((o): StoredObject => ({
    id: o.id,
    type: o.type,
    key_version: o.key_version,
    deleted: false,
    data: o.data,
  }));
  const { check, manifest } = manifestOf(ctx, vaultId, collected, floor);
  const corrupt = live
    .filter((o) => {
      if (o.data === null || !ctx.keys.hasVaultKey(vaultId, o.key_version))
        return true;
      return ctx.keys.useVaultKey(
        vaultId,
        o.key_version,
        (key) =>
          findUndecryptableObjects({
            vaultId,
            objects: [o],
            oldVaultKey: () => key,
          }).length > 0,
      );
    })
    .map((o) => ({ id: o.id, type: o.type }));
  return {
    baseRevision: delta.last,
    keyVersion: delta.keyVersion,
    objects: live,
    corrupt,
    members: await ctx.api.members(vaultId),
    check,
    manifest,
  };
}

/** Refuses a collected state that does not match its manifest. */
function checked(collected: Collected): Collected {
  if (collected.check.status === "mismatch")
    throw new SyncError("manifest_mismatch");
  if (collected.check.status === "unknown") throw new SyncError("read_only");
  const root = collected.manifest?.root.seq ?? Number.POSITIVE_INFINITY;
  if (collected.manifest && root < collected.manifest.floor)
    throw new SyncError("rollback_open");
  return collected;
}

function recipientsOf(
  ctx: SharingContext,
  members: Member[],
): RotationRecipient[] {
  const contacts = ctx.contacts();
  return members
    .filter((m) => m.user_id !== ctx.userId)
    .map((m) => ({
      candidate: toCandidate(m, contacts, ctx.userId),
      state: m.state,
    }));
}

/** Loads the vault afresh and lists what the owner must decide. */
export async function prepareRotation(
  ctx: SharingContext,
  vaultId: string,
  vaultName: string,
  /** Highest manifest root `seq` this device has seen. */
  floor = 0,
): Promise<RotationReview> {
  const collected = checked(await collect(ctx, vaultId, floor));
  if (collected.corrupt.some((o) => o.type === "vault_meta"))
    throw new SyncError("read_only");
  const review: RotationReview = Object.freeze({
    vaultId,
    recipients: recipientsOf(ctx, collected.members),
    corrupt: collected.corrupt,
    objects: collected.objects.filter((o) => o.type !== "manifest").length,
  });
  plans.set(review, { collected, vaultName, floor });
  return review;
}

function parts(objects: StoredObject[]): StoredObject[][] {
  const result: StoredObject[][] = [];
  let part: StoredObject[] = [];
  let bytes = 0;
  for (const object of objects) {
    const size = (object.data?.length ?? 0) + 200;
    if (
      part.length > 0 &&
      (part.length >= PART_OBJECTS || bytes + size > PART_BYTES)
    ) {
      result.push(part);
      part = [];
      bytes = 0;
    }
    part.push(object);
    bytes += size;
  }
  if (part.length > 0) result.push(part);
  return result;
}

/**
 * The recipients that keep access, each verified now; a new unverified one
 * or one the review did not show means the owner must decide again.
 */
function keptRecipients(
  ctx: SharingContext,
  members: Member[],
  remove: ReadonlySet<string>,
  reviewed: ReadonlySet<string>,
): { members: Candidate[]; invites: Candidate[] } {
  const contacts = ctx.contacts();
  const kept: { members: Candidate[]; invites: Candidate[] } = {
    members: [],
    invites: [],
  };
  for (const recipient of recipientsOf(ctx, members)) {
    const { candidate } = recipient;
    if (remove.has(candidate.userId)) continue;
    if (statusNow(candidate, contacts) !== "verified")
      throw new SyncError(
        reviewed.has(candidate.userId) ? "unverified" : "rotation_conflict",
      );
    (recipient.state === "active" ? kept.members : kept.invites).push(
      candidate,
    );
  }
  return kept;
}

async function attempt(
  ctx: SharingContext,
  vaultId: string,
  vaultName: string,
  collected: Collected,
  decisions: RotationDecisions,
  reviewed: ReadonlySet<string>,
  run: RotationRun,
): Promise<number> {
  const remove = new Set(decisions.remove);
  if (collected.corrupt.length > 0 && !decisions.dropCorrupt)
    throw new SyncError("corrupt_objects");
  keptRecipients(ctx, collected.members, remove, reviewed);
  const newKeyVersion = collected.keyVersion + 1;
  const vaultKey = rotationKey(systemRandomness);
  let stored = false;
  try {
    const now = new Date().toISOString();
    const owner = { vaultId, ownerId: ctx.userId, newKeyVersion };
    const drops = collected.corrupt.map((o) =>
      dropTombstone(systemRandomness, owner, o, vaultKey, now),
    );
    const call = async <T>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.code === "conflict") throw new Restart("conflict");
          if (error.code === "rotation_invalid") throw new Restart("invalid");
          if (error.code === "key_version_mismatch")
            throw new SyncError("stale_key");
          if (error.code === "rotation_incomplete")
            throw new SyncError("rotation_conflict");
        }
        throw error;
      }
    };
    const opened = await call(() =>
      ctx.api.openRotation(
        vaultId,
        systemRandomness.id("idempotency_key"),
        JSON.stringify({
          base_revision: collected.baseRevision,
          new_key_version: newKeyVersion,
        }),
      ),
    );
    const dropped = new Set(collected.corrupt.map((o) => o.id));
    // Manifest objects are renewed, not re-encrypted as they are.
    const live = collected.objects.filter(
      (o) => !dropped.has(o.id) && o.type !== "manifest",
    );
    const split = parts(live);
    const hashes: { id: string; type: string; hash: string }[] = [];
    let done = 0;
    run.onProgress?.({ done, total: live.length });
    for (const part of split) {
      if (run.stale?.(collected.baseRevision)) throw new Restart("conflict");
      // Re-encrypted only now, so a large vault is not held twice.
      const objects = part.map((o) =>
        ctx.keys.useVaultKey(vaultId, o.key_version, (oldKey) =>
          rotateObject(
            systemRandomness,
            { vaultId, oldVaultKey: () => oldKey, newKeyVersion },
            o,
            vaultKey,
          ),
        ),
      );
      const body = JSON.stringify({ objects });
      const key = systemRandomness.id("idempotency_key");
      await call(() =>
        ctx.api.uploadRotationObjects(vaultId, opened.rotation_id, key, body),
      );
      for (const o of objects)
        hashes.push({
          id: o.id,
          type: o.type,
          hash: objectHash(vaultId, o.id, o.type, newKeyVersion, o.data),
        });
      done += part.length;
      run.onProgress?.({ done, total: live.length });
    }
    const manifest = collected.manifest;
    if (manifest) {
      const objects = rotateManifest(
        systemRandomness,
        { vaultId, newKeyVersion },
        manifest,
        hashes,
        vaultKey,
      );
      const body = JSON.stringify({ objects });
      const key = systemRandomness.id("idempotency_key");
      await call(() =>
        ctx.api.uploadRotationObjects(vaultId, opened.rotation_id, key, body),
      );
    }
    // Invitations sent meanwhile must not vanish unnoticed.
    const members = await ctx.api.members(vaultId);
    const kept = keptRecipients(ctx, members, remove, reviewed);
    const recipient = (c: Candidate) => ({
      userId: c.userId,
      publicKey: keyOf(c).publicKey,
    });
    const removeIds = members
      .map((m) => m.user_id)
      .filter((id) => remove.has(id));
    // A changed roles chain only needs a new statement and new boxes.
    for (let attempt = 1; ; attempt++) {
      const roles = await run.roles?.(members, remove, attempt > 1);
      const commit = ctx.keys.useUserKey((userKey) =>
        ctx.keys.usePrivateKey((ownerPrivateKey) =>
          ctx.keys.useSigningKey((signingSecretKey) =>
            rotationCommit(
              systemRandomness,
              {
                ...owner,
                ownerPrivateKey,
                userKey,
                vaultName,
                created: now,
                members: kept.members.map(recipient),
                invites: kept.invites.map(recipient),
                ...(roles
                  ? { roles: { ...roles, signingSecretKey, created: now } }
                  : {}),
              },
              vaultKey,
              drops,
            ),
          ),
        ),
      );
      const body = JSON.stringify({ ...commit, remove_user_ids: removeIds });
      const key = systemRandomness.id("idempotency_key");
      try {
        await call(() =>
          ctx.api.commitRotation(vaultId, opened.rotation_id, key, body),
        );
        break;
      } catch (error) {
        if (
          !(
            error instanceof ApiError &&
            (error.code === "roles_conflict" || error.code === "roles_required")
          ) ||
          attempt >= MAX_ATTEMPTS
        )
          throw error;
      }
    }
    ctx.keys.setVaultKey(vaultId, newKeyVersion, vaultKey);
    stored = true;
    return newKeyVersion;
  } finally {
    if (!stored) wipe(vaultKey);
  }
}

/**
 * Runs the rotation with its retry rules; returns the new
 * key version. A changed vault restarts automatically while the decisions
 * still cover it, otherwise `rotation_conflict` asks for a new review.
 */
export async function runRotation(
  ctx: SharingContext,
  review: RotationReview,
  decisions: RotationDecisions,
  run: RotationRun = {},
): Promise<number> {
  const plan = plans.get(review);
  if (!plan) throw new SyncError("rotation_conflict");
  const reviewed = new Set(review.recipients.map((r) => r.candidate.userId));
  const corrupt = new Set(review.corrupt.map((o) => o.id));
  let collected = plan.collected;
  let conflicts = 0;
  let invalid = 0;
  for (;;) {
    try {
      return await attempt(
        ctx,
        review.vaultId,
        plan.vaultName,
        collected,
        decisions,
        reviewed,
        run,
      );
    } catch (error) {
      if (!(error instanceof Restart)) throw error;
      if (
        error.reason === "conflict"
          ? ++conflicts >= MAX_ATTEMPTS
          : ++invalid > 1
      )
        throw new SyncError("rotation_conflict");
    }
    collected = checked(await collect(ctx, review.vaultId, plan.floor));
    // New corrupt objects need the owner's decision.
    if (collected.corrupt.some((o) => !corrupt.has(o.id)))
      throw new SyncError("rotation_conflict");
  }
}
