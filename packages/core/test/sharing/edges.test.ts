/** Edge cases of the sharing flows: refusals, lost answers and errors. */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { CryptoError } from "../../src/crypto/errors";
import { generateKeyPair } from "../../src/crypto/keypair";
import { KeyStore } from "../../src/crypto/keystore";
import { systemRandomness } from "../../src/crypto/random";
import { emptyDraft } from "../../src/model/entry";
import { keyOf, toCandidate } from "../../src/sharing/candidate";
import { contactStatus, contactViews } from "../../src/sharing/contacts";
import { acceptGrant, grantName } from "../../src/sharing/grants";
import { invite } from "../../src/sharing/members";
import { flipped, rootOf } from "../sync/devices";
import { owner, person, share } from "./people";

const FP = "A".repeat(64);
const FP2 = "C".repeat(64);

/** An unlocked store that holds no vault key. */
function unlockedWithoutVaults(userId: string): KeyStore {
  const keys = new KeyStore();
  const pair = generateKeyPair(systemRandomness);
  keys.unlock({
    userId,
    userKey: systemRandomness.bytes("user_key", 32),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  });
  return keys;
}
const USER = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

describe("contact status", () => {
  it("names conflicts and changed keys", () => {
    const contact = {
      userId: USER,
      email: "a@example.com",
      fingerprint: FP,
      verifiedAt: "2026-10-23T08:00:00.000Z",
    };
    const both = { v1: FP, v2: FP2 };
    const v2 = { ...contact, fingerprint2: FP2 };
    expect(contactStatus([{ ...v2, conflict: true }], USER, both)).toBe(
      "conflict",
    );
    expect(contactStatus([v2], USER, { v1: FP, v2: "B".repeat(64) })).toBe(
      "changed",
    );
    expect(contactStatus([v2], USER, { v1: FP, v2: undefined })).toBe(
      "changed",
    );
    expect(contactStatus([v2], USER, both)).toBe("verified");
    // Checked before fingerprint version 2: compare once more.
    expect(contactStatus([contact], USER, both)).toBe("outdated");
    expect(contactStatus([contact], USER, { v1: FP, v2: undefined })).toBe(
      "outdated",
    );
    expect(
      contactStatus([contact], USER, { ...both, v1: "B".repeat(64) }),
    ).toBe("changed");
    expect(contactStatus([], USER, both)).toBe("unverified");
    expect(contactViews([{ ...contact, conflict: true }])[0]).toMatchObject({
      fingerprint: "AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA",
      conflict: true,
      outdated: true,
    });
    expect(contactViews([v2])[0]).toMatchObject({
      fingerprint: "CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC",
      outdated: false,
    });
    expect(contactViews([{ ...v2, fingerprint2: 7 }])[0]).toMatchObject({
      fingerprint: "AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA",
      outdated: false,
    });
  });
});

describe("grants", () => {
  it("refuses missing grants, other senders and lost answers that did not work", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    const carol = await person(alice.server, "carol@example.com");
    const candidate = await alice.engine.lookupUser(bob.email);
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(alice.vaultId, candidate);
    const summary = (await bob.api.vaults())[0];
    if (!summary) throw new Error("missing");
    const ctx = {
      api: bob.api,
      keys: new KeyStore(),
      userId: bob.account.userId ?? "",
      contacts: () => [],
    };
    const sender = await bob.engine.lookupUser(alice.email);
    await expect(
      acceptGrant(ctx, "key", summary, sender),
    ).rejects.toMatchObject({ code: "not_found" });
    const other = await bob.engine.lookupUser(carol.email);
    await expect(
      acceptGrant(ctx, "invitation", summary, other),
    ).rejects.toMatchObject({ code: "unverified" });
    // Locked keys stay a locked error.
    const trusted = {
      ...ctx,
      contacts: () => [
        {
          userId: sender.userId,
          email: sender.email,
          fingerprint: keyOf(sender).fingerprints.v1,
          fingerprint2: keyOf(sender).fingerprints.v2,
          verifiedAt: "2026-10-23T08:00:00.000Z",
        },
      ],
    };
    await expect(
      acceptGrant(trusted, "invitation", summary, sender),
    ).rejects.toBeInstanceOf(CryptoError);
    const grant = summary.invitation;
    if (!grant) throw new Error("missing");
    expect(() => grantName(ctx, summary.vault_id, grant, sender)).toThrow(
      CryptoError,
    );
    // Withdrawn meanwhile: the 404 is no success.
    await bob.engine.refresh();
    const verified = bob.engine.snapshot.invitations[0]?.sender;
    if (verified) await bob.account.verifyContact(verified);
    await alice.engine.withdrawInvitation(
      alice.vaultId,
      bob.account.userId ?? "",
    );
    await expect(
      bob.engine.acceptInvitation(alice.vaultId),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("members", () => {
  it("rethrows real errors and needs the current key", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    await share(alice, bob, alice.vaultId);
    const candidate = await alice.engine.lookupUser(bob.email);
    // Bob is active: already_member is no lost answer.
    await expect(
      alice.engine.invite(alice.vaultId, candidate),
    ).rejects.toMatchObject({
      code: "already_member",
    });
    await expect(
      alice.engine.withdrawInvitation(alice.vaultId, bob.account.userId ?? ""),
    ).rejects.toMatchObject({ code: "use_rotate" });
    alice.server.failures.set(`/v1/vaults/${alice.vaultId}/decline`, [
      { status: 500, code: "internal_error" },
    ]);
    await expect(
      alice.engine.declineInvitation(alice.vaultId),
    ).rejects.toMatchObject({
      status: 500,
    });
    const ctx = {
      api: alice.api,
      keys: unlockedWithoutVaults(alice.account.userId ?? ""),
      userId: alice.account.userId ?? "",
      contacts: () => [
        {
          userId: candidate.userId,
          email: candidate.email,
          fingerprint: keyOf(candidate).fingerprints.v1,
          fingerprint2: keyOf(candidate).fingerprints.v2,
          verifiedAt: "2026-10-23T08:00:00.000Z",
        },
      ],
    };
    await expect(
      invite(
        ctx,
        { vaultId: alice.vaultId, keyVersion: 1, vaultName: "x" },
        candidate,
      ),
    ).rejects.toMatchObject({ code: "read_only" });
    const fresh = toCandidate(
      { user_id: USER, email: "z@example.com", public_key: "A".repeat(43) },
      [],
      USER,
    );
    expect(fresh.self).toBe(true);
  });
});

describe("rotation errors", () => {
  it("maps server answers and lists objects without key or data", async () => {
    const alice = await owner();
    const bob = await person(alice.server, "bob@example.com");
    await share(alice, bob, alice.vaultId);
    const { server, vaultId } = alice;
    const record = () => {
      const found = server.vaults.get(vaultId);
      if (!found) throw new Error("missing");
      return found;
    };
    const created = await alice.engine.createEntry(
      vaultId,
      rootOf(alice.engine, vaultId),
      {
        ...emptyDraft(),
        title: "Eins",
      },
    );
    const second = await alice.engine.createEntry(
      vaultId,
      rootOf(alice.engine, vaultId),
      {
        ...emptyDraft(),
        title: "Zwei",
      },
    );
    // An object without data and one of an unknown key version are corrupt.
    const one = record().objects.get(created.id);
    const two = record().objects.get(second.id);
    if (one) one.data = null;
    if (two) two.key_version = 9;
    // Changed behind the manifest: refused until the owner accepts it.
    await expect(alice.engine.prepareRotation(vaultId)).rejects.toMatchObject({
      code: "manifest_mismatch",
    });
    await alice.engine.acknowledgeManifest(vaultId);
    const review = await alice.engine.prepareRotation(vaultId);
    expect(review.corrupt.map((o) => o.id).sort()).toEqual(
      [created.id, second.id].sort(),
    );

    // Another owner rotated meanwhile.
    server.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/rotations"))
        record().key_version++;
    };
    await expect(
      alice.engine.runRotation(review, { remove: [], dropCorrupt: true }),
    ).rejects.toMatchObject({ code: "stale_key" });
    record().key_version = 1;

    // The members changed right before the commit.
    const carol = await person(server, "carol@example.com");
    server.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/commit"))
        record().members.set(carol.account.userId ?? "", {
          role: "member",
          state: "active",
          key_version: 1,
          key_wrapped: null,
          key_box: null,
          sender_id: null,
          pending_key: null,
          created: "2026-10-23T09:00:00.000Z",
        });
    };
    const again = await alice.engine.prepareRotation(vaultId);
    await expect(
      alice.engine.runRotation(again, { remove: [], dropCorrupt: true }),
    ).rejects.toMatchObject({ code: "rotation_conflict" });
    record().members.delete(carol.account.userId ?? "");

    // Any other answer passes through.
    server.onRequest = (method, path) => {
      if (method === "PUT" && path.endsWith("/objects"))
        record().objects.delete(vaultId);
    };
    const third = await alice.engine.prepareRotation(vaultId);
    await expect(
      alice.engine.runRotation(third, { remove: [], dropCorrupt: true }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    server.onRequest = () => undefined;
  });

  it("asks again when a restart finds new corrupt objects", async () => {
    const alice = await owner();
    const { server, vaultId } = alice;
    const created = await alice.engine.createEntry(
      vaultId,
      rootOf(alice.engine, vaultId),
      {
        ...emptyDraft(),
        title: "Bald kaputt",
      },
    );
    const review = await alice.engine.prepareRotation(vaultId);
    let once = true;
    server.onRequest = (method, path) => {
      if (method === "POST" && path.endsWith("/commit") && once) {
        once = false;
        const record = server.vaults.get(vaultId);
        const stored = record?.objects.get(created.id);
        if (record && stored?.data) {
          stored.data = flipped(stored.data);
          record.revision++;
        }
      }
    };
    // The restart finds the object changed behind the manifest.
    await expect(
      alice.engine.runRotation(review, { remove: [], dropCorrupt: false }),
    ).rejects.toMatchObject({ code: "manifest_mismatch" });
    server.onRequest = () => undefined;
  });
});
