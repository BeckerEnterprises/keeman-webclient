/**
 * The roles keeper on its own: anchors against the device floor, failed
 * loads, confirmations in the wrong state, empty and broken chains.
 */
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../../src/crypto/bytes";
import type { Keys } from "../../src/crypto/keystore";
import { readSignedRoles } from "../../src/crypto/roles";
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

function keeper(someone: Person, anchors: Map<string, RoleAnchor> = new Map()) {
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
  });
  return { roles, marks, saved, anchors };
}

describe("roles keeper", () => {
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
    await expect(other.roles.update(vaultId, 2, undefined)).rejects.toThrow();
    await expect(other.roles.confirm(vaultId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(other.roles.acknowledge(vaultId)).rejects.toMatchObject({
      code: "not_found",
    });
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

  it("asks before taking over a list whose signer it does not know", async () => {
    const { bob, vaultId } = await setup();
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
    await k.roles.confirm(vaultId);
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
    expect(await k.roles.invitationChain(vaultId)).toBeUndefined();
    // Anchored but without chain: no rotation statement can be built.
    await expect(
      k.roles.rotationRoles(vaultId, [], new Set(), true),
    ).rejects.toMatchObject({ code: "roles_invalid" });
    // Without anchor and chain, a rotation has no statement.
    expect(
      await keeper(bob).roles.rotationRoles(vaultId, [], new Set(), true),
    ).toBeUndefined();
    await k.roles.acknowledge(vaultId);
    expect(k.anchors.has(vaultId)).toBe(false);
    // A chain whose first statement is broken cannot be taken over.
    chain.push({
      ...(saved[0] ?? chain[0]),
      signature: toBase64Url(new Uint8Array(64)),
    } as never);
    const broken = keeper(bob, new Map([[vaultId, { ...second, owners: [] }]]));
    expect((await broken.roles.reload(vaultId)).status).toBe("rollback");
    await expect(broken.roles.acknowledge(vaultId)).rejects.toMatchObject({
      code: "roles_invalid",
    });
    await expect(broken.roles.invitationChain(vaultId)).rejects.toMatchObject({
      code: "roles_invalid",
    });
    await expect(
      broken.roles.rotationRoles(vaultId, [], new Set(), false),
    ).rejects.toMatchObject({ code: "roles_invalid" });
  });
});
