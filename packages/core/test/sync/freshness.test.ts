/**
 * Freshness on new and long-unused devices: own attestations as floors and
 * reference times, the period, stale vaults, strict mode and what the
 * server cannot fake.
 */
import { describe, expect, it } from "vitest";
import { signFreshness, type VaultFreshness } from "../../src/crypto/freshness";
import { deriveSigningKeyPair } from "../../src/crypto/signing";
import {
  attestedAt,
  confirmationBasis,
  effectivePeriodDays,
  isSatisfied,
  ownUserDataAttestation,
  ownVaultAttestation,
} from "../../src/sync/freshness";
import { inMemorySyncMarks } from "../../src/sync/marks";
import { FakeServer, type VaultRecord } from "../account/fake-server";
import { tv } from "../../src/crypto/internal/test-values";
import {
  EMAIL,
  ManualTimers,
  NAMES,
  PASSWORD,
  shownHead,
  vault,
} from "./devices";
import { acceptShown } from "../sharing/people";

import {
  another,
  Clock,
  DAY,
  entry,
  first,
  puts,
  register,
  settle,
  snapshotVault,
  withhold,
} from "./freshness-devices";

describe("freshness rules", () => {
  const attestation: VaultFreshness = {
    type: "vault_freshness",
    vaultId: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b01",
    userId: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a01",
    time: "2026-10-27T08:00:00.000Z",
    keyVersion: 3,
    manifest: { seq: 10, hash: "A".repeat(43) },
    roles: { version: 2, hash: "Q".repeat(43) },
  };
  const chain = [
    { statement: { version: 1 }, hash: "C".repeat(43) },
    { statement: { version: 2 }, hash: "Q".repeat(43) },
  ];

  it("needs a state at least as new as the attested one", () => {
    const delivered = {
      keyVersion: 3,
      root: { seq: 10, hash: "A".repeat(43) },
      roles: chain,
    };
    expect(isSatisfied(attestation, delivered)).toBe(true);
    expect(isSatisfied(attestation, { ...delivered, keyVersion: 2 })).toBe(
      false,
    );
    expect(
      isSatisfied(attestation, {
        ...delivered,
        root: { seq: 10, hash: "D".repeat(43) },
      }),
    ).toBe(false);
    expect(
      isSatisfied(attestation, {
        ...delivered,
        root: { seq: 11, hash: "D".repeat(43) },
      }),
    ).toBe(true);
    expect(isSatisfied(attestation, { ...delivered, root: null })).toBe(false);
    expect(isSatisfied(attestation, { ...delivered, root: undefined })).toBe(
      true,
    );
    expect(
      isSatisfied(attestation, { ...delivered, roles: chain.slice(0, 1) }),
    ).toBe(false);
    expect(isSatisfied(attestation, { ...delivered, roles: undefined })).toBe(
      false,
    );
  });

  it("takes the later of the own confirmation and a satisfied attestation", () => {
    const now = Date.parse(attestation.time) + DAY;
    const delivered = { keyVersion: 3, root: undefined, roles: chain };
    expect(confirmationBasis(0, attestation, delivered, now)).toBe(
      Date.parse(attestation.time),
    );
    expect(confirmationBasis(now - 1, attestation, delivered, now)).toBe(
      now - 1,
    );
    expect(
      confirmationBasis(5, attestation, { ...delivered, keyVersion: 1 }, now),
    ).toBe(5);
  });

  it("ignores times more than a day ahead and caps the others at now", () => {
    const now = Date.parse("2026-10-27T08:00:00.000Z");
    expect(attestedAt("2026-10-28T09:00:00.000Z", now)).toBeUndefined();
    expect(attestedAt("2026-10-27T20:00:00.000Z", now)).toBe(now);
    expect(attestedAt("2026-10-26T08:00:00.000Z", now)).toBe(now - DAY);
  });

  it("counts only the own account's attestation of the vault it comes with", () => {
    const own = deriveSigningKeyPair(tv("freshness-test-own", 32));
    const other = deriveSigningKeyPair(tv("freshness-test-other", 32));
    const signed = signFreshness(attestation, own.secretKey);
    const { userId, vaultId } = attestation;
    const at = Date.parse(attestation.time);
    // More than a day ahead of this device's clock: no attestation at all,
    // so not a floor either.
    expect(
      ownVaultAttestation(signed, userId, vaultId, own.publicKey, at - 2 * DAY),
    ).toBeUndefined();
    const elsewhere = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b02";
    expect(
      ownVaultAttestation(signed, userId, vaultId, own.publicKey, at),
    ).toEqual(attestation);
    expect(
      ownVaultAttestation(signed, userId, elsewhere, own.publicKey, at),
    ).toBeUndefined();
    expect(
      ownVaultAttestation(signed, elsewhere, vaultId, own.publicKey, at),
    ).toBeUndefined();
    expect(
      ownVaultAttestation(signed, userId, vaultId, other.publicKey, at),
    ).toBeUndefined();
    expect(
      ownVaultAttestation(
        { statement: "x" },
        userId,
        vaultId,
        own.publicKey,
        at,
      ),
    ).toBeUndefined();
    expect(
      ownVaultAttestation(null, userId, vaultId, own.publicKey, at),
    ).toBeUndefined();
    expect(
      ownUserDataAttestation(signed, userId, own.publicKey, at),
    ).toBeUndefined();
    const userData = signFreshness(
      { type: "user_data_freshness", userId, time: attestation.time, seq: 4 },
      own.secretKey,
    );
    expect(
      ownUserDataAttestation(userData, userId, own.publicKey, at),
    ).toMatchObject({ seq: 4 });
    expect(
      ownUserDataAttestation(userData, elsewhere, own.publicKey, at),
    ).toBeUndefined();
  });

  it("never uses a longer period than the confirmed one", () => {
    expect(effectivePeriodDays(30, undefined)).toBe(7);
    expect(effectivePeriodDays(30, 30)).toBe(30);
    expect(effectivePeriodDays(3, 30)).toBe(3);
    expect(effectivePeriodDays(90, 7)).toBe(7);
  });
});

describe("a new device", () => {
  it("takes over a state the own account confirmed, and confirms it itself", async () => {
    const a = await first();
    expect(puts(a.server, `/${a.vaultId}/freshness`)).toBe(1);
    expect(puts(a.server, "/v1/me/freshness")).toBeGreaterThan(0);
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "fresh",
      writable: true,
    });
    expect(b.account.userDataStale).toBe(false);
    expect(b.account.isNewDevice).toBe(true);
    await entry(b.engine, a.vaultId);
  });

  it("without an attestation is stale and read-only until understood", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "stale",
      confirmedSince: undefined,
      writable: false,
    });
    expect(b.account.userDataStale).toBe(true);
    expect(b.account.contacts).toEqual([]);
    await expect(
      b.account.updateSettings({ autoLockMinutes: 5 }),
    ).rejects.toMatchObject({ code: "user_data_read_only" });
    await expect(entry(b.engine, a.vaultId)).rejects.toMatchObject({
      code: "read_only",
    });
    const before = puts(a.server, `/${a.vaultId}/freshness`);
    await b.engine.acknowledgeFreshness();
    await b.account.acknowledgeUserDataFreshness();
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "fresh",
      writable: true,
    });
    expect(puts(a.server, `/${a.vaultId}/freshness`)).toBe(before + 1);
    await b.account.updateSettings({ autoLockMinutes: 5 });
  });

  it("is not confirmed by a matching state code", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    const code = vault(a.engine, a.vaultId).roles.code;
    if (!code) throw new Error("no state code");
    expect(
      (await b.engine.compareStateCode(a.vaultId, code.display)).result,
    ).toBe("match");
    await b.engine.refresh();
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "stale",
      writable: false,
    });
  });

  it("does not count an attestation older than the period", async () => {
    const a = await first();
    a.account.lock();
    a.clock.advance(8 * DAY);
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "stale",
      writable: false,
    });
    expect(b.account.userDataStale).toBe(true);
    // With user_data unconfirmed, attestations are no reference time at all.
    expect(vault(b.engine, a.vaultId).confirmedSince).toBeUndefined();
  });

  it("ignores attestations by another key, of another vault or from the future", async () => {
    const a = await first();
    const second = await a.engine.createVault(NAMES);
    const own = a.server.vaults
      .get(a.vaultId)
      ?.members.get(a.account.userId ?? "")?.freshness;
    // The own attestation of one vault, delivered for the other.
    a.server.tamperVaults = (list) => {
      for (const item of list)
        if (item.vault_id === second) item.freshness = own ?? null;
    };
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
    expect(vault(b.engine, second).freshness).toBe("stale");

    // An attestation the server signed with a key of its own.
    const forged = signFreshness(
      {
        type: "vault_freshness",
        vaultId: a.vaultId,
        userId: a.account.userId ?? "",
        time: new Date(a.clock.t).toISOString(),
        keyVersion: 1,
        manifest: null,
        roles: null,
      },
      deriveSigningKeyPair(tv("freshness-test-forger", 32)).secretKey,
    );
    a.server.tamperVaults = (list) => {
      for (const item of list) item.freshness = forged;
    };
    a.server.tamperMe = (me) => {
      me.freshness = { statement: "garbage", signature: "x" };
    };
    const c = await another(a.server, a.clock);
    expect(vault(c.engine, a.vaultId).freshness).toBe("stale");
    expect(c.account.userDataStale).toBe(true);

    // An attestation from a clock two days ahead.
    a.server.tamperVaults = () => undefined;
    a.server.tamperMe = () => undefined;
    const ahead = new Clock();
    ahead.t = a.clock.t + 2 * DAY;
    const future = await another(a.server, ahead);
    expect(vault(future.engine, a.vaultId).freshness).toBe("fresh");
    const d = await another(a.server, a.clock);
    expect(vault(d.engine, a.vaultId).freshness).toBe("stale");
  });
});

describe("own attestations as floors", () => {
  it("make an older key version a rollback, whatever their age", async () => {
    const a = await first();
    const review = await a.engine.prepareRotation(a.vaultId);
    await a.engine.runRotation(review, { remove: [], dropCorrupt: false });
    a.clock.advance(30 * DAY);
    a.server.tamperVaults = (list) => {
      for (const item of list) item.vault_key_version = 1;
    };
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      keyRollback: true,
      writable: false,
    });
  });

  it("raise the key version and are a point of the roles chain", async () => {
    const a = await first();
    const userId = a.account.userId ?? "";
    const before = snapshotVault(a.server, a.vaultId);
    const beforeUser = structuredClone(a.server.users.get(userId));
    const review = await a.engine.prepareRotation(a.vaultId);
    await a.engine.runRotation(review, { remove: [], dropCorrupt: false });
    a.clock.advance(61_000);
    await a.engine.pull(a.vaultId);
    const own = a.server.vaults.get(a.vaultId)?.members.get(userId)?.freshness;
    // Vault and user_data played back, only the vault attestation is new.
    a.server.vaults.set(a.vaultId, structuredClone(before));
    const user = a.server.users.get(userId);
    const member = a.server.vaults.get(a.vaultId)?.members.get(userId);
    if (!user || !beforeUser || !member || !own) throw new Error("setup");
    user.user_data = { ...beforeUser.user_data };
    user.freshness = beforeUser.freshness;
    member.freshness = own;
    const b = await another(a.server, a.clock);
    // Nothing else on this device knows the newer key version or chain.
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      keyRollback: true,
      writable: false,
    });
    expect(vault(b.engine, a.vaultId).roles.status).toBe("rollback");
  });

  it("are not made by a device that sees a rollback", async () => {
    const a = await first();
    await entry(a.engine, a.vaultId);
    a.clock.advance(2 * 60_000);
    const before = puts(a.server, `/${a.vaultId}/freshness`);
    a.server.tamperVaults = (list) => {
      for (const item of list) item.revision = 1;
    };
    await a.engine.refresh();
    expect(vault(a.engine, a.vaultId).rollback).toBe(true);
    a.clock.advance(2 * 3_600_000);
    await a.engine.refresh();
    expect(puts(a.server, `/${a.vaultId}/freshness`)).toBe(before);
  });
});

describe("the state before a rotation", () => {
  it("is detected at once after a confirmation by another device, and beyond the period without", async () => {
    const a = await first();
    await entry(a.engine, a.vaultId);
    const userId = a.account.userId ?? "";
    const before = snapshotVault(a.server, a.vaultId);
    const beforeUser = structuredClone(a.server.users.get(userId));
    a.clock.advance(DAY);
    const review = await a.engine.prepareRotation(a.vaultId);
    await a.engine.runRotation(review, { remove: [], dropCorrupt: false });
    await entry(a.engine, a.vaultId);
    const after = snapshotVault(a.server, a.vaultId);
    const afterUser = structuredClone(a.server.users.get(userId));
    const playBack = (vault: VaultRecord, user: typeof beforeUser) => {
      a.server.vaults.set(a.vaultId, structuredClone(vault));
      const current = a.server.users.get(userId);
      if (!current || !user) throw new Error("no user");
      current.user_data = { ...user.user_data };
      current.freshness = user.freshness;
    };

    // Only the vault played back: the account's roles anchor is newer.
    playBack(before, afterUser);
    const anchored = await another(a.server, a.clock);
    expect(vault(anchored.engine, a.vaultId).roles.status).toBe("rollback");

    // Vault and user_data played back, within the period: a device
    // without a confirmation takes the old state, as the attestations from
    // before the rotation are still fresh. This is the limit of the period.
    playBack(before, beforeUser);
    const early = await another(a.server, a.clock);
    expect(vault(early.engine, a.vaultId)).toMatchObject({
      vaultKeyVersion: 1,
      freshness: "fresh",
    });

    // Confirmed by the device that saw the rotation: rollbacks.
    const confirmed = await another(a.server, a.clock);
    await confirmed.account.requestConfirmation();
    playBack(after, afterUser);
    const [request] = await a.account.confirmationRequests();
    await a.account.confirmRequest(request?.requestId ?? "");
    playBack(before, beforeUser);
    expect(await confirmed.account.checkConfirmation()).toMatchObject({
      status: "confirmed",
    });
    expect(vault(confirmed.engine, a.vaultId)).toMatchObject({
      keyRollback: true,
      writable: false,
    });
    expect(confirmed.account.userDataRollback).toBe(true);

    // Without a confirmation, after the period: the old attestations no
    // longer count.
    a.account.lock();
    a.clock.advance(8 * DAY);
    const late = await another(a.server, a.clock);
    expect(vault(late.engine, a.vaultId)).toMatchObject({
      vaultKeyVersion: 1,
      freshness: "stale",
      writable: false,
    });
    expect(late.account.userDataStale).toBe(true);
  });
});

describe("a long-unused device", () => {
  it("needs a confirmation within the period, by itself or another device", async () => {
    const a = await first();
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
    b.account.lock();
    // The other device stays in use; this one is not used for 8 days.
    // In use, it renews its attestations, those of user_data too.
    for (let day = 0; day < 4; day++) {
      a.clock.advance(2 * DAY);
      await a.engine.refresh();
      await a.account.reloadUserData();
      await settle();
    }
    expect(vault(a.engine, a.vaultId).freshness).toBe("fresh");
    const again = await another(a.server, a.clock, marks);
    expect(vault(again.engine, a.vaultId).freshness).toBe("fresh");
    again.account.lock();
    a.account.lock();
    // Nobody was active for longer than the period.
    a.clock.advance(8 * DAY);
    const late = await another(a.server, a.clock, marks);
    expect(vault(late.engine, a.vaultId)).toMatchObject({
      freshness: "stale",
      writable: false,
    });
  });

  it("does not take a pending key while stale", async () => {
    const alice = await first();
    const bob = await register(alice.server, alice.clock, "bob@example.com");
    const candidate = await alice.engine.lookupUser(bob.email);
    await alice.account.verifyContact(candidate);
    await alice.engine.invite(alice.vaultId, candidate);
    await bob.engine.refresh();
    const invitation = bob.engine.snapshot.invitations[0];
    if (!invitation?.sender) throw new Error("no invitation");
    await bob.account.verifyContact(invitation.sender);
    await acceptShown(bob.engine, alice.vaultId);
    // The invitation of an owner confirms the new member's state.
    expect(vault(bob.engine, alice.vaultId).freshness).toBe("fresh");
    bob.account.lock();
    // Alice stays in use, Bob does not.
    for (let day = 0; day < 4; day++) {
      alice.clock.advance(2 * DAY);
      await alice.engine.refresh();
    }
    const review = await alice.engine.prepareRotation(alice.vaultId);
    await alice.engine.runRotation(review, { remove: [], dropCorrupt: false });
    // Bob's own attestation is as old as his last use.
    await bob.account.unlock(PASSWORD);
    const engine = bob.account.startSync();
    await engine.refresh();
    // His user_data is unconfirmed too, so no contact counts yet.
    expect(bob.account.userDataStale).toBe(true);
    expect(vault(engine, alice.vaultId)).toMatchObject({
      vaultKeyVersion: 2,
      keyStatus: "pending",
      pendingReason: "unverified",
    });
    await bob.account.acknowledgeUserDataFreshness();
    await engine.refresh();
    // The sender counts again, but the vault is still unconfirmed.
    expect(vault(engine, alice.vaultId)).toMatchObject({
      keyStatus: "pending",
      pendingReason: "stale",
      writable: false,
    });
    await engine.acknowledgeFreshness(alice.vaultId);
    await engine.refresh();
    expect(vault(engine, alice.vaultId)).toMatchObject({
      keyStatus: "ok",
      writable: true,
    });
  });
});

describe("the period", () => {
  it("is lowered at once and raised only after a confirmation", async () => {
    const a = await first();
    await a.account.updateSettings({ freshnessDays: 30 });
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    // Confirmed with the new value: it applies from now on.
    expect(b.account.freshnessPeriodDays).toBe(30);
    b.account.lock();
    a.account.lock();
    a.clock.advance(10 * DAY);
    const later = await another(a.server, a.clock, marks);
    expect(vault(later.engine, a.vaultId).freshness).toBe("fresh");
    expect(later.account.freshnessPeriodDays).toBe(30);
    await later.account.updateSettings({ freshnessDays: 3 });
    expect(later.account.freshnessPeriodDays).toBe(3);
  });

  it("of an older user_data does not help a device that confirmed less", async () => {
    const a = await first();
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    expect(b.account.freshnessPeriodDays).toBe(7);
    b.account.lock();
    // Later the server delivers user_data with a longer period, and no
    // attestation that would confirm it.
    await a.account.updateSettings({ freshnessDays: 60 });
    a.account.lock();
    withhold(a.server);
    a.clock.advance(8 * DAY);
    const late = await another(a.server, a.clock, marks);
    expect(late.account.freshnessPeriodDays).toBe(7);
    expect(late.account.userDataStale).toBe(true);
    expect(vault(late.engine, a.vaultId).freshness).toBe("stale");
  });
});

describe("marks from before confirmation times", () => {
  it("confirm once, then the times apply", async () => {
    const a = await first();
    const userId = a.account.userId ?? "";
    const marks = inMemorySyncMarks();
    await marks.raise(userId, {
      ud: [1, 1],
      vaults: { [a.vaultId]: { rev: 1, obj: {} } },
    });
    withhold(a.server);
    const b = await another(a.server, a.clock, marks);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
    expect(b.account.userDataStale).toBe(false);
    const seen = await marks.read(userId);
    expect(seen.vaults[a.vaultId]?.ft).toBe(a.clock.t);
    expect(seen.uf).toBe(a.clock.t);
  });

  it("are not made up by a first sync the server lets fail", async () => {
    const a = await first();
    const userId = a.account.userId ?? "";
    a.account.lock();
    withhold(a.server);
    // The first unlock of a new device writes owners and the roles floor,
    // then the server lets the sync fail.
    let failing = true;
    a.server.loseResponses = (path) =>
      failing && path === `/v1/vaults/${a.vaultId}/changes`;
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    const seen = (await marks.read(userId)).vaults[a.vaultId];
    expect(seen).toMatchObject({ rev: 0, obj: {} });
    // The next unlock syncs: nothing confirms it, in strict mode neither.
    failing = false;
    b.account.lock();
    await b.account.unlock(PASSWORD);
    const engine = b.account.startSync();
    await engine.refresh();
    expect(vault(engine, a.vaultId).freshness).toBe("stale");
  });

  it("are not made up by a rolled-back user_data", async () => {
    const a = await first();
    const userId = a.account.userId ?? "";
    const user = a.server.userByEmail(EMAIL);
    if (!user) throw new Error("no user");
    const old = { ...user.user_data };
    await a.account.updateSettings({ autoLockMinutes: 5 });
    await settle();
    a.account.lock();
    const current = { ...user.user_data };
    // A new device gets the older copy next to the newer attestation.
    user.user_data = { ...old };
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    expect(b.account.userDataRollback).toBe(true);
    expect((await marks.read(userId)).uf).toBe(0);
    b.account.lock();
    // Later the current copy, but no attestation that would confirm it.
    user.user_data = current;
    withhold(a.server);
    await b.account.unlock(PASSWORD);
    expect(b.account.userDataStale).toBe(true);
  });
});

describe("an attestation after an own write", () => {
  it("names the new root, also when the sync after the write fails", async () => {
    const a = await first();
    // Uploads are spaced by a minute.
    a.clock.advance(61_000);
    a.server.loseResponses = (path) =>
      path === `/v1/vaults/${a.vaultId}/changes`;
    await entry(a.engine, a.vaultId);
    await settle();
    a.server.loseResponses = () => false;
    a.account.lock();
    // Another device takes that attestation as confirmation.
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
  });
});

describe("the manifest floor of an attestation", () => {
  it("catches the root a device holds without syncing it again", async () => {
    const a = await first();
    const a2 = await another(a.server, a.clock);
    expect(vault(a2.engine, a.vaultId).writable).toBe(true);
    const seen = a.server.vaults.get(a.vaultId)?.revision ?? 0;
    await entry(a.engine, a.vaultId);
    // Uploads are spaced by a minute.
    a.clock.advance(61_000);
    await a.engine.refresh();
    await settle();
    // The server keeps the new revision from the second device, but its
    // own attestation names the newer root.
    a.server.tamperVaults = (list) => {
      for (const summary of list)
        if (summary.vault_id === a.vaultId) summary.revision = seen;
    };
    await a2.engine.refresh();
    expect(vault(a2.engine, a.vaultId)).toMatchObject({
      rollback: true,
      writable: false,
    });
  });
});

describe("resetting corrupt user_data", () => {
  it("writes above the floor and confirms it", async () => {
    const a = await first();
    const user = a.server.userByEmail(EMAIL);
    if (!user) throw new Error("no user");
    await a.account.updateSettings({ autoLockMinutes: 5 });
    await settle();
    user.user_data = {
      revision: user.user_data.revision + 1,
      data: user.user_data.data.slice(0, -8) + "AAAAAAAA",
    };
    await a.account.reloadUserData();
    expect(a.account.userDataState?.status).toBe("corrupt");
    await a.account.resetUserData("de");
    // Neither this device nor another one takes it for a rollback.
    await a.account.reloadUserData();
    expect(a.account.userDataRollback).toBe(false);
    expect(a.account.userDataStale).toBe(false);
    await settle();
    const b = await another(a.server, a.clock);
    expect(b.account.userDataRollback).toBe(false);
  });
});

describe("uploads", () => {
  it("come at most once a minute per vault and are renewed hourly", async () => {
    const timers = new ManualTimers();
    const a = await first(new FakeServer(), new Clock(), timers);
    const path = `/${a.vaultId}/freshness`;
    expect(puts(a.server, path)).toBe(1);
    await entry(a.engine, a.vaultId);
    await a.engine.pull(a.vaultId);
    expect(puts(a.server, path)).toBe(1);
    a.clock.advance(61_000);
    timers.fire(60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(puts(a.server, path)).toBe(2);
    // Nothing new and the stored one is fresh: no upload.
    await a.engine.pull(a.vaultId);
    expect(puts(a.server, path)).toBe(2);
    // The hourly refresh renews it.
    const lists = a.server.log.filter((r) => r.path === "/v1/vaults").length;
    a.clock.advance(3_600_000);
    timers.fire(3_600_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      a.server.log.filter((r) => r.path === "/v1/vaults").length,
    ).toBeGreaterThan(lists);
    expect(puts(a.server, path)).toBe(3);
  });

  it("do not happen on a server without attestations, where new devices are stale", async () => {
    const server = new FakeServer();
    server.freshnessEnabled = false;
    const a = await first(server);
    expect(puts(server, "/freshness")).toBe(0);
    expect(vault(a.engine, a.vaultId).freshness).toBe("fresh");
    const b = await another(server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
  });
});

describe("owner actions on a stale vault", () => {
  it("are refused except stepping down", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    await expect(b.engine.prepareRotation(a.vaultId)).rejects.toMatchObject({
      code: "stale",
    });
    const bob = await register(a.server, a.clock, "bob@example.com");
    const candidate = await b.engine.lookupUser(bob.email);
    await expect(b.engine.invite(a.vaultId, candidate)).rejects.toMatchObject({
      code: "stale",
    });
    await expect(
      b.engine.setMemberRole(a.vaultId, bob.account.userId ?? "", "owner"),
    ).rejects.toMatchObject({ code: "stale" });
    await b.engine.acknowledgeFreshness(a.vaultId);
    await expect(b.engine.prepareRotation(a.vaultId)).resolves.toBeDefined();
  });
});

describe("strict mode", () => {
  it("keeps a new device stale despite fresh attestations, until another device confirms it", async () => {
    const a = await first();
    await a.account.updateSettings({ requireConfirmation: true });
    await settle();
    expect(a.account.strictMode).toBe(true);
    const b = await another(a.server, a.clock);
    expect(b.account.strictMode).toBe(true);
    expect(b.account.userDataStale).toBe(true);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "stale",
      writable: false,
    });
    await b.account.requestConfirmation();
    const [request] = await a.account.confirmationRequests();
    await a.account.confirmRequest(request?.requestId ?? "");
    expect(await b.account.checkConfirmation()).toMatchObject({
      status: "confirmed",
      confirmed: 1,
    });
    expect(b.account.userDataStale).toBe(false);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
  });

  it("applies the same without confirmations on the server, and understood still confirms", async () => {
    const server = new FakeServer();
    server.confirmationEnabled = false;
    const a = await first(server);
    await a.account.updateSettings({ requireConfirmation: true });
    await settle();
    const b = await another(server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    await b.account.acknowledgeUserDataFreshness();
    await b.engine.acknowledgeFreshness();
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
  });

  it("holds while user_data is unconfirmed, even without the setting", async () => {
    const a = await first();
    // Only the attestation of user_data is withheld.
    a.server.tamperMe = (me) => {
      me.freshness = null;
    };
    const b = await another(a.server, a.clock);
    expect(b.account.strictMode).toBe(false);
    expect(b.account.userDataStale).toBe(true);
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    // Once user_data is confirmed, the vault's attestation counts again.
    await b.account.acknowledgeUserDataFreshness();
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
  });

  it("stays on a device that confirmed it until that device confirms user_data without it", async () => {
    const a = await first();
    await a.account.updateSettings({ requireConfirmation: true });
    await settle();
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    await b.account.acknowledgeUserDataFreshness();
    expect((await marks.read(b.account.userId ?? "")).fs).toBe(true);
    b.account.lock();
    // Switched off later, by a device that stays in use.
    await a.account.updateSettings({ requireConfirmation: false });
    for (let day = 0; day < 4; day++) {
      a.clock.advance(2 * DAY);
      await a.engine.refresh();
      await a.account.reloadUserData();
      await settle();
    }
    const late = await another(a.server, a.clock, marks);
    // The fresh attestations of the other device do not count here yet.
    expect(late.account.strictMode).toBe(true);
    expect(late.account.userDataStale).toBe(true);
    expect(vault(late.engine, a.vaultId).freshness).toBe("stale");
    await late.account.acknowledgeUserDataFreshness();
    expect(late.account.strictMode).toBe(false);
    expect((await marks.read(late.account.userId ?? "")).fs).toBe(false);
    expect(vault(late.engine, a.vaultId).freshness).toBe("fresh");
  });
});

describe("an invitation", () => {
  type Someone = Awaited<ReturnType<typeof register>>;
  async function shareWith(host: Someone, guest: Someone, vaultId: string) {
    const candidate = await host.engine.lookupUser(guest.email);
    if (candidate.status !== "verified")
      await host.account.verifyContact(candidate);
    await host.engine.invite(vaultId, candidate);
    await guest.engine.refresh();
    const invitation = guest.engine.snapshot.invitations.find(
      (i) => i.vaultId === vaultId,
    );
    if (!invitation?.sender) throw new Error("no invitation");
    if (invitation.sender.status !== "verified")
      await guest.account.verifyContact(invitation.sender);
    await acceptShown(guest.engine, vaultId);
  }

  it("is not accepted when its sender owns no part of the statement it names", async () => {
    const alice = await first();
    const carol = await register(
      alice.server,
      alice.clock,
      "carol@example.com",
    );
    const dave = await register(alice.server, alice.clock, "dave@example.com");
    await shareWith(alice, carol, alice.vaultId);
    expect(vault(carol.engine, alice.vaultId).freshness).toBe("fresh");
    // The server calls Carol an owner; the signed list does not.
    const member = alice.server.vaults
      .get(alice.vaultId)
      ?.members.get(carol.account.userId ?? "");
    if (!member) throw new Error("no member");
    member.role = "owner";
    await carol.engine.refresh();
    const candidate = await carol.engine.lookupUser(dave.email);
    await carol.account.verifyContact(candidate);
    await carol.engine.invite(alice.vaultId, candidate);
    await dave.engine.refresh();
    const sender = dave.engine.snapshot.invitations[0]?.sender;
    if (!sender) throw new Error("no invitation");
    await dave.account.verifyContact(sender);
    const details = await dave.engine.invitationDetails(alice.vaultId);
    expect(details.status).toBe("sender_not_owner");
    await expect(
      dave.engine.acceptInvitation(alice.vaultId, details),
    ).rejects.toMatchObject({ code: "sender_not_owner" });
    expect(dave.engine.snapshot.invitations).toHaveLength(1);
  });
});

describe("understood at a warning", () => {
  it("overrules the own attestation that contradicts it, and replaces it", async () => {
    const a = await first();
    const userId = a.account.userId ?? "";
    const before = snapshotVault(a.server, a.vaultId);
    const beforeUser = structuredClone(a.server.users.get(userId));
    const review = await a.engine.prepareRotation(a.vaultId);
    await a.engine.runRotation(review, { remove: [], dropCorrupt: false });
    await a.account.updateSettings({ autoLockMinutes: 9 });
    a.clock.advance(61_000);
    await a.engine.pull(a.vaultId);
    const own = a.server.vaults.get(a.vaultId)?.members.get(userId)?.freshness;
    const ownUserData = a.server.users.get(userId)?.freshness;
    // Restored from a backup, but the newer attestations stayed.
    a.server.vaults.set(a.vaultId, structuredClone(before));
    const member = a.server.vaults.get(a.vaultId)?.members.get(userId);
    const user = a.server.users.get(userId);
    if (!member || !user || !beforeUser || !own) throw new Error("setup");
    member.freshness = own;
    user.user_data = { ...beforeUser.user_data };
    user.freshness = ownUserData;
    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    expect(b.account.userDataRollback).toBe(true);
    expect(vault(b.engine, a.vaultId)).toMatchObject({ keyRollback: true });
    expect(vault(b.engine, a.vaultId).roles.status).toBe("rollback");
    await b.account.acknowledgeUserDataRollback();
    await b.engine.acknowledgeRoles(a.vaultId, shownHead(b.engine, a.vaultId));
    await b.engine.acknowledgeRollback(a.vaultId);
    await b.engine.refresh();
    expect(b.account.userDataRollback).toBe(false);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      keyRollback: false,
      writable: true,
    });
    expect(vault(b.engine, a.vaultId).roles.status).toBe("ok");
    // The device replaced the attestations; a later unlock stays quiet.
    b.account.lock();
    const c = await another(a.server, a.clock, marks);
    expect(c.account.userDataRollback).toBe(false);
    expect(vault(c.engine, a.vaultId)).toMatchObject({
      keyRollback: false,
      writable: true,
    });
  });
});
