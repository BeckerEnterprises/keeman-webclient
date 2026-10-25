import { describe, expect, it } from "vitest";
import { emptyDraft, type EntryDraft } from "../../src/model/entry";
import type { SearchQuery } from "../../src/search/index";
import type { SyncEngine } from "../../src/sync/engine";
import { SyncError } from "../../src/sync/errors";
import {
  binOf,
  entryRef,
  firstDevice,
  groupRef,
  NAMES,
  rootOf,
  secondDevice,
  stored,
  vault,
} from "./devices";

function draft(extra: Partial<EntryDraft> = {}): EntryDraft {
  return { ...emptyDraft(), title: "Mail", ...extra };
}

function edit(engine: SyncEngine, vaultId: string, id: string) {
  const result = engine.editEntry(vaultId, id);
  if (!result) throw new Error("entry missing");
  return result;
}

describe("entries", () => {
  it("creates, edits and keeps a history that another device sees", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const group = await a.engine.createGroup(a.vaultId, root, {
      name: "Server",
      defaultEntryIcon: { type: "builtin", name: "server" },
    });
    const sub = await a.engine.createGroup(a.vaultId, group.id, {
      name: "Sub",
    });
    const { id } = await a.engine.createEntry(
      a.vaultId,
      sub.id,
      draft({ username: "root", tags: ["a"] }),
    );
    // The inherited default icon is copied into the entry.
    expect(vault(a.engine, a.vaultId).entries.get(id)).toMatchObject({
      icon: "server",
      title: "Mail",
      groupId: sub.id,
    });
    const first = edit(a.engine, a.vaultId, id);
    expect(first.draft).toMatchObject({
      title: "Mail",
      username: "root",
      icon: { type: "builtin", name: "server" },
    });
    expect((await a.engine.saveEntry(first.base, first.draft)).notices).toEqual(
      [],
    );
    expect(stored(a.server, a.vaultId, id).revision).toBe(
      a.server.vaults.get(a.vaultId)?.objects.get(id)?.revision,
    );
    const revision = stored(a.server, a.vaultId, id).revision;
    await a.engine.saveEntry(first.base, { ...first.draft, password: "neu" });
    expect(stored(a.server, a.vaultId, id).revision).toBeGreaterThan(revision);
    const b = await secondDevice(a.server);
    const detail = b.engine.entry(a.vaultId, id);
    expect(detail?.values.password).toBe("neu");
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0]).toMatchObject({
      changed: ["password"],
      restorable: true,
      conflict: false,
    });
    // Restore the first state.
    await b.engine.restoreHistory(a.vaultId, id, 0);
    await a.engine.pull(a.vaultId);
    const restored = a.engine.entry(a.vaultId, id);
    expect(restored?.values.password).toBe("");
    expect(restored?.history.map((h) => h.values.password)).toEqual([
      "neu",
      "",
    ]);
    expect((await a.engine.restoreHistory(a.vaultId, id, 1)).notices).toEqual(
      [],
    );
    await expect(
      a.engine.restoreHistory(a.vaultId, id, 9),
    ).rejects.toMatchObject({ code: "invalid_target" });
    await expect(
      a.engine.restoreHistory(a.vaultId, sub.id, 0),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks drafts, sizes and targets", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    await expect(
      a.engine.createEntry(a.vaultId, root, draft({ tags: ["a;b"] })),
    ).rejects.toMatchObject({ code: "invalid_entry" });
    await expect(
      a.engine.createEntry(
        a.vaultId,
        root,
        draft({ notes: "x".repeat(1024 * 1024) }),
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      a.engine.createEntry(a.vaultId, binOf(a.engine, a.vaultId), draft()),
    ).rejects.toMatchObject({ code: "invalid_target" });
    const { id } = await a.engine.createEntry(a.vaultId, root, draft());
    const e = edit(a.engine, a.vaultId, id);
    await expect(
      a.engine.saveEntry(e.base, {
        ...e.draft,
        fields: [{ name: "otp", value: "", protected: false }],
      }),
    ).rejects.toMatchObject({ code: "invalid_entry" });
    await expect(
      a.engine.saveEntry(e.base, {
        ...e.draft,
        notes: "y".repeat(1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(a.engine.editEntry(a.vaultId, root)).toBeUndefined();
  });

  it("merges conflicting edits per field and keeps the losing version", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const { id } = await a.engine.createEntry(
      a.vaultId,
      root,
      draft({ username: "u", password: "p" }),
    );
    const b = await secondDevice(a.server);
    // Different fields: both stay.
    const ea = edit(a.engine, a.vaultId, id);
    const eb = edit(b.engine, a.vaultId, id);
    await a.engine.saveEntry(ea.base, { ...ea.draft, username: "von A" });
    const merged = await b.engine.saveEntry(eb.base, {
      ...eb.draft,
      url: "https://b",
    });
    expect(merged.notices).toEqual([]);
    await a.engine.pull(a.vaultId);
    expect(a.engine.entry(a.vaultId, id)?.values).toMatchObject({
      username: "von A",
      url: "https://b",
    });
    // The same field: the server wins, the local version goes into the history.
    const ea2 = edit(a.engine, a.vaultId, id);
    const eb2 = edit(b.engine, a.vaultId, id);
    await a.engine.saveEntry(ea2.base, { ...ea2.draft, password: "A gewinnt" });
    const conflict = await b.engine.saveEntry(eb2.base, {
      ...eb2.draft,
      password: "B verliert",
      notes: "B",
    });
    expect(conflict.notices).toEqual([
      { kind: "entry_conflict", objectId: id, fields: ["password"] },
    ]);
    expect(JSON.stringify(conflict.notices)).not.toContain("verliert");
    await a.engine.pull(a.vaultId);
    const detail = a.engine.entry(a.vaultId, id);
    expect(detail?.values).toMatchObject({ password: "A gewinnt", notes: "B" });
    expect(detail?.history[0]).toMatchObject({ conflict: true });
    expect(detail?.history[0]?.values.password).toBe("B verliert");
    // Without room for a conflict snapshot nothing is written.
    await a.engine.updateVault(a.vaultId, { historyMaxItems: 0 });
    await b.engine.pull(a.vaultId);
    const ea3 = edit(a.engine, a.vaultId, id);
    const eb3 = edit(b.engine, a.vaultId, id);
    await a.engine.saveEntry(ea3.base, { ...ea3.draft, title: "A" });
    await expect(
      b.engine.saveEntry(eb3.base, { ...eb3.draft, title: "B" }),
    ).rejects.toMatchObject({ code: "conflict_unresolved" });
    await expect(
      a.engine.updateVault(a.vaultId, { historyMaxItems: 101 }),
    ).rejects.toBeInstanceOf(SyncError);
  });

  it("moves entries between vaults and reports a failed second phase", async () => {
    const a = await firstDevice();
    const target = await a.engine.createVault({ ...NAMES, name: "Ziel" });
    const { id } = await a.engine.createEntry(
      a.vaultId,
      rootOf(a.engine, a.vaultId),
      draft(),
    );
    const path = `/v1/vaults/${a.vaultId}/batch`;
    const failure = { status: 400, code: "validation_failed" };
    a.server.failures.set(path, [failure]);
    await expect(
      a.engine.move(a.vaultId, [entryRef(id)], {
        vaultId: target,
        groupId: rootOf(a.engine, target),
      }),
    ).rejects.toMatchObject({ code: "move_incomplete" });
    await a.engine.pull(target);
    // A duplicate instead of a loss.
    expect(vault(a.engine, target).entries.get(id)?.title).toBe("Mail");
    expect(vault(a.engine, a.vaultId).entries.get(id)?.title).toBe("Mail");
    await expect(
      a.engine.move(a.vaultId, [groupRef(rootOf(a.engine, a.vaultId))], {
        vaultId: target,
        groupId: rootOf(a.engine, target),
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });
});

describe("search", () => {
  it("finds entries by normalised terms in scope", async () => {
    const a = await firstDevice();
    const root = rootOf(a.engine, a.vaultId);
    const work = await a.engine.createGroup(a.vaultId, root, {
      name: "Arbeit",
    });
    const [mail, bank, gone] = await a.engine.createEntries(
      a.vaultId,
      work.id,
      [
        draft({ title: "Straße Mail", username: "jürgen", tags: ["Büro"] }),
        draft({
          title: "Bank",
          password: "strasse",
          fields: [
            { name: "Kunde", value: "Geheimzahl", protected: true },
            { name: "Filiale", value: "Café" },
          ].map((f) => ({ protected: false, ...f })),
        }),
        draft({ title: "Alt Mail" }),
      ],
    );
    const other = await a.engine.createVault({ ...NAMES, name: "Zwei" });
    const [elsewhere] = await a.engine.createEntries(
      other,
      rootOf(a.engine, other),
      [draft({ title: "Mail Zwei" })],
    );
    await a.engine.trash(a.vaultId, [entryRef(gone ?? "")], "Papierkorb");
    const query = (text: string, extra: Partial<SearchQuery> = {}) =>
      a.engine
        .search({
          text,
          scope: { kind: "all" },
          includeTrash: false,
          searchProtected: false,
          ...extra,
        })
        .map((e) => e.id)
        .sort();
    expect(query("STRASSE")).toEqual([mail]);
    expect(query("jurgen buro")).toEqual([mail]);
    expect(query("mail")).toEqual([mail, elsewhere].sort());
    expect(query("mail", { includeTrash: true })).toEqual(
      [mail, gone, elsewhere].sort(),
    );
    expect(
      query("mail", { scope: { kind: "vault", vaultId: a.vaultId } }),
    ).toEqual([mail]);
    expect(query("cafe filiale")).toEqual([bank]);
    expect(query("geheimzahl")).toEqual([]);
    expect(query("geheimzahl", { searchProtected: true })).toEqual([bank]);
    expect(query("kunde")).toEqual([bank]);
    expect(query("   ")).toEqual([]);
    expect(
      query("mail", {
        scope: {
          kind: "group",
          vaultId: a.vaultId,
          groupId: binOf(a.engine, a.vaultId),
        },
      }),
    ).toEqual([gone]);
    expect(
      query("mail", {
        scope: { kind: "group", vaultId: a.vaultId, groupId: root },
      }),
    ).toEqual([mail]);
  });
});
