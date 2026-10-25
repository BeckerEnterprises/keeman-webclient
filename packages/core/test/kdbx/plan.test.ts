import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/crypto/bytes";
import {
  historyLimitOf,
  planKdbxImport,
  PLANNED_KEY,
  type KdbxImportOptions,
  type KdbxImportPlan,
  type KdbxPlannedObject,
} from "../../src/kdbx/plan";
import { iconHash } from "../../src/model/icon";
import { KEEPASS_ICONS } from "../../src/model/icons";
import { iconPng } from "../helpers";
import {
  hex,
  kdbxEntry,
  kdbxFile,
  kdbxGroup,
  kdbxState,
  readFixture,
  uuid,
} from "./helpers";

const USER = "0193ffff-0000-7000-8000-000000000001";
const NOW = "2026-10-24T12:00:00.000Z";
const ICON_A = "a".repeat(32);
const ICON_B = "b".repeat(32);
const ICON_C = "c".repeat(32);

function options(more: Partial<KdbxImportOptions> = {}): KdbxImportOptions {
  let n = 0;
  return {
    mode: "vault",
    name: "Imported",
    historyMaxItems: 10,
    emptyFieldName: "Feld",
    stamp: { now: NOW, userId: USER },
    newId: (label) =>
      `0193eeee-0000-7000-8000-${(n++).toString(16).padStart(12, "0")}${label === "" ? "x" : ""}`,
    attachmentMaxBytes: 52_428_800,
    ...more,
  };
}

function byTitle(plan: KdbxImportPlan, title: string): JsonObject {
  const found = plan.entries.find((e) => e.raw.title === title);
  if (found === undefined) throw new Error(`no entry ${title}`);
  return found.raw;
}

function groupNamed(plan: KdbxImportPlan, name: string): KdbxPlannedObject {
  const found = [plan.root, ...plan.groups].find((g) => g.raw.name === name);
  if (found === undefined) throw new Error(`no group ${name}`);
  return found;
}

function fieldsOf(raw: JsonObject) {
  return raw.fields as {
    id: string;
    name: string;
    value: string;
    protected: boolean;
  }[];
}

describe("planKdbxImport: fixtures", () => {
  it("plans the generated sample as a new vault", async () => {
    const plan = planKdbxImport(await readFixture("keeman-sample"), options());
    const sample = "01930001-0000-4000-8000-000000000001";
    expect(plan.root.id).toBe(sample);
    expect(plan.root.raw).toMatchObject({
      parentId: null,
      sortKey: "",
      name: "Sample",
    });
    expect(plan.meta).toMatchObject({
      name: "Imported",
      description: "Fantasy data for KeeMan tests",
      color: "#2563EB",
      rootGroupId: sample,
      recycleBinGroupId: "01930008-0000-4000-8000-000000000008",
      recycleBinEnabled: true,
      historyMaxItems: 100,
      modifiedBy: USER,
    });
    // Parents come first.
    const seen = new Set([plan.root.id]);
    for (const group of plan.groups) {
      expect(seen.has(String(group.raw.parentId))).toBe(true);
      seen.add(group.id);
    }
    for (const entry of plan.entries)
      expect(seen.has(String(entry.raw.parentId))).toBe(true);
    expect(plan.report).toMatchObject({ groups: 8, entries: 15, newIds: 0 });

    const root = byTitle(plan, "root web01");
    expect(root.otp).toBe(
      "otpauth://totp/root%20web01:root?secret=JBSWY3DPEHPK3PXP&issuer=root%20web01&algorithm=SHA256&digits=8&period=60",
    );
    expect(fieldsOf(root).map((f) => [f.name, f.protected])).toEqual([
      ["Host", false],
      ["SSH Passphrase", true],
    ]);
    const history = root.history as JsonObject[];
    expect(history.map((h) => h.password)).toEqual([
      "Hamster-3",
      "Hamster-2",
      "Hamster-1",
    ]);
    expect(history[0]).not.toHaveProperty("modifiedBy");
    expect(history[0]).toMatchObject({
      schema: 1,
      modified: "2026-01-25T09:00:00.000Z",
      attachments: [],
    });
    // Field IDs stay the same per name across states.
    expect(fieldsOf(history[2] ?? {}).map((f) => f.id)).toEqual(
      fieldsOf(root).map((f) => f.id),
    );
    expect(root).toMatchObject({
      seq: 1,
      modifiedBy: USER,
      created: "2026-01-10T09:00:00.000Z",
      icon: { type: "builtin", name: KEEPASS_ICONS[38] },
      tags: ["prod", "server"],
    });

    const robot = byTitle(plan, "Nordhost Panel");
    expect(robot.password).toBe("{REF:P@I:01930065000040008000000000000065}");

    expect(byTitle(plan, "Seed account").otp).toBe(
      "otpauth://totp/Seed%20account:seed%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=Seed%20account",
    );
    expect(byTitle(plan, "KeeOtp account").otp).toContain(
      "algorithm=SHA512&digits=8&period=45",
    );
    expect(byTitle(plan, "HOTP account").otp).toBe(
      "otpauth://hotp/x?secret=MFRGG&counter=3",
    );
    const steam = byTitle(plan, "Steam account");
    expect(steam.otp).toBeNull();
    expect(fieldsOf(steam).map((f) => f.name)).toEqual([
      "TOTP Seed",
      "TOTP Settings",
    ]);
    expect(byTitle(plan, "Hex account").otp).toContain(
      "secret=JBSWY3DPEHPK3PXP",
    );
    expect(byTitle(plan, "Base64 account").otp).toContain(
      "secret=JBSWY3DPEHPK3PXP",
    );
    expect(byTitle(plan, "UTF-8 account").otp).toContain(
      "secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );

    const odd = byTitle(plan, "Odd fields");
    expect(odd.notes).toBe("Line one\n\tindented line\nüñíçødé ✓");
    expect(odd.tags).toEqual(["a:b", "c", "d", "e"]);
    expect(fieldsOf(odd).map((f) => f.name)).toEqual([
      "Ticket",
      "Title (2)",
      "ticket (2)",
      "url (2)",
    ]);
    expect(byTitle(plan, "Expiring").expires).toBe("2026-11-30T08:00:00.000Z");

    expect(byTitle(plan, "Old entry").previousParentId).toBe(
      groupNamed(plan, "Mail").id,
    );
    expect(groupNamed(plan, "Old group").raw.previousParentId).toBe(
      groupNamed(plan, "Provider").id,
    );
    expect(groupNamed(plan, "Recycle Bin").raw).not.toHaveProperty(
      "previousParentId",
    );
    expect(byTitle(plan, "Older entry")).not.toHaveProperty("previousParentId");

    const kinds = plan.report.items.map((item) => item.kind);
    expect(kinds.filter((k) => k === "field_renamed")).toHaveLength(3);
    expect(plan.report.items).toContainEqual({
      kind: "otp_kept",
      path: ["Mail"],
      title: "HOTP account",
      problem: "hotp",
    });
    expect(plan.report.items).toContainEqual({
      kind: "otp_unconverted",
      path: ["Mail"],
      title: "Steam account",
      names: ["TOTP Seed", "TOTP Settings"],
    });
    expect(plan.report.items).toContainEqual({
      kind: "field_renamed",
      path: ["Mail"],
      title: "Odd fields",
      from: "url",
      to: "url (2)",
    });
  });

  it("plans the sample into a group: no meta, bin skipped, target history limit", async () => {
    const plan = planKdbxImport(
      await readFixture("keeman-sample"),
      options({ mode: "group", historyMaxItems: 2 }),
    );
    expect(plan.meta).toBeNull();
    expect(plan.root.raw.parentId).toBeNull();
    expect(plan.report.skippedBin).toEqual({ groups: 2, entries: 2 });
    expect(plan.report.groups).toBe(7);
    expect(plan.report.entries).toBe(13);
    expect(plan.entries.some((e) => e.raw.title === "Old entry")).toBe(false);
    expect((byTitle(plan, "root web01").history as unknown[]).length).toBe(2);
    expect(plan.report.items).toContainEqual({
      kind: "history_trimmed",
      path: ["Provider", "Nordhost", "web01"],
      title: "root web01",
      dropped: 1,
    });
  });

  it("plans the KeePassXC file: public colour, OTP URI, icon and attachments", async () => {
    const plan = planKdbxImport(
      await readFixture("keepassxc-example"),
      options(),
    );
    expect(plan.meta?.color).toBe("#2ec27e");
    expect(plan.meta?.historyMaxItems).toBe(10);
    const entry = byTitle(plan, "test");
    expect(entry.otp).toBe(
      "otpauth://totp/test:username?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=test",
    );
    expect(fieldsOf(entry).map((f) => [f.name, f.protected])).toEqual([
      ["field1-insecure", false],
      ["field2-secure", true],
    ]);
    expect(entry.expires).toMatch(/^2026-10-25T/);
    expect((entry.history as unknown[]).length).toBe(2);
    // Without a re-encoded icon from the app the custom icon is unreadable.
    expect(plan.report.items).toEqual(
      expect.arrayContaining([
        { kind: "custom_icon_unreadable", path: ["test"], title: "test" },
      ]),
    );
    // Both binaries become attachments, with placeholder keys until the upload.
    const planned = plan.entries.find((e) => e.raw.title === "test");
    expect(planned?.attachments).toHaveLength(2);
    expect(plan.report.attachments).toBeGreaterThanOrEqual(2);
    const elements = entry.attachments as Record<string, unknown>[];
    expect(elements).toHaveLength(2);
    for (const element of elements) {
      expect(element.key).toBe(PLANNED_KEY);
      expect(element.compression).toBe("none");
      const source = planned?.attachments?.find((a) => a.id === element.id);
      expect(element.size).toBe(plan.binaries[source?.binary ?? -1]?.length);
    }
    expect(plan.report.ignored.publicCustomData).toBe(3);
  });

  it("plans the KeePass 2 sample database", async () => {
    const plan = planKdbxImport(
      await readFixture("keepass-example"),
      options(),
    );
    expect(plan.meta).toMatchObject({
      color: "#FF00FF",
      recycleBinGroupId: null,
    });
    expect(plan.root.raw.icon).toEqual({
      type: "builtin",
      name: KEEPASS_ICONS[49],
    });
    expect(plan.groups.map((g) => g.raw.name)).toEqual([
      "General",
      "Windows",
      "Network",
      "Internet",
      "eMail",
      "Homebanking",
    ]);
    const keys = plan.groups.map((g) => String(g.raw.sortKey));
    expect([...keys].sort()).toEqual(keys);
    expect(byTitle(plan, "Sample Entry #2").password).toBe("12345");
  });
});

describe("planKdbxImport: rules", () => {
  it("gives null and repeated UUIDs new IDs; the first occurrence keeps its own", () => {
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [
          kdbxEntry(2, { Title: "first" }),
          kdbxEntry(2, { Title: "second" }),
          { ...kdbxEntry(0, { Title: "null" }), uuid: "0".repeat(32) },
        ],
        groups: [kdbxGroup(2, "same as entry"), kdbxGroup(1, "same as root")],
      }),
    );
    const plan = planKdbxImport(file, options());
    expect(plan.entries.map((e) => e.id)).toEqual([
      uuid(2),
      "0193eeee-0000-7000-8000-000000000000",
      "0193eeee-0000-7000-8000-000000000001",
    ]);
    expect(plan.groups.map((g) => g.id)).toEqual([
      "0193eeee-0000-7000-8000-000000000002",
      "0193eeee-0000-7000-8000-000000000003",
    ]);
    expect(plan.report.newIds).toBe(4);
  });

  it("applies the field name rules and the field limit", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 103; i++) many[`f${String(i)}`] = "v";
    const long = "x".repeat(130);
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [
          kdbxEntry(2, {
            Title: "names",
            " ": "empty",
            [long]: "long",
            OTP: "not a uri",
            otp: "garbage",
            Notes: "standard",
            notes: "custom",
            [`otp${"y".repeat(125)}`]: "fits",
          }),
          kdbxEntry(3, { Title: "many", ...many }),
        ],
      }),
    );
    const plan = planKdbxImport(file, options());
    const names = fieldsOf(byTitle(plan, "names")).map((f) => f.name);
    expect(names).toEqual([
      "Feld",
      "x".repeat(128),
      "OTP (2)",
      "otp (3)",
      "notes (2)",
      `otp${"y".repeat(125)}`,
    ]);
    expect(byTitle(plan, "names").notes).toBe("standard");
    expect(fieldsOf(byTitle(plan, "many"))).toHaveLength(100);
    expect(plan.report.items).toContainEqual({
      kind: "fields_skipped",
      path: [],
      title: "many",
      names: ["f100", "f101", "f102"],
    });
    expect(plan.report.items).toContainEqual({
      kind: "otp_unconverted",
      path: [],
      title: "names",
      names: ["otp"],
    });
  });

  it("shortens a suffixed name to 128 code points", () => {
    const name = `Title${"z".repeat(123)}`;
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [kdbxEntry(2, { Title: "t", [name]: "a", [`${name}!`]: "b" })],
      }),
    );
    const [, second] = fieldsOf(
      planKdbxImport(file, options()).entries[0]?.raw ?? {},
    );
    expect(Array.from(second?.name ?? "")).toHaveLength(128);
    expect(second?.name.endsWith(" (2)")).toBe(true);
  });

  it("cleans tags", () => {
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [
          kdbxEntry(
            2,
            { Title: "t" },
            {
              tags: [" a ", "", "A", "b", "c".repeat(130)],
            },
          ),
        ],
      }),
    );
    const plan = planKdbxImport(file, options());
    expect(plan.entries[0]?.raw.tags).toEqual(["a", "b", "c".repeat(128)]);
    expect(plan.report.items).toContainEqual({
      kind: "tags_truncated",
      path: [],
      title: "t",
    });
  });

  it("skips entries above 1 MiB and trims history to fit", () => {
    const big = "p".repeat(400 * 1024);
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [
          kdbxEntry(2, { Title: "huge", Notes: "n".repeat(1024 * 1024) }),
          kdbxEntry(
            3,
            { Title: "fat", Notes: big },
            {
              history: [
                kdbxState(3, { Notes: big }),
                kdbxState(3, { Notes: big }),
                kdbxState(3, { Notes: big }),
              ],
            },
          ),
        ],
      }),
    );
    const plan = planKdbxImport(file, options());
    expect(plan.entries.map((e) => e.raw.title)).toEqual(["fat"]);
    expect((byTitle(plan, "fat").history as unknown[]).length).toBe(1);
    expect(plan.report.items).toEqual(
      expect.arrayContaining([
        { kind: "entry_skipped", path: [], title: "huge" },
        { kind: "history_trimmed", path: [], title: "fat", dropped: 2 },
      ]),
    );
  });

  it("shortens group notes, giant names and the description", () => {
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        groups: [
          kdbxGroup(2, "notes", { notes: "n".repeat(70 * 1024) }),
          kdbxGroup(3, "g".repeat(70 * 1024)),
        ],
      }),
      { description: "d".repeat(20 * 1024) },
    );
    const plan = planKdbxImport(file, options());
    const notes = groupNamed(plan, "notes").raw;
    expect(JSON.stringify(notes).length).toBeLessThanOrEqual(64 * 1024);
    expect(String(notes.notes).length).toBeGreaterThan(60 * 1024);
    expect(Array.from(String(plan.groups[1]?.raw.name))).toHaveLength(256);
    expect(plan.report.descriptionTruncated).toBe(true);
    expect(JSON.stringify(plan.meta).length).toBeLessThanOrEqual(16 * 1024);
    expect(
      plan.report.items.filter((i) => i.kind === "group_truncated"),
    ).toHaveLength(2);
  });

  it("uses the import time for missing timestamps and maps icons", () => {
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        icon: null,
        customIcon: ICON_A,
        groups: [kdbxGroup(4, "odd icon", { icon: 99 })],
        entries: [
          kdbxEntry(
            2,
            { Title: "t" },
            {
              icon: 99,
              history: [
                kdbxState(
                  2,
                  { Title: "old" },
                  {
                    times: {
                      created: "2020-01-01T00:00:00.000Z",
                      modified: null,
                      expires: null,
                    },
                    customIcon: ICON_A,
                  },
                ),
              ],
            },
          ),
        ],
      }),
    );
    const plan = planKdbxImport(file, options());
    expect(plan.root.raw).toMatchObject({
      icon: null,
      created: NOW,
      modified: NOW,
    });
    expect(groupNamed(plan, "odd icon").raw.icon).toBeNull();
    const entry = byTitle(plan, "t");
    expect(entry).toMatchObject({ icon: null, created: NOW, modified: NOW });
    expect((entry.history as JsonObject[])[0]).toMatchObject({
      created: "2020-01-01T00:00:00.000Z",
    });
    expect((entry.history as JsonObject[])[0]).not.toHaveProperty("modified");
    expect(plan.report.items).toEqual(
      expect.arrayContaining([
        { kind: "custom_icon_unreadable", path: [], title: null },
        { kind: "custom_icon_unreadable", path: [], title: "t" },
      ]),
    );
  });

  it("resolves the recycle bin and previous parents only when they qualify", () => {
    const root = kdbxGroup(1, "Root", {
      groups: [
        kdbxGroup(2, "A"),
        kdbxGroup(3, "Bin", {
          groups: [
            kdbxGroup(4, "Inner", {
              previousParent: hex(3),
              entries: [
                kdbxEntry(
                  5,
                  { Title: "back to inner" },
                  { previousParent: hex(4) },
                ),
              ],
            }),
          ],
          entries: [
            kdbxEntry(6, { Title: "to A" }, { previousParent: hex(2) }),
            kdbxEntry(7, { Title: "to nowhere" }, { previousParent: hex(99) }),
          ],
        }),
      ],
      entries: [kdbxEntry(8, { Title: "outside" }, { previousParent: hex(2) })],
    });
    const plan = planKdbxImport(
      kdbxFile(root, { recycleBinUuid: hex(3) }),
      options(),
    );
    expect(plan.meta?.recycleBinGroupId).toBe(uuid(3));
    expect(byTitle(plan, "to A").previousParentId).toBe(uuid(2));
    expect(byTitle(plan, "to nowhere")).not.toHaveProperty("previousParentId");
    expect(byTitle(plan, "back to inner")).not.toHaveProperty(
      "previousParentId",
    );
    expect(groupNamed(plan, "Inner").raw).not.toHaveProperty(
      "previousParentId",
    );
    expect(byTitle(plan, "outside")).not.toHaveProperty("previousParentId");

    const missing = planKdbxImport(
      kdbxFile(kdbxGroup(1, "Root"), { recycleBinUuid: hex(9) }),
      options(),
    );
    expect(missing.meta?.recycleBinGroupId).toBeNull();
    const rootBin = planKdbxImport(
      kdbxFile(kdbxGroup(1, "Root"), { recycleBinUuid: hex(1) }),
      options(),
    );
    expect(rootBin.meta?.recycleBinGroupId).toBeNull();
  });

  it("takes only valid colours and limits historyMaxItems", () => {
    const plan = (meta: Parameters<typeof kdbxFile>[1]) =>
      planKdbxImport(kdbxFile(kdbxGroup(1, "Root"), meta), options()).meta;
    expect(plan({ color: "red", publicColor: "#123" })?.color).toBeNull();
    expect(plan({ color: "#abcdef" })?.color).toBe("#abcdef");
    expect(historyLimitOf(null)).toBe(10);
    expect(historyLimitOf(-1)).toBe(100);
    expect(historyLimitOf(-7)).toBe(100);
    expect(historyLimitOf(150)).toBe(100);
    expect(historyLimitOf(0)).toBe(0);
    expect(plan({ historyMaxItems: 5 })?.historyMaxItems).toBe(5);
  });
});

describe("custom icons in the import", () => {
  function file() {
    return kdbxFile(
      kdbxGroup(1, "Root", {
        customIcon: ICON_A,
        groups: [kdbxGroup(3, "Same bytes", { customIcon: ICON_B, icon: 3 })],
        entries: [
          kdbxEntry(
            2,
            { Title: "t" },
            {
              customIcon: ICON_C,
              icon: 1,
              history: [kdbxState(2, { Title: "old" }, { customIcon: ICON_A })],
            },
          ),
        ],
      }),
    );
  }

  it("plans each readable icon once, before the groups", () => {
    const named = file();
    named.customIcons = [
      { uuid: ICON_A, name: "Firma", data: new Uint8Array([1]) },
      { uuid: ICON_B, name: "", data: new Uint8Array([2]) },
    ];
    const plan = planKdbxImport(
      named,
      options({
        icons: new Map([
          [ICON_A, iconPng(1)],
          [ICON_B, iconPng(1)],
        ]),
      }),
    );
    // A and B have the same PNG: one icon; C could not be read.
    expect(plan.icons).toHaveLength(1);
    expect(plan.report.icons).toBe(1);
    const icon = plan.icons[0];
    expect(icon?.type).toBe("icon");
    expect(icon?.raw).toMatchObject({
      name: "Firma",
      mime: "image/png",
      hash: iconHash(iconPng(1)),
      source: { type: "kdbx" },
      created: NOW,
      modifiedBy: USER,
    });
    const ref = { type: "custom", id: icon?.id };
    expect(plan.root.raw.icon).toEqual(ref);
    expect(groupNamed(plan, "Same bytes").raw.icon).toEqual(ref);
    const entry = byTitle(plan, "t");
    // C is unreadable: the standard icon stands in.
    expect(entry.icon).toEqual({ type: "builtin", name: KEEPASS_ICONS[1] });
    expect((entry.history as JsonObject[])[0]?.icon).toEqual(ref);
    expect(plan.report.items).toEqual([
      { kind: "custom_icon_unreadable", path: [], title: "t" },
    ]);
  });

  it("uses an existing icon of the target with the same hash", () => {
    const existing = "0193dddd-0000-7000-8000-000000000001";
    const plan = planKdbxImport(
      file(),
      options({
        mode: "group",
        icons: new Map([
          [ICON_A, iconPng(5)],
          [ICON_B, iconPng(6)],
          [ICON_C, iconPng(5)],
        ]),
        existingIcons: new Map([[iconHash(iconPng(5)), existing]]),
      }),
    );
    expect(plan.icons).toHaveLength(1);
    expect(plan.root.raw.icon).toEqual({ type: "custom", id: existing });
    expect(byTitle(plan, "t").icon).toEqual({ type: "custom", id: existing });
    expect(groupNamed(plan, "Same bytes").raw.icon).toEqual({
      type: "custom",
      id: plan.icons[0]?.id,
    });
    expect(plan.report.items).toEqual([]);
  });

  it("brings only used icons from the sample, one of them broken", async () => {
    const file = await readFixture("keeman-sample");
    const red = "01930100000040008000000000000a01";
    const broken = "01930100000040008000000000000a03";
    expect(file.customIcons.map((i) => [i.uuid, i.name])).toEqual([
      [red, "Red square"],
      [broken, ""],
    ]);
    // The app could re-encode the red square, but not the broken one.
    const plan = planKdbxImport(
      file,
      options({ icons: new Map([[red, iconPng(11)]]) }),
    );
    expect(plan.icons).toHaveLength(1);
    expect(plan.icons[0]?.raw.name).toBe("Red square");
    const ref = { type: "custom", id: plan.icons[0]?.id };
    expect(groupNamed(plan, "Nordhost").raw.icon).toEqual(ref);
    const web01 = byTitle(plan, "root web01");
    expect(
      (web01.history as JsonObject[]).some(
        (h) => JSON.stringify(h.icon) === JSON.stringify(ref),
      ),
    ).toBe(true);
    expect(byTitle(plan, "Odd fields").icon).toEqual({
      type: "builtin",
      name: KEEPASS_ICONS[0],
    });
    expect(plan.report.items).toContainEqual({
      kind: "custom_icon_unreadable",
      path: ["Mail"],
      title: "Odd fields",
    });
  });

  it("ignores icons that are no icon PNG", () => {
    const plan = planKdbxImport(
      file(),
      options({ icons: new Map([[ICON_A, iconPng(1, 32, 32)]]) }),
    );
    expect(plan.icons).toEqual([]);
    expect(plan.root.raw.icon).toEqual({ type: "builtin", name: "folder" });
  });
});
