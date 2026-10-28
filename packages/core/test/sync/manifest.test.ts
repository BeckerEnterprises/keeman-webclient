import { describe, expect, it } from "vitest";
import { emptyDraft } from "../../src/model/entry";
import { bucketOf, manifestIds } from "../../src/model/manifest";
import { inMemorySyncMarks } from "../../src/sync/marks";
import { FakeServer } from "../account/fake-server";
import {
  entryRef,
  firstDevice,
  flipped,
  groupRef,
  rootOf,
  secondDevice,
  stored,
  vault,
} from "./devices";
import type { SyncEngine } from "../../src/sync/engine";

function draft(title: string) {
  return { ...emptyDraft(), title };
}

async function group(engine: SyncEngine, vaultId: string, name: string) {
  return (await engine.createGroup(vaultId, rootOf(engine, vaultId), { name }))
    .id;
}

function manifestObjects(server: FakeServer, vaultId: string) {
  return [...(server.vaults.get(vaultId)?.objects.values() ?? [])].filter(
    (o) => o.type === "manifest",
  );
}

describe("vault manifest: detection", () => {
  it("a new device notices a withheld object", async () => {
    const a = await firstDevice();
    const kept = await group(a.engine, a.vaultId, "Bleibt");
    const { id: hidden } = await a.engine.createEntry(
      a.vaultId,
      rootOf(a.engine, a.vaultId),
      draft("Versteckt"),
    );
    expect(vault(a.engine, a.vaultId).manifest).toBe("verified");
    a.server.tamperChanges = (page) => {
      page.objects = page.objects.filter((o) => o.id !== hidden);
    };
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "mismatch",
      manifestIssues: [{ id: hidden, type: "entry", reason: "missing" }],
      writable: false,
    });
    await expect(
      b.engine.renameGroup(a.vaultId, kept, "Neu"),
    ).rejects.toMatchObject({ code: "read_only" });

    // The server delivers everything again: a full sync settles it
    // without rewriting the manifest.
    a.server.tamperChanges = () => undefined;
    const sent = a.server.batchSizes.length;
    await b.engine.acknowledgeManifest(a.vaultId);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "verified",
      writable: true,
    });
    expect(a.server.batchSizes).toHaveLength(sent);
  });

  it("understood covers only the rollbacks the warning showed", async () => {
    const a = await firstDevice();
    const id = await group(a.engine, a.vaultId, "Alt");
    const old = { ...stored(a.server, a.vaultId, id) };
    await a.engine.renameGroup(a.vaultId, id, "Neu");
    const { id: hidden } = await a.engine.createEntry(
      a.vaultId,
      rootOf(a.engine, a.vaultId),
      draft("Versteckt"),
    );
    a.server.tamperChanges = (page) => {
      page.objects = page.objects.filter((o) => o.id !== hidden);
    };
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "mismatch",
      rollback: false,
    });
    // The full sync that "understood" starts also plays back the group.
    a.server.tamperChanges = (page) => {
      page.objects = page.objects
        .filter((o) => o.id !== hidden)
        .map((o) =>
          o.id === id ? { ...old, revision: page.vault_revision } : o,
        );
    };
    const sent = a.server.batchSizes.length;
    await expect(b.engine.acknowledgeManifest(a.vaultId)).rejects.toMatchObject(
      { code: "rollback_open" },
    );
    // Shown as its own warning; nothing was taken over or rebuilt.
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      rollback: true,
      writable: false,
    });
    expect(a.server.batchSizes).toHaveLength(sent);
  });

  it("a deleted object played back is not in the manifest", async () => {
    const a = await firstDevice();
    const id = await group(a.engine, a.vaultId, "Weg");
    const old = { ...stored(a.server, a.vaultId, id) };
    await a.engine.destroy(a.vaultId, [groupRef(id)]);
    a.server.tamperChanges = (page) => {
      if (!page.objects.some((o) => o.id === id))
        page.objects.push({ ...old, revision: page.vault_revision });
    };
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).manifestIssues).toEqual([
      { id, type: "group", reason: "unlisted" },
    ]);
  });

  it("a device that synced before notices a withheld deletion", async () => {
    const a = await firstDevice();
    const { id } = await a.engine.createEntry(
      a.vaultId,
      rootOf(a.engine, a.vaultId),
      draft("Gleich weg"),
    );
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).manifest).toBe("verified");
    await a.engine.destroy(a.vaultId, [entryRef(id)]);
    a.server.tamperChanges = (page) => {
      page.objects = page.objects.filter((o) => o.id !== id);
    };
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "mismatch",
      manifestIssues: [{ id, type: "entry", reason: "unlisted" }],
    });
  });

  it("a relabelled key version does not match", async () => {
    const a = await firstDevice();
    const id = await group(a.engine, a.vaultId, "G");
    a.server.tamperChanges = (page) => {
      for (const o of page.objects) if (o.id === id) o.key_version = 7;
    };
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).manifestIssues).toEqual([
      { id, type: "group", reason: "differs" },
    ]);
  });

  it("a missing manifest is noticed by the flag", async () => {
    const a = await firstDevice();
    const ids = manifestIds(a.vaultId);
    const hide = new Set([ids.root, ...ids.shards]);
    a.server.tamperChanges = (page) => {
      page.objects = page.objects.filter((o) => !hide.has(o.id));
    };
    // A new device: vault_meta says the vault has a manifest.
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "mismatch",
      manifestIssues: [{ id: ids.root, type: "manifest", reason: "missing" }],
    });
  });

  it("a missing manifest is noticed by the mark, also with an old vault_meta", async () => {
    const server = new FakeServer();
    server.manifestEnabled = false;
    const a = await firstDevice(server);
    const flagless = { ...stored(server, a.vaultId, a.vaultId) };
    server.manifestEnabled = true;
    const marks = inMemorySyncMarks();
    const b = await secondDevice(server, undefined, marks);
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId).manifest).toBe("verified");
    const seen = await marks.read(a.account.userId ?? "");
    expect(seen.vaults[a.vaultId]?.mf).toBe(1);

    // The server hides the manifest and plays back the vault_meta from
    // before it existed.
    const ids = manifestIds(a.vaultId);
    const hide = new Set([ids.root, ...ids.shards]);
    server.tamperChanges = (page) => {
      page.objects = page.objects
        .filter((o) => !hide.has(o.id))
        .map((o) =>
          o.id === a.vaultId ? { ...flagless, revision: o.revision } : o,
        );
    };
    // A new device learns the root's `seq` from the own attestation.
    const fresh = await secondDevice(server);
    expect(vault(fresh.engine, a.vaultId).manifest).toBe("mismatch");
    // Without it (withheld), the old vault_meta is all it has: unverified,
    // and not confirmed either.
    server.tamperVaults = (list) => {
      for (const item of list) item.freshness = null;
    };
    const blind = await secondDevice(server);
    expect(vault(blind.engine, a.vaultId)).toMatchObject({
      manifest: "unverified",
      freshness: "stale",
      writable: false,
    });
    const again = await secondDevice(server, undefined, marks);
    expect(vault(again.engine, a.vaultId).manifest).toBe("mismatch");
  });

  it("a corrupt version written by a member is no false alarm", async () => {
    const a = await firstDevice();
    const id = await group(a.engine, a.vaultId, "Gut");
    const b = await secondDevice(a.server);
    await a.engine.renameGroup(a.vaultId, id, "Neuer");
    // The new version turns corrupt, and the owner accepts it as delivered:
    // the manifest now names the corrupt bytes.
    const object = stored(a.server, a.vaultId, id);
    object.data = flipped(object.data ?? "");
    await a.engine.acknowledgeManifest(a.vaultId);
    expect(vault(a.engine, a.vaultId).manifest).toBe("verified");
    // b keeps its valid version, read-only, and sees no withheld data.
    await b.engine.pull(a.vaultId);
    const view = vault(b.engine, a.vaultId);
    expect(view.manifest).toBe("verified");
    expect(view.corrupt.map((c) => c.id)).toEqual([id]);
  });

  it("checks again after a full resync", async () => {
    const a = await firstDevice();
    const b = await secondDevice(a.server);
    const id = await group(a.engine, a.vaultId, "Alt");
    await a.engine.destroy(a.vaultId, [groupRef(id)]);
    const record = a.server.vaults.get(a.vaultId);
    if (record) {
      record.horizon = record.revision;
      for (const o of [...record.objects.values()])
        if (o.deleted) record.objects.delete(o.id);
    }
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId).manifest).toBe("verified");
  });
});

describe("vault manifest: writing", () => {
  it("every batch keeps it verified, also with other devices", async () => {
    const a = await firstDevice();
    const b = await secondDevice(a.server);
    const g = await group(a.engine, a.vaultId, "A");
    // b writes on a stale view: the conflict is only on the manifest.
    const result = await b.engine.createEntry(
      a.vaultId,
      rootOf(b.engine, a.vaultId),
      draft("Von b"),
    );
    expect(result.notices).toEqual([]);
    await a.engine.renameGroup(a.vaultId, g, "A2");
    for (const device of [a, b]) {
      await device.engine.pull(a.vaultId);
      expect(vault(device.engine, a.vaultId).manifest).toBe("verified");
    }
    expect(vault(a.engine, a.vaultId).entries.size).toBe(1);
  });

  it("conflicts only on the manifest do not count as merge attempts", async () => {
    const a = await firstDevice();
    const id = await group(a.engine, a.vaultId, "X");
    const path = `/v1/vaults/${a.vaultId}/batch`;
    const root = manifestIds(a.vaultId).root;
    const onRoot = {
      status: 409,
      code: "conflict",
      extra: { conflicts: [{ id: root, current_revision: 1, deleted: false }] },
    };
    a.server.failures.set(path, [
      onRoot,
      onRoot,
      onRoot,
      { status: 422, code: "manifest_required" },
    ]);
    const result = await a.engine.renameGroup(a.vaultId, id, "Y");
    expect(result.notices).toEqual([]);
    expect(stored(a.server, a.vaultId, id)).toBeDefined();
    // Six attempts at most.
    a.server.failures.set(
      path,
      Array.from({ length: 6 }, () => onRoot),
    );
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Z"),
    ).rejects.toMatchObject({ code: "conflict_unresolved" });
  });

  it("a batch writes the root and only the touched shards", async () => {
    const a = await firstDevice();
    const before = a.server.batchSizes.length;
    const id = await group(a.engine, a.vaultId, "Eins");
    // The group, its shard and the root.
    expect(a.server.batchSizes.slice(before)).toEqual([3]);
    const shard = manifestIds(a.vaultId).shards[bucketOf(id)] ?? "";
    expect(stored(a.server, a.vaultId, shard).revision).toBe(
      stored(a.server, a.vaultId, id).revision,
    );
  });

  it("creates a missing manifest once, also from two devices", async () => {
    const server = new FakeServer();
    server.manifestEnabled = false;
    const a = await firstDevice(server);
    await group(a.engine, a.vaultId, "Alt");
    expect(manifestObjects(server, a.vaultId)).toEqual([]);
    expect(vault(a.engine, a.vaultId).manifest).toBe("unverified");

    // The server learns it; two devices come along.
    server.manifestEnabled = true;
    const [b, c] = await Promise.all([
      secondDevice(server),
      secondDevice(server),
    ]);
    for (const device of [b, c]) await device.engine.pull(a.vaultId);
    const roots = manifestObjects(server, a.vaultId).filter(
      (o) => o.id === manifestIds(a.vaultId).root,
    );
    expect(roots).toHaveLength(1);
    expect(vault(b.engine, a.vaultId).manifest).toBe("verified");
    expect(vault(c.engine, a.vaultId).manifest).toBe("verified");

    // The old device, which did not create it, gets 422 and writes again
    // with the manifest: two batches for one change.
    const before = server.batchSizes.length;
    await group(a.engine, a.vaultId, "Neu");
    expect(server.batchSizes.length - before).toBe(2);
    await a.engine.pull(a.vaultId);
    expect(vault(a.engine, a.vaultId).manifest).toBe("verified");
  });

  it("creates no manifest from a state with a rolled-back object", async () => {
    const server = new FakeServer();
    server.manifestEnabled = false;
    const a = await firstDevice(server);
    const id = await group(a.engine, a.vaultId, "Alt");
    const old = { ...stored(server, a.vaultId, id) };
    await a.engine.renameGroup(a.vaultId, id, "Neu");
    server.manifestEnabled = true;
    // The server plays back the older group to a device that knows better;
    // a manifest made now would commit to it.
    server.tamperChanges = (page) => {
      page.objects = page.objects.map((o) =>
        o.id === id ? { ...old, revision: page.vault_revision } : o,
      );
    };
    const b = await secondDevice(server, undefined, a.marks);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "unverified",
      rollback: true,
    });
    expect(manifestObjects(server, a.vaultId)).toEqual([]);
  });

  it("an older server without the manifest keeps working", async () => {
    const server = new FakeServer();
    server.manifestEnabled = false;
    const a = await firstDevice(server);
    await group(a.engine, a.vaultId, "G");
    expect(manifestObjects(server, a.vaultId)).toEqual([]);
    expect(vault(a.engine, a.vaultId)).toMatchObject({
      manifest: "unverified",
      writable: true,
    });
  });

  it("rebuilds a corrupt root above every earlier counter", async () => {
    const a = await firstDevice();
    await group(a.engine, a.vaultId, "G");
    await group(a.engine, a.vaultId, "H");
    const root = manifestIds(a.vaultId).root;
    const before = stored(a.server, a.vaultId, root);
    before.data = flipped(before.data ?? "");
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).manifestIssues).toEqual([
      { id: root, type: "manifest", reason: "corrupt" },
    ]);
    // The root is not the one a attested, so b cannot confirm the state;
    // "understood" takes the delivered state, as confirmed.
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    await b.engine.acknowledgeManifest(a.vaultId);
    expect(vault(b.engine, a.vaultId).freshness).toBe("fresh");
    expect(vault(b.engine, a.vaultId).manifest).toBe("verified");
    // a saw the old root: the new one is higher, so no rollback.
    await a.engine.pull(a.vaultId);
    expect(vault(a.engine, a.vaultId)).toMatchObject({
      manifest: "verified",
      rollback: false,
      writable: true,
    });
  });
});
