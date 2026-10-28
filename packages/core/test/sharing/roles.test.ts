/**
 * The owner-signed roles chain in sync: keys only with a commitment, role
 * changes signed and checked from the anchor, forks and rollbacks, the
 * transition of older accounts and vaults, concurrent owners.
 */
import { describe, expect, it } from "vitest";
import { toBase64Url, utf8Decode, utf8Encode } from "../../src/crypto/bytes";
import { buildKeyBox } from "../../src/crypto/flows/vault";
import { derivePublicKey } from "../../src/crypto/keypair";
import { systemRandomness } from "../../src/crypto/random";
import {
  readSignedRoles,
  signRoleStatement,
  successorStatement,
  roleOwner,
} from "../../src/crypto/roles";
import { deriveSigningKeyPair } from "../../src/crypto/signing";
import { FakeServer } from "../account/fake-server";
import { newMember } from "../account/fake-sharing";
import {
  ManualTimers,
  newAccount,
  PASSWORD,
  shownHead,
  vault,
} from "../sync/devices";
import { tv } from "../helpers";
import {
  acceptShown,
  owner,
  person,
  posts,
  share,
  type Person,
} from "./people";

async function trust(who: Person, other: Person): Promise<void> {
  const candidate = await who.engine.lookupUser(other.email);
  await who.account.verifyContact(candidate);
}

async function rotate(someone: Person, vaultId: string, remove: string[] = []) {
  const review = await someone.engine.prepareRotation(vaultId);
  await someone.engine.runRotation(review, { remove, dropCorrupt: false });
}

async function team(options: { roles?: boolean } = {}) {
  const server = new FakeServer();
  server.rolesEnabled = options.roles ?? true;
  const alice = await owner(server);
  const bob = await person(server, "bob@example.com");
  const carol = await person(server, "carol@example.com");
  await share(alice, bob, alice.vaultId);
  await share(alice, carol, alice.vaultId);
  // Without a roles chain an invitation confirms nothing: the invitees
  // confirm the state themselves.
  if (options.roles === false)
    for (const someone of [bob, carol])
      await someone.engine.acknowledgeFreshness(alice.vaultId);
  return { server, alice, bob, carol, vaultId: alice.vaultId };
}

const id = (someone: Person) => someone.account.userId ?? "";

/** An account the test controls with known keys, added straight to the server. */
function mallory(server: FakeServer, vaultId: string) {
  const userId = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5aff";
  const privateKey = tv("roles-sync-mallory-private", 32);
  const signing = deriveSigningKeyPair(tv("roles-sync-mallory-user-key", 32));
  server.users.set(userId, {
    user_id: userId,
    email: "mallory@example.com",
    public_key: toBase64Url(derivePublicKey(privateKey)),
    signing_public_key: toBase64Url(signing.publicKey),
  } as never);
  server.vaults
    .get(vaultId)
    ?.members.set(userId, newMember("member", "active", 1));
  return { userId, email: "mallory@example.com", privateKey, signing };
}

describe("signed roles", () => {
  it("starts with the creator as the only owner and keeps it as anchor", async () => {
    const { server, alice, bob, vaultId } = await team();
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    expect(chain.map((r) => r.version)).toEqual([1]);
    const first = readSignedRoles(chain[0] ?? { statement: "", signature: "" });
    expect(first.statement.owners.map((o) => o.userId)).toEqual([id(alice)]);
    for (const someone of [alice, bob])
      expect(vault(someone.engine, vaultId).roles).toMatchObject({
        status: "ok",
        owners: [{ userId: id(alice) }],
        ownersMismatch: false,
      });
    // Bob's anchor came from Alice's invitation; the floor sits there too.
    const marks = await bob.marks.read(id(bob));
    expect(marks.vaults[vaultId]?.rl?.[0]).toBe(1);
    const members = await bob.engine.members(vaultId);
    expect(
      members.map((m) => [m.email, m.role, m.signed, m.roleMismatch]),
    ).toEqual([
      ["alice@example.com", "owner", true, false],
      ["bob@example.com", "member", true, false],
      ["carol@example.com", "member", true, false],
    ]);
  });

  it("refuses a removed member's key even when the server names her owner", async () => {
    const { server, bob, vaultId } = await team();
    const evil = mallory(server, vaultId);
    await trust(bob, { email: evil.email, engine: bob.engine } as never);
    const bobUser = server.users.get(id(bob));
    const key = tv("roles-sync-mallory-vault-key", 32);
    const box = buildKeyBox(systemRandomness, {
      senderId: evil.userId,
      senderPrivateKey: evil.privateKey,
      recipientId: id(bob),
      recipientPublicKey: Buffer.from(bobUser?.public_key ?? "", "base64url"),
      vaultId,
      keyVersion: 2,
      vaultKey: key,
      vaultName: "x",
      created: new Date().toISOString(),
    });
    // The server makes Mallory owner and passes off her box as a rotation.
    const record = server.vaults.get(vaultId);
    const member = record?.members.get(evil.userId);
    if (member) member.role = "owner";
    server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === vaultId)
          Object.assign(summary, {
            vault_key_version: 2,
            pending_key: {
              key_box: box,
              key_version: 2,
              sender_id: evil.userId,
            },
          });
    };
    const accepted = posts(server, "/key");
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "invalid",
      pendingReason: "roles_rejected",
      writable: false,
    });
    expect(posts(server, "/key")).toBe(accepted);
    await expect(bob.engine.acceptPendingKey(vaultId)).rejects.toMatchObject({
      code: "roles_rejected",
    });
    expect(posts(server, "/key")).toBe(accepted);
    // A chain statement signed by Mallory herself does not help her.
    const chain = record?.roles ?? [];
    const head = readSignedRoles(chain[0] ?? { statement: "", signature: "" });
    const forged = signRoleStatement(
      successorStatement(
        {
          statement: head.statement,
          hash: head.hash,
          signed: chain[0] as never,
        },
        {
          owners: [
            roleOwner(
              evil.userId,
              derivePublicKey(evil.privateKey),
              evil.signing.publicKey,
            ),
          ],
          signer: evil.userId,
          created: new Date().toISOString(),
          rotation: { keyVersion: 2, vaultKey: key },
        },
      ),
      evil.signing.secretKey,
    );
    chain.push({
      version: 2,
      ...forged,
      hash: readSignedRoles(forged).hash,
    });
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "pending",
      pendingReason: "roles_invalid",
      roles: { status: "invalid" },
    });
    expect(posts(server, "/key")).toBe(accepted);
    // Without a good chain, roles are only the server's claim.
    const members = await bob.engine.members(vaultId);
    expect(members.find((m) => m.userId === evil.userId)).toMatchObject({
      role: "owner",
      signed: false,
    });
  });

  it("accepts no key and stays read-only while a named chain cannot be checked", async () => {
    const { server, bob, vaultId } = await team();
    const evil = mallory(server, vaultId);
    await trust(bob, { email: evil.email, engine: bob.engine } as never);
    const record = server.vaults.get(vaultId);
    const member = record?.members.get(evil.userId);
    if (member) member.role = "owner";
    let failing = true;
    server.loseResponses = (path, method) =>
      failing && method === "GET" && path === `/v1/vaults/${vaultId}/roles`;
    // A new unlock has no checked chain yet; the server lets it fail and
    // names Mallory as owner.
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    bob.engine = bob.account.startSync();
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      writable: false,
      roles: { status: "unavailable", head: undefined },
    });
    // Nothing is attested or passed on for a chain it could not check, and
    // the server's owners are not remembered.
    expect(bob.engine.unconfirmableVaults).toBe(1);
    const marks = await bob.marks.read(id(bob));
    expect(marks.vaults[vaultId]?.ow ?? []).not.toContain(evil.userId);
    await expect(
      bob.engine.acknowledgeRoles(vaultId, { head: null }),
    ).rejects.toMatchObject({ code: "roles_unavailable" });
    // Then the server passes off Mallory's box as a rotation.
    const bobUser = server.users.get(id(bob));
    const box = buildKeyBox(systemRandomness, {
      senderId: evil.userId,
      senderPrivateKey: evil.privateKey,
      recipientId: id(bob),
      recipientPublicKey: Buffer.from(bobUser?.public_key ?? "", "base64url"),
      vaultId,
      keyVersion: 2,
      vaultKey: tv("roles-sync-mallory-vault-key", 32),
      vaultName: "x",
      created: new Date().toISOString(),
    });
    server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === vaultId)
          Object.assign(summary, {
            vault_key_version: 2,
            pending_key: {
              key_box: box,
              key_version: 2,
              sender_id: evil.userId,
            },
          });
    };
    const accepted = posts(server, "/key");
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "pending",
      pendingReason: "roles_unavailable",
      writable: false,
    });
    expect(posts(server, "/key")).toBe(accepted);
    // Once the chain loads, it does not commit to her key.
    failing = false;
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "invalid",
      pendingReason: "roles_rejected",
      roles: { status: "ok" },
    });
    expect(posts(server, "/key")).toBe(accepted);
    server.tamperVaults = () => undefined;
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "ok",
      writable: true,
    });
    expect(bob.engine.unconfirmableVaults).toBe(0);
  });

  it("accepts no invitation whose named chain is not delivered", async () => {
    const { server, alice, vaultId } = await team();
    const dave = await person(server, "dave@example.com");
    await trust(alice, dave);
    await alice.engine.invite(
      vaultId,
      await alice.engine.lookupUser(dave.email),
    );
    // The list names a head the chain does not reach.
    server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === vaultId && summary.state === "pending")
          summary.roles_version = 9;
    };
    await dave.engine.refresh();
    const invitation = dave.engine.snapshot.invitations.find(
      (i) => i.vaultId === vaultId,
    );
    if (!invitation?.sender) throw new Error("invitation missing");
    await dave.account.verifyContact(invitation.sender);
    await expect(dave.engine.invitationDetails(vaultId)).rejects.toMatchObject({
      code: "roles_unavailable",
    });
    await expect(
      dave.engine.acceptInvitation(vaultId, { head: undefined }),
    ).rejects.toMatchObject({ code: "roles_unavailable" });
    expect(posts(server, "/accept")).toBe(2);
  });

  it("loads the chain page by page", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    server.rolesPageSize = 1;
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    bob.engine = bob.account.startSync();
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles).toMatchObject({
      status: "ok",
      code: { version: 2 },
    });
  });

  it("checks a named chain also when the configuration does not load", async () => {
    const { server, bob, vaultId } = await team();
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    bob.engine = bob.account.startSync();
    server.failures.set("/v1/config", [
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
    ] as never);
    await bob.engine.refresh();
    // No rollback that "understood" would answer by deleting the anchor.
    expect(vault(bob.engine, vaultId)).toMatchObject({
      roles: { status: "ok" },
      writable: true,
    });
    const marks = await bob.marks.read(id(bob));
    expect(marks.vaults[vaultId]?.rl?.[0]).toBe(1);
  });

  it("signs promotions only for verified contacts and carries them to members", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    await expect(
      alice.engine.setMemberRole(vaultId, id(carol), "owner"),
    ).resolves.toBeUndefined();
    // Carol was verified when she was invited; a stranger is refused.
    const outsider = mallory(server, vaultId);
    await expect(
      alice.engine.setMemberRole(vaultId, outsider.userId, "owner"),
    ).rejects.toMatchObject({ code: "unverified" });
    await bob.engine.refresh();
    expect(
      vault(bob.engine, vaultId).roles.owners.map((o) => o.userId),
    ).toEqual([id(alice), id(carol)].sort());
    const members = await bob.engine.members(vaultId);
    expect(members.find((m) => m.userId === id(carol))).toMatchObject({
      role: "owner",
      signed: true,
    });
    // The server claims Bob is owner too: the signed list says otherwise.
    const record = server.vaults.get(vaultId);
    const bobMember = record?.members.get(id(bob));
    if (bobMember) bobMember.role = "owner";
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles.ownersMismatch).toBe(true);
    expect(
      (await bob.engine.members(vaultId)).find((m) => m.userId === id(bob)),
    ).toMatchObject({ role: "member", roleMismatch: true });
  });

  it("retries a role change after another owner changed the chain", async () => {
    const { server, alice, carol, bob, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await carol.engine.refresh();
    // Alice changes the chain while Carol's device still knows the old head.
    await trust(alice, bob);
    await alice.engine.setMemberRole(vaultId, id(bob), "owner");
    await carol.engine.setMemberRole(vaultId, id(alice), "member");
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    expect(chain.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    const head = readSignedRoles(chain[3] ?? { statement: "", signature: "" });
    expect(head.statement.owners.map((o) => o.userId)).toEqual(
      [id(bob), id(carol)].sort(),
    );
    expect(head.statement.signer).toBe(id(carol));
  });

  it("rotates with the next statement, and members take the key without asking", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await carol.engine.refresh();
    await trust(bob, carol);
    await trust(carol, bob);
    await rotate(carol, vaultId, [id(alice)]);
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    const head = readSignedRoles(
      chain.at(-1) ?? { statement: "", signature: "" },
    );
    expect(head.statement).toMatchObject({ keyVersion: 2, signer: id(carol) });
    expect(head.statement.owners.map((o) => o.userId)).toEqual([id(carol)]);
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "ok",
      vaultKeyVersion: 2,
      roles: { status: "ok", owners: [{ userId: id(carol) }] },
    });
  });

  it("steps down before leaving and before deleting the account", async () => {
    const { server, alice, carol, bob, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await carol.engine.refresh();
    await carol.engine.leaveVault(vaultId);
    let chain = server.vaults.get(vaultId)?.roles ?? [];
    let head = readSignedRoles(
      chain.at(-1) ?? { statement: "", signature: "" },
    );
    expect(head.statement.owners.map((o) => o.userId)).toEqual([id(alice)]);
    expect(server.vaults.get(vaultId)?.members.has(id(carol))).toBe(false);
    // The last owner cannot step down.
    await expect(alice.engine.leaveVault(vaultId)).rejects.toMatchObject({
      code: "last_owner",
    });
    await trust(alice, bob);
    await alice.engine.setMemberRole(vaultId, id(bob), "owner");
    const record = server.vaults.get(vaultId);
    const aliceId = id(alice);
    await alice.account.deleteAccount(PASSWORD);
    chain = record?.roles ?? [];
    head = readSignedRoles(chain.at(-1) ?? { statement: "", signature: "" });
    expect(head.statement.owners.map((o) => o.userId)).toEqual([id(bob)]);
    expect(head.statement.signer).toBe(aliceId);
  });

  it("drops owners who are no longer members", async () => {
    const { server, alice, carol, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    // Gone without stepping down, e.g. removed by the operator.
    server.vaults.get(vaultId)?.members.delete(id(carol));
    await alice.engine.refresh();
    await alice.engine.refresh();
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    const head = readSignedRoles(
      chain.at(-1) ?? { statement: "", signature: "" },
    );
    expect(head.statement.owners.map((o) => o.userId)).toEqual([id(alice)]);
    expect(vault(alice.engine, vaultId).roles.ownersMismatch).toBe(false);
  });

  it("warns about a fork and a rolled-back chain and takes it over on understood", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await bob.engine.refresh();
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    const saved = [...chain];
    // Another statement 2 than Bob checked.
    const second = chain[1];
    if (!second) throw new Error("no statement 2");
    const text = utf8Decode(readSignedRoles(second).bytes);
    const other = text.replace(
      /"created":"[^"]+"/,
      '"created":"2026-01-01T00:00:00.000Z"',
    );
    chain[1] = {
      ...second,
      statement: toBase64Url(utf8Encode(other)),
      hash: readSignedRoles({
        ...second,
        statement: toBase64Url(utf8Encode(other)),
      }).hash,
    };
    // A device that loads the chain again sees it.
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    bob.engine = bob.account.startSync();
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles.status).toBe("fork");
    // A restore from a backup: the chain ends before Bob's anchor.
    chain.splice(0, chain.length, ...saved.slice(0, 1));
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles).toMatchObject({
      status: "rollback",
      owners: [{ userId: id(alice) }],
    });
    await bob.engine.acknowledgeRoles(vaultId, shownHead(bob.engine, vaultId));
    expect(vault(bob.engine, vaultId).roles.status).toBe("ok");
    expect((await bob.marks.read(id(bob))).vaults[vaultId]?.rl?.[0]).toBe(1);
  });

  it("does not let a server hide the chain of an anchored vault", async () => {
    const { server, bob, vaultId } = await team();
    server.rolesEnabled = false;
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles.status).toBe("rollback");
  });

  it("checks the chain an invitation vouches for", async () => {
    const { server, alice, vaultId } = await team();
    const dave = await person(server, "dave@example.com");
    await share(alice, dave, vaultId);
    expect(vault(dave.engine, vaultId).roles).toMatchObject({
      status: "ok",
      owners: [{ userId: id(alice) }],
    });
    // An invitation without a statement to a vault with a chain is refused.
    const erin = await person(server, "erin@example.com");
    const candidate = await alice.engine.lookupUser(erin.email);
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(vaultId, candidate);
    const record = server.vaults.get(vaultId);
    const pending = record?.members.get(id(erin));
    const erinUser = server.users.get(id(erin));
    if (!pending || !erinUser) throw new Error("no invitation");
    // The server swaps in a box without roles from a verified contact.
    const evil = mallory(server, vaultId);
    pending.key_box = buildKeyBox(systemRandomness, {
      senderId: evil.userId,
      senderPrivateKey: evil.privateKey,
      recipientId: id(erin),
      recipientPublicKey: Buffer.from(erinUser.public_key, "base64url"),
      vaultId,
      keyVersion: 1,
      vaultKey: tv("roles-sync-other-key", 32),
      vaultName: "x",
      created: new Date().toISOString(),
    });
    pending.sender_id = evil.userId;
    await erin.engine.refresh();
    const invitation = erin.engine.snapshot.invitations.find(
      (i) => i.vaultId === vaultId,
    );
    if (!invitation?.sender) throw new Error("no sender");
    await erin.account.verifyContact(invitation.sender);
    await expect(acceptShown(erin.engine, vaultId)).rejects.toMatchObject({
      code: "roles_rejected",
    });
  });
});

describe("transition of older accounts and vaults", () => {
  it("starts no chain for an unconfirmed vault when an owner steps down", async () => {
    const { server, alice, carol, vaultId } = await team({ roles: false });
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    server.rolesEnabled = true;
    // Carol adds her signing key, Alice compares her fingerprint again:
    // a chain could be started with both of them.
    // Her confirmed device would start the chain; the server lets that
    // fail, so only an attempt of the new device would show.
    server.failures.set(
      `/v1/vaults/${vaultId}/roles`,
      Array.from({ length: 10 }, () => ({
        status: 503,
        code: "internal_error",
      })),
    );
    for (const someone of [alice, carol]) {
      someone.account.lock();
      await someone.account.unlock(PASSWORD);
      someone.engine = someone.account.startSync();
    }
    await trust(alice, carol);
    await alice.engine.refresh();
    // A new device of Alice's: her user_data is confirmed, the vault not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.tamperVaults = (list) => {
      for (const summary of list) summary.freshness = null;
    };
    const device = newAccount(server);
    await device.account.login(alice.email, PASSWORD);
    const engine = device.account.startSync();
    await engine.refresh();
    expect(vault(engine, vaultId).freshness).toBe("stale");
    const appended = posts(server, "/roles");
    await engine.setMemberRole(vaultId, id(alice), "member");
    expect(posts(server, "/roles")).toBe(appended);
    expect(server.vaults.get(vaultId)?.roles).toEqual([]);
    expect(server.vaults.get(vaultId)?.members.get(id(alice))?.role).toBe(
      "member",
    );
  });

  it("adds signing keys, starts the chain and takes it over from a remembered owner", async () => {
    const { server, alice, bob, carol, vaultId } = await team({
      roles: false,
    });
    expect(server.users.get(id(alice))?.signing_public_key).toBeNull();
    expect(server.vaults.get(vaultId)?.roles).toEqual([]);
    // The server learns signing keys and roles chains.
    server.rolesEnabled = true;
    for (const someone of [alice, bob, carol]) {
      someone.account.lock();
      await someone.account.unlock(PASSWORD);
      someone.engine = someone.account.startSync();
    }
    expect(server.users.get(id(alice))?.signing_public_key).toEqual(
      expect.any(String),
    );
    // Contacts checked before fingerprint version 2 ask for one comparison.
    const aliceSeen = await bob.engine.lookupUser(alice.email);
    expect(aliceSeen.status).toBe("outdated");
    await alice.engine.refresh();
    await alice.engine.refresh();
    expect(server.vaults.get(vaultId)?.roles.map((r) => r.version)).toEqual([
      1,
    ]);
    // Alice is a remembered owner and an (outdated) contact: taken over.
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles.status).toBe("ok");
    // A new key from her waits until Bob compares her fingerprint again;
    // Alice compares her members' first.
    await trust(alice, bob);
    await trust(alice, carol);
    await rotate(alice, vaultId);
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      keyStatus: "pending",
      pendingReason: "unverified",
    });
    await bob.account.verifyContact(await bob.engine.lookupUser(alice.email));
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({ keyStatus: "ok" });
  });

  it("waits for verified co-owners and asks before taking over an unknown owner list", async () => {
    const { server, alice, bob, carol, vaultId } = await team({ roles: false });
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    server.rolesEnabled = true;
    const timers = new ManualTimers();
    for (const someone of [alice, bob, carol]) {
      someone.account.lock();
      await someone.account.unlock(PASSWORD);
      someone.engine = someone.account.startSync(
        someone === bob ? { timers } : {},
      );
    }
    // Carol is an outdated contact of Alice: no chain yet.
    await alice.engine.refresh();
    expect(server.vaults.get(vaultId)?.roles).toEqual([]);
    expect(vault(alice.engine, vaultId).roles.verifyOwners).toBe(true);
    await alice.account.verifyContact(
      await alice.engine.lookupUser(carol.email),
    );
    await alice.engine.refresh();
    expect(server.vaults.get(vaultId)?.roles.length).toBe(1);
    const chain = server.vaults.get(vaultId)?.roles ?? [];
    const first = readSignedRoles(chain[0] ?? { statement: "", signature: "" });
    expect(first.statement.owners.map((o) => o.userId)).toEqual(
      [id(alice), id(carol)].sort(),
    );
    // Bob forgets what he remembered: the list needs his confirmation.
    await bob.marks.rememberOwners(id(bob), vaultId, []);
    const signed = () =>
      server.log.filter(
        (r) => r.method === "PUT" && r.path.endsWith(`${vaultId}/freshness`),
      ).length;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    timers.fire(60_000);
    await settle();
    const before = signed();
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles).toMatchObject({
      status: "unanchored",
    });
    // An unconfirmed owner list is not passed on to the other devices,
    // not even once the spacing of uploads has passed.
    timers.fire(60_000);
    await settle();
    expect(signed()).toBe(before);
    await bob.engine.confirmRoles(vaultId, shownHead(bob.engine, vaultId));
    expect(vault(bob.engine, vaultId).roles.status).toBe("ok");
    timers.fire(60_000);
    await settle();
    expect(signed()).toBe(before + 1);
  });
});
