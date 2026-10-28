/**
 * Comparing state codes between members: a rotation the server hides from
 * one account and a chain a former owner forks with the server are found
 * from both sides; honest states never warn; contradictions persist.
 */
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../../src/crypto/bytes";
import { buildKeyBox } from "../../src/crypto/flows/vault";
import { derivePublicKey } from "../../src/crypto/keypair";
import { systemRandomness } from "../../src/crypto/random";
import {
  readSignedRoles,
  roleOwner,
  signRoleStatement,
  successorStatement,
} from "../../src/crypto/roles";
import { deriveSigningKeyPair } from "../../src/crypto/signing";
import { newMember } from "../account/fake-sharing";
import { newAccount, PASSWORD, rootOf, vault } from "../sync/devices";
import { tv } from "../helpers";
import { owner, person, share, type Person } from "./people";

const id = (someone: Person) => someone.account.userId ?? "";

async function trust(who: Person, email: string): Promise<void> {
  await who.account.verifyContact(await who.engine.lookupUser(email));
}

/** The state code a member reads out. */
function codeOf(someone: Person, vaultId: string): string {
  const code = vault(someone.engine, vaultId).roles.code;
  if (!code) throw new Error("no state code");
  return code.display;
}

/** Alice owns the vault, Bob and Carol are members. */
async function team() {
  const alice = await owner();
  const { server, vaultId } = alice;
  const bob = await person(server, "bob@example.com");
  const carol = await person(server, "carol@example.com");
  await share(alice, bob, vaultId);
  await share(alice, carol, vaultId);
  await bob.engine.refresh();
  return { server, alice, bob, carol, vaultId };
}

/** Another device of the same account, without its marks. */
async function otherDevice(someone: Person) {
  const device = newAccount(someone.server);
  await device.account.login(someone.email, PASSWORD);
  const engine = device.account.startSync();
  await engine.refresh();
  return { ...device, engine };
}

/** A former owner the test controls, with known keys. */
function fred(t: { server: Person["server"]; vaultId: string }) {
  const userId = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5af1";
  const privateKey = tv("state-fred-private", 32);
  const signing = deriveSigningKeyPair(tv("state-fred-user-key", 32));
  const publicKey = derivePublicKey(privateKey);
  t.server.users.set(userId, {
    user_id: userId,
    email: "fred@example.com",
    public_key: toBase64Url(publicKey),
    signing_public_key: toBase64Url(signing.publicKey),
  } as never);
  t.server.vaults
    .get(t.vaultId)
    ?.members.set(userId, newMember("member", "active", 1));
  return {
    userId,
    email: "fred@example.com",
    privateKey,
    publicKey,
    signing,
  };
}

/**
 * Fred was owner in version 2 and was demoted in version 3. He signs
 * another version 3 (a rotation to a key of his own), and the server shows
 * Nina, who never had the vault, that chain with his invitation into it.
 */
async function forkedInvitation() {
  const t = await team();
  const { server, alice, vaultId } = t;
  const evil = fred(t);
  await trust(alice, evil.email);
  await alice.engine.setMemberRole(vaultId, evil.userId, "owner");
  await alice.engine.setMemberRole(vaultId, evil.userId, "member");
  const record = server.vaults.get(vaultId);
  const second = record?.roles[1];
  if (!record || record.roles.length !== 3 || !second) throw new Error("chain");
  const key = tv("state-fred-vault-key", 32);
  const forged = signRoleStatement(
    successorStatement(
      {
        statement: readSignedRoles(second).statement,
        hash: second.hash,
        signed: second,
      },
      {
        owners: [
          roleOwner(evil.userId, evil.publicKey, evil.signing.publicKey),
        ],
        signer: evil.userId,
        created: new Date().toISOString(),
        rotation: { keyVersion: 2, vaultKey: key },
      },
    ),
    evil.signing.secretKey,
  );
  const hash = readSignedRoles(forged).hash;
  const nina = await person(server, "nina@example.com");
  server.split(vaultId, [id(nina)]);
  const view = server.viewOf(id(nina), vaultId);
  view.roles = [...view.roles.slice(0, 2), { version: 3, ...forged, hash }];
  view.key_version = 2;
  const ninaUser = server.users.get(id(nina));
  if (!ninaUser) throw new Error("no account");
  view.members.set(
    id(nina),
    newMember("member", "pending", 2, {
      key_box: buildKeyBox(systemRandomness, {
        senderId: evil.userId,
        senderPrivateKey: evil.privateKey,
        recipientId: id(nina),
        recipientPublicKey: fromBase64Url(ninaUser.public_key, 32),
        vaultId,
        keyVersion: 2,
        vaultKey: key,
        vaultName: "Persönlich",
        created: new Date().toISOString(),
        roles: { version: 3, hash },
      }),
      sender_id: evil.userId,
    }),
  );
  await trust(nina, evil.email);
  await nina.engine.refresh();
  return { ...t, evil, nina };
}

describe("a rotation the server hides from an account", () => {
  /** Carol becomes owner and rotates; the server keeps Bob before that. */
  async function hidden() {
    const t = await team();
    const { server, alice, bob, carol, vaultId } = t;
    server.split(vaultId, [id(bob)]);
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await carol.engine.refresh();
    await trust(carol, bob.email);
    const review = await carol.engine.prepareRotation(vaultId);
    await carol.engine.runRotation(review, { remove: [], dropCorrupt: false });
    await bob.engine.refresh();
    return t;
  }

  it("is found from both sides and makes the vault read-only", async () => {
    const { bob, carol, vaultId } = await hidden();
    expect(vault(carol.engine, vaultId).roles.code?.version).toBe(3);
    expect(vault(bob.engine, vaultId).roles.code?.version).toBe(1);
    // Carol checks Bob's code: Bob is behind and should check hers.
    expect(
      await carol.engine.compareStateCode(vaultId, codeOf(bob, vaultId)),
    ).toMatchObject({ result: "behind", own: { version: 3 } });
    expect(vault(carol.engine, vaultId).roles.compared).toBeUndefined();
    // Bob checks Carol's: the server delivers nothing newer.
    const missing = await bob.engine.compareStateCode(
      vaultId,
      codeOf(carol, vaultId),
    );
    expect(missing).toMatchObject({
      result: "missing",
      entered: { version: 3 },
      own: { version: 1 },
    });
    expect(vault(bob.engine, vaultId).writable).toBe(true);
    const { saved } = await bob.engine.confirmStateContradiction(
      vaultId,
      missing.entered,
    );
    expect(saved).toBe(true);
    expect(vault(bob.engine, vaultId)).toMatchObject({
      writable: false,
      roles: {
        status: "rollback",
        code: undefined,
        compared: { kind: "missing", code: { version: 3 } },
      },
    });
    await expect(
      bob.engine.createGroup(vaultId, rootOf(bob.engine, vaultId), {
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "read_only" });
    // Another device of Bob's account sees it from user_data.
    const second = await otherDevice(bob);
    expect(vault(second.engine, vaultId).roles).toMatchObject({
      status: "rollback",
      compared: { kind: "missing" },
    });
  });

  it("stays on the device when the server plays back user_data", async () => {
    const { server, bob, carol, vaultId } = await hidden();
    const before = structuredClone(server.users.get(id(bob))?.user_data);
    const missing = await bob.engine.compareStateCode(
      vaultId,
      codeOf(carol, vaultId),
    );
    await bob.engine.confirmStateContradiction(vaultId, missing.entered);
    const user = server.users.get(id(bob));
    if (!user || !before) throw new Error("no account");
    user.user_data = before;
    bob.account.lock();
    await bob.account.unlock(PASSWORD);
    const engine = bob.account.startSync();
    await engine.refresh();
    expect(vault(engine, vaultId).roles).toMatchObject({
      status: "rollback",
      compared: { kind: "missing" },
    });
  });

  it("goes away once the server delivers the member's statement", async () => {
    const { server, bob, carol, vaultId } = await hidden();
    const missing = await bob.engine.compareStateCode(
      vaultId,
      codeOf(carol, vaultId),
    );
    await bob.engine.confirmStateContradiction(vaultId, missing.entered);
    server.join(id(bob));
    await bob.engine.refresh();
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId).roles).toMatchObject({
      status: "ok",
      compared: undefined,
      code: { version: 3 },
    });
    // The point left user_data too.
    const second = await otherDevice(bob);
    expect(vault(second.engine, vaultId).roles.compared).toBeUndefined();
    const marks = await bob.marks.read(id(bob));
    expect(marks.vaults[vaultId]?.cp).toBeUndefined();
  });

  it("is written to user_data later when it cannot be at once", async () => {
    const { server, bob, carol, vaultId } = await hidden();
    const missing = await bob.engine.compareStateCode(
      vaultId,
      codeOf(carol, vaultId),
    );
    server.failures.set("/v1/me/user-data", [
      { status: 503, code: "internal_error" },
    ]);
    const { saved } = await bob.engine.confirmStateContradiction(
      vaultId,
      missing.entered,
    );
    expect(saved).toBe(false);
    expect(vault(bob.engine, vaultId).roles.status).toBe("rollback");
    await bob.engine.refresh();
    const second = await otherDevice(bob);
    expect(vault(second.engine, vaultId).roles.compared?.kind).toBe("missing");
  });
});

describe("a chain a former owner forks", () => {
  it("is found by the invitee and by a member, from both sides", async () => {
    const { alice, nina, evil, vaultId } = await forkedInvitation();
    const details = await nina.engine.invitationDetails(vaultId);
    expect(details).toMatchObject({
      status: "ok",
      owners: [{ userId: evil.userId, sender: true, verified: true }],
      code: { version: 3 },
    });
    // Nina compares with Alice, not with the inviter.
    const result = await nina.engine.compareInvitationCode(
      vaultId,
      codeOf(alice, vaultId),
    );
    expect(result).toMatchObject({ result: "mismatch", own: { version: 3 } });
    await nina.engine.confirmStateContradiction(vaultId, result.entered);
    expect((await nina.engine.invitationDetails(vaultId)).status).toBe(
      "contradicted",
    );
    await expect(
      nina.engine.acceptInvitation(vaultId, details),
    ).rejects.toMatchObject({ code: "state_mismatch" });
    // Alice compares Nina's code: version 3 with another code.
    const other = await alice.engine.compareStateCode(
      vaultId,
      details.code?.display ?? "",
    );
    expect(other).toMatchObject({ result: "mismatch", own: { version: 3 } });
    await alice.engine.confirmStateContradiction(vaultId, other.entered);
    expect(vault(alice.engine, vaultId)).toMatchObject({
      writable: false,
      roles: { status: "fork", compared: { kind: "mismatch" } },
    });
    // Nothing is signed on a chain with a warning, not even a step-down.
    await expect(alice.engine.leaveVault(vaultId)).rejects.toMatchObject({
      code: "roles_warning_open",
    });
    await expect(alice.engine.stepDownEverywhere()).rejects.toMatchObject({
      code: "roles_warning_open",
    });
    await alice.engine.acknowledgeRoles(vaultId);
    expect(vault(alice.engine, vaultId)).toMatchObject({
      writable: true,
      roles: { status: "ok", compared: undefined },
    });
  });

  it("is found after accepting when the invitee compares later", async () => {
    const { alice, nina, vaultId } = await forkedInvitation();
    const details = await nina.engine.invitationDetails(vaultId);
    await nina.engine.acceptInvitation(vaultId, details);
    expect(vault(nina.engine, vaultId).roles.code?.version).toBe(3);
    const result = await nina.engine.compareStateCode(
      vaultId,
      codeOf(alice, vaultId),
    );
    expect(result.result).toBe("mismatch");
    await nina.engine.confirmStateContradiction(vaultId, result.entered);
    expect(vault(nina.engine, vaultId)).toMatchObject({
      writable: false,
      roles: { status: "fork", compared: { kind: "mismatch" } },
    });
  });
});

describe("an honest state", () => {
  it("matches, also when this device has not synced the change yet", async () => {
    const { alice, bob, carol, vaultId } = await team();
    await carol.engine.refresh();
    const old = codeOf(carol, vaultId);
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    expect(vault(bob.engine, vaultId).roles.code?.version).toBe(1);
    expect(
      await bob.engine.compareStateCode(vaultId, codeOf(alice, vaultId), {
        partner: id(alice),
      }),
    ).toMatchObject({ result: "match" });
    expect(vault(bob.engine, vaultId).roles).toMatchObject({
      status: "ok",
      code: { version: 2 },
      lastMatch: { version: 2, partner: { userId: id(alice) } },
    });
    // Carol's device is behind: Alice is told to let her check the other way.
    expect(await alice.engine.compareStateCode(vaultId, old)).toMatchObject({
      result: "behind",
      own: { version: 2 },
    });
    expect(vault(alice.engine, vaultId)).toMatchObject({
      writable: true,
      roles: { status: "ok", compared: undefined },
    });
    // The last match is in user_data for the account's other devices.
    const second = await otherDevice(bob);
    expect(vault(second.engine, vaultId).roles.lastMatch?.version).toBe(2);
  });

  it("refuses input that is no state code and codes of another vault", async () => {
    const { alice, vaultId } = await team();
    await expect(
      alice.engine.compareStateCode(vaultId, "v2 nope"),
    ).rejects.toMatchObject({ code: "state_code_invalid" });
    const second = await alice.engine.createVault({
      name: "Zweite",
      rootName: "Zweite",
      recycleBinName: "Papierkorb",
    });
    const code = vault(alice.engine, second).roles.code;
    if (!code) throw new Error("no code");
    expect(
      await alice.engine.compareStateCode(vaultId, code.display),
    ).toMatchObject({ result: "other_vault", otherVault: second });
    expect(
      await alice.engine.compareStateCode(vaultId, code.uri),
    ).toMatchObject({ result: "other_vault", otherVault: second });
    await expect(
      alice.engine.confirmStateContradiction(
        "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5bff",
        code,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("turns a head shown only while comparing into a rollback afterwards", async () => {
    const { server, alice, bob, carol, vaultId } = await team();
    server.split(vaultId, [id(bob)]);
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    const view = server.viewOf(id(bob), vaultId);
    const hidden = view.roles;
    view.roles = structuredClone(server.vaults.get(vaultId)?.roles ?? []);
    expect(
      (await bob.engine.compareStateCode(vaultId, codeOf(alice, vaultId)))
        .result,
    ).toBe("match");
    view.roles = hidden;
    await bob.engine.refresh();
    expect(vault(bob.engine, vaultId)).toMatchObject({
      writable: false,
      roles: { status: "rollback" },
    });
  });

  it("binds accepting an invitation to the head the dialog showed", async () => {
    const { server, alice, carol, vaultId } = await team();
    const dave = await person(server, "dave@example.com");
    const candidate = await alice.engine.lookupUser(dave.email);
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(vaultId, candidate);
    await dave.engine.refresh();
    const sender = dave.engine.snapshot.invitations[0]?.sender;
    if (!sender) throw new Error("no invitation");
    await dave.account.verifyContact(sender);
    const shown = await dave.engine.invitationDetails(vaultId);
    expect(shown).toMatchObject({
      status: "ok",
      owners: [{ userId: id(alice), verified: true, sender: true }],
      code: { version: 1 },
    });
    await alice.engine.setMemberRole(vaultId, id(carol), "owner");
    await expect(
      dave.engine.acceptInvitation(vaultId, shown),
    ).rejects.toMatchObject({ code: "roles_changed" });
    const again = await dave.engine.invitationDetails(vaultId);
    expect(again.code?.version).toBe(2);
    // A code that matches the invitation's chain is remembered for display.
    expect(
      (await dave.engine.compareInvitationCode(vaultId, codeOf(alice, vaultId)))
        .result,
    ).toBe("match");
    await dave.engine.acceptInvitation(vaultId, again);
    expect(vault(dave.engine, vaultId).roles).toMatchObject({
      code: { version: 2 },
      lastMatch: { version: 2 },
    });
  });
});

describe("a server without roles chains", () => {
  it("lets understood release an anchored vault", async () => {
    const { server, alice, vaultId } = await team();
    server.rolesEnabled = false;
    await alice.engine.refresh();
    expect(vault(alice.engine, vaultId)).toMatchObject({
      writable: false,
      roles: { status: "rollback" },
    });
    await alice.engine.acknowledgeRoles(vaultId);
    expect(vault(alice.engine, vaultId).writable).toBe(true);
  });
});
