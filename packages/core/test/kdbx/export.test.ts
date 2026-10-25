import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/crypto/bytes";
import {
  attachKdbxBinaries,
  buildKdbxExport,
  kdbxFileName,
  verifyKdbxExport,
  type KdbxExportSource,
} from "../../src/kdbx/export";
import { readKdbx } from "../../src/kdbx/file/read";
import { writeKdbx } from "../../src/kdbx/file/write";
import type {
  KdbxEntryFile,
  KdbxExportModel,
  KdbxFile,
  KdbxGroupFile,
} from "../../src/kdbx/types";
import { inspectEntry, type Entry } from "../../src/model/entry";
import { KEEPASS_ICONS } from "../../src/model/icons";
import { siblingOrder } from "../../src/model/sort-key";
import { buildTree } from "../../src/model/tree";
import {
  inspectGroup,
  type Group,
  type VaultMeta,
} from "../../src/model/vault";
import { rootOf, firstDevice } from "../sync/devices";
import { iconPng } from "../helpers";
import { arrayBufferOf, readFixture, utf8 } from "./helpers";

const TEXTS = { emptyFieldName: "Feld" };

async function roundTrip(model: KdbxExportModel): Promise<KdbxFile> {
  const bytes = await writeKdbx(model, utf8("export pw"));
  return readKdbx(arrayBufferOf(bytes), {
    password: utf8("export pw"),
    keyFile: null,
  });
}

function allEntries(group: KdbxGroupFile): KdbxEntryFile[] {
  return [...group.entries, ...group.groups.flatMap(allEntries)];
}

function allGroups(group: KdbxGroupFile): KdbxGroupFile[] {
  return [group, ...group.groups.flatMap(allGroups)];
}

function strings(entry: { strings: KdbxEntryFile["strings"] } | undefined) {
  return Object.fromEntries(
    (entry?.strings ?? []).map((s) => [s.key, s.value]),
  );
}

describe("KDBX export", () => {
  it("exports an imported sample that reads back the same and passes the self-check", async () => {
    const { engine } = await firstDevice();
    const original = await readFixture("keeman-sample");
    const job = await engine.prepareKdbxImport(
      original,
      { kind: "vault", name: "Sample" },
      TEXTS,
    );
    await job.run();
    const { model, report } = await engine.exportKdbx(job.vaultId ?? "");
    const file = await roundTrip(model);
    expect(verifyKdbxExport(model, file)).toBe(true);
    expect(report).toMatchObject({
      groups: 8,
      entries: 15,
      corrupt: 0,
      removedCharacters: 0,
      substituteRoot: false,
      items: [],
    });
    expect(file.meta).toMatchObject({
      name: "Sample",
      description: "Fantasy data for KeeMan tests",
      color: "#2563EB",
      historyMaxItems: 100,
      recycleBinUuid: "01930008000040008000000000000008",
    });
    // Same groups and entries with the same UUIDs and standard strings.
    const uuids = (root: KdbxGroupFile) =>
      [
        ...allGroups(root).map((g) => g.uuid),
        ...allEntries(root).map((e) => e.uuid),
      ].sort();
    expect(uuids(file.root)).toEqual(uuids(original.root));
    for (const entry of allEntries(original.root)) {
      const exported = allEntries(file.root).find((e) => e.uuid === entry.uuid);
      const before = strings(entry);
      const after = strings(exported);
      for (const key of ["Title", "UserName", "Password", "URL", "Notes"])
        expect(after[key], `${String(before.Title)} ${key}`).toBe(before[key]);
      expect(exported?.history.length).toBe(entry.history.length);
    }
    const web01 = allEntries(file.root).find(
      (e) => strings(e).Title === "root web01",
    );
    expect(strings(web01).otp).toBe(
      "otpauth://totp/root%20web01:root?secret=JBSWY3DPEHPK3PXP&issuer=root%20web01&algorithm=SHA256&digits=8&period=60",
    );
    expect(web01?.strings.find((s) => s.key === "otp")?.protected).toBe(true);
    expect(web01?.history.map((h) => strings(h).Password)).toEqual([
      "Hamster-1",
      "Hamster-2",
      "Hamster-3",
    ]);
    const odd = allEntries(file.root).find(
      (e) => strings(e).Title === "Odd fields",
    );
    expect(odd?.tags).toEqual(["a:b", "c", "d", "e"]);
    expect(strings(odd).Notes).toBe("Line one\n\tindented line\nüñíçødé ✓");
  });

  it("exports the KeePassXC entry with its protection and reports attachments", async () => {
    const { engine, vaultId } = await firstDevice();
    const job = await engine.prepareKdbxImport(
      await readFixture("keepassxc-example"),
      { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
      TEXTS,
    );
    await job.run();
    const { model, report } = await engine.exportKdbx(vaultId);
    const file = await roundTrip(model);
    expect(verifyKdbxExport(model, file)).toBe(true);
    const entry = allEntries(file.root).find(
      (e) => strings(e).Title === "test",
    );
    expect(entry?.strings.map((s) => [s.key, s.protected])).toEqual([
      ["Title", false],
      ["UserName", false],
      ["Password", true],
      ["URL", false],
      ["Notes", false],
      ["otp", true],
      ["field1-insecure", false],
      ["field2-secure", true],
    ]);
    expect(report.items).toEqual([]);
    // Attachments were not imported, so nothing is lost here.
    expect(file.root.groups.map((g) => g.name)).toEqual(["Papierkorb", "Root"]);
  });

  it("exports custom icons and reads them back", async () => {
    const { engine, vaultId } = await firstDevice();
    const original = await readFixture("keepassxc-example");
    expect(original.customIcons).toHaveLength(1);
    const uuid = original.customIcons[0]?.uuid ?? "";
    const job = await engine.prepareKdbxImport(
      original,
      { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
      { ...TEXTS, icons: new Map([[uuid, iconPng(7)]]) },
    );
    expect(job.report.icons).toBe(1);
    expect(
      job.report.items.some((i) => i.kind === "custom_icon_unreadable"),
    ).toBe(false);
    await job.run();
    const { model, report } = await engine.exportKdbx(vaultId);
    expect(report.items).toEqual([]);
    expect(model.customIcons).toHaveLength(1);
    const file = await roundTrip(model);
    expect(verifyKdbxExport(model, file)).toBe(true);
    expect(file.customIcons).toHaveLength(1);
    expect(file.customIcons[0]?.data).toEqual(iconPng(7));
    const entry = allEntries(file.root).find(
      (e) => strings(e).Title === "test",
    );
    expect(entry?.customIcon).toBe(file.customIcons[0]?.uuid);
    expect(entry?.icon).toBe(0);
    // The self-check notices a missing or different icon.
    const changed = structuredClone(file);
    changed.customIcons = [];
    expect(verifyKdbxExport(model, changed)).toBe(false);
    const other = structuredClone(file);
    if (other.customIcons[0]) other.customIcons[0].data = iconPng(8);
    expect(verifyKdbxExport(model, other)).toBe(false);
  });

  it("detects a file that differs from the model", async () => {
    const { engine, vaultId } = await firstDevice();
    const { model } = await engine.exportKdbx(vaultId);
    const file = await roundTrip(model);
    expect(verifyKdbxExport(model, file)).toBe(true);
    const changed = structuredClone(file);
    changed.root.name = "other";
    expect(verifyKdbxExport(model, changed)).toBe(false);
    const meta = structuredClone(file);
    meta.meta.color = "#000000";
    expect(verifyKdbxExport(model, meta)).toBe(false);
    const header = structuredClone(file);
    header.header.version = "4.1";
    expect(verifyKdbxExport(model, header)).toBe(false);
  });
});

const USER = "0193ffff-0000-7000-8000-000000000001";
const ROOT = "0193000d-0000-4000-8000-000000000001";
const BIN = "0193000d-0000-4000-8000-000000000002";
const SUB = "0193000d-0000-4000-8000-000000000003";

function sourceOf(
  raws: Record<string, JsonObject>,
  meta: Partial<VaultMeta> = {},
  icons: Record<string, Uint8Array> = {},
): KdbxExportSource {
  const groups = new Map<string, Group>();
  const entries = new Map<string, Entry>();
  for (const [id, raw] of Object.entries(raws)) {
    if ("title" in raw) {
      const inspected = inspectEntry(raw);
      if (inspected.status === "ok") entries.set(id, inspected.value);
    } else {
      const inspected = inspectGroup(raw);
      if (inspected.status === "ok") groups.set(id, inspected.value);
    }
  }
  const vaultMeta: VaultMeta = {
    name: "Vault",
    description: "",
    icon: { type: "builtin", name: "database" },
    color: null,
    rootGroupId: ROOT,
    recycleBinGroupId: BIN,
    recycleBinEnabled: true,
    historyMaxItems: 10,
    ...meta,
  };
  const layout = buildTree({
    rootId: vaultMeta.rootGroupId,
    binId: vaultMeta.recycleBinGroupId,
    fallbackRootId: "0193000d-0000-4000-8000-0000000000ff",
    groups: new Map(
      [...groups].map(([id, g]) => [
        id,
        {
          id,
          parentId: g.parentId,
          sortKey: g.sortKey,
          name: g.name,
          modified: undefined,
        },
      ]),
    ),
    entries: new Map(
      [...entries].map(([id, e]) => [
        id,
        { id, parentId: e.parentId, sortKey: e.sortKey, title: e.title },
      ]),
    ),
    order: siblingOrder(new Intl.Collator("de", { numeric: true })),
  });
  const times = { created: null, modified: null, expires: null };
  return {
    meta: vaultMeta,
    layout,
    group: (id) => {
      const value = groups.get(id);
      return value && { value, times };
    },
    entry: (id) => {
      const value = entries.get(id);
      return value && { value, times };
    },
    icon: (id) => icons[id],
    corrupt: 2,
    newId: () => "0193000d-0000-7000-8000-0000000000aa",
  };
}

function group(
  parentId: string | null,
  name: string,
  more: JsonObject = {},
): JsonObject {
  return { schema: 1, seq: 1, parentId, sortKey: "a0", name, ...more };
}

function entry(parentId: string, more: JsonObject): JsonObject {
  return {
    schema: 1,
    seq: 1,
    parentId,
    sortKey: "a0",
    title: "t",
    modifiedBy: USER,
    ...more,
  };
}

describe("buildKdbxExport rules", () => {
  it("renames colliding fields, cleans text and converts references", () => {
    const source = sourceOf({
      [ROOT]: group(null, "Root\u0001", { notes: "a\r\nb\rc" }),
      [BIN]: group(ROOT, "Bin", { icon: { type: "builtin", name: "trash-2" } }),
      e1: entry(ROOT, {
        title: "fields",
        password: `{REF:P@I:${SUB}}`,
        notes: `see {REF:U@I:${SUB}} ￾`,
        otp: "otpauth://totp/x?secret=MFRGG",
        tags: ["a,b", " ", "c;d\te"],
        fields: [
          {
            id: "0193000d-0000-4000-8000-0000000000f1",
            name: "Title",
            value: "x",
          },
          {
            id: "0193000d-0000-4000-8000-0000000000f2",
            name: "otp",
            value: "y",
          },
          {
            id: "0193000d-0000-4000-8000-0000000000f3",
            name: "Host",
            value: "1",
          },
          {
            id: "0193000d-0000-4000-8000-0000000000f4",
            name: "Host",
            value: "2",
          },
          {
            id: "0193000d-0000-4000-8000-0000000000f5",
            name: "",
            value: "3",
            protected: true,
          },
        ],
      }),
    });
    const { model, report } = buildKdbxExport(source);
    expect(model.root.name).toBe("Root");
    expect(model.root.notes).toBe("a\nb\nc");
    expect(model.meta.recycleBinUuid).toBe(BIN.replaceAll("-", ""));
    expect(model.root.groups[0]?.icon).toBe(KEEPASS_ICONS.indexOf("trash-2"));
    const [first] = model.root.entries;
    const hex = SUB.replaceAll("-", "").toUpperCase();
    expect(first?.strings).toEqual([
      { key: "Title", value: "fields", protected: false },
      { key: "UserName", value: "", protected: false },
      { key: "Password", value: `{REF:P@I:${hex}}`, protected: true },
      { key: "URL", value: "", protected: false },
      { key: "Notes", value: `see {REF:U@I:${hex}} `, protected: false },
      { key: "otp", value: "otpauth://totp/x?secret=MFRGG", protected: true },
      { key: "Title (2)", value: "x", protected: false },
      { key: "otp (2)", value: "y", protected: false },
      { key: "Host", value: "1", protected: false },
      { key: "Host (2)", value: "2", protected: false },
      { key: " (2)", value: "3", protected: true },
    ]);
    expect(first?.tags).toEqual(["a_b", "c_d_e"]);
    expect(report.removedCharacters).toBe(2);
    expect(report.corrupt).toBe(2);
    expect(report.items.filter((i) => i.kind === "field_renamed")).toHaveLength(
      4,
    );
  });

  it("resolves icons through the group chain and falls back to defaults", () => {
    const source = sourceOf({
      [ROOT]: group(null, "Root", {
        defaultEntryIcon: { type: "builtin", name: "server" },
        icon: { type: "builtin", name: "no-such-icon" },
      }),
      [SUB]: group(ROOT, "Sub", { icon: { type: "custom", id: ROOT } }),
      e1: entry(SUB, { title: "inherits", icon: null }),
      e2: entry(SUB, {
        title: "unknown",
        icon: { type: "builtin", name: "no-such-icon" },
      }),
      e3: entry(ROOT, { title: "custom", icon: { type: "custom", id: ROOT } }),
    });
    const { model, report } = buildKdbxExport(source);
    expect(model.root.icon).toBe(48);
    expect(model.root.groups[0]?.icon).toBe(48);
    const [inherits, unknown] = model.root.groups[0]?.entries ?? [];
    expect(inherits?.icon).toBe(KEEPASS_ICONS.indexOf("server"));
    expect(unknown?.icon).toBe(0);
    // A missing custom icon exports the default icon, with a report line.
    expect(model.root.entries[0]).toMatchObject({ icon: 0, customIcon: null });
    expect(model.root.groups[0]?.customIcon).toBeNull();
    expect(model.customIcons).toEqual([]);
    expect(report.items).toHaveLength(2);
    expect(report.items).toEqual(
      expect.arrayContaining([
        { kind: "custom_icon_missing", path: [], title: "custom" },
        { kind: "custom_icon_missing", path: ["Sub"], title: null },
      ]),
    );
    expect(model.meta.recycleBinUuid).toBeNull();
  });

  it("exports custom icons once with their ID as UUID", () => {
    const ICON = "0193000d-0000-4000-8000-0000000000c1";
    const ref = { type: "custom", id: ICON };
    const source = sourceOf(
      {
        [ROOT]: group(null, "Root", { defaultEntryIcon: ref }),
        [SUB]: group(ROOT, "Sub", { icon: ref }),
        e1: entry(SUB, {
          title: "inherits",
          icon: null,
          history: [{ schema: 1, title: "alt", icon: ref }],
        }),
        e2: entry(ROOT, { title: "own", icon: ref }),
      },
      {},
      { [ICON]: iconPng(3) },
    );
    const { model, report } = buildKdbxExport(source);
    const uuid = ICON.replaceAll("-", "");
    expect(model.customIcons).toEqual([{ uuid, data: iconPng(3) }]);
    expect(model.root.groups[0]).toMatchObject({ icon: 48, customIcon: uuid });
    const inherits = model.root.groups[0]?.entries[0];
    expect(inherits).toMatchObject({ icon: 0, customIcon: uuid });
    expect(inherits?.history[0]).toMatchObject({ icon: 0, customIcon: uuid });
    expect(model.root.entries[0]).toMatchObject({ customIcon: uuid });
    expect(report.items).toEqual([]);
  });

  it("writes history oldest first, skips unreadable snapshots, collects attachments", () => {
    const attachment = {
      id: "0193000d-0000-4000-8000-0000000000c1",
      name: "a.txt",
      mime: "text/plain",
      size: 1,
      key: "A".repeat(43),
      compression: "none",
    };
    const source = sourceOf({
      [ROOT]: group(null, "Root"),
      e1: entry(ROOT, {
        title: "history",
        password: "now",
        history: [
          {
            schema: 1,
            password: "newer",
            modified: "2026-02-01T00:00:00.000Z",
            conflict: true,
          },
          "unreadable",
          { schema: 1, password: "older", attachments: [attachment] },
        ],
      }),
    });
    const { model, report, attachments } = buildKdbxExport(source);
    const [item] = model.root.entries;
    expect(
      item?.history.map(
        (h) => h.strings.find((s) => s.key === "Password")?.value,
      ),
    ).toEqual(["older", "newer"]);
    expect(item?.history[1]?.times.modified).toBe("2026-02-01T00:00:00.000Z");
    expect(report.items).toEqual([
      { kind: "snapshots_skipped", path: [], title: "history", count: 1 },
    ]);
    expect(attachments).toEqual([
      {
        entryId: "e1",
        attachmentId: attachment.id,
        path: [],
        title: "history",
        name: "a.txt",
      },
    ]);
    expect(item?.history[0]?.attachments).toEqual([
      { name: "a.txt", binary: 0 },
    ]);
    expect(model.binaries).toEqual([]);
  });

  it("adds downloaded attachments and drops unreadable ones", () => {
    const element = (id: string, name: string) => ({
      id,
      name,
      mime: "text/plain",
      size: 1,
      key: "A".repeat(43),
      compression: "none",
    });
    const a = "0193000d-0000-4000-8000-0000000000a1";
    const b = "0193000d-0000-4000-8000-0000000000b1";
    const source = sourceOf({
      [ROOT]: group(null, "Root"),
      e1: entry(ROOT, {
        title: "files",
        attachments: [element(a, "x.txt"), element(b, "x.txt")],
        history: [{ schema: 1, attachments: [element(b, "y.txt")] }],
      }),
    });
    const built = buildKdbxExport(source);
    const [item] = built.model.root.entries;
    // Names are unique per state in KDBX.
    expect(item?.attachments.map((r) => r.name)).toEqual([
      "x.txt",
      "x.txt (2)",
    ]);
    expect(built.report.items).toContainEqual({
      kind: "attachment_renamed",
      path: [],
      title: "files",
      from: "x.txt",
      to: "x.txt (2)",
    });
    attachKdbxBinaries(
      built.model,
      built.report,
      built.attachments,
      built.attachments.map((x) =>
        x.attachmentId === a ? undefined : Uint8Array.from([7]),
      ),
    );
    expect(built.model.binaries).toEqual([Uint8Array.from([7])]);
    expect(item?.attachments).toEqual([{ name: "x.txt (2)", binary: 0 }]);
    expect(item?.history[0]?.attachments).toEqual([
      { name: "y.txt", binary: 0 },
    ]);
    expect(built.report.items).toContainEqual({
      kind: "attachment_unreadable",
      path: [],
      title: "files",
      name: "x.txt",
    });
  });

  it("writes a stand-in root when the root group is missing", () => {
    const source = sourceOf(
      {
        [SUB]: group(ROOT, "Orphan"),
        e1: entry(ROOT, { title: "below the missing root" }),
      },
      { name: "Vault name" },
    );
    const { model, report } = buildKdbxExport(source);
    expect(report.substituteRoot).toBe(true);
    expect(model.root).toMatchObject({
      uuid: "0193000d0000700080000000000000aa",
      name: "Vault name",
    });
    expect(model.root.groups.map((g) => g.name)).toEqual(["Orphan"]);
    expect(model.root.entries).toHaveLength(1);
  });
});

describe("kdbxFileName", () => {
  const day = new Date(2026, 9, 4, 23, 59);
  it.each([
    ["Persönlich", "Persönlich-2026-10-04.kdbx"],
    ['a/b\\c:d*e?f"g<h>i|j\u0007', "a_b_c_d_e_f_g_h_i_j_-2026-10-04.kdbx"],
    ["  .Hidden name. ", "Hidden name-2026-10-04.kdbx"],
    ["", "KeeMan-2026-10-04.kdbx"],
    ["...", "KeeMan-2026-10-04.kdbx"],
    ["x".repeat(120), `${"x".repeat(100)}-2026-10-04.kdbx`],
    [`${"y".repeat(99)} z`, `${"y".repeat(99)}-2026-10-04.kdbx`],
  ])("%j → %s", (name, expected) => {
    expect(kdbxFileName(name, day)).toBe(expected);
  });
});
