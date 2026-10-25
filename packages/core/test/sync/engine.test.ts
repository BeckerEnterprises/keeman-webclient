import { describe, expect, it, vi } from "vitest";
import { AccountError } from "../../src/account/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import type { SyncEngine } from "../../src/sync/engine";
import { SyncError } from "../../src/sync/errors";
import { inMemorySyncMarks, type SyncMarks } from "../../src/sync/marks";
import { FakeServer } from "../account/fake-server";
import {
  EMAIL,
  firstDevice,
  flipped,
  NAMES,
  newAccount,
  PASSWORD,
  rootOf,
  secondDevice,
  stored,
  vault,
} from "./devices";
import { FakeSocket } from "./fake-socket";

/** Groups below the root except the bin, as a flat list. */
function groups(engine: SyncEngine, vaultId: string) {
  const tree = vault(engine, vaultId).tree;
  return [...tree.nodes.values()]
    .filter((n) => n.kind === "group")
    .map((n) => ({
      id: n.id,
      name: n.name,
      parentId: n.parentId,
      location: n.inTrash ? "trash" : n.problem ? "orphan" : "main",
      writable: n.writable,
      rollback: n.rollback,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function group(engine: SyncEngine, vaultId: string, name: string) {
  return groups(engine, vaultId).find((g) => g.name === name);
}

function add(engine: SyncEngine, vaultId: string, name: string) {
  return engine.createGroup(vaultId, rootOf(engine, vaultId), { name });
}

const asGroup = (id: string) => [{ kind: "group" as const, id }];

describe("first vault and the vault list", () => {
  it("creates a vault with root group and recycle bin", async () => {
    const { engine, vaultId, server, marks, account } = await firstDevice();
    const view = vault(engine, vaultId);
    expect(view).toMatchObject({
      name: "Persönlich",
      role: "owner",
      status: "ready",
      writable: true,
      rollback: false,
      corrupt: [],
      recycleBinEnabled: true,
    });
    const objects = server.vaults.get(vaultId)?.objects;
    expect(objects?.size).toBe(3);
    expect(objects?.has(view.rootGroupId ?? "")).toBe(true);
    expect(objects?.has(view.recycleBinGroupId ?? "")).toBe(true);
    const seen = await marks.read(account.userId ?? "");
    expect(seen.vaults[vaultId]?.rev).toBe(1);
    expect(Object.values(seen.vaults[vaultId]?.obj ?? {})).toEqual([1, 1, 1]);
    expect(engine.snapshot.loaded).toBe(true);
    expect(account.sync).toBe(engine);
    expect(account.startSync()).toBe(engine);
  });

  it("rejects invalid names", async () => {
    const { engine, vaultId } = await firstDevice();
    await expect(engine.createVault({ ...NAMES, name: "  " })).rejects.toThrow(
      SyncError,
    );
    await expect(add(engine, vaultId, "")).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(
      engine.updateVault(vaultId, { name: "x".repeat(257) }),
    ).rejects.toMatchObject({
      code: "invalid_name",
    });
    const { id } = await add(engine, vaultId, "A");
    await expect(engine.renameGroup(vaultId, id, " ")).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(
      engine.renameGroup(vaultId, vaultId, "x"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      add(engine, "0192b3a4-5c6d-7e8f-9a0b-0000000000ff", "x"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("orders vaults by vaultOrder, then by creation", async () => {
    const { engine, server, vaultId } = await firstDevice();
    const second = await engine.createVault({ ...NAMES, name: "Zwei" });
    const third = await engine.createVault({ ...NAMES, name: "Drei" });
    expect(engine.snapshot.vaults.map((v) => v.id)).toEqual([
      vaultId,
      second,
      third,
    ]);
    await engine.moveVault(third, -1);
    await engine.moveVault(vaultId, -1);
    await engine.moveVault("0192b3a4-5c6d-7e8f-9a0b-0000000000ff", 1);
    expect(engine.snapshot.vaults.map((v) => v.id)).toEqual([
      vaultId,
      third,
      second,
    ]);
    const other = await secondDevice(server);
    expect(other.engine.snapshot.vaults.map((v) => v.id)).toEqual([
      vaultId,
      third,
      second,
    ]);
  });

  it("creates a vault again after a lost answer with the same request", async () => {
    const { engine, server } = await firstDevice();
    const before = server.vaults.size;
    // The answer is lost three times in a row: the request failed for the caller.
    let drops = 0;
    server.loseResponses = (path, method) =>
      path === "/v1/vaults" && method === "POST" && drops++ < 3;
    const error = await engine
      .createVault({ ...NAMES, name: "Neu" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("network");
    expect(server.vaults.size).toBe(before + 1);
    const id = (await (error as SyncError).retry?.()) as string;
    expect(vault(engine, id).name).toBe("Neu");
    const bodies = server
      .requests("/v1/vaults")
      .filter((r) => r.method === "POST");
    expect(new Set(bodies.slice(-4).map((r) => r.body)).size).toBe(1);
  });
});

describe("syncing two devices", () => {
  it("sees groups, the recycle bin and deletions of the other device", async () => {
    const a = await firstDevice();
    const b = await secondDevice(a.server);
    const { id } = await add(a.engine, a.vaultId, "Server");
    await b.engine.pull(a.vaultId);
    expect(group(b.engine, a.vaultId, "Server")).toMatchObject({
      id,
      location: "main",
      writable: true,
    });
    await a.engine.trash(a.vaultId, asGroup(id), "Papierkorb");
    await b.engine.pull(a.vaultId);
    expect(group(b.engine, a.vaultId, "Server")?.location).toBe("trash");
    await a.engine.restore(a.vaultId, asGroup(id));
    await b.engine.refresh();
    expect(group(b.engine, a.vaultId, "Server")?.location).toBe("main");
    const child = await add(a.engine, a.vaultId, "Kind");
    await b.engine.pull(a.vaultId);
    await a.engine.destroy(a.vaultId, asGroup(id));
    await b.engine.pull(a.vaultId);
    expect(group(b.engine, a.vaultId, "Server")).toBeUndefined();
    expect(group(b.engine, a.vaultId, "Kind")?.id).toBe(child.id);
    const tombstone = stored(a.server, a.vaultId, id);
    expect(tombstone.deleted).toBe(true);
  });

  it("deletes a group with everything below it", async () => {
    const a = await firstDevice();
    const parent = await add(a.engine, a.vaultId, "Eltern");
    const child = await add(a.engine, a.vaultId, "Kind");
    const grandchild = await add(a.engine, a.vaultId, "Enkel");
    await a.engine.move(a.vaultId, asGroup(child.id), {
      vaultId: a.vaultId,
      groupId: parent.id,
    });
    await a.engine.move(a.vaultId, asGroup(grandchild.id), {
      vaultId: a.vaultId,
      groupId: child.id,
    });
    await expect(
      a.engine.move(a.vaultId, asGroup(parent.id), {
        vaultId: a.vaultId,
        groupId: grandchild.id,
      }),
    ).rejects.toMatchObject({
      code: "invalid_target",
    });
    await expect(
      a.engine.move(a.vaultId, asGroup(parent.id), {
        vaultId: a.vaultId,
        groupId: a.vaultId,
      }),
    ).rejects.toMatchObject({
      code: "invalid_target",
    });
    const b = await secondDevice(a.server);
    const state = vault(b.engine, a.vaultId);
    expect(
      groups(b.engine, a.vaultId).map((g) => [g.name, g.location]),
    ).toEqual([
      ["Eltern", "main"],
      ["Enkel", "main"],
      ["Kind", "main"],
    ]);
    await b.engine.trash(a.vaultId, asGroup(parent.id), "Papierkorb");
    expect(group(b.engine, a.vaultId, "Enkel")?.location).toBe("trash");
    const result = await b.engine.destroy(a.vaultId, asGroup(parent.id));
    expect(result.notices).toEqual([]);
    await a.engine.pull(a.vaultId);
    expect(groups(a.engine, a.vaultId)).toEqual([]);
    await expect(
      a.engine.destroy(a.vaultId, asGroup(state.rootGroupId ?? "")),
    ).rejects.toMatchObject({
      code: "invalid_target",
    });
  });

  it("pages through a full sync with small pages", async () => {
    const a = await firstDevice();
    const names = Array.from({ length: 30 }, (_, i) => `G${String(i)}`);
    expect(
      await a.engine.createGroups(
        a.vaultId,
        names.map((name) => ({ name })),
      ),
    ).toHaveLength(30);
    await expect(
      a.engine.createGroups(a.vaultId, [{ name: " " }]),
    ).rejects.toMatchObject({
      code: "invalid_name",
    });
    const b = await secondDevice(a.server, 4);
    expect(groups(b.engine, a.vaultId)).toHaveLength(30);
    const pages = a.server.log.filter(
      (r) =>
        r.path.startsWith(`/v1/vaults/${a.vaultId}/changes`) &&
        r.path.includes("limit=4"),
    );
    expect(pages.length).toBeGreaterThanOrEqual(9);
  });

  it("merges conflicting changes without losing data", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Alt");
    const b = await secondDevice(a.server);
    // Different fields: both stay.
    await a.engine.renameGroup(a.vaultId, id, "Neu von A");
    const moved = await b.engine.trash(a.vaultId, asGroup(id), "Papierkorb");
    expect(moved.notices).toEqual([]);
    await a.engine.pull(a.vaultId);
    expect(group(a.engine, a.vaultId, "Neu von A")?.location).toBe("trash");
    // The same field: the server wins with a notice.
    await a.engine.renameGroup(a.vaultId, id, "A gewinnt");
    const renamed = await b.engine.renameGroup(a.vaultId, id, "B verliert");
    expect(renamed.notices).toEqual([
      { kind: "discarded", objectId: id, field: "name", value: "B verliert" },
    ]);
    await b.engine.pull(a.vaultId);
    expect(group(b.engine, a.vaultId, "A gewinnt")).toBeDefined();
  });

  it("does not repeat a delete against a changed object and reports deletions", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "X");
    const b = await secondDevice(a.server);
    await a.engine.renameGroup(a.vaultId, id, "Y");
    const deleted = await b.engine.destroy(a.vaultId, asGroup(id));
    expect(deleted.notices).toEqual([
      { kind: "changed_meanwhile", objectId: id },
    ]);
    expect(stored(a.server, a.vaultId, id).deleted).toBe(false);
    await b.engine.pull(a.vaultId);
    await a.engine.destroy(a.vaultId, asGroup(id));
    const renamed = await b.engine.renameGroup(a.vaultId, id, "Z");
    expect(renamed.notices).toEqual([
      { kind: "deleted_meanwhile", objectId: id },
    ]);
  });

  it("gives up after three conflicts", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "X");
    const path = `/v1/vaults/${a.vaultId}/batch`;
    a.server.failures.set(path, [
      { status: 409, code: "conflict" },
      { status: 409, code: "conflict" },
      { status: 409, code: "conflict" },
    ]);
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Y"),
    ).rejects.toMatchObject({
      code: "conflict_unresolved",
    });
  });

  it("offers a retry with the same bytes after network errors", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "X");
    const path = `/v1/vaults/${a.vaultId}/batch`;
    a.server.failures.set(path, [
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
      { status: 503, code: "internal_error" },
    ]);
    const error = await a.engine
      .renameGroup(a.vaultId, id, "Y")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network" });
    await (error as SyncError).retry?.();
    expect(group(a.engine, a.vaultId, "Y")).toBeDefined();
    const bodies = a.server
      .requests(path)
      .slice(-4)
      .map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);
    a.server.failures.set(path, [{ status: 409, code: "stale_key_version" }]);
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Z"),
    ).rejects.toMatchObject({
      code: "stale_key",
    });
    a.server.failures.set(path, [{ status: 403, code: "forbidden" }]);
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Z"),
    ).rejects.toMatchObject({
      code: "read_only",
    });
    a.server.failures.set(path, [{ status: 404, code: "not_found" }]);
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Z"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    a.server.failures.set(path, [{ status: 400, code: "validation_failed" }]);
    await expect(
      a.engine.renameGroup(a.vaultId, id, "Z"),
    ).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("corrupt objects and tombstones", () => {
  it("lists objects that do not decrypt or validate and never writes them", async () => {
    const a = await firstDevice();
    const one = await add(a.engine, a.vaultId, "Eins");
    const two = await add(a.engine, a.vaultId, "Zwei");
    const three = await add(a.engine, a.vaultId, "Drei");
    const four = await add(a.engine, a.vaultId, "Vier");
    const five = await add(a.engine, a.vaultId, "Fünf");
    a.server.tamperChanges = (page) => {
      for (const o of page.objects) {
        if (o.id === one.id && o.data) o.data = flipped(o.data);
        if (o.id === two.id) o.data = null;
        if (o.id === three.id) o.deleted = true;
        if (o.id === four.id) o.key_version = 2;
        if (o.id === five.id) {
          o.deleted = true;
          o.data = null;
        }
      }
    };
    const b = await secondDevice(a.server);
    const view = vault(b.engine, a.vaultId);
    expect(groups(b.engine, a.vaultId)).toEqual([]);
    expect(
      Object.fromEntries(view.corrupt.map((c) => [c.id, c.reason])),
    ).toEqual({
      [one.id]: "auth",
      [two.id]: "no_data",
      [three.id]: "validation",
      [four.id]: "no_key",
      [five.id]: "dropped",
    });
    await expect(
      b.engine.renameGroup(a.vaultId, one.id, "x"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("keeps an object as corrupt when its tombstone is invalid", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Bleibt");
    const b = await secondDevice(a.server);
    await a.engine.destroy(a.vaultId, asGroup(id));
    a.server.tamperChanges = (page) => {
      for (const o of page.objects)
        if (o.id === id && o.data) o.data = flipped(o.data);
    };
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId).corrupt).toEqual([
      { id, type: "group", reason: "auth" },
    ]);
  });

  it("makes the vault read-only when vault_meta is corrupt or the key is unusable", async () => {
    const a = await firstDevice();
    a.server.tamperChanges = (page) => {
      for (const o of page.objects)
        if (o.id === a.vaultId && o.data) o.data = flipped(o.data);
    };
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      name: undefined,
      writable: false,
    });
    await expect(add(b.engine, a.vaultId, "x")).rejects.toMatchObject({
      code: "read_only",
    });
    a.server.tamperChanges = () => undefined;
    const member = a.server.vaults
      .get(a.vaultId)
      ?.members.get(a.account.userId ?? "");
    if (member) member.key_wrapped = toBase64Url(new Uint8Array(73).fill(1));
    const c = await secondDevice(a.server);
    expect(vault(c.engine, a.vaultId).status).toBe("corrupt");
  });

  it("replaces the state after 410", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Weg");
    const b = await secondDevice(a.server);
    await a.engine.destroy(a.vaultId, asGroup(id));
    // The tombstone was purged and the horizon raised.
    const server = a.server.vaults.get(a.vaultId);
    server?.objects.delete(id);
    if (server) server.horizon = server.revision;
    await add(b.engine, a.vaultId, "Neu");
    await b.engine.pull(a.vaultId);
    expect(group(b.engine, a.vaultId, "Weg")).toBeUndefined();
    expect(group(b.engine, a.vaultId, "Neu")).toBeDefined();
    expect(a.server.log.some((r) => r.path.includes("since=0"))).toBe(true);
  });
});

describe("rollback detection", () => {
  it("warns about an older vault revision and older objects", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Alt");
    const old = { ...stored(a.server, a.vaultId, id) };
    await a.engine.renameGroup(a.vaultId, id, "Neu");
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).rollback).toBe(false);
    // The server plays back the old version of the group.
    a.server.tamperChanges = (page) => {
      page.objects.push({ ...old, revision: page.vault_revision });
    };
    await b.engine.refresh();
    await b.engine.pull(a.vaultId);
    const view = vault(b.engine, a.vaultId);
    expect(view.rollback).toBe(true);
    expect(groups(b.engine, a.vaultId).find((g) => g.id === id)).toMatchObject({
      name: "Alt",
      rollback: true,
      writable: false,
    });
    await expect(
      b.engine.renameGroup(a.vaultId, id, "x"),
    ).rejects.toMatchObject({
      code: "read_only",
    });
    a.server.tamperChanges = () => undefined;
    // Let the sync started by the failed write finish first.
    await b.engine.pull(a.vaultId);
    await b.engine.acknowledgeRollback(a.vaultId);
    expect(vault(b.engine, a.vaultId).rollback).toBe(false);
    await b.engine.renameGroup(a.vaultId, id, "Wieder");
    // An older vault revision makes the whole vault read-only.
    a.server.tamperChanges = (page) => {
      page.vault_revision = 1;
    };
    await b.engine.pull(a.vaultId);
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      rollback: true,
      writable: false,
    });
    a.server.tamperChanges = () => undefined;
    await b.engine.pull(a.vaultId);
    await b.engine.acknowledgeRollback(a.vaultId);
    expect(vault(b.engine, a.vaultId).writable).toBe(true);
  });

  it("detects revived objects and older tombstones", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Lebt");
    const live = { ...stored(a.server, a.vaultId, id) };
    const b = await secondDevice(a.server);
    await a.engine.destroy(a.vaultId, asGroup(id));
    await b.engine.pull(a.vaultId);
    a.server.tamperChanges = (page) => {
      page.objects.push({ ...live, revision: page.vault_revision });
    };
    await add(b.engine, a.vaultId, "Anlass");
    await b.engine.pull(a.vaultId);
    expect(groups(b.engine, a.vaultId).find((g) => g.id === id)?.rollback).toBe(
      true,
    );

    // A tombstone older than the live object seen before (only a stale
    // client can produce one; the fake server lets it through).
    const c = await firstDevice();
    const other = await add(c.engine, c.vaultId, "A");
    const stale = await secondDevice(c.server);
    await c.engine.renameGroup(c.vaultId, other.id, "B");
    await c.engine.renameGroup(c.vaultId, other.id, "C");
    const viewer = await secondDevice(c.server);
    const record = stored(c.server, c.vaultId, other.id);
    record.revision = 2;
    await stale.engine.destroy(c.vaultId, asGroup(other.id));
    await viewer.engine.pull(c.vaultId);
    const view = vault(viewer.engine, c.vaultId);
    expect(view.rollback).toBe(true);
    expect(
      groups(viewer.engine, c.vaultId).find((g) => g.id === other.id)?.name,
    ).toBe("C");
    await viewer.engine.acknowledgeRollback(c.vaultId);
    expect(
      groups(viewer.engine, c.vaultId).find((g) => g.id === other.id),
    ).toBeUndefined();
  });

  it("warns about older user_data at unlock", async () => {
    const server = new FakeServer();
    const a = await firstDevice(server);
    await a.account.updateSettings({ autoLockMinutes: 5 });
    await a.account.updateSettings({ autoLockMinutes: 6 });
    const user = server.userByEmail(EMAIL);
    const current = user?.user_data;
    a.account.lock();
    expect(a.account.sync).toBeUndefined();
    server.tamperMe = (me) => {
      me.user_data = {
        revision: 1,
        data: (me.user_data as { data: string }).data,
      };
    };
    const report = await a.account.unlock(PASSWORD);
    expect(report.userDataRollback).toBe(true);
    expect(a.account.userDataRollback).toBe(true);
    await expect(
      a.account.updateSettings({ autoLockMinutes: 7 }),
    ).rejects.toBeInstanceOf(AccountError);
    await a.account.acknowledgeUserDataRollback();
    expect(a.account.userDataRollback).toBe(false);
    server.tamperMe = () => undefined;
    expect(current?.revision).toBe(3);
    await a.account.acknowledgeUserDataRollback();
  });
});

describe("events and lifecycle", () => {
  it("syncs on events from the WebSocket and ends on session_revoked", async () => {
    const a = await firstDevice();
    const b = newAccount(a.server);
    await b.account.login(EMAIL, PASSWORD);
    const sockets: FakeSocket[] = [];
    const onSessionEnded = vi.fn();
    const onUserDataChanged = vi.fn();
    const engine = b.account.startSync({
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onSessionEnded,
      onUserDataChanged,
    });
    const snapshots: unknown[] = [];
    const unsubscribe = engine.subscribe((s) => snapshots.push(s));
    await engine.refresh();
    const socket = sockets[0] ?? new FakeSocket();
    socket.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ type: "auth" });
    socket.message({ type: "ready" });
    expect(engine.snapshot.connection).toBe("online");
    const { id } = await add(a.engine, a.vaultId, "Neu");
    socket.message({ type: "vault_changed", vault_id: a.vaultId, revision: 2 });
    await vi.waitFor(() => {
      expect(group(engine, a.vaultId, "Neu")?.id).toBe(id);
    });
    const other = await a.engine.createVault({ ...NAMES, name: "Neu" });
    socket.message({ type: "vault_changed", vault_id: other, revision: 1 });
    await vi.waitFor(() => {
      expect(engine.snapshot.vaults.some((v) => v.id === other)).toBe(true);
    });
    await a.account.updateSettings({ autoLockMinutes: 9 });
    socket.message({ type: "user_data_changed", revision: 2 });
    await vi.waitFor(() => {
      expect(onUserDataChanged).toHaveBeenCalled();
    });
    expect(b.account.settings.autoLockMinutes).toBe(9);
    socket.message({ type: "vaults_changed" });
    engine.nudge();
    socket.message({ type: "session_revoked" });
    expect(onSessionEnded).toHaveBeenCalled();
    unsubscribe();
    expect(snapshots.length).toBeGreaterThan(2);
  });

  it("deletes a vault with the password and forgets its marks", async () => {
    const a = await firstDevice();
    const b = await secondDevice(a.server);
    await expect(
      a.engine.deleteVault(a.vaultId, "wrong password!!"),
    ).rejects.toMatchObject({
      code: "wrong_password",
    });
    await a.engine.deleteVault(a.vaultId, PASSWORD);
    expect(a.engine.snapshot.vaults).toEqual([]);
    expect(
      (await a.marks.read(a.account.userId ?? "")).vaults[a.vaultId],
    ).toBeUndefined();
    await b.engine.refresh();
    expect(b.engine.snapshot.vaults).toEqual([]);
    await expect(
      a.engine.deleteVault(a.vaultId, PASSWORD),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("deletes the account and forgets it on this device", async () => {
    const a = await firstDevice();
    const userId = a.account.userId ?? "";
    a.kdfMemory.set(userId, { ops: 3, mem: 67108864 });
    await a.account.deleteAccount(PASSWORD);
    expect(a.account.userId).toBeUndefined();
    expect(a.account.isUnlocked).toBe(false);
    expect(a.kdfMemory.get(userId)).toBeUndefined();
    expect(await a.marks.read(userId)).toEqual({ vaults: {} });
    expect(a.server.users.size).toBe(0);
    expect(a.server.vaults.size).toBe(0);
  });
});

describe("edge cases of the engine", () => {
  it("reports marks it cannot store", async () => {
    const server = new FakeServer();
    server.invites.add("INVITE");
    const marks = inMemorySyncMarks();
    const failing: SyncMarks = {
      ...marks,
      raise: () => Promise.resolve(false),
    };
    const device = newAccount(server, failing);
    const pending = await device.account.startRegistration({
      email: EMAIL,
      password: PASSWORD,
      inviteCode: "INVITE",
      language: "de",
    });
    await pending.submit();
    const engine = device.account.startSync();
    await engine.createVault(NAMES);
    expect(engine.snapshot.marksLimited).toBe(true);
  });

  it("shows errors of the vault list and of a vault, and recovers", async () => {
    const a = await firstDevice();
    const failure = { status: 500, code: "internal_error" };
    a.server.failures.set("/v1/vaults", [failure, failure, failure]);
    await a.engine.refresh();
    expect(a.engine.snapshot.error).toBeDefined();
    const path = `/v1/vaults/${a.vaultId}/changes`;
    a.server.failures.set(path, [failure, failure, failure]);
    await add(a.engine, a.vaultId, "X");
    await vi.waitFor(() => {
      expect(vault(a.engine, a.vaultId).status).toBe("error");
    });
    await a.engine.refresh();
    await a.engine.pull(a.vaultId);
    expect(a.engine.snapshot.error).toBeUndefined();
    expect(vault(a.engine, a.vaultId).status).toBe("ready");
  });

  it("flags a lower revision in the vault list and vaults without a key", async () => {
    const a = await firstDevice();
    await add(a.engine, a.vaultId, "X");
    const record = a.server.vaults.get(a.vaultId);
    if (record) record.revision = 1;
    await a.engine.refresh();
    expect(vault(a.engine, a.vaultId).rollback).toBe(true);
    const member = record?.members.get(a.account.userId ?? "");
    if (member) (member as { key_wrapped: unknown }).key_wrapped = null;
    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).status).toBe("corrupt");
    await expect(add(b.engine, a.vaultId, "y")).rejects.toMatchObject({
      code: "read_only",
    });
  });

  it("checks roles, repeats and edge positions", async () => {
    const a = await firstDevice();
    const member = a.server.vaults
      .get(a.vaultId)
      ?.members.get(a.account.userId ?? "");
    if (member) member.role = "member";
    await a.engine.refresh();
    await expect(
      a.engine.deleteVault(a.vaultId, PASSWORD),
    ).rejects.toMatchObject({
      code: "read_only",
    });
    if (member) member.role = "owner";
    await a.engine.refresh();
    a.server.failures.set(`/v1/vaults/${a.vaultId}`, [
      { status: 404, code: "not_found" },
    ]);
    await a.engine.deleteVault(a.vaultId, PASSWORD);
    expect(a.engine.snapshot.vaults).toEqual([]);
    const second = await a.engine.createVault({ ...NAMES, name: "Zwei" });
    await a.engine.moveVault(second, -1);
    await a.engine.moveVault(second, 1);
    const result = await a.engine.updateVault(second, {
      description: "Beschreibung",
      color: "#2563EB",
    });
    expect(result.notices).toEqual([]);
    expect(vault(a.engine, second)).toMatchObject({
      description: "Beschreibung",
      color: "#2563EB",
    });
    const { id } = await add(a.engine, second, "G");
    await expect(
      a.engine.move(second, asGroup(id), {
        vaultId: second,
        groupId: "0192b3a4-5c6d-7e8f-9a0b-0000000000ff",
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await a.engine.move(second, asGroup(id), {
      vaultId: second,
      groupId: vault(a.engine, second).rootGroupId ?? "",
    });
  });

  it("refuses to create over a foreign vault and ignores old events", async () => {
    const a = await firstDevice();
    a.server.failures.set("/v1/vaults", [{ status: 409, code: "conflict" }]);
    await expect(
      a.engine.createVault({ ...NAMES, name: "Fremd" }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect(a.engine.snapshot.vaults).toHaveLength(1);
  });

  it("stops on lock and ignores work that finishes later", async () => {
    const a = await firstDevice();
    const engine = a.engine;
    const pull = engine.pull(a.vaultId);
    a.account.lock();
    await pull;
    await engine.pull(a.vaultId);
    await engine.refresh();
    engine.nudge();
    expect(engine.snapshot.vaults.length).toBe(1);
  });

  it("does not delete rolled back objects", async () => {
    const a = await firstDevice();
    const { id } = await add(a.engine, a.vaultId, "Alt");
    const old = { ...stored(a.server, a.vaultId, id) };
    await a.engine.renameGroup(a.vaultId, id, "Neu");
    const b = await secondDevice(a.server);
    a.server.tamperChanges = (page) => {
      page.objects.push({ ...old, revision: page.vault_revision });
    };
    await b.engine.pull(a.vaultId);
    await b.engine.refresh();
    await b.engine.pull(a.vaultId);
    await expect(
      b.engine.destroy(a.vaultId, asGroup(id)),
    ).rejects.toMatchObject({
      code: "read_only",
    });
  });
});
