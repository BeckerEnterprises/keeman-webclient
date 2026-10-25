/**
 * keepassxc-cli as an independent check: it reads our fixtures and
 * our exports. Skipped without KeePassXC unless KEEMAN_REQUIRE_KEEPASSXC=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import * as kdbxweb from "kdbxweb";
import { afterAll, describe, expect, it } from "vitest";
import { writeKdbx } from "../../src/kdbx/file/write";
import type { KdbxExportModel, KdbxGroupFile } from "../../src/kdbx/types";
import { totpFromUri } from "../../src/totp/code";
import { firstDevice, rootOf } from "../sync/devices";
import { FIXTURES, readFixture, utf8, type FixtureName } from "./helpers";

const available =
  spawnSync("keepassxc-cli", ["--version"], { encoding: "utf8" }).status === 0;
const required = process.env.KEEMAN_REQUIRE_KEEPASSXC === "1";
const ENV = { ...process.env, LANGUAGE: "en", LC_ALL: "C.UTF-8" };

const dir = mkdtempSync(join(tmpdir(), "keeman-kdbx-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[], password: string): string {
  const result = spawnSync("keepassxc-cli", [...args], {
    input: `${password}\n`,
    encoding: "utf8",
    env: ENV,
  });
  if (result.status !== 0)
    throw new Error(`keepassxc-cli ${args[0] ?? ""} failed`);
  return result.stdout;
}

interface XmlEntry {
  uuid: string;
  strings: { key: string; value: string; protected: boolean }[];
  tags: string;
  history: XmlEntry[];
}

interface XmlGroup {
  uuid: string;
  name: string;
  notes: string;
  groups: XmlGroup[];
  entries: XmlEntry[];
}

/** The DOM members used here; the core has no DOM types. */
interface XmlNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<XmlNode>;
  getAttribute(name: string): string | null;
}

function children(node: XmlNode, name: string): XmlNode[] {
  return Array.from(node.childNodes).filter(
    (child) => child.nodeType === 1 && child.nodeName === name,
  );
}

function text(node: XmlNode, name: string): string {
  return children(node, name)[0]?.textContent ?? "";
}

function hexOf(base64: string): string {
  return kdbxweb.ByteUtils.bytesToHex(kdbxweb.ByteUtils.base64ToBytes(base64));
}

function xmlEntry(node: XmlNode): XmlEntry {
  return {
    uuid: hexOf(text(node, "UUID")),
    strings: children(node, "String").map((item) => {
      const value = children(item, "Value")[0];
      return {
        key: text(item, "Key"),
        value: value?.textContent ?? "",
        protected: value?.getAttribute("ProtectInMemory") === "True",
      };
    }),
    tags: text(node, "Tags"),
    history: children(node, "History").flatMap((history) =>
      children(history, "Entry").map(xmlEntry),
    ),
  };
}

function xmlGroup(node: XmlNode): XmlGroup {
  return {
    uuid: hexOf(text(node, "UUID")),
    name: text(node, "Name"),
    notes: text(node, "Notes"),
    groups: children(node, "Group").map(xmlGroup),
    entries: children(node, "Entry").map(xmlEntry),
  };
}

function keepassxcXml(path: string, password: string): XmlNode {
  const xml = cli(["export", "-q", "-f", "xml", path], password);
  return (
    kdbxweb.XmlUtils.parse(xml) as unknown as { documentElement: XmlNode }
  ).documentElement;
}

/** Custom icons and the UUIDs entries use, as keepassxc-cli exports them. */
function keepassxcIcons(path: string, password: string) {
  const doc = keepassxcXml(path, password);
  const meta = children(doc, "Meta")[0];
  const icons = (meta ? children(meta, "CustomIcons") : []).flatMap((list) =>
    children(list, "Icon").map((icon) => ({
      uuid: hexOf(text(icon, "UUID")),
      data: kdbxweb.ByteUtils.base64ToBytes(text(icon, "Data")),
    })),
  );
  const used: string[] = [];
  const walk = (node: XmlNode) => {
    for (const child of Array.from(node.childNodes))
      if (child.nodeType === 1) {
        if (child.nodeName === "CustomIconUUID")
          used.push(hexOf(child.textContent ?? ""));
        else walk(child);
      }
  };
  for (const root of children(doc, "Root")) walk(root);
  return { icons, used };
}

/** A decodable 64 × 64 PNG in one colour, built by hand (no canvas here). */
function solidPng(rgba: [number, number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(64).fill(rgba).flat()),
  ]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
}

/** The root group as keepassxc-cli exports it. */
function keepassxcRoot(path: string, password: string): XmlGroup {
  const doc = { documentElement: keepassxcXml(path, password) };
  const root = children(doc.documentElement, "Root")[0];
  const group = root && children(root, "Group")[0];
  if (!group) throw new Error("no root group");
  return xmlGroup(group);
}

type Comparable = Pick<KdbxGroupFile, "uuid" | "name" | "notes"> & {
  groups: Comparable[];
  entries: {
    uuid: string;
    strings: { key: string; value: string; protected: boolean }[];
    tags: string[];
    history: {
      strings: { key: string; value: string; protected: boolean }[];
    }[];
  }[];
};

/** Same tree, strings, protection, tags and history as KeePassXC sees it. */
function expectSame(ours: Comparable, theirs: XmlGroup): void {
  expect(theirs.uuid).toBe(ours.uuid);
  expect(theirs.name).toBe(ours.name);
  expect(theirs.notes).toBe(ours.notes);
  expect(theirs.groups.map((g) => g.uuid)).toEqual(
    ours.groups.map((g) => g.uuid),
  );
  ours.groups.forEach((group, i) => {
    const other = theirs.groups[i];
    if (other) expectSame(group, other);
  });
  expect(theirs.entries.map((e) => e.uuid)).toEqual(
    ours.entries.map((e) => e.uuid),
  );
  // KeePassXC writes empty standard strings that KeePass 2 leaves out.
  const STANDARD = ["Title", "UserName", "Password", "URL", "Notes"];
  const sorted = (list: { key: string; value: string }[]) =>
    list
      .filter((item) => item.value !== "" || !STANDARD.includes(item.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  ours.entries.forEach((entry, i) => {
    const other = theirs.entries[i];
    expect(sorted(other?.strings ?? [])).toEqual(sorted(entry.strings));
    expect(other?.tags.split(/[,;]/).filter((t) => t !== "")).toEqual(
      entry.tags,
    );
    expect(other?.history.length).toBe(entry.history.length);
    entry.history.forEach((state, j) => {
      expect(sorted(other?.history[j]?.strings ?? [])).toEqual(
        sorted(state.strings),
      );
    });
  });
}

if (required && !available)
  throw new Error("KEEMAN_REQUIRE_KEEPASSXC=1, but keepassxc-cli is missing");

describe.skipIf(!available)("keepassxc-cli as independent check", () => {
  it.each<FixtureName>([
    "keepass-example",
    "keepassxc-example",
    "keeman-sample",
  ])("reads %s like we do", async (name) => {
    const ours = await readFixture(name);
    const theirs = keepassxcRoot(
      fileURLToPath(new URL(`${name}.kdbx`, FIXTURES)),
      "test",
    );
    expectSame(ours.root, theirs);
  });

  it("opens our export: AES-256, Argon2id 64 MiB, same content", async () => {
    const { engine, vaultId } = await firstDevice();
    await (
      await engine.prepareKdbxImport(
        await readFixture("keeman-sample"),
        { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
        { emptyFieldName: "Feld" },
      )
    ).run();
    const { model } = await engine.exportKdbx(vaultId);
    const path = join(dir, "export.kdbx");
    writeFileSync(path, await writeKdbx(model, utf8("Export-Passwort 1")));
    const info = cli(["db-info", "-q", path], "Export-Passwort 1");
    expect(info).toContain("Cipher: AES 256-bit");
    expect(info).toMatch(/KDF: Argon2id \(3 rounds, 65536 KB\)/);
    expect(info).toContain("Recycle bin is enabled.");
    expectSame(model.root, keepassxcRoot(path, "Export-Passwort 1"));
  });

  it("reads the attachments of our export byte for byte", async () => {
    const { engine, vaultId } = await firstDevice();
    const source = await readFixture("keepassxc-example");
    await (
      await engine.prepareKdbxImport(
        source,
        { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
        { emptyFieldName: "Feld" },
      )
    ).run();
    const { model, report } = await engine.exportKdbx(vaultId);
    expect(report.items.filter((i) => i.kind.startsWith("attachment"))).toEqual(
      [],
    );
    const path = join(dir, "attachments.kdbx");
    writeFileSync(path, await writeKdbx(model, utf8("Anhang-Passwort 1")));
    const group = source.root.groups.find((g) => g.name === "test");
    const entry = group?.entries.find((e) =>
      e.strings.some((s) => s.key === "Title" && s.value === "test"),
    );
    expect(entry?.attachments.length).toBe(2);
    for (const attachment of entry?.attachments ?? []) {
      const out = join(dir, `out-${attachment.name}`);
      // The import put the KDBX root below the vault root, under its name.
      cli(
        [
          "attachment-export",
          "-q",
          path,
          `${source.root.name}/test/test`,
          attachment.name,
          out,
        ],
        "Anhang-Passwort 1",
      );
      expect(new Uint8Array(readFileSync(out))).toEqual(
        source.binaries[attachment.binary],
      );
    }
  });

  it("keeps the custom icons of our export", async () => {
    const { engine, vaultId } = await firstDevice();
    const source = await readFixture("keepassxc-example");
    const png = solidPng([220, 38, 38, 255]);
    await (
      await engine.prepareKdbxImport(
        source,
        { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
        {
          emptyFieldName: "Feld",
          icons: new Map(source.customIcons.map((icon) => [icon.uuid, png])),
        },
      )
    ).run();
    const { model, report } = await engine.exportKdbx(vaultId);
    expect(report.items).toEqual([]);
    expect(model.customIcons).toHaveLength(1);
    const path = join(dir, "icons.kdbx");
    writeFileSync(path, await writeKdbx(model, utf8("Icon-Passwort 1")));
    const { icons, used } = keepassxcIcons(path, "Icon-Passwort 1");
    expect(icons).toEqual([{ uuid: model.customIcons[0]?.uuid, data: png }]);
    expect(new Set(used)).toEqual(new Set([model.customIcons[0]?.uuid]));
  });

  it("shows the same TOTP codes as we compute", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // RFC 6238 seed
    const variants = [
      "secret=JBSWY3DPEHPK3PXP",
      `secret=${secret}&algorithm=SHA256&digits=8`,
      `secret=${secret}&algorithm=SHA512&digits=7&period=60`,
      `secret=${secret}&digits=8&period=15`,
    ];
    const times = { created: null, modified: null, expires: null };
    const model: KdbxExportModel = {
      meta: {
        name: "TOTP",
        description: "",
        color: null,
        historyMaxItems: 10,
        recycleBinEnabled: false,
        recycleBinUuid: null,
      },
      root: {
        uuid: "0193000e000040008000000000000001",
        name: "TOTP",
        notes: "",
        icon: 48,
        customIcon: null,
        times,
        groups: [],
        entries: variants.map((query, i) => ({
          uuid: `0193000e0000400080000000000000${String(10 + i)}`,
          icon: 0,
          customIcon: null,
          strings: [
            { key: "Title", value: `t${String(i)}`, protected: false },
            {
              key: "otp",
              value: `otpauth://totp/x:y?${query}`,
              protected: true,
            },
          ],
          tags: [],
          times,
          attachments: [],
          history: [],
        })),
      },
      binaries: [],
      customIcons: [],
    };
    const path = join(dir, "totp.kdbx");
    writeFileSync(path, await writeKdbx(model, utf8("totp")));
    for (const [i, query] of variants.entries()) {
      const uri = `otpauth://totp/x:y?${query}`;
      const before = await totpFromUri(uri, Date.now());
      const theirs = cli(["show", "-q", "-t", path, `/t${String(i)}`], "totp")
        .trim()
        .split("\n")
        .at(-1);
      const after = await totpFromUri(uri, Date.now());
      const ours = [before, after].map((r) => (r.ok ? r.value.code : ""));
      expect(ours, query).toContain(theirs);
    }
  });

  it("refuses our export with a wrong password", async () => {
    const { engine, vaultId } = await firstDevice();
    const path = join(dir, "wrong.kdbx");
    writeFileSync(
      path,
      await writeKdbx((await engine.exportKdbx(vaultId)).model, utf8("right")),
    );
    expect(() => cli(["db-info", "-q", path], "wrong")).toThrow("failed");
  });
});
