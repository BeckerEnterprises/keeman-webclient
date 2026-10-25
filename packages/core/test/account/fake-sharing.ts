/**
 * Sharing endpoints of the fake server with the server's
 * checks and orders, enough to drive the core's sharing flows. Test data only.
 */
import type { MemberRecord, StoredObject, VaultRecord } from "./fake-server";

export interface SharingUser {
  user_id: string;
  email: string;
  public_key: string;
}

export interface FakeRotation {
  id: string;
  vaultId: string;
  base: number;
  newKeyVersion: number;
  createdBy: string;
  expires: number;
  objects: Map<string, { type: string; data: string }>;
}

export interface SharingContext {
  vaults: Map<string, VaultRecord>;
  users: () => SharingUser[];
  rotations: Map<string, FakeRotation>;
  now: () => number;
  newId: () => string;
  idempotent: (endpoint: string, run: () => Response) => Response;
  reply: (status: number, body?: unknown) => Response;
  problem: (status: number, code: string, extra?: object) => Response;
  tamperLookup: (user: SharingUser) => void;
  tamperPublicKey: (user: SharingUser) => void;
  rotationUploads: { objects: number; bytes: number }[];
}

const TIMESTAMP = "2026-10-23T08:00:00.000Z";

export function newMember(
  role: string,
  state: string,
  keyVersion: number,
  extra: Partial<MemberRecord> = {},
): MemberRecord {
  return {
    role,
    state,
    key_version: keyVersion,
    key_wrapped: null,
    key_box: null,
    sender_id: null,
    pending_key: null,
    created: TIMESTAMP,
    ...extra,
  };
}

function owners(vault: VaultRecord): number {
  return [...vault.members.values()].filter(
    (m) => m.role === "owner" && m.state === "active",
  ).length;
}

/** Handles the sharing paths; `undefined` for any other path. */
export function sharing(
  ctx: SharingContext,
  method: string,
  path: string,
  body: string | undefined,
  data: Record<string, unknown>,
  userId: string,
): Response | undefined {
  const { reply, problem } = ctx;
  const userOf = (id: string) => ctx.users().find((u) => u.user_id === id);
  const publicUser = (u: SharingUser): SharingUser => ({
    user_id: u.user_id,
    email: u.email,
    public_key: u.public_key,
  });

  if (method === "POST" && path === "/v1/users/lookup") {
    const email = String(data.email).trim().toLowerCase();
    const found = ctx.users().find((u) => u.email === email);
    if (!found) return problem(404, "user_not_found");
    const answer = publicUser(found);
    ctx.tamperLookup(answer);
    return reply(200, answer);
  }
  const keyMatch = /^\/v1\/users\/([0-9a-f-]{36})\/public-key$/.exec(path);
  if (method === "GET" && keyMatch) {
    const target = keyMatch[1] ?? "";
    const shared = [...ctx.vaults.values()].some(
      (v) => v.members.has(userId) && v.members.has(target),
    );
    const found = userOf(target);
    if (!found || (target !== userId && !shared))
      return problem(404, "user_not_found");
    const answer = publicUser(found);
    ctx.tamperPublicKey(answer);
    return reply(200, answer);
  }

  const match =
    /^\/v1\/vaults\/([0-9a-f-]{36})\/(members|members\/me|members\/([0-9a-f-]{36})|accept|decline|key|rotations|rotations\/([0-9a-f-]{36})\/(objects|commit))$/.exec(
      path,
    );
  if (!match) return undefined;
  const vault = ctx.vaults.get(match[1] ?? "");
  const own = vault?.members.get(userId);
  const area = match[2] ?? "";
  const notFound = () => problem(404, "not_found");
  const mismatch = (current: number) =>
    problem(409, "key_version_mismatch", { current_key_version: current });

  if (area === "accept" || area === "decline") {
    if (!vault || own?.state !== "pending") return notFound();
    if (area === "decline") {
      vault.members.delete(userId);
      return reply(204);
    }
    if (data.key_version !== own.key_version)
      return mismatch(vault.key_version);
    own.state = "active";
    own.key_wrapped = data.key_wrapped as string;
    own.key_box = null;
    return reply(204);
  }
  if (!vault || !own) return notFound();
  if (area === "members/me" && method === "DELETE") {
    if (own.state !== "active") return problem(403, "forbidden");
    if (own.role === "owner" && owners(vault) <= 1)
      return problem(409, "last_owner");
    vault.members.delete(userId);
    vault.rotation_required = true;
    for (const [id, m] of vault.members) {
      if (m.state === "pending" && m.sender_id === userId)
        vault.members.delete(id);
      if (m.pending_key?.sender_id === userId) m.pending_key = null;
    }
    return reply(204);
  }
  if (own.state !== "active") return problem(403, "forbidden");
  const ownerOnly = () =>
    own.role === "owner" ? undefined : problem(403, "forbidden");

  if (area === "key" && method === "POST") {
    const pending = own.pending_key;
    if (!pending) return notFound();
    if (data.key_version !== pending.key_version)
      return mismatch(vault.key_version);
    own.key_wrapped = data.key_wrapped as string;
    own.key_version = pending.key_version;
    own.pending_key = null;
    return reply(204);
  }
  if (area === "members" && method === "GET") {
    const members = [...vault.members.entries()]
      .map(([id, m]) => ({ id, m, user: userOf(id) }))
      .filter((x) => x.user)
      .sort(
        (a, b) =>
          a.m.created.localeCompare(b.m.created) || a.id.localeCompare(b.id),
      )
      .map(({ id, m, user }) => ({
        user_id: id,
        email: user?.email,
        role: m.role,
        state: m.state,
        public_key: user?.public_key,
        invited_by: m.sender_id,
        created: m.created,
      }));
    return reply(200, { members });
  }
  if (area === "members" && method === "POST") {
    const denied = ownerOnly();
    if (denied) return denied;
    const invitee = data.user_id as string;
    if (!userOf(invitee)) return problem(404, "user_not_found");
    if (vault.members.has(invitee)) return problem(409, "already_member");
    if (data.key_version !== vault.key_version)
      return mismatch(vault.key_version);
    vault.members.set(
      invitee,
      newMember("member", "pending", vault.key_version, {
        key_box: data.key_box as string,
        sender_id: userId,
        created: new Date(ctx.now()).toISOString(),
      }),
    );
    return reply(201);
  }
  if (match[3] !== undefined) {
    const denied = ownerOnly();
    if (denied) return denied;
    const target = vault.members.get(match[3]);
    if (method === "PATCH") {
      if (target?.state !== "active") return notFound();
      if (target.role === data.role) return reply(204);
      if (target.role === "owner" && owners(vault) <= 1)
        return problem(409, "last_owner");
      target.role = data.role as string;
      return reply(204);
    }
    if (method === "DELETE") {
      if (!target) return notFound();
      if (target.state === "active") return problem(409, "use_rotate");
      vault.members.delete(match[3]);
      return reply(204);
    }
  }
  if (area === "rotations" && method === "POST") {
    return ctx.idempotent(`POST ${path}`, () => {
      const denied = ownerOnly();
      if (denied) return denied;
      if (data.base_revision !== vault.revision)
        return problem(409, "conflict", { current_revision: vault.revision });
      if (data.new_key_version !== vault.key_version + 1)
        return mismatch(vault.key_version);
      for (const [id, r] of ctx.rotations)
        if (r.vaultId === vault.id) ctx.rotations.delete(id);
      const rotation: FakeRotation = {
        id: ctx.newId(),
        vaultId: vault.id,
        base: vault.revision,
        newKeyVersion: vault.key_version + 1,
        createdBy: userId,
        expires: ctx.now() + 3_600_000,
        objects: new Map(),
      };
      ctx.rotations.set(rotation.id, rotation);
      return reply(201, { rotation_id: rotation.id, expires_in: 3600 });
    });
  }
  const rotationId = match[4] ?? "";
  const valid = () => {
    const r = ctx.rotations.get(rotationId);
    return r &&
      r.vaultId === vault.id &&
      r.createdBy === userId &&
      r.expires > ctx.now()
      ? r
      : undefined;
  };
  if (match[5] === "objects" && method === "PUT") {
    if ((body ?? "").length > 16 * 1024 * 1024)
      return problem(413, "payload_too_large");
    const objects = (data.objects ?? []) as {
      id: string;
      type: string;
      key_version: number;
      data: string;
    }[];
    if (objects.length < 1 || objects.length > 500)
      return problem(400, "validation_failed");
    ctx.rotationUploads.push({
      objects: objects.length,
      bytes: (body ?? "").length,
    });
    return ctx.idempotent(`PUT ${path}`, () => {
      const denied = ownerOnly();
      if (denied) return denied;
      const rotation = valid();
      if (!rotation) return problem(409, "rotation_invalid");
      for (const o of objects) {
        const stored = vault.objects.get(o.id);
        if (
          o.key_version !== rotation.newKeyVersion ||
          !stored ||
          stored.deleted ||
          stored.type !== o.type
        )
          return problem(400, "validation_failed");
      }
      for (const o of objects)
        rotation.objects.set(o.id, { type: o.type, data: o.data });
      return reply(204);
    });
  }
  if (match[5] === "commit" && method === "POST") {
    if ((body ?? "").length > 16 * 1024 * 1024)
      return problem(413, "payload_too_large");
    return ctx.idempotent(`POST ${path}`, () => {
      const denied = ownerOnly();
      if (denied) return denied;
      const rotation = valid();
      if (!rotation) return problem(409, "rotation_invalid");
      if (vault.revision !== rotation.base) {
        ctx.rotations.delete(rotation.id);
        return problem(409, "conflict", { current_revision: vault.revision });
      }
      const memberKeys = data.member_keys as {
        user_id: string;
        key_box: string;
      }[];
      const inviteKeys = data.invite_keys as {
        user_id: string;
        key_box: string;
      }[];
      const removed = new Set(data.remove_user_ids as string[]);
      const drops = data.drop_objects as { id: string; data: string }[];
      if (drops.some((d) => d.id === vault.id))
        return problem(400, "validation_failed");
      for (const drop of drops) {
        const stored = vault.objects.get(drop.id);
        if (!stored || stored.deleted) return problem(400, "validation_failed");
      }
      const dropped = new Set(drops.map((d) => d.id));
      const missing = [...vault.objects.values()].some(
        (o) =>
          !o.deleted &&
          !dropped.has(o.id) &&
          rotation.objects.get(o.id)?.type !== o.type,
      );
      const remaining = [...vault.members.entries()]
        .filter(
          ([id, m]) =>
            m.state === "active" && id !== userId && !removed.has(id),
        )
        .map(([id]) => id)
        .sort();
      const keyed = memberKeys.map((k) => k.user_id).sort();
      if (
        missing ||
        [...removed].some((id) => !vault.members.has(id)) ||
        JSON.stringify(remaining) !== JSON.stringify(keyed) ||
        inviteKeys.some(
          (k) => vault.members.get(k.user_id)?.state !== "pending",
        )
      )
        return problem(422, "rotation_incomplete");
      const revision = rotation.base + 1;
      const key = rotation.newKeyVersion;
      const stamp = new Date(ctx.now()).toISOString();
      const write = (o: StoredObject) => vault.objects.set(o.id, o);
      for (const [id, o] of rotation.objects)
        write({
          id,
          type: o.type,
          revision,
          key_version: key,
          deleted: false,
          data: o.data,
          updated_at: stamp,
          updated_by: userId,
        });
      for (const drop of drops)
        write({
          id: drop.id,
          type: vault.objects.get(drop.id)?.type ?? "entry",
          revision,
          key_version: key,
          deleted: true,
          data: drop.data,
          updated_at: stamp,
          updated_by: userId,
        });
      for (const [id, o] of vault.objects)
        if (o.deleted && o.revision <= rotation.base) vault.objects.delete(id);
      vault.horizon = Math.max(vault.horizon, rotation.base);
      vault.revision = revision;
      vault.key_version = key;
      vault.rotation_required = false;
      own.key_wrapped = data.key_wrapped as string;
      own.key_version = key;
      own.pending_key = null;
      for (const k of memberKeys) {
        const m = vault.members.get(k.user_id);
        if (m)
          m.pending_key = {
            key_box: k.key_box,
            key_version: key,
            sender_id: userId,
          };
      }
      for (const id of removed) vault.members.delete(id);
      const kept = new Set(inviteKeys.map((k) => k.user_id));
      for (const [id, m] of vault.members) {
        if (m.state !== "pending") continue;
        if (!kept.has(id)) {
          vault.members.delete(id);
          continue;
        }
        m.key_box = inviteKeys.find((k) => k.user_id === id)?.key_box ?? null;
        m.key_version = key;
        m.sender_id = userId;
      }
      ctx.rotations.delete(rotation.id);
      return reply(200, { revision });
    });
  }
  return undefined;
}
