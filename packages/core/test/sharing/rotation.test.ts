/**
 * Staged key rotation: removing members, new keys only
 * from verified contacts, drop tombstones, retries and large vaults.
 */
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/crypto/bytes";
import { emptyDraft } from "../../src/model/entry";
import type { SyncEngine } from "../../src/sync/engine";
import { FakeServer } from "../account/fake-server";
import { flipped, rootOf, vault } from "../sync/devices";
import { owner, person, posts, share, type Person } from "./people";

function titles(engine: SyncEngine, vaultId: string): string[] {
  return [...vault(engine, vaultId).entries.values()].map((e) => e.title);
}

async function entry(
  someone: Person,
  vaultId: string,
  title: string,
  notes = "",
): Promise<string> {
  const result = await someone.engine.createEntry(
    vaultId,
    rootOf(someone.engine, vaultId),
    { ...emptyDraft(), title, notes },
  );
  return result.id;
}

async function rotate(
  someone: Person,
  vaultId: string,
  remove: string[] = [],
  dropCorrupt = false,
) {
  const review = await someone.engine.prepareRotation(vaultId);
  await someone.engine.runRotation(review, { remove, dropCorrupt });
  return review;
}

async function team() {
  const server = new FakeServer();
  const alice = await owner(server);
  const bob = await person(server, "bob@example.com");
  const carol = await person(server, "carol@example.com");
  await share(alice, bob, alice.vaultId);
  await share(alice, carol, alice.vaultId);
  await entry(alice, alice.vaultId, "Vorher");
  return { server, alice, bob, carol, vaultId: alice.vaultId };
}

describe("removing a member", () => {
  it("re-encrypts, removes and hands the new key to verified members", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    const dave = await person(server, "dave@example.com");
    const candidate = await alice.engine.lookupUser(dave.email);
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(vaultId, candidate);

    const review = await alice.engine.prepareRotation(vaultId);
    expect(review.corrupt).toEqual([]);
    expect(
      review.recipients.map((r) => [
        r.candidate.email,
        r.state,
        r.candidate.status,
      ]),
    ).toEqual([
      ["bob@example.com", "active", "verified"],
      ["carol@example.com", "active", "verified"],
      ["dave@example.com", "pending", "verified"],
    ]);
    const progress: number[] = [];
    await alice.engine.runRotation(
      review,
      { remove: [carol.account.userId ?? ""], dropCorrupt: false },
      ({ done }) => progress.push(done),
    );
    expect(progress.at(-1)).toBe(review.objects);
    const record = server.vaults.get(vaultId);
    expect(record?.key_version).toBe(2);
    expect(record?.members.has(carol.account.userId ?? "")).toBe(false);
    expect(record?.members.get(dave.account.userId ?? "")?.key_version).toBe(2);
    expect(vault(alice.engine, vaultId)).toMatchObject({
      vaultKeyVersion: 2,
      keyStatus: "ok",
      writable: true,
    });
    expect(titles(alice.engine, vaultId)).toEqual(["Vorher"]);

    // Bob verified Alice: the new key is taken without asking.
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "ok",
      vaultKeyVersion: 2,
      memberKeyVersion: 2,
    });
    await entry(alice, vaultId, "Nachher");
    await bob.engine.pull(vaultId);
    expect(titles(bob.engine, vaultId).sort()).toEqual(["Nachher", "Vorher"]);

    // Carol's vault is gone; the server answers 404 for it.
    await carol.engine.refresh();
    expect(carol.engine.snapshot.vaults.some((v) => v.id === vaultId)).toBe(
      false,
    );
    await expect(carol.api.changes(vaultId, 0)).rejects.toMatchObject({
      status: 404,
    });
    // Dave accepts the renewed invitation with key version 2.
    await dave.engine.refresh();
    const sender = dave.engine.snapshot.invitations[0]?.sender;
    expect(dave.engine.snapshot.invitations[0]?.keyVersion).toBe(2);
    if (sender) await dave.account.verifyContact(sender);
    await dave.engine.acceptInvitation(vaultId);
    expect(titles(dave.engine, vaultId).sort()).toEqual(["Nachher", "Vorher"]);
  });

  it("treats an older key version as a rollback and never writes with it", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    const bobId = bob.account.userId ?? "";
    const oldKey = server.vaults.get(vaultId)?.members.get(bobId)?.key_wrapped;
    const review = await alice.engine.prepareRotation(vaultId);
    await alice.engine.runRotation(
      review,
      { remove: [carol.account.userId ?? ""], dropCorrupt: false },
      () => undefined,
    );
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      vaultKeyVersion: 2,
      keyStatus: "ok",
      rollback: false,
      keyRollback: false,
    });
    // The server plays back the state before the rotation: Bob still holds
    // the old key, and with it Carol could read what he writes.
    server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === vaultId)
          Object.assign(summary, {
            vault_key_version: 1,
            member_key_version: 1,
            key_wrapped: oldKey,
            pending_key: null,
          });
    };
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      vaultKeyVersion: 1,
      rollback: true,
      keyRollback: true,
      writable: false,
    });
    const batches = posts(server, "/batch");
    await expect(
      bob.engine.createGroup(vaultId, rootOf(bob.engine, vaultId), {
        name: "Neu",
      }),
    ).rejects.toMatchObject({ code: "read_only" });
    expect(posts(server, "/batch")).toBe(batches);
  });

  it("asks before taking a key from a sender not known as owner", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    const carolId = carol.account.userId ?? "";
    // Carol is a verified contact of everyone, but only Alice is an owner
    // as far as Bob knows.
    await bob.account.verifyContact(await bob.engine.lookupUser(carol.email));
    for (const other of [alice, bob])
      await carol.account.verifyContact(
        await carol.engine.lookupUser(other.email),
      );
    const bobId = bob.account.userId ?? "";
    expect((await bob.marks.read(bobId)).vaults[vaultId]?.ow).toEqual([
      alice.account.userId,
    ]);
    // Bob does not sync while Carol is made owner and renews the key: to
    // him the key comes from an account he has never seen as owner, as
    // would the box of a removed member that a server passes off as new.
    await alice.engine.setMemberRole(vaultId, carolId, "owner");
    await carol.engine.refresh();
    await rotate(carol, vaultId);
    const accepted = posts(server, "/key");
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      vaultKeyVersion: 2,
      keyStatus: "pending",
      pendingReason: "unknown_owner",
      writable: false,
    });
    expect(vault(bob.engine, vaultId).pendingSender?.userId).toBe(carolId);
    expect(posts(server, "/key")).toBe(accepted);
    await expect(bob.engine.acceptPendingKey(vaultId)).rejects.toMatchObject({
      code: "unknown_owner",
    });
    expect(posts(server, "/key")).toBe(accepted);
    // Confirmed by the user, the key is taken, and Carol is an owner now.
    await bob.engine.acceptPendingKey(vaultId, { confirmOwner: true });
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "ok",
      writable: true,
    });
    expect(
      [...((await bob.marks.read(bobId)).vaults[vaultId]?.ow ?? [])].sort(),
    ).toEqual([alice.account.userId, carolId].sort());
  });

  it("takes a key without asking from an owner promoted while the key was current", async () => {
    const { alice, bob, carol, vaultId } = await team();
    const carolId = carol.account.userId ?? "";
    await bob.account.verifyContact(await bob.engine.lookupUser(carol.email));
    for (const other of [alice, bob])
      await carol.account.verifyContact(
        await carol.engine.lookupUser(other.email),
      );
    await alice.engine.setMemberRole(vaultId, carolId, "owner");
    await bob.engine.refresh();
    await carol.engine.refresh();
    await rotate(carol, vaultId);
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      vaultKeyVersion: 2,
      keyStatus: "ok",
      pendingReason: undefined,
    });
  });

  it('keeps the owners and takes the delivered key version on "understood"', async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    const bobId = bob.account.userId ?? "";
    const oldKey = server.vaults.get(vaultId)?.members.get(bobId)?.key_wrapped;
    await rotate(alice, vaultId, [carol.account.userId ?? ""]);
    await bob.engine.refresh();
    server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === vaultId)
          Object.assign(summary, {
            vault_key_version: 1,
            member_key_version: 1,
            key_wrapped: oldKey,
            pending_key: null,
          });
    };
    await bob.engine.refresh();
    await bob.engine.acknowledgeRollback(vaultId);
    expect((await bob.marks.read(bobId)).vaults[vaultId]).toMatchObject({
      kv: 1,
      ow: [alice.account.userId],
    });
  });

  it("keeps a removed member from reading new or changed objects", async () => {
    const { server, alice, carol, vaultId } = await team();
    const before = server.vaults
      .get(vaultId)
      ?.members.get(carol.account.userId ?? "");
    await rotate(alice, vaultId, [carol.account.userId ?? ""]);
    await entry(alice, vaultId, "Geheim neu");
    // A lying server keeps Carol in the vault with her old key...
    const record = server.vaults.get(vaultId);
    if (record && before)
      record.members.set(carol.account.userId ?? "", { ...before });
    await carol.engine.refresh();
    // ...but the current key is missing: nothing is synced or shown.
    expect(vault(carol.engine, vaultId)).toMatchObject({
      keyStatus: "missing",
      writable: false,
    });
    expect(titles(carol.engine, vaultId)).not.toContain("Geheim neu");
    // Even if it claims key version 1 and relabels the objects, nothing
    // decrypts: the AAD carries the key version, the key is a new one.
    if (record) record.key_version = 1;
    server.tamperChanges = (page) => {
      for (const object of page.objects) object.key_version = 1;
    };
    await carol.engine.refresh();
    await carol.engine.pull(vaultId);
    const view = vault(carol.engine, vaultId);
    expect(titles(carol.engine, vaultId)).not.toContain("Geheim neu");
    expect(view.corrupt.length).toBeGreaterThan(0);
    // Every object on the server carries the new key version.
    const objects = [...(record?.objects.values() ?? [])].filter(
      (o) => !o.deleted,
    );
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((o) => o.key_version === 2)).toBe(true);
  });

  it("waits for the user when the sender is not verified", async () => {
    const { alice, bob, vaultId } = await team();
    await bob.account.removeContact(alice.account.userId ?? "");
    await rotate(alice, vaultId);
    await bob.engine.refresh();
    const view = vault(bob.engine, vaultId);
    expect(view.keyStatus).toBe("pending");
    expect(view.writable).toBe(false);
    expect(view.pendingSender?.fingerprint).toBe(alice.account.ownFingerprint);
    expect(posts(bob.server, "/key")).toBe(0);
    await expect(
      bob.engine.createGroup(vaultId, rootOf(bob.engine, vaultId), {
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "read_only" });
    // Verifying the sender takes the key.
    if (view.pendingSender) await bob.account.verifyContact(view.pendingSender);
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).keyStatus).toBe("ok");
    expect(posts(bob.server, "/key")).toBe(1);
  });

  it("refuses a pending key that fails the checks", async () => {
    const { server, alice, bob, vaultId } = await team();
    await rotate(alice, vaultId);
    const member = server.vaults
      .get(vaultId)
      ?.members.get(bob.account.userId ?? "");
    if (member?.pending_key) {
      const box = fromBase64Url(member.pending_key.key_box);
      box[40] = (box[40] ?? 0) ^ 1;
      member.pending_key.key_box = toBase64Url(box);
    }
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).keyStatus).toBe("invalid");
    await expect(bob.engine.acceptPendingKey(vaultId)).rejects.toMatchObject({
      code: "key_box_invalid",
    });
  });

  it("asks for verified recipients and refuses non-owners", async () => {
    const { alice, bob, carol, vaultId } = await team();
    await alice.account.removeContact(carol.account.userId ?? "");
    const review = await alice.engine.prepareRotation(vaultId);
    expect(
      review.recipients.find((r) => r.candidate.email === carol.email)
        ?.candidate.status,
    ).toBe("unverified");
    await expect(
      alice.engine.runRotation(review, { remove: [], dropCorrupt: false }),
    ).rejects.toMatchObject({ code: "unverified" });
    // Removing the unverified member in the same rotation is allowed.
    await alice.engine.runRotation(review, {
      remove: [carol.account.userId ?? ""],
      dropCorrupt: false,
    });
    await expect(bob.engine.prepareRotation(vaultId)).rejects.toMatchObject({
      code: "read_only",
    });
  });
});

describe("rotation details", () => {
  it("drops corrupt objects with authenticated tombstones", async () => {
    const { server, alice, bob, vaultId } = await team();
    const id = await entry(alice, vaultId, "Kaputt");
    await bob.engine.pull(vaultId);
    expect(titles(bob.engine, vaultId)).toContain("Kaputt");
    const stored = server.vaults.get(vaultId)?.objects.get(id);
    if (stored?.data) stored.data = flipped(stored.data);
    await alice.engine.refresh();

    const review = await alice.engine.prepareRotation(vaultId);
    expect(review.corrupt).toEqual([{ id, type: "entry" }]);
    await expect(
      alice.engine.runRotation(review, { remove: [], dropCorrupt: false }),
    ).rejects.toMatchObject({ code: "corrupt_objects" });
    await alice.engine.runRotation(review, { remove: [], dropCorrupt: true });
    expect(server.vaults.get(vaultId)?.objects.get(id)?.deleted).toBe(true);
    // Bob had the valid version: the drop deletes it without a rollback.
    await bob.engine.refresh();
    await bob.engine.pull(vaultId);
    expect(titles(bob.engine, vaultId)).not.toContain("Kaputt");
    expect(vault(bob.engine, vaultId).rollback).toBe(false);
  });

  it("never drops vault_meta and waits for an acknowledged rollback", async () => {
    const { server, alice, vaultId } = await team();
    const record = server.vaults.get(vaultId);
    const meta = record?.objects.get(vaultId);
    const original = meta?.data ?? null;
    if (meta?.data) meta.data = flipped(meta.data);
    await expect(alice.engine.prepareRotation(vaultId)).rejects.toMatchObject({
      code: "read_only",
    });
    if (meta) meta.data = original;
    if (record) record.revision = 1;
    await alice.engine.refresh();
    expect(vault(alice.engine, vaultId).rollback).toBe(true);
    await expect(alice.engine.prepareRotation(vaultId)).rejects.toMatchObject({
      code: "rollback_open",
    });
  });

  it("starts over after a conflict and gives up after three attempts", async () => {
    const { server, alice, vaultId } = await team();
    let changes = 1;
    server.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/commit") && changes > 0) {
        changes--;
        const record = server.vaults.get(vaultId);
        if (record) record.revision++;
      }
    };
    await rotate(alice, vaultId);
    expect(server.vaults.get(vaultId)?.key_version).toBe(2);
    expect(posts(server, "/rotations")).toBe(2);

    changes = 10;
    const review = await alice.engine.prepareRotation(vaultId);
    await expect(
      alice.engine.runRotation(review, { remove: [], dropCorrupt: false }),
    ).rejects.toMatchObject({ code: "rotation_conflict" });
    expect(server.vaults.get(vaultId)?.key_version).toBe(2);
    server.onRequest = () => undefined;
  });

  it("restarts once for an expired rotation and repeats a lost commit", async () => {
    const { server, alice, vaultId } = await team();
    let expire = true;
    server.onRequest = (method, path) => {
      if (method === "PUT" && path.endsWith("/objects") && expire) {
        expire = false;
        const now = Date.now() + 2 * 3_600_000;
        server.now = () => now;
      }
    };
    server.dropResponse = (path, method) =>
      method === "POST" && path.endsWith("/commit");
    await rotate(alice, vaultId);
    expect(server.vaults.get(vaultId)?.key_version).toBe(2);
    expect(posts(server, "/commit")).toBe(2);
    expect(vault(alice.engine, vaultId).keyStatus).toBe("ok");
    server.onRequest = () => undefined;
  });

  it("keeps an invitation sent meanwhile or asks again", async () => {
    const { server, alice, vaultId } = await team();
    const erin = await person(server, "erin@example.com");
    const candidate = await alice.engine.lookupUser(erin.email);
    await alice.account.verifyContact(candidate);
    const review = await alice.engine.prepareRotation(vaultId);
    // An invitation arrives after the review; Erin is verified: kept.
    await alice.engine.invite(vaultId, candidate);
    await alice.engine.runRotation(review, { remove: [], dropCorrupt: false });
    const invited = server.vaults
      .get(vaultId)
      ?.members.get(erin.account.userId ?? "");
    expect(invited?.key_version).toBe(2);

    // An unverified invitee the review did not show: review again.
    const frank = await person(server, "frank@example.com");
    const second = await alice.engine.prepareRotation(vaultId);
    const record = server.vaults.get(vaultId);
    record?.members.set(frank.account.userId ?? "", {
      role: "member",
      state: "pending",
      key_version: 2,
      key_wrapped: null,
      key_box: "Ag",
      sender_id: alice.account.userId ?? "",
      pending_key: null,
      created: "2026-10-23T09:00:00.000Z",
    });
    await expect(
      alice.engine.runRotation(second, { remove: [], dropCorrupt: false }),
    ).rejects.toMatchObject({ code: "rotation_conflict" });
  });

  it("uploads in parts of at most 500 objects and 12 MiB, over 20 MiB in all", async () => {
    const server = new FakeServer();
    const alice = await owner(server);
    const groups = Array.from({ length: 1200 }, (_, i) => ({
      name: `Gruppe ${String(i)}`,
    }));
    await alice.engine.createGroups(alice.vaultId, groups);
    const big = "x".repeat(960_000);
    for (let i = 0; i < 24; i++)
      await entry(
        alice,
        alice.vaultId,
        `Groß ${String(i)}`,
        `${big}${String(i)}`,
      );
    const review = await rotate(alice, alice.vaultId);
    expect(review.objects).toBe(1200 + 24 + 3);
    const total = server.rotationUploads.reduce((sum, u) => sum + u.bytes, 0);
    expect(total).toBeGreaterThan(20 * 1024 * 1024);
    for (const upload of server.rotationUploads) {
      expect(upload.objects).toBeLessThanOrEqual(500);
      expect(upload.bytes).toBeLessThanOrEqual(12 * 1024 * 1024 + 64 * 1024);
    }
    expect(server.vaults.get(alice.vaultId)?.key_version).toBe(2);
    await alice.engine.pull(alice.vaultId);
    expect(titles(alice.engine, alice.vaultId).length).toBe(24);
  });
});
