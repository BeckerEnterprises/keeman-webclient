import { describe, expect, it } from "vitest";
import { emptyDraft } from "../../src/model/entry";
import { SyncError } from "../../src/sync/errors";
import {
  binOf,
  entryRef,
  firstDevice,
  groupRef,
  names,
  node,
  NAMES,
  rootOf,
  secondDevice,
  stored,
  vault,
} from "./devices";

function draft(title: string) {
  return { ...emptyDraft(), title };
}

describe("groups in the tree", () => {
  it("creates nested groups in order and reorders them", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const one = await a.engine.createGroup(a.vaultId, root, { name: "Eins" });
    const two = await a.engine.createGroup(a.vaultId, root, { name: "Zwei" });
    const child = await a.engine.createGroup(a.vaultId, one.id, {
      name: "Kind",
      icon: { type: "builtin", name: "server" },
      defaultEntryIcon: { type: "builtin", name: "globe" },
      notes: "n",
    });
    const bin = binOf(a.engine, a.vaultId);
    expect(
      names(a.engine, a.vaultId, node(a.engine, a.vaultId, root).children),
    ).toEqual(["Papierkorb", "Eins", "Zwei"]);
    expect(node(a.engine, a.vaultId, child.id)).toMatchObject({
      kind: "group",
      icon: "server",
      depth: 2,
      parentId: one.id,
      notes: "n",
      defaultEntryIcon: { type: "builtin", name: "globe" },
    });
    expect(node(a.engine, a.vaultId, bin)).toMatchObject({
      kind: "bin",
      icon: "trash-2",
    });
    expect(node(a.engine, a.vaultId, root)).toMatchObject({
      kind: "root",
      icon: "database",
    });
    await a.engine.reorderGroup(a.vaultId, two.id, -1);
    expect(
      names(a.engine, a.vaultId, node(a.engine, a.vaultId, root).children),
    ).toEqual(["Papierkorb", "Zwei", "Eins"]);
    expect((await a.engine.reorderGroup(a.vaultId, bin, -1)).notices).toEqual(
      [],
    );
    await a.engine.move(a.vaultId, [groupRef(one.id)], {
      vaultId: a.vaultId,
      groupId: root,
      before: bin,
    });
    expect(
      names(a.engine, a.vaultId, node(a.engine, a.vaultId, root).children),
    ).toEqual(["Eins", "Papierkorb", "Zwei"]);
    // Only the moved group was written.
    expect(stored(a.server, a.vaultId, bin).revision).toBe(1);
    const b = await secondDevice(a.server);
    expect(
      names(b.engine, a.vaultId, node(b.engine, a.vaultId, root).children),
    ).toEqual(["Eins", "Papierkorb", "Zwei"]);
    await a.engine.updateGroup(a.vaultId, child.id, {
      notes: "neu",
      defaultEntryIcon: null,
    });
    expect(node(a.engine, a.vaultId, child.id)).toMatchObject({
      notes: "neu",
      defaultEntryIcon: null,
    });
    expect(
      (await a.engine.updateGroup(a.vaultId, child.id, { notes: "neu" }))
        .notices,
    ).toEqual([]);
  });

  it("refuses moves into the own subtree and of the root", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const parent = await a.engine.createGroup(a.vaultId, root, { name: "P" });
    const child = await a.engine.createGroup(a.vaultId, parent.id, {
      name: "C",
    });
    const target = (groupId: string) => ({ vaultId: a.vaultId, groupId });
    expect(
      a.engine.canMove(a.vaultId, [groupRef(parent.id)], target(child.id)),
    ).toEqual({ ok: false, reason: "cycle" });
    expect(
      a.engine.canMove(a.vaultId, [groupRef(parent.id)], target(parent.id)),
    ).toEqual({ ok: false, reason: "cycle" });
    expect(
      a.engine.canMove(a.vaultId, [groupRef(root)], target(parent.id)),
    ).toEqual({ ok: false, reason: "root" });
    expect(
      a.engine.canMove(a.vaultId, [groupRef(parent.id)], target(a.vaultId)),
    ).toEqual({ ok: false, reason: "target" });
    expect(a.engine.canMove(a.vaultId, [], target(root))).toEqual({
      ok: false,
      reason: "target",
    });
    expect(
      a.engine.canMove(a.vaultId, [groupRef(child.id)], target(root)),
    ).toEqual({ ok: true });
    await expect(
      a.engine.move(a.vaultId, [groupRef(parent.id)], target(child.id)),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await expect(
      a.engine.createGroup(a.vaultId, binOf(a.engine, a.vaultId), {
        name: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("moves groups and entries through the recycle bin and back", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const bin = binOf(a.engine, a.vaultId);
    const work = await a.engine.createGroup(a.vaultId, root, {
      name: "Arbeit",
    });
    const sub = await a.engine.createGroup(a.vaultId, work.id, { name: "Sub" });
    const { id: entry } = await a.engine.createEntry(
      a.vaultId,
      sub.id,
      draft("Mail"),
    );
    expect(a.engine.deletePlan(a.vaultId, [groupRef(work.id)])).toEqual({
      mode: "trash",
      groups: 2,
      entries: 1,
      createsBin: false,
    });
    await a.engine.trash(a.vaultId, [groupRef(sub.id)], "Papierkorb");
    expect(node(a.engine, a.vaultId, sub.id)).toMatchObject({
      parentId: bin,
      inTrash: true,
    });
    expect(vault(a.engine, a.vaultId).entries.get(entry)).toMatchObject({
      inTrash: true,
      groupId: sub.id,
    });
    expect(a.engine.deletePlan(a.vaultId, [entryRef(entry)])).toMatchObject({
      mode: "permanent",
      entries: 1,
    });
    expect(
      a.engine.deletePlan(a.vaultId, [entryRef(entry), groupRef(work.id)]),
    ).toMatchObject({ mode: "blocked", reason: "mixed" });
    // Back to the previous parent.
    await a.engine.restore(a.vaultId, [groupRef(sub.id)]);
    expect(node(a.engine, a.vaultId, sub.id)).toMatchObject({
      parentId: work.id,
      inTrash: false,
    });
    expect(stored(a.server, a.vaultId, sub.id)).toBeDefined();
    // Previous parent in the bin too: back to the root.
    await a.engine.trash(a.vaultId, [entryRef(entry)], "Papierkorb");
    await a.engine.trash(a.vaultId, [groupRef(work.id)], "Papierkorb");
    await a.engine.restore(a.vaultId, [entryRef(entry)]);
    expect(vault(a.engine, a.vaultId).entries.get(entry)?.groupId).toBe(root);
    // Dragging out of the bin also clears previousParentId.
    await a.engine.move(a.vaultId, [groupRef(work.id)], {
      vaultId: a.vaultId,
      groupId: root,
    });
    expect(a.engine.editEntry(a.vaultId, entry)).toBeDefined();
    expect(node(a.engine, a.vaultId, work.id).inTrash).toBe(false);
    for (const ref of [groupRef(root), groupRef(bin)])
      expect(a.engine.deletePlan(a.vaultId, [ref]).mode).toBe("blocked");
    await expect(
      a.engine.trash(a.vaultId, [groupRef(root)], "Papierkorb"),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("creates a missing recycle bin once, even on two devices", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const oldBin = binOf(a.engine, a.vaultId);
    const x = await a.engine.createGroup(a.vaultId, root, { name: "X" });
    const y = await a.engine.createGroup(a.vaultId, root, { name: "Y" });
    await a.engine.updateVault(a.vaultId, { recycleBinEnabled: false });
    expect(a.engine.deletePlan(a.vaultId, [groupRef(x.id)]).mode).toBe(
      "permanent",
    );
    await a.engine.updateVault(a.vaultId, { recycleBinEnabled: true });
    // The bin disappears (e.g. its tombstone was purged long ago).
    a.server.vaults.get(a.vaultId)?.objects.delete(oldBin);
    const b = await secondDevice(a.server);
    const c = await secondDevice(a.server);
    // The manifest still names it: the user accepts the delivered state.
    expect(vault(b.engine, a.vaultId).manifest).toBe("mismatch");
    await b.engine.acknowledgeManifest(a.vaultId);
    await c.engine.pull(a.vaultId);
    expect(vault(c.engine, a.vaultId).manifest).toBe("verified");
    expect(b.engine.deletePlan(a.vaultId, [groupRef(x.id)])).toMatchObject({
      mode: "trash",
      createsBin: true,
    });
    await b.engine.trash(a.vaultId, [groupRef(x.id)], "Papierkorb");
    const newBin = binOf(b.engine, a.vaultId);
    expect(newBin).not.toBe(oldBin);
    expect(node(b.engine, a.vaultId, newBin)).toMatchObject({
      name: "Papierkorb",
      kind: "bin",
    });
    expect(node(b.engine, a.vaultId, x.id).parentId).toBe(newBin);
    // c still believes the bin is missing; its plan runs again after the conflict.
    const result = await c.engine.trash(
      a.vaultId,
      [groupRef(y.id)],
      "Recycle Bin",
    );
    expect(result.notices).toEqual([]);
    await c.engine.pull(a.vaultId);
    expect(binOf(c.engine, a.vaultId)).toBe(newBin);
    expect(node(c.engine, a.vaultId, y.id).parentId).toBe(newBin);
    const extra = [...vault(c.engine, a.vaultId).tree.nodes.values()].filter(
      (n) => n.name === "Recycle Bin",
    );
    expect(extra).toEqual([]);
  });

  it("deletes for good bottom-up in limited batches", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const top = await a.engine.createGroup(a.vaultId, root, { name: "Top" });
    const [inner = ""] = await a.engine.createGroups(a.vaultId, [
      { name: "Inner", parentId: top.id },
    ]);
    await a.engine.createEntries(
      a.vaultId,
      inner,
      Array.from({ length: 520 }, (_, i) => draft(`E${String(i)}`)),
    );
    // Root and shards count towards the 500 ops of a batch.
    expect(a.server.batchSizes.slice(-2).every((n) => n <= 500)).toBe(true);
    expect(a.server.batchContent.slice(-2).reduce((x, y) => x + y)).toBe(520);
    a.server.batchSizes.length = 0;
    a.server.batchContent.length = 0;
    // The second batch fails: 500 entries are gone, the groups stay, no orphans.
    const path = `/v1/vaults/${a.vaultId}/batch`;
    const failure = { status: 503, code: "internal_error" };
    a.server.loseResponses = (p, method) => {
      if (p === path && method === "POST") {
        a.server.failures.set(path, [failure, failure, failure]);
        a.server.loseResponses = () => false;
      }
      return false;
    };
    const error = await a.engine
      .destroy(a.vaultId, [groupRef(top.id)])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network" });
    await a.engine.pull(a.vaultId);
    const [first = 0] = a.server.batchContent;
    expect(first).toBeGreaterThan(400);
    expect(vault(a.engine, a.vaultId).entries.size).toBe(520 - first);
    expect(vault(a.engine, a.vaultId).tree.repairs).toEqual([]);
    expect(vault(a.engine, a.vaultId).manifest).toBe("verified");
    expect(stored(a.server, a.vaultId, top.id).deleted).toBe(false);
    await (error as SyncError).retry?.();
    await a.engine.pull(a.vaultId);
    expect(vault(a.engine, a.vaultId).entries.size).toBe(0);
    expect(stored(a.server, a.vaultId, top.id).deleted).toBe(true);
    expect(stored(a.server, a.vaultId, inner).deleted).toBe(true);
    expect(a.server.batchContent).toEqual([first, 520 - first + 2]);
    expect(a.server.batchSizes.every((n) => n <= 500)).toBe(true);
  });

  it("empties the recycle bin and refuses unwritable subtrees", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const g = await a.engine.createGroup(a.vaultId, root, { name: "G" });
    const { id: e } = await a.engine.createEntry(a.vaultId, root, draft("E"));
    await a.engine.trash(
      a.vaultId,
      [groupRef(g.id), entryRef(e)],
      "Papierkorb",
    );
    await a.engine.emptyRecycleBin(a.vaultId);
    expect(
      node(a.engine, a.vaultId, binOf(a.engine, a.vaultId)).children,
    ).toEqual([]);
    expect(vault(a.engine, a.vaultId).entries.size).toBe(0);
    // A rolled back child cannot be written: the permanent delete is refused.
    const h = await a.engine.createGroup(a.vaultId, root, { name: "H" });
    const { id: child } = await a.engine.createEntry(
      a.vaultId,
      h.id,
      draft("N"),
    );
    const old = { ...stored(a.server, a.vaultId, child) };
    const edit = a.engine.editEntry(a.vaultId, child);
    if (!edit) throw new Error("no entry");
    await a.engine.saveEntry(edit.base, { ...edit.draft, title: "M" });
    const b = await secondDevice(a.server);
    await b.engine.trash(a.vaultId, [groupRef(h.id)], "Papierkorb");
    a.server.tamperChanges = (page) => {
      page.objects.push({ ...old, revision: page.vault_revision });
    };
    await b.engine.refresh();
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId).entries.get(child)?.rollback).toBe(true);
    expect(b.engine.deletePlan(a.vaultId, [groupRef(h.id)])).toMatchObject({
      mode: "blocked",
      reason: "read_only",
    });
    await expect(
      b.engine.destroy(a.vaultId, [groupRef(h.id)]),
    ).rejects.toMatchObject({ code: "read_only" });
    await expect(b.engine.emptyRecycleBin(a.vaultId)).rejects.toMatchObject({
      code: "read_only",
    });
  });

  it("repairs orphans, cycles and a missing root", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const p = await a.engine.createGroup(a.vaultId, root, { name: "P" });
    const q = await a.engine.createGroup(a.vaultId, root, { name: "Q" });
    const lost = await a.engine.createGroup(a.vaultId, p.id, { name: "Lost" });
    const { id: entry } = await a.engine.createEntry(
      a.vaultId,
      lost.id,
      draft("E"),
    );
    const b = await secondDevice(a.server);
    // Two devices move P below Q and Q below P at the same time.
    await a.engine.move(a.vaultId, [groupRef(p.id)], {
      vaultId: a.vaultId,
      groupId: q.id,
    });
    await b.engine.move(a.vaultId, [groupRef(q.id)], {
      vaultId: a.vaultId,
      groupId: p.id,
    });
    await a.engine.pull(a.vaultId);
    const tree = vault(a.engine, a.vaultId).tree;
    expect(tree.repairs).toHaveLength(1);
    const head = tree.repairs[0] ?? "";
    expect(node(a.engine, a.vaultId, head)).toMatchObject({
      problem: "cycle",
      parentId: root,
    });
    await a.engine.repair(a.vaultId, "Wurzel");
    expect(vault(a.engine, a.vaultId).tree.repairs).toEqual([]);
    // An orphan: its parent was deleted on another device.
    await b.engine.pull(a.vaultId);
    await b.engine
      .destroy(a.vaultId, [groupRef(lost.id)])
      .catch(() => undefined);
    await a.engine.pull(a.vaultId);
    expect(vault(a.engine, a.vaultId).entries.has(entry)).toBe(false);
  });

  it("stands in for a missing root and repairs it once", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const g = await a.engine.createGroup(a.vaultId, root, { name: "G" });
    a.server.vaults.get(a.vaultId)?.objects.delete(root);
    const b = await secondDevice(a.server);
    const tree = vault(b.engine, a.vaultId).tree;
    expect(tree.missingRoot).toBe(true);
    expect(node(b.engine, a.vaultId, root)).toMatchObject({
      kind: "root",
      problem: "missing",
      writable: false,
    });
    expect(node(b.engine, a.vaultId, g.id).parentId).toBe(root);
    await expect(b.engine.repair(a.vaultId, " ")).rejects.toMatchObject({
      code: "invalid_name",
    });
    const c = await secondDevice(a.server);
    // The manifest still names the root: accepted as delivered first.
    expect(vault(b.engine, a.vaultId).manifest).toBe("mismatch");
    await b.engine.acknowledgeManifest(a.vaultId);
    await c.engine.pull(a.vaultId);
    await b.engine.repair(a.vaultId, "Persönlich");
    // The second device's plan sees the new root after the conflict.
    await c.engine.repair(a.vaultId, "Persönlich");
    await c.engine.pull(a.vaultId);
    const repaired = vault(c.engine, a.vaultId).tree;
    expect(repaired.missingRoot).toBe(false);
    expect(repaired.rootId).not.toBe(root);
    expect(node(c.engine, a.vaultId, g.id).parentId).toBe(repaired.rootId);
    const roots = [...repaired.nodes.values()].filter(
      (n) => n.name === "Persönlich" && n.parentId === null,
    );
    expect(roots).toHaveLength(1);
  });
});

describe("moving between vaults", () => {
  it("copies into the target and then deletes in the source", async () => {
    const a = await firstDevice();
    const source = a.vaultId;
    const target = await a.engine.createVault({ ...NAMES, name: "Ziel" });
    const sroot = rootOf(a.engine, source);
    const troot = rootOf(a.engine, target);
    const g = await a.engine.createGroup(a.vaultId, sroot, { name: "G" });
    const sub = await a.engine.createGroup(a.vaultId, g.id, { name: "Sub" });
    const { id: e } = await a.engine.createEntry(a.vaultId, sub.id, draft("E"));
    const { id: loose } = await a.engine.createEntry(
      a.vaultId,
      sroot,
      draft("Lose"),
    );
    const to = { vaultId: target, groupId: troot };
    expect(
      a.engine.canMove(source, [groupRef(binOf(a.engine, source))], to),
    ).toEqual({ ok: false, reason: "bin" });
    expect(
      a.engine.canMove(source, [groupRef(g.id)], {
        vaultId: target,
        groupId: binOf(a.engine, target),
      }),
    ).toEqual({ ok: false, reason: "target" });
    await a.engine.move(source, [groupRef(g.id), entryRef(loose)], to);
    const moved = vault(a.engine, target);
    expect(moved.tree.nodes.get(g.id)).toMatchObject({
      parentId: troot,
      name: "G",
    });
    expect(moved.tree.nodes.get(sub.id)?.parentId).toBe(g.id);
    expect(moved.entries.get(e)).toMatchObject({ groupId: sub.id, title: "E" });
    expect(moved.entries.get(loose)?.groupId).toBe(troot);
    expect(vault(a.engine, source).entries.size).toBe(0);
    expect(stored(a.server, source, g.id).deleted).toBe(true);
    // Back again: the IDs are tombstones in the source now, so they change.
    await a.engine.move(target, [groupRef(g.id)], {
      vaultId: source,
      groupId: sroot,
    });
    const back = vault(a.engine, source);
    const again = [...back.tree.nodes.values()].find((n) => n.name === "G");
    expect(again?.id).not.toBe(g.id);
    const child = [...back.tree.nodes.values()].find((n) => n.name === "Sub");
    expect(child?.parentId).toBe(again?.id);
    expect([...back.entries.values()].map((x) => x.title)).toEqual(["E"]);
  });
});
