import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { toBase64Url } from "../../src/crypto/bytes";
import { iconHash } from "../../src/model/icon";
import { emptyDraft } from "../../src/model/entry";
import type { SyncEngine } from "../../src/sync/engine";
import { SyncError } from "../../src/sync/errors";
import { iconPng } from "../helpers";
import {
  firstDevice,
  flipped,
  rootOf,
  secondDevice,
  stored,
  vault,
} from "./devices";

const UPLOAD = { type: "upload" } as const;

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function iconCount(
  server: {
    vaults: Map<
      string,
      { objects: Map<string, { type: string; deleted: boolean }> }
    >;
  },
  vaultId: string,
): number {
  return [...(server.vaults.get(vaultId)?.objects.values() ?? [])].filter(
    (o) => o.type === "icon" && !o.deleted,
  ).length;
}

function edit(engine: SyncEngine, vaultId: string, id: string) {
  const result = engine.editEntry(vaultId, id);
  if (!result) throw new Error("entry missing");
  return result;
}

describe("icon library", () => {
  it("adds icons at once and reuses one with the same hash", async () => {
    const a = await firstDevice();
    const id = await a.engine.addIcon(a.vaultId, iconPng(1), "Eins", UPLOAD);
    expect(vault(a.engine, a.vaultId).icons.get(id)).toMatchObject({
      name: "Eins",
      hash: iconHash(iconPng(1)),
      source: { type: "upload" },
      used: false,
    });
    expect(iconCount(a.server, a.vaultId)).toBe(1);
    const revision = a.server.vaults.get(a.vaultId)?.revision;
    expect(await a.engine.addIcon(a.vaultId, iconPng(1), "Zwei", UPLOAD)).toBe(
      id,
    );
    expect(a.server.vaults.get(a.vaultId)?.revision).toBe(revision);
    const other = await a.engine.addIcon(a.vaultId, iconPng(2), "Zwei", {
      type: "favicon",
      origin: "https://www.example.com",
    });
    expect(other).not.toBe(id);
    expect(iconCount(a.server, a.vaultId)).toBe(2);

    const b = await secondDevice(a.server);
    expect(vault(b.engine, a.vaultId).icons.get(other)).toMatchObject({
      name: "Zwei",
      source: { type: "favicon", origin: "https://www.example.com" },
    });
    // The other device knows the icon and adds nothing.
    expect(await b.engine.addIcon(a.vaultId, iconPng(2), "x", UPLOAD)).toBe(
      other,
    );
    expect(iconCount(a.server, a.vaultId)).toBe(2);
  });

  it("refuses anything but an icon PNG", async () => {
    const a = await firstDevice();
    for (const png of [
      iconPng(1, 32, 32),
      new Uint8Array(4),
      new Uint8Array(40_000),
    ]) {
      const error = await rejected(
        a.engine.addIcon(a.vaultId, png, "x", UPLOAD),
      );
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).code).toBe("invalid_icon");
    }
    expect(iconCount(a.server, a.vaultId)).toBe(0);
  });

  it("shows custom icons on groups, entries and the vault", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const icon = await a.engine.addIcon(a.vaultId, iconPng(3), "Logo", UPLOAD);
    const custom = { type: "custom", id: icon } as const;
    const group = await a.engine.createGroup(a.vaultId, root, {
      name: "Kunden",
      icon: custom,
      defaultEntryIcon: custom,
    });
    const { id } = await a.engine.createEntry(a.vaultId, group.id, {
      ...emptyDraft(),
      title: "Mail",
    });
    await a.engine.updateVault(a.vaultId, { icon: custom });
    const b = await secondDevice(a.server);
    for (const engine of [a.engine, b.engine]) {
      const view = vault(engine, a.vaultId);
      expect(view.customIcon).toBe(icon);
      expect(view.tree.nodes.get(group.id)).toMatchObject({
        icon: "folder",
        customIcon: icon,
      });
      // The default entry icon was copied into the new entry.
      expect(view.entries.get(id)).toMatchObject({
        icon: "key-round",
        customIcon: icon,
      });
      expect(view.icons.get(icon)?.used).toBe(true);
    }
  });

  it("removes only unused icons, snapshots count", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const add = (seed: number) =>
      a.engine.addIcon(a.vaultId, iconPng(seed), String(seed), UPLOAD);
    const inSnapshot = await add(1);
    const inGroup = await add(2);
    const unused = await add(3);
    const inVault = await add(4);
    const ref = (id: string) => ({ type: "custom", id }) as const;
    await a.engine.createGroup(a.vaultId, root, {
      name: "G",
      defaultEntryIcon: ref(inGroup),
    });
    await a.engine.updateVault(a.vaultId, { icon: ref(inVault) });
    const { id } = await a.engine.createEntry(a.vaultId, root, {
      ...emptyDraft(),
      title: "Alt",
      icon: ref(inSnapshot),
    });
    const first = edit(a.engine, a.vaultId, id);
    await a.engine.saveEntry(first.base, {
      ...first.draft,
      title: "Neu",
      icon: { type: "builtin", name: "server" },
    });
    expect(vault(a.engine, a.vaultId).icons.get(inSnapshot)?.used).toBe(true);
    expect(vault(a.engine, a.vaultId).icons.get(unused)?.used).toBe(false);

    expect(await a.engine.removeUnusedIcons(a.vaultId)).toBe(1);
    expect([...vault(a.engine, a.vaultId).icons.keys()].sort()).toEqual(
      [inSnapshot, inGroup, inVault].sort(),
    );
    expect(stored(a.server, a.vaultId, unused).deleted).toBe(true);
    expect(await a.engine.removeUnusedIcons(a.vaultId)).toBe(0);
  });

  it("does not clean up while groups or entries are corrupt", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    await a.engine.addIcon(a.vaultId, iconPng(5), "x", UPLOAD);
    const group = await a.engine.createGroup(a.vaultId, root, { name: "G" });
    const object = stored(a.server, a.vaultId, group.id);
    object.data = flipped(object.data ?? "");
    const b = await secondDevice(a.server);
    // Changed on the server: read-only until the user accepts the state.
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      manifest: "mismatch",
      iconCleanup: "read_only",
    });
    await b.engine.acknowledgeManifest(a.vaultId);
    expect(vault(b.engine, a.vaultId).iconCleanup).toBe("corrupt");
    const error = await rejected(b.engine.removeUnusedIcons(a.vaultId));
    expect((error as SyncError).code).toBe("corrupt_objects");
    expect(iconCount(a.server, a.vaultId)).toBe(1);
  });
});

describe("favicons", () => {
  it("sends only the origin and checks the answer", async () => {
    const a = await firstDevice();
    const { png, origin } = await a.engine.favicon(
      " https://user:secret@www.Example.com/login?token=abc#top ",
    );
    expect(a.server.faviconRequests).toEqual(["https://www.example.com/"]);
    expect(png).toEqual(iconPng(42));
    expect(origin).toBe("https://www.example.com");
    await a.engine.favicon("example.org:8443/path");
    expect(a.server.faviconRequests.at(-1)).toBe("https://example.org:8443/");
  });

  it("refuses other schemes without asking the server", async () => {
    const a = await firstDevice();
    for (const url of [
      "ftp://example.com/",
      "mailto:a@example.com",
      "javascript:alert(1)",
      "",
      "https://",
    ]) {
      const error = await rejected(a.engine.favicon(url));
      expect((error as SyncError).code, url).toBe("invalid_url");
    }
    expect(a.server.faviconRequests).toEqual([]);
  });

  it("rejects answers that are no icon and passes on errors", async () => {
    const a = await firstDevice();
    a.server.favicon = () => ({
      status: 200,
      body: {
        mime: "image/png",
        data: toBase64Url(iconPng(1, 32, 32)),
        width: 64,
        height: 64,
        origin: "https://example.com",
      },
    });
    expect(
      ((await rejected(a.engine.favicon("https://example.com"))) as SyncError)
        .code,
    ).toBe("invalid_icon");
    a.server.favicon = () => ({
      status: 422,
      body: { code: "favicon_not_found" },
    });
    const error = await rejected(a.engine.favicon("https://example.com"));
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("favicon_not_found");
  });
});

describe("moving to another vault with custom icons", () => {
  const custom = (id: string) => ({ type: "custom", id }) as const;

  async function setup() {
    const a = await firstDevice();
    const other = await a.engine.createVault({
      name: "Zweite",
      rootName: "Zweite",
      recycleBinName: "Papierkorb",
    });
    return { ...a, other, otherRoot: rootOf(a.engine, other) };
  }

  it("copies the icons first and keeps their IDs", async () => {
    const a = await setup();
    const root = rootOf(a.engine, a.vaultId);
    const own = await a.engine.addIcon(a.vaultId, iconPng(1), "Eigen", UPLOAD);
    const old = await a.engine.addIcon(a.vaultId, iconPng(2), "Alt", UPLOAD);
    const groupIcon = await a.engine.addIcon(
      a.vaultId,
      iconPng(3),
      "G",
      UPLOAD,
    );
    const missing = "0192b3a4-5c6d-7e8f-9a0b-0000000000ff";
    const group = await a.engine.createGroup(a.vaultId, root, {
      name: "Kunden",
      icon: custom(groupIcon),
      defaultEntryIcon: custom(missing),
    });
    const { id } = await a.engine.createEntry(a.vaultId, group.id, {
      ...emptyDraft(),
      title: "Mail",
      icon: custom(old),
    });
    const opened = edit(a.engine, a.vaultId, id);
    await a.engine.saveEntry(opened.base, {
      ...opened.draft,
      title: "Mail 2",
      icon: custom(own),
    });
    await a.engine.move(a.vaultId, [{ kind: "group", id: group.id }], {
      vaultId: a.other,
      groupId: a.otherRoot,
    });
    const target = vault(a.engine, a.other);
    expect([...target.icons.keys()].sort()).toEqual(
      [own, old, groupIcon].sort(),
    );
    expect(target.icons.get(own)).toMatchObject({ name: "Eigen", used: true });
    expect(target.tree.nodes.get(group.id)).toMatchObject({
      customIcon: groupIcon,
      // A reference to a missing icon stays as it is.
      defaultEntryIcon: custom(missing),
    });
    expect(target.entries.get(id)?.customIcon).toBe(own);
    expect(a.engine.entry(a.other, id)?.history[0]?.values.customIcon).toBe(
      old,
    );
    expect(stored(a.server, a.other, own).revision).toBeGreaterThan(0);
    // The source keeps its library; the icons are unused there now.
    expect(vault(a.engine, a.vaultId).icons.get(own)?.used).toBe(false);
    expect(vault(a.engine, a.vaultId).tree.nodes.has(group.id)).toBe(false);
  });

  it("uses an icon with the same hash in the target", async () => {
    const a = await setup();
    const root = rootOf(a.engine, a.vaultId);
    const icon = await a.engine.addIcon(
      a.vaultId,
      iconPng(4),
      "Quelle",
      UPLOAD,
    );
    const there = await a.engine.addIcon(a.other, iconPng(4), "Ziel", UPLOAD);
    expect(there).not.toBe(icon);
    const { id } = await a.engine.createEntry(a.vaultId, root, {
      ...emptyDraft(),
      title: "Mail",
      icon: { ...custom(icon), keep: "unbekannt" } as unknown as ReturnType<
        typeof custom
      >,
    });
    await a.engine.move(a.vaultId, [{ kind: "entry", id }], {
      vaultId: a.other,
      groupId: a.otherRoot,
    });
    expect([...vault(a.engine, a.other).icons.keys()]).toEqual([there]);
    expect(vault(a.engine, a.other).entries.get(id)?.customIcon).toBe(there);
    const raw = a.engine.editEntry(a.other, id);
    expect(raw?.draft.icon).toEqual({ type: "custom", id: there });
  });

  it("gives a copy a new ID when the target knows it as deleted", async () => {
    const a = await setup();
    const root = rootOf(a.engine, a.vaultId);
    const icon = await a.engine.addIcon(a.vaultId, iconPng(5), "x", UPLOAD);
    const first = await a.engine.createEntry(a.vaultId, root, {
      ...emptyDraft(),
      title: "Eins",
      icon: custom(icon),
    });
    const second = await a.engine.createEntry(a.vaultId, root, {
      ...emptyDraft(),
      title: "Zwei",
      icon: custom(icon),
    });
    await a.engine.move(a.vaultId, [{ kind: "entry", id: first.id }], {
      vaultId: a.other,
      groupId: a.otherRoot,
    });
    expect(vault(a.engine, a.other).icons.has(icon)).toBe(true);
    await a.engine.destroy(a.other, [{ kind: "entry", id: first.id }]);
    expect(await a.engine.removeUnusedIcons(a.other)).toBe(1);
    await a.engine.move(a.vaultId, [{ kind: "entry", id: second.id }], {
      vaultId: a.other,
      groupId: a.otherRoot,
    });
    const target = vault(a.engine, a.other);
    const [copy] = [...target.icons.keys()];
    expect(copy).toBeDefined();
    expect(copy).not.toBe(icon);
    expect(target.entries.get(second.id)?.customIcon).toBe(copy);
  });

  it("deletes the copied icons when the move is rolled back", async () => {
    const a = await setup();
    const icon = await a.engine.addIcon(a.vaultId, iconPng(6), "x", UPLOAD);
    const id = a.engine.newEntryId();
    const staged = await a.engine.stageAttachment(a.vaultId, id, {
      name: "a",
      mime: "application/octet-stream",
      data: new Uint8Array([1, 2, 3]),
    });
    await a.engine.createEntry(
      a.vaultId,
      rootOf(a.engine, a.vaultId),
      {
        ...emptyDraft(),
        title: "Mit Anhang",
        icon: custom(icon),
        attachments: [staged.id],
      },
      id,
    );
    a.server.failures.set(
      `/v1/vaults/${a.vaultId}/attachments/${staged.id}/transfer`,
      [{ status: 507, code: "quota_exceeded" }],
    );
    const error = await rejected(
      a.engine.move(a.vaultId, [{ kind: "entry", id }], {
        vaultId: a.other,
        groupId: a.otherRoot,
      }),
    );
    expect((error as ApiError).code).toBe("quota_exceeded");
    expect(vault(a.engine, a.other).icons.size).toBe(0);
    expect(stored(a.server, a.other, icon).deleted).toBe(true);
    expect(vault(a.engine, a.vaultId).entries.get(id)?.customIcon).toBe(icon);
  });
});
