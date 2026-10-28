/**
 * The roles keeper on its own: anchors against the device floor, failed
 * loads, confirmations in the wrong state, empty and broken chains.
 */
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../../src/crypto/bytes";
import type { Keys } from "../../src/crypto/keystore";
import type { ApiClient } from "../../src/api/client";
import { derivePublicKey } from "../../src/crypto/keypair";
import {
  genesisStatement,
  readSignedRoles,
  roleOwner,
  signRoleStatement,
  type RolePoint,
} from "../../src/crypto/roles";
import { deriveSigningKeyPair } from "../../src/crypto/signing";
import type { RoleAnchor } from "../../src/model/user-data";
import { inMemorySyncMarks } from "../../src/sync/marks";
import { RolesKeeper } from "../../src/sync/roles";
import { owner, person, share, type Person } from "../sharing/people";
import { tv } from "../helpers";

const noKeys = new Proxy({} as Keys, {
  get() {
    throw new Error("no keys in these tests");
  },
});

async function setup() {
  const alice = await owner();
  const bob = await person(alice.server, "bob@example.com");
  const carol = await person(alice.server, "carol@example.com");
  await share(alice, bob, alice.vaultId);
  await share(alice, carol, alice.vaultId);
  await alice.engine.setMemberRole(
    alice.vaultId,
    carol.account.userId ?? "",
    "owner",
  );
  const chain = alice.server.vaults.get(alice.vaultId)?.roles ?? [];
  const points = chain.map((r) => ({ version: r.version, hash: r.hash }));
  return { alice, bob, carol, vaultId: alice.vaultId, chain, points };
}

function keeper(
  someone: Person,
  anchors: Map<string, RoleAnchor> = new Map(),
  points: RolePoint[] = [],
) {
  const marks = inMemorySyncMarks();
  const saved: Record<string, RoleAnchor | null>[] = [];
  const roles = new RolesKeeper({
    api: someone.api,
    keys: noKeys,
    userId: someone.account.userId ?? "",
    marks,
    anchor: (vaultId) => anchors.get(vaultId),
    saveAnchors: (a) => {
      saved.push(a);
      for (const [id, anchor] of Object.entries(a))
        if (anchor) anchors.set(id, anchor);
        else anchors.delete(id);
      return Promise.resolve();
    },
    contacts: () => [],
    points: () => points,
  });
  return { roles, marks, saved, anchors, points };
}

/** A keeper over one delivered chain, with the account's real keys. */
function ownKeeper(chain: ReturnType<typeof signRoleStatement>[]) {
  const userId = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a10";
  const privateKey = tv("roles-keeper-own-private", 32);
  const signing = deriveSigningKeyPair(tv("roles-keeper-own-user-key", 32));
  const keys = {
    usePrivateKey: <T>(use: (key: Uint8Array) => T) => use(privateKey),
    signingPublicKey: () => signing.publicKey,
  } as unknown as Keys;
  const api = {
    roles: () =>
      Promise.resolve(
        chain.map((signed, i) => ({ ...signed, version: i + 1 })),
      ),
  } as unknown as ApiClient;
  const roles = new RolesKeeper({
    api,
    keys,
    userId,
    marks: inMemorySyncMarks(),
    anchor: () => undefined,
    saveAnchors: () => Promise.resolve(),
    contacts: () => [],
  });
  return { roles, userId, privateKey, signing };
}

describe("roles keeper", () => {
  it("takes over a chain signed by this account only with its own keys", async () => {
    const vaultId = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a20";
    const start = (
      userId: string,
      publicKey: Uint8Array,
      signing: { publicKey: Uint8Array; secretKey: Uint8Array },
    ) =>
      signRoleStatement(
        genesisStatement({
          vaultId,
          owners: [roleOwner(userId, publicKey, signing.publicKey)],
          signer: userId,
          keyVersion: 1,
          vaultKey: tv("roles-keeper-vault-key", 32),
          created: "2026-10-28T08:00:00.000Z",
        }),
        signing.secretKey,
      );
    // The server forges a first statement in this account's name, with
    // keys of its own.
    const forged = ownKeeper([]);
    const other = deriveSigningKeyPair(tv("roles-keeper-server-user-key", 32));
    const otherKey = derivePublicKey(tv("roles-keeper-server-private", 32));
    const evil = ownKeeper([start(forged.userId, otherKey, other)]);
    expect((await evil.roles.update(vaultId, 1, [])).status).toBe("invalid");
    expect(evil.roles.point(vaultId)).toBeUndefined();
    // Signed with the own keys, it is taken over.
    const honest = ownKeeper([
      start(forged.userId, derivePublicKey(forged.privateKey), forged.signing),
    ]);
    expect((await honest.roles.update(vaultId, 1, [])).status).toBe("ok");
    // Another signer's statement that names this account with keys of the
    // server's: invalid, whoever signed it.
    const other2 = deriveSigningKeyPair(
      tv("roles-keeper-co-owner-user-key", 32),
    );
    const coOwner = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a11";
    const named = ownKeeper([]);
    const theirs = ownKeeper([
      signRoleStatement(
        genesisStatement({
          vaultId,
          owners: [
            roleOwner(named.userId, otherKey, other.publicKey),
            roleOwner(
              coOwner,
              derivePublicKey(tv("roles-keeper-co-owner-private", 32)),
              other2.publicKey,
            ),
          ],
          signer: coOwner,
          keyVersion: 1,
          vaultKey: tv("roles-keeper-vault-key", 32),
          created: "2026-10-28T08:00:00.000Z",
        }),
        other2.secretKey,
      ),
    ]);
    expect((await theirs.roles.update(vaultId, 1, [coOwner])).status).toBe(
      "invalid",
    );
  });

  it("prefers the higher of anchor and floor and reports a fork between them", async () => {
    const { bob, vaultId, points } = await setup();
    const [first, second] = points;
    if (!first || !second) throw new Error("chain");
    const userId = bob.account.userId ?? "";
    // The floor is higher than the stored anchor: it counts.
    const k = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]));
    await k.marks.raise(userId, {
      vaults: { [vaultId]: { rev: 0, obj: {}, rl: [2, second.hash] } },
    });
    expect((await k.roles.update(vaultId, 2, undefined)).status).toBe("ok");
    await k.roles.flush();
    expect(k.anchors.get(vaultId)?.version).toBe(2);
    // The same version with another hash on the device and in user_data.
    const forked = keeper(
      bob,
      new Map([[vaultId, { ...second, hash: first.hash, owners: [] }]]),
    );
    await forked.marks.raise(userId, {
      vaults: { [vaultId]: { rev: 0, obj: {}, rl: [2, second.hash] } },
    });
    expect((await forked.roles.update(vaultId, 2, undefined)).status).toBe(
      "fork",
    );
    // A lower anchor that the chain does not lead to.
    const lower = keeper(
      bob,
      new Map([[vaultId, { ...first, hash: second.hash, owners: [] }]]),
    );
    await lower.marks.raise(userId, {
      vaults: { [vaultId]: { rev: 0, obj: {}, rl: [2, second.hash] } },
    });
    expect((await lower.roles.update(vaultId, 2, undefined)).status).toBe(
      "fork",
    );
  });

  it("keeps the last result when loading fails and refuses wrong states", async () => {
    const { bob, vaultId, points } = await setup();
    const first = points[0];
    if (!first) throw new Error("chain");
    const k = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]));
    const checked = await k.roles.update(vaultId, 2, undefined);
    expect(checked.status).toBe("ok");
    bob.server.failures.set(`/v1/vaults/${vaultId}/roles`, [
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
    ] as never);
    expect(await k.roles.update(vaultId, 3, undefined)).toBe(checked);
    const other = keeper(bob);
    bob.server.failures.set(`/v1/vaults/${vaultId}/roles`, [
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
    ] as never);
    expect((await other.roles.update(vaultId, 2, undefined)).status).toBe(
      "unavailable",
    );
    await expect(
      other.roles.confirm(vaultId, { head: null }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(other.roles.point(vaultId)).toBeUndefined();
    expect(
      other.roles.check(vaultId, 1, {
        vaultKey: tv("roles-keeper-key", 32),
        roles: undefined,
      }),
    ).toBe("unchecked");
    k.roles.forget(vaultId);
    expect(k.roles.get(vaultId)).toBeUndefined();
  });

  it("never falls back to the older rules when a named chain cannot be checked", async () => {
    const { bob, vaultId, chain, points } = await setup();
    const fail = () =>
      bob.server.failures.set(`/v1/vaults/${vaultId}/roles`, [
        { status: 503, code: "internal_error" },
        { status: 503, code: "internal_error" },
        { status: 503, code: "internal_error" },
      ] as never);
    // The load fails and this unlock has no result yet.
    const fresh = keeper(bob);
    fail();
    const failed = await fresh.roles.update(vaultId, 2, undefined);
    expect(failed).toMatchObject({ status: "unavailable", head: undefined });
    expect(fresh.roles.point(vaultId)).toBeUndefined();
    // Nothing to take over and nothing to understand.
    await expect(
      fresh.roles.acknowledge(vaultId, 2, { head: null }),
    ).rejects.toMatchObject({ code: "roles_unavailable" });
    expect(fresh.saved).toEqual([]);
    // The last result had no chain: a named one that fails to load does
    // not keep that.
    const none = keeper(bob);
    expect((await none.roles.update(vaultId, null, undefined)).status).toBe(
      "none",
    );
    fail();
    expect((await none.roles.update(vaultId, 2, undefined)).status).toBe(
      "unavailable",
    );
    // The server names a head it does not deliver: an empty chain, or one
    // that ends below the named version.
    const short = keeper(bob);
    expect((await short.roles.update(vaultId, 5, undefined)).status).toBe(
      "unavailable",
    );
    const saved = chain.splice(0);
    const empty = keeper(bob);
    expect((await empty.roles.update(vaultId, 2, undefined)).status).toBe(
      "unavailable",
    );
    // Once it delivers the chain again, the same named version loads.
    chain.push(...saved);
    expect((await empty.roles.update(vaultId, 2, undefined)).status).toBe(
      "unanchored",
    );
    // Below an anchor a chain cut short stays the rollback it is, and
    // "understood" can take it over.
    const [first, second] = points;
    if (!first || !second) throw new Error("chain");
    const anchored = keeper(
      bob,
      new Map([[vaultId, { ...second, owners: [] }]]),
    );
    const tail = chain.splice(1);
    expect((await anchored.roles.update(vaultId, 3, undefined)).status).toBe(
      "rollback",
    );
    await anchored.roles.acknowledge(vaultId, 3, { head: first });
    expect(anchored.anchors.get(vaultId)?.version).toBe(1);
    chain.push(...tail);
  });

  it("needs every lower point delivered, not only the highest one", async () => {
    const { bob, vaultId, chain, points } = await setup();
    const [first, second] = points;
    if (!first || !second) throw new Error("chain");
    // The account's anchor is version 1; an attestation names version 2.
    // The server delivers the chain from version 2 on only, so whatever
    // forked below that point would stay hidden.
    const k = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]), [
      second,
    ]);
    const saved = chain.splice(0, 1);
    expect((await k.roles.update(vaultId, 2, undefined)).status).toBe("fork");
    expect(k.roles.point(vaultId)).toBeUndefined();
    // Delivered in full, both points hold.
    chain.unshift(...saved);
    const full = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]), [
      second,
    ]);
    expect((await full.roles.update(vaultId, 2, undefined)).status).toBe("ok");
  });

  it("keeps the points of own attestations when the chain is reloaded", async () => {
    const { bob, vaultId, points } = await setup();
    const [first, second] = points;
    if (!first || !second) throw new Error("chain");
    // An own attestation names another statement at version 2.
    const k = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]), [
      { version: 2, hash: first.hash },
    ]);
    expect((await k.roles.update(vaultId, 2, undefined)).status).toBe("fork");
    expect((await k.roles.reload(vaultId)).status).toBe("fork");
  });

  it("checks new points against the last result when loading fails", async () => {
    const { bob, vaultId, points } = await setup();
    const [first, second] = points;
    if (!first || !second) throw new Error("chain");
    const k = keeper(bob, new Map([[vaultId, { ...first, owners: [] }]]));
    expect((await k.roles.update(vaultId, 2, undefined)).status).toBe("ok");
    const failing = () =>
      bob.server.failures.set(`/v1/vaults/${vaultId}/roles`, [
        { status: 503, code: "internal_error" },
        { status: 503, code: "internal_error" },
        { status: 503, code: "internal_error" },
      ] as never);
    // A point above the last head cannot be judged yet.
    k.points.push({ version: 3, hash: first.hash });
    failing();
    expect((await k.roles.update(vaultId, 3, undefined)).status).toBe("ok");
    // One that contradicts a statement already checked can.
    k.points.push({ version: 2, hash: first.hash });
    failing();
    const result = await k.roles.update(vaultId, 3, undefined);
    expect(result.status).toBe("fork");
    expect(k.roles.get(vaultId)).toBe(result);
  });

  it("acknowledges a chain it never checked as an empty one", async () => {
    const { bob, vaultId, points } = await setup();
    const second = points[1];
    if (!second) throw new Error("chain");
    const k = keeper(bob, new Map([[vaultId, { ...second, owners: [] }]]));
    await k.marks.raise(bob.account.userId ?? "", {
      vaults: { [vaultId]: { rev: 0, obj: {}, rl: [2, second.hash] } },
    });
    // No version named: a server without chains.
    await k.roles.acknowledge(vaultId, undefined, { head: null });
    expect(k.anchors.has(vaultId)).toBe(false);
    const marks = await k.marks.read(bob.account.userId ?? "");
    expect(marks.vaults[vaultId]?.rl).toBeUndefined();
  });

  it("asks before taking over a list whose signer it does not know", async () => {
    const { bob, vaultId, points } = await setup();
    const k = keeper(bob);
    // The signer is no remembered owner.
    expect((await k.roles.update(vaultId, 2, [])).status).toBe("unanchored");
    expect(k.roles.point(vaultId)).toBeUndefined();
    // Remembered, but no contact.
    const alice = bob.server.vaults.get(vaultId)?.roles[1];
    const signer = alice ? readSignedRoles(alice).statement.signer : "";
    const known = keeper(bob);
    expect((await known.roles.update(vaultId, 2, [signer])).status).toBe(
      "unanchored",
    );
    // Only the head that was shown.
    await expect(
      k.roles.confirm(vaultId, { head: points[0] ?? null }),
    ).rejects.toMatchObject({ code: "roles_changed" });
    expect(k.anchors.has(vaultId)).toBe(false);
    await k.roles.confirm(vaultId, { head: points[1] ?? null });
    expect(k.anchors.get(vaultId)?.version).toBe(2);
    expect((await k.roles.update(vaultId, 2, [])).status).toBe("ok");
  });

  it("acknowledges an empty or broken chain and handles chains without statements", async () => {
    const { bob, vaultId, chain, points } = await setup();
    const second = points[1];
    if (!second) throw new Error("chain");
    const k = keeper(bob, new Map([[vaultId, { ...second, owners: [] }]]));
    const saved = [...chain];
    chain.splice(0, chain.length);
    expect((await k.roles.update(vaultId, null, undefined)).status).toBe(
      "rollback",
    );
    expect(await k.roles.invitationChain(vaultId, null)).toBeUndefined();
    // Anchored but without chain: no rotation statement can be built.
    await expect(
      k.roles.rotationRoles(vaultId, [], new Set(), true),
    ).rejects.toMatchObject({ code: "roles_invalid" });
    // Without anchor and chain, a rotation has no statement.
    expect(
      await keeper(bob).roles.rotationRoles(vaultId, [], new Set(), true),
    ).toBeUndefined();
    await k.roles.acknowledge(vaultId, null, { head: null });
    expect(k.anchors.has(vaultId)).toBe(false);
    // A chain whose first statement is broken cannot be taken over.
    chain.push({
      ...(saved[0] ?? chain[0]),
      signature: toBase64Url(new Uint8Array(64)),
    } as never);
    const broken = keeper(bob, new Map([[vaultId, { ...second, owners: [] }]]));
    expect((await broken.roles.reload(vaultId)).status).toBe("rollback");
    await expect(
      broken.roles.acknowledge(vaultId, 1, { head: null }),
    ).rejects.toMatchObject({ code: "roles_invalid" });
    await expect(
      broken.roles.invitationChain(vaultId, 1),
    ).rejects.toMatchObject({ code: "roles_invalid" });
    await expect(
      broken.roles.rotationRoles(vaultId, [], new Set(), false),
    ).rejects.toMatchObject({ code: "roles_invalid" });
  });
});
