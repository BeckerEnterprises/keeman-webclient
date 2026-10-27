/**
 * Contacts, invitations and their acceptance:
 * keys go only to and come only from verified contacts; a key the server
 * substitutes changes the fingerprint and never opens a box.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import { sodium } from "../../src/crypto/sodium";
import { AccountError } from "../../src/account/errors";
import { FakeServer } from "../account/fake-server";
import { NAMES, PASSWORD, rootOf, vault } from "../sync/devices";
import { owner, person, posts, share } from "./people";

const attackerKey = () => toBase64Url(sodium().crypto_box_keypair().publicKey);

describe("contacts and fingerprints", () => {
  it("computes the own fingerprint locally and lists verified contacts", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    const own = alice.account.ownFingerprint;
    expect(own).toMatch(/^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
    // A server that names another public key does not change it.
    alice.server.tamperMe = (me) => {
      me.public_key = attackerKey();
    };
    await alice.account.reloadUserData();
    expect(alice.account.ownFingerprint).toBe(own);
    alice.server.tamperMe = () => undefined;

    const candidate = await alice.engine.lookupUser(" BOB@example.com ");
    expect(candidate).toMatchObject({
      userId: bob.account.userId,
      email: "bob@example.com",
      fingerprint: bob.account.ownFingerprint,
      status: "unverified",
      self: false,
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    await alice.account.verifyContact(candidate);
    expect(alice.account.contacts).toEqual([
      expect.objectContaining({
        userId: bob.account.userId,
        email: "bob@example.com",
        fingerprint: bob.account.ownFingerprint,
        conflict: false,
      }),
    ]);
    expect(alice.account.contactEmail(bob.account.userId ?? "")).toBe(
      "bob@example.com",
    );
    expect((await alice.engine.lookupUser("bob@example.com")).status).toBe(
      "verified",
    );
    // A key change makes the contact "changed" (red warning).
    alice.server.tamperLookup = (user) => {
      user.public_key = attackerKey();
    };
    const changed = await alice.engine.lookupUser("bob@example.com");
    expect(changed.status).toBe("changed");
    expect(changed.fingerprint).not.toBe(bob.account.ownFingerprint);
    alice.server.tamperLookup = () => undefined;

    await alice.account.removeContact(bob.account.userId ?? "");
    expect(alice.account.contacts).toEqual([]);
    expect((await alice.engine.lookupUser("bob@example.com")).status).toBe(
      "unverified",
    );
    const self = await alice.engine.lookupUser("alice@example.com");
    expect(self.self).toBe(true);
    await expect(
      alice.engine.lookupUser("nobody@example.com"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses candidates the core did not make", async () => {
    const alice = await owner();
    const fake = {
      userId: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
      email: "x@example.com",
      fingerprint: "AAAA",
      status: "verified" as const,
      self: false,
      verifiable: true,
    };
    await expect(alice.account.verifyContact(fake)).rejects.toMatchObject({
      code: "unverified",
    });
    await expect(
      alice.engine.invite(alice.vaultId, fake),
    ).rejects.toMatchObject({
      code: "unverified",
    });
  });

  it("cannot confirm contacts while user_data is corrupt", async () => {
    const alice = await owner();
    await person(alice.server, "bob@example.com");
    const candidate = await alice.engine.lookupUser("bob@example.com");
    const user = alice.server.userByEmail("alice@example.com");
    if (user) user.user_data.data = toBase64Url(new Uint8Array(80).fill(1));
    await alice.account.reloadUserData();
    expect(alice.account.contactsWritable).toBe(false);
    await expect(alice.account.verifyContact(candidate)).rejects.toBeInstanceOf(
      AccountError,
    );
    await expect(
      alice.account.removeContact(candidate.userId),
    ).rejects.toMatchObject({ code: "user_data_corrupt" });
  });
});

describe("invitations", () => {
  it("shares a vault with a verified contact; both edit it", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    const candidate = await alice.engine.lookupUser("bob@example.com");
    await expect(
      alice.engine.invite(alice.vaultId, candidate),
    ).rejects.toMatchObject({
      code: "unverified",
    });
    expect(posts(alice.server, "/members")).toBe(0);
    const self = await alice.engine.lookupUser("alice@example.com");
    await expect(
      alice.engine.invite(alice.vaultId, self),
    ).rejects.toMatchObject({
      code: "self",
    });
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(alice.vaultId, candidate);
    const members = await alice.engine.members(alice.vaultId);
    expect(members.map((m) => [m.email, m.role, m.state, m.self])).toEqual([
      ["alice@example.com", "owner", "active", true],
      ["bob@example.com", "member", "pending", false],
    ]);
    expect(members[1]?.candidate.status).toBe("verified");
    expect(members[1]?.invitedBy).toBe(alice.account.userId);

    await bob.engine.refresh();
    const [invitation] = bob.engine.snapshot.invitations;
    expect(invitation).toMatchObject({
      vaultId: alice.vaultId,
      keyVersion: 1,
      senderId: alice.account.userId,
      vaultName: "Persönlich",
    });
    expect(invitation?.sender?.fingerprint).toBe(alice.account.ownFingerprint);
    expect(invitation?.sender?.status).toBe("unverified");
    await expect(
      bob.engine.acceptInvitation(alice.vaultId),
    ).rejects.toMatchObject({
      code: "unverified",
    });
    expect(posts(alice.server, "/accept")).toBe(0);
    if (invitation?.sender) await bob.account.verifyContact(invitation.sender);
    await bob.engine.acceptInvitation(alice.vaultId);
    expect(bob.engine.snapshot.invitations).toEqual([]);
    expect(vault(bob.engine, alice.vaultId)).toMatchObject({
      status: "ready",
      role: "member",
      name: "Persönlich",
      keyStatus: "ok",
      memberCount: 2,
    });

    // Both edit; each sees the other's change.
    await bob.engine.createGroup(
      alice.vaultId,
      rootOf(bob.engine, alice.vaultId),
      {
        name: "Von Bob",
      },
    );
    await alice.engine.pull(alice.vaultId);
    const fromBob = [
      ...vault(alice.engine, alice.vaultId).tree.nodes.values(),
    ].find((n) => n.name === "Von Bob");
    expect(fromBob).toBeDefined();
    await alice.engine.createGroup(
      alice.vaultId,
      rootOf(alice.engine, alice.vaultId),
      {
        name: "Von Alice",
      },
    );
    await bob.engine.pull(alice.vaultId);
    expect(
      [...vault(bob.engine, alice.vaultId).tree.nodes.values()].map(
        (n) => n.name,
      ),
    ).toContain("Von Alice");
  });

  it("detects a key the server substitutes in lookup and public-key", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    // The server gives Alice a wrong key for Bob: the fingerprint differs
    // from the one Bob reads on his own device.
    alice.server.tamperLookup = (user) => {
      user.public_key = attackerKey();
    };
    const forged = await alice.engine.lookupUser("bob@example.com");
    expect(forged.fingerprint).not.toBe(bob.account.ownFingerprint);
    // If Alice confirmed anyway, the box is sealed to the attacker and
    // never opens on Bob's device.
    await alice.account.verifyContact(forged);
    await alice.engine.invite(alice.vaultId, forged);
    alice.server.tamperLookup = () => undefined;
    await bob.engine.refresh();
    const invitation = bob.engine.snapshot.invitations[0];
    expect(invitation?.vaultName).toBeUndefined();
    if (invitation?.sender) await bob.account.verifyContact(invitation.sender);
    await expect(
      bob.engine.acceptInvitation(alice.vaultId),
    ).rejects.toMatchObject({
      code: "key_box_invalid",
    });
    expect(posts(alice.server, "/accept")).toBe(0);
  });

  it("refuses an invitation whose sender's key changed", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    // Bob knows Alice from an earlier share; she invites him again.
    await share(alice, bob, alice.vaultId);
    const second = await alice.engine.createVault({
      ...NAMES,
      name: "Zweite",
    });
    await alice.engine.invite(
      second,
      await alice.engine.lookupUser("bob@example.com"),
    );
    // The server now names another key for Alice.
    alice.server.tamperPublicKey = (user) => {
      if (user.email === "alice@example.com") user.public_key = attackerKey();
    };
    // A session keeps the keys it loaded; the next one asks the server again.
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    const engine = bob.account.startSync();
    await engine.refresh();
    const invitation = engine.snapshot.invitations.find(
      (i) => i.vaultId === second,
    );
    expect(invitation?.sender?.status).toBe("changed");
    expect(invitation?.sender?.fingerprint).not.toBe(
      alice.account.ownFingerprint,
    );
    expect(invitation?.vaultName).toBeUndefined();
    const accepted = posts(alice.server, "/accept");
    await expect(engine.acceptInvitation(second)).rejects.toMatchObject({
      code: "unverified",
    });
    expect(posts(alice.server, "/accept")).toBe(accepted);
  });

  it("declines, withdraws and repeats lost answers", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    const carol = await person(alice.server, "carol@example.com");
    for (const guest of [bob, carol]) {
      const candidate = await alice.engine.lookupUser(guest.email);
      await alice.account.verifyContact(candidate);
      // The first answer is lost and not repeated automatically;
      // the user's repetition finds the own invitation.
      alice.server.dropResponse = (path, method) =>
        method === "POST" && path.endsWith("/members");
      await expect(
        alice.engine.invite(alice.vaultId, candidate),
      ).rejects.toBeDefined();
      await alice.engine.invite(alice.vaultId, candidate);
    }
    await bob.engine.refresh();
    await bob.engine.declineInvitation(alice.vaultId);
    await bob.engine.declineInvitation(alice.vaultId);
    expect(bob.engine.snapshot.invitations).toEqual([]);
    await alice.engine.withdrawInvitation(
      alice.vaultId,
      carol.account.userId ?? "",
    );
    await alice.engine.withdrawInvitation(
      alice.vaultId,
      carol.account.userId ?? "",
    );
    await carol.engine.refresh();
    expect(carol.engine.snapshot.invitations).toEqual([]);
    expect((await alice.engine.members(alice.vaultId)).length).toBe(1);
    await expect(
      bob.engine.acceptInvitation(alice.vaultId),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("treats a lost accept answer as done", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    const candidate = await alice.engine.lookupUser("bob@example.com");
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(alice.vaultId, candidate);
    await bob.engine.refresh();
    const sender = bob.engine.snapshot.invitations[0]?.sender;
    if (sender) await bob.account.verifyContact(sender);
    bob.server.loseResponses = (path, method) =>
      method === "POST" && path.endsWith("/accept");
    await expect(
      bob.engine.acceptInvitation(alice.vaultId),
    ).rejects.toBeDefined();
    bob.server.loseResponses = () => false;
    // The repetition answers 404 while the vault is active: done.
    await bob.engine.refresh();
    expect(vault(bob.engine, alice.vaultId).status).toBe("ready");
  });
});

describe("roles and leaving", () => {
  it("changes roles, leaves and flags the rotation", async () => {
    const server = new FakeServer();
    const alice = await owner(server);
    const bob = await person(server, "bob@example.com");
    await share(alice, bob, alice.vaultId);
    await expect(
      bob.engine.setMemberRole(
        alice.vaultId,
        bob.account.userId ?? "",
        "owner",
      ),
    ).rejects.toMatchObject({ code: "read_only" });
    await alice.engine.setMemberRole(
      alice.vaultId,
      bob.account.userId ?? "",
      "owner",
    );
    await bob.engine.refresh();
    expect(vault(bob.engine, alice.vaultId).role).toBe("owner");
    await alice.engine.leaveVault(alice.vaultId);
    expect(
      alice.engine.snapshot.vaults.some((v) => v.id === alice.vaultId),
    ).toBe(false);
    await bob.engine.refresh();
    expect(vault(bob.engine, alice.vaultId).rotationRequired).toBe(true);
    await expect(bob.engine.leaveVault(alice.vaultId)).rejects.toMatchObject({
      code: "last_owner",
    });
    await expect(alice.engine.members(alice.vaultId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
