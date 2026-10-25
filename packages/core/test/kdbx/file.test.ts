import * as kdbxweb from "kdbxweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kdbxArgon2 } from "../../src/kdbx/file/argon2";
import {
  inspectKdbxHeader,
  kdbxErrorOf,
  readKdbx,
} from "../../src/kdbx/file/read";
import { verifyKdbxExport } from "../../src/kdbx/export";
import { uuidOfHex } from "../../src/kdbx/file/uuid";
import { writeKdbx } from "../../src/kdbx/file/write";
import {
  KDBX_LIMITS,
  KdbxError,
  type KdbxEntryFile,
  type KdbxExportModel,
  type KdbxFile,
  type KdbxGroupFile,
} from "../../src/kdbx/types";
import { arrayBufferOf, fixture, utf8, type FixtureName } from "./helpers";

const TWOFISH = Uint8Array.from([
  0xad, 0x68, 0xf2, 0x9f, 0x57, 0x6f, 0x4b, 0xb9, 0xa3, 0x6a, 0xd4, 0x7a, 0xf9,
  0x65, 0x34, 0x6c,
]);

function read(name: FixtureName, password = "test"): Promise<KdbxFile> {
  return readKdbx(arrayBufferOf(fixture(name)), {
    password: utf8(password),
    keyFile: null,
  });
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KdbxError) return error.code;
    throw error;
  }
  throw new Error("expected a KdbxError");
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof KdbxError) return error.code;
    throw error;
  }
  throw new Error("expected a KdbxError");
}

function child(group: KdbxGroupFile, name: string): KdbxGroupFile {
  const found = group.groups.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no group ${name}`);
  return found;
}

function entry(group: KdbxGroupFile, title: string): KdbxEntryFile {
  const found = group.entries.find((item) =>
    item.strings.some((s) => s.key === "Title" && s.value === title),
  );
  if (found === undefined) throw new Error(`no entry ${title}`);
  return found;
}

function value(item: { strings: KdbxEntryFile["strings"] }, key: string) {
  return item.strings.find((s) => s.key === key);
}

/** Rewrites the 16-byte CipherID field of a KDBX 4 outer header. */
function withCipher(bytes: Uint8Array, cipher: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  let offset = 12;
  for (;;) {
    const id = copy[offset];
    const size = view.getUint32(offset + 1, true);
    if (id === 2) {
      copy.set(cipher, offset + 5);
      return copy;
    }
    if (id === 0) throw new Error("no cipher field");
    offset += 5 + size;
  }
}

/** Builds a file with kdbxweb directly, bypassing our limits. */
async function craft(
  configure: (db: kdbxweb.Kdbx) => void,
  credentials = new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromString("test"),
  ),
): Promise<Uint8Array> {
  const db = kdbxweb.Kdbx.create(credentials, "Crafted");
  const group = db.createGroup(db.getDefaultGroup(), "Group");
  const item = db.createEntry(group);
  item.fields.set("Title", "Crafted entry");
  configure(db);
  return new Uint8Array(await db.save());
}

afterEach(() => {
  kdbxweb.CryptoEngine.setArgon2Impl(kdbxArgon2);
});

describe("readKdbx: fixtures", () => {
  it("reads the KeePass 2 sample database", async () => {
    const file = await read("keepass-example");
    expect(file.header).toEqual({
      version: "4.0",
      cipher: "chacha20",
      kdf: "argon2id",
      memoryBytes: 64 * 1024 * 1024,
    });
    expect(file.meta).toEqual({
      name: "keepass test",
      description: "db description",
      color: "#FF00FF",
      publicColor: null,
      recycleBinEnabled: true,
      recycleBinUuid: null,
      historyMaxItems: 10,
    });
    expect(file.root.name).toBe("Database");
    expect(file.root.icon).toBe(49);
    expect(file.root.groups.map((g) => [g.name, g.icon])).toEqual([
      ["General", 48],
      ["Windows", 38],
      ["Network", 3],
      ["Internet", 1],
      ["eMail", 19],
      ["Homebanking", 37],
    ]);
    const second = entry(file.root, "Sample Entry #2");
    expect(value(second, "Password")).toEqual({
      key: "Password",
      value: "12345",
      protected: true,
    });
    expect(value(second, "UserName")?.protected).toBe(false);
    expect(file.ignored.autoType).toBe(1);
    expect(file.extraRoots).toBe(0);
  });

  it("reads the KeePassXC database with fields, OTP, history and public data", async () => {
    const file = await read("keepassxc-example");
    expect(file.header).toMatchObject({
      version: "4.1",
      cipher: "aes",
      kdf: "argon2d",
    });
    expect(file.meta).toMatchObject({
      name: "keeman test kdbx 4",
      color: null,
      publicColor: "#2ec27e",
      historyMaxItems: 10,
    });
    const item = entry(child(file.root, "test"), "test");
    expect(item.customIcon).toBe("008998b114284617bef17cdca29b722d");
    // Only icons in use come along, with their bytes (a PNG from KeePassXC).
    expect(file.customIcons.map((icon) => icon.uuid)).toEqual([
      "008998b114284617bef17cdca29b722d",
    ]);
    expect([...(file.customIcons[0]?.data.slice(0, 8) ?? [])]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(item.tags).toEqual(["tag1", "tag2"]);
    expect(item.attachments).toHaveLength(2);
    for (const ref of item.attachments)
      expect(file.binaries[ref.binary]?.length).toBeGreaterThan(0);
    expect(item.times.expires).toMatch(/^2026-10-25T/);
    expect(value(item, "field1-insecure")?.protected).toBe(false);
    expect(value(item, "field2-secure")?.protected).toBe(true);
    expect(value(item, "otp")?.value).toBe(
      "otpauth://totp/test:username?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=test",
    );
    expect(item.history).toHaveLength(2);
    expect(value(item.history[0] ?? item, "field2")?.protected).toBe(false);
    expect(file.ignored).toMatchObject({
      colors: 1,
      qualityCheck: 1,
      customData: 1,
      publicCustomData: 3,
    });
  });

  it("reads the generated sample: depth, history order, tabs, tags, bin", async () => {
    const file = await read("keeman-sample");
    expect(file.header).toEqual({
      version: "4.1",
      cipher: "aes",
      kdf: "aes",
      memoryBytes: null,
    });
    expect(file.meta.historyMaxItems).toBe(-1);
    expect(file.meta.recycleBinUuid).toBe("01930008000040008000000000000008");
    const web01 = child(
      child(child(file.root, "Provider"), "Nordhost"),
      "web01",
    );
    const deep = child(child(web01, "Kunde X"), "Sonstiges");
    expect(deep.notes).toBe("deepest group");
    expect(entry(deep, "Deep entry").uuid).toBe(
      "01930067000040008000000000000067",
    );
    const root = entry(web01, "root web01");
    expect(root.history.map((h) => value(h, "Password")?.value)).toEqual([
      "Hamster-1",
      "Hamster-2",
      "Hamster-3",
    ]);
    const mail = child(file.root, "Mail");
    const odd = entry(mail, "Odd fields");
    expect(value(odd, "Notes")?.value).toBe(
      "Line one\n\tindented line\nüñíçødé ✓",
    );
    expect(odd.tags).toEqual(["a:b", "c", "d", "e"]);
    expect(entry(mail, "Expiring").times.expires).toBe(
      "2026-11-30T08:00:00.000Z",
    );
    const bin = child(file.root, "Recycle Bin");
    expect(entry(bin, "Old entry").previousParent).toBe(mail.uuid);
    expect(child(bin, "Old group").previousParent).toBe(
      child(file.root, "Provider").uuid,
    );
  });

  it("reports the header before deriving keys", async () => {
    const seen: string[] = [];
    await readKdbx(
      arrayBufferOf(fixture("keepass-example")),
      { password: utf8("test"), keyFile: null },
      (header) => seen.push(header.kdf),
    );
    expect(seen).toEqual(["argon2id"]);
  });
});

describe("readKdbx: refusals", () => {
  it("needs a password or a key file", async () => {
    expect(
      await failure(
        readKdbx(arrayBufferOf(fixture("keepass-example")), {
          password: null,
          keyFile: null,
        }),
      ),
    ).toBe("no_credentials");
  });

  it("reports a wrong password", async () => {
    expect(await failure(read("keepass-example", "wrong"))).toBe("wrong_key");
    expect(await failure(read("keeman-sample", "wrong"))).toBe("wrong_key");
  });

  it("refuses files that are not KDBX", () => {
    expect(code(() => inspectKdbxHeader(new ArrayBuffer(4)))).toBe("corrupt");
    expect(
      code(() => inspectKdbxHeader(arrayBufferOf(utf8("not a database!!")))),
    ).toBe("not_kdbx");
    // KeePass 1.x signature.
    const kdb = Uint8Array.from([
      0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5, 0, 0, 0, 0,
    ]);
    expect(code(() => inspectKdbxHeader(kdb.buffer))).toBe("not_kdbx");
  });

  it("refuses files above 128 MiB before reading them", () => {
    expect(
      code(() => inspectKdbxHeader(new ArrayBuffer(KDBX_LIMITS.fileBytes + 1))),
    ).toBe("too_large");
  });

  it("refuses unknown versions", () => {
    const bytes = fixture("keepass-example");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint16(10, 5, true);
    expect(code(() => inspectKdbxHeader(arrayBufferOf(bytes)))).toBe(
      "unsupported_version",
    );
    view.setUint16(10, 4, true);
    view.setUint16(8, 9, true);
    expect(code(() => inspectKdbxHeader(arrayBufferOf(bytes)))).toBe(
      "unsupported_version",
    );
  });

  it("refuses Twofish before any key derivation", async () => {
    const argon = vi.fn(kdbxArgon2);
    kdbxweb.CryptoEngine.setArgon2Impl(argon);
    const bytes = withCipher(fixture("keepassxc-example"), TWOFISH);
    expect(
      await failure(
        readKdbx(arrayBufferOf(bytes), {
          password: utf8("test"),
          keyFile: null,
        }),
      ),
    ).toBe("unsupported_cipher");
    expect(argon).not.toHaveBeenCalled();
  });

  it("refuses Argon2 above 1 GiB and Argon2 version 1.0", async () => {
    kdbxweb.CryptoEngine.setArgon2Impl(() =>
      Promise.resolve(new ArrayBuffer(32)),
    );
    const params = (db: kdbxweb.Kdbx, key: string, value: number) => {
      db.setKdf(kdbxweb.Consts.KdfId.Argon2d);
      const type =
        key === "M"
          ? kdbxweb.VarDictionary.ValueType.UInt64
          : kdbxweb.VarDictionary.ValueType.UInt32;
      db.header.kdfParameters?.set(
        key,
        type,
        key === "M" ? new kdbxweb.Int64(value) : value,
      );
    };
    const huge = await craft((db) => {
      params(db, "M", 2 * 1024 * 1024 * 1024);
    });
    const old = await craft((db) => {
      params(db, "V", 0x10);
    });
    kdbxweb.CryptoEngine.setArgon2Impl(kdbxArgon2);
    expect(code(() => inspectKdbxHeader(arrayBufferOf(huge)))).toBe(
      "kdf_limits",
    );
    expect(code(() => inspectKdbxHeader(arrayBufferOf(old)))).toBe(
      "unsupported_kdf",
    );
  });

  it("refuses Argon2 headers without version or memory", () => {
    // Renames a VarDictionary key (last letter → X); the header HMAC no
    // longer matches, which does not matter because the check comes first.
    const rename = (bytes: Uint8Array, type: number, key: string) => {
      const copy = bytes.slice();
      const name = Array.from(new TextEncoder().encode(key));
      const at = copy.findIndex(
        (byte, index) =>
          byte === type &&
          copy[index + 1] === name.length &&
          copy[index + 2] === 0 &&
          name.every((char, offset) => copy[index + 5 + offset] === char),
      );
      if (at < 0) throw new Error(`no ${key}`);
      copy[at + 4 + name.length] = "X".charCodeAt(0);
      return copy;
    };
    const bytes = fixture("keepass-example");
    expect(
      code(() => inspectKdbxHeader(arrayBufferOf(rename(bytes, 0x05, "M")))),
    ).toBe("corrupt");
    expect(
      code(() => inspectKdbxHeader(arrayBufferOf(rename(bytes, 0x04, "V")))),
    ).toBe("unsupported_kdf");
    expect(
      code(() =>
        inspectKdbxHeader(arrayBufferOf(rename(bytes, 0x42, "$UUID"))),
      ),
    ).toBe("unsupported_kdf");
  });

  it("guards the Argon2 adapter itself", async () => {
    const buffer = new ArrayBuffer(32);
    await expect(
      kdbxArgon2(buffer, buffer, 1024, 1, 32, 1, 2, 0x10),
    ).rejects.toThrow(KdbxError);
    await expect(
      kdbxArgon2(buffer, buffer, 2 * 1024 * 1024, 1, 32, 1, 0, 0x13),
    ).rejects.toThrow(KdbxError);
    const hash = await kdbxArgon2(buffer, buffer, 64, 1, 32, 1, 0, 0x13);
    expect(hash.byteLength).toBe(32);
  });

  it("reports a damaged body as corrupt", async () => {
    const bytes = fixture("keeman-sample");
    const cut = bytes.slice(0, bytes.length - 200);
    expect(
      await failure(
        readKdbx(arrayBufferOf(cut), { password: utf8("test"), keyFile: null }),
      ),
    ).toBe("corrupt");
  });

  it("maps library errors to codes without their messages", () => {
    const { ErrorCodes } = kdbxweb.Consts;
    const map = (code: string, message?: string) =>
      kdbxErrorOf(new kdbxweb.KdbxError(code, message)).code;
    expect(map(ErrorCodes.BadSignature)).toBe("not_kdbx");
    expect(map(ErrorCodes.InvalidVersion)).toBe("unsupported_version");
    expect(map(ErrorCodes.InvalidKey)).toBe("wrong_key");
    expect(map(ErrorCodes.Unsupported, "unsupported cipher")).toBe(
      "unsupported_cipher",
    );
    expect(map(ErrorCodes.Unsupported, "bad kdf")).toBe("unsupported_kdf");
    expect(map(ErrorCodes.Unsupported, "argon2 secret key")).toBe(
      "unsupported_kdf",
    );
    expect(map(ErrorCodes.Unsupported, "compression")).toBe("corrupt");
    expect(map(ErrorCodes.InvalidArg, "key file without meta")).toBe(
      "wrong_key",
    );
    expect(map(ErrorCodes.FileCorrupt, "bad keyfile version")).toBe(
      "wrong_key",
    );
    expect(
      map(ErrorCodes.FileCorrupt, "no protected stream key in header"),
    ).toBe("corrupt");
    expect(kdbxErrorOf(new KdbxError("too_large")).code).toBe("too_large");
    expect(kdbxErrorOf(new RangeError("x")).code).toBe("failed");
    expect(kdbxErrorOf(new Error("x")).code).toBe("corrupt");
    expect(kdbxErrorOf("x").code).toBe("failed");
  });
});

describe("readKdbx: KDBX 3.1 and key files", () => {
  const keyFiles: [string, () => Promise<Uint8Array>][] = [
    ["XML 2.0", () => kdbxweb.Credentials.createRandomKeyFile(2)],
    ["XML 1.0", () => kdbxweb.Credentials.createRandomKeyFile(1)],
    [
      "32 bytes",
      () => Promise.resolve(crypto.getRandomValues(new Uint8Array(32))),
    ],
    ["64 hex digits", () => Promise.resolve(utf8("ab".repeat(32)))],
    ["any other file", () => Promise.resolve(utf8("just some text\n"))],
  ];

  it.each(keyFiles)(
    "opens a file protected by a %s key file",
    async (_, make) => {
      const keyFile = await make();
      // kdbxweb takes ownership of (and wipes) a raw 32-byte key.
      const bytes = await craft(
        (db) => {
          db.setVersion(3);
        },
        new kdbxweb.Credentials(null, keyFile.slice()),
      );
      const file = await readKdbx(arrayBufferOf(bytes), {
        password: null,
        keyFile,
      });
      expect(file.header).toMatchObject({ version: "3.1", kdf: "aes" });
      expect(file.root.groups.map((g) => g.name)).toContain("Group");
    },
  );

  it("needs both password and key file when both were set", async () => {
    const keyFile = await kdbxweb.Credentials.createRandomKeyFile(2);
    const bytes = await craft(
      () => undefined,
      new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("pw"), keyFile),
    );
    const open = (password: string | null, key: Uint8Array | null) =>
      readKdbx(arrayBufferOf(bytes), {
        password: password === null ? null : utf8(password),
        keyFile: key,
      });
    await expect(open("pw", keyFile)).resolves.toMatchObject({
      header: { version: "4.0" },
    });
    expect(await failure(open("pw", null))).toBe("wrong_key");
    expect(await failure(open(null, keyFile))).toBe("wrong_key");
    expect(await failure(open("pw", utf8("<KeyFile></KeyFile>")))).toBe(
      "wrong_key",
    );
  });

  it("moves further top-level groups under the root", async () => {
    const bytes = await craft((db) => {
      const extra = kdbxweb.KdbxGroup.create("Second root");
      db.groups.push(extra);
    });
    const file = await readKdbx(arrayBufferOf(bytes), {
      password: utf8("test"),
      keyFile: null,
    });
    expect(file.extraRoots).toBe(1);
    expect(file.root.groups.map((g) => g.name)).toContain("Second root");
  });

  it("reads timestamps outside the supported years as missing", async () => {
    const bytes = await craft((db) => {
      const item = db.getDefaultGroup().groups.find((g) => g.name === "Group")
        ?.entries[0];
      if (item === undefined) throw new Error("no entry");
      item.times.creationTime = new Date(Date.UTC(12000, 0, 1));
      item.times.lastModTime = undefined;
      item.times.expires = true;
      item.times.expiryTime = new Date(Date.UTC(10000, 0, 1));
    });
    const file = await readKdbx(arrayBufferOf(bytes), {
      password: utf8("test"),
      keyFile: null,
    });
    const item = file.root.groups.find((g) => g.name === "Group")?.entries[0];
    expect(item?.times).toEqual({
      created: null,
      modified: null,
      expires: null,
    });
  });

  it("reports contents kdbxweb cannot parse as corrupt", async () => {
    const bytes = await craft((db) => {
      const item = db.getDefaultGroup().groups.find((g) => g.name === "Group")
        ?.entries[0];
      if (item === undefined) throw new Error("no entry");
      item.times.creationTime = new Date(Date.UTC(-5, 0, 1));
    });
    expect(
      await failure(
        readKdbx(arrayBufferOf(bytes), {
          password: utf8("test"),
          keyFile: null,
        }),
      ),
    ).toBe("corrupt");
  });
});

function model(): KdbxExportModel {
  const times = {
    created: "2026-01-02T03:04:05.000Z",
    modified: "2026-02-03T04:05:06.000Z",
    expires: null,
  };
  return {
    meta: {
      name: "Exported",
      description: "Line 1\nLine 2",
      color: "#2563EB",
      historyMaxItems: 7,
      recycleBinEnabled: true,
      recycleBinUuid: "0193000a000040008000000000000002",
    },
    root: {
      uuid: "0193000a000040008000000000000001",
      name: "Exported",
      notes: "root notes",
      icon: 48,
      customIcon: null,
      times,
      groups: [
        {
          uuid: "0193000a000040008000000000000002",
          name: "Recycle Bin",
          notes: "",
          icon: 43,
          customIcon: null,
          times,
          groups: [],
          entries: [],
        },
      ],
      entries: [
        {
          uuid: "0193000a000040008000000000000003",
          icon: 3,
          customIcon: null,
          strings: [
            { key: "Title", value: "Server", protected: false },
            { key: "UserName", value: "root", protected: false },
            { key: "Password", value: "pässwört", protected: true },
            { key: "URL", value: "", protected: false },
            { key: "Notes", value: "a\tb", protected: false },
            {
              key: "otp",
              value: "otpauth://totp/x?secret=MFRGG",
              protected: true,
            },
            { key: "Host", value: "203.0.113.10", protected: false },
          ],
          tags: ["a:b", "c"],
          times: { ...times, expires: "2027-01-01T00:00:00.000Z" },
          attachments: [{ name: "notiz.txt", binary: 0 }],
          history: [
            {
              uuid: "0193000a000040008000000000000003",
              icon: 3,
              customIcon: null,
              strings: [{ key: "Password", value: "old", protected: true }],
              tags: [],
              times: { created: null, modified: null, expires: null },
              attachments: [
                { name: "notiz.txt", binary: 0 },
                { name: "alt.bin", binary: 1 },
              ],
            },
          ],
        },
      ],
    },
    // Test data only.
    binaries: [utf8("Fantasie-Notiz"), Uint8Array.from([0, 1, 2, 255])],
    customIcons: [],
  };
}

describe("writeKdbx", () => {
  it("writes KDBX 4.0 with AES-256, Argon2id 64 MiB/3/1 that reads back", async () => {
    const bytes = await writeKdbx(model(), utf8("export password"));
    const file = await readKdbx(arrayBufferOf(bytes), {
      password: utf8("export password"),
      keyFile: null,
    });
    expect(file.header).toEqual({
      version: "4.0",
      cipher: "aes",
      kdf: "argon2id",
      memoryBytes: 64 * 1024 * 1024,
    });
    const header = kdbxweb.KdbxHeader.read(
      new kdbxweb.BinaryStream(arrayBufferOf(bytes)),
      new kdbxweb.KdbxContext({ kdbx: new kdbxweb.Kdbx() }),
    );
    expect(header.compression).toBe(kdbxweb.Consts.CompressionAlgorithm.GZip);
    expect((header.kdfParameters?.get("I") as kdbxweb.Int64).value).toBe(3);
    expect(header.kdfParameters?.get("P")).toBe(1);
    expect(file.meta).toMatchObject({
      name: "Exported",
      description: "Line 1\nLine 2",
      color: "#2563EB",
      historyMaxItems: 7,
      recycleBinEnabled: true,
      recycleBinUuid: "0193000a000040008000000000000002",
    });
    expect(file.root.uuid).toBe("0193000a000040008000000000000001");
    expect(file.root.notes).toBe("root notes");
    expect(file.root.groups.map((g) => g.name)).toEqual(["Recycle Bin"]);
    const [item] = file.root.entries;
    expect(item?.strings).toEqual(model().root.entries[0]?.strings);
    expect(item?.tags).toEqual(["a:b", "c"]);
    expect(item?.times).toEqual({
      created: "2026-01-02T03:04:05.000Z",
      modified: "2026-02-03T04:05:06.000Z",
      expires: "2027-01-01T00:00:00.000Z",
    });
    expect(item?.history).toHaveLength(1);
    expect(item?.history[0]?.strings).toEqual([
      { key: "Password", value: "old", protected: true },
    ]);
    // One binary per content, shared by the entry and its history.
    expect(file.binaries).toHaveLength(2);
    const bytesOf = (ref?: { binary: number }) =>
      ref === undefined ? undefined : file.binaries[ref.binary];
    expect(item?.attachments.map((a) => a.name)).toEqual(["notiz.txt"]);
    expect(bytesOf(item?.attachments[0])).toEqual(utf8("Fantasie-Notiz"));
    const past = item?.history[0]?.attachments ?? [];
    expect(past.map((a) => a.name).sort()).toEqual(["alt.bin", "notiz.txt"]);
    expect(past.find((a) => a.name === "notiz.txt")?.binary).toBe(
      item?.attachments[0]?.binary,
    );
    expect(bytesOf(past.find((a) => a.name === "alt.bin"))).toEqual(
      Uint8Array.from([0, 1, 2, 255]),
    );
    expect(verifyKdbxExport(model(), file)).toBe(true);
  });

  it("draws fresh salts and IVs for every file", async () => {
    const header = (bytes: Uint8Array) =>
      kdbxweb.KdbxHeader.read(
        new kdbxweb.BinaryStream(arrayBufferOf(bytes)),
        new kdbxweb.KdbxContext({ kdbx: new kdbxweb.Kdbx() }),
      );
    const a = header(await writeKdbx(model(), utf8("pw")));
    const b = header(await writeKdbx(model(), utf8("pw")));
    const hex = (value: unknown) =>
      kdbxweb.ByteUtils.bytesToHex(value as ArrayBuffer);
    expect(hex(a.kdfParameters?.get("S"))).not.toBe(
      hex(b.kdfParameters?.get("S")),
    );
    expect(hex(a.masterSeed)).not.toBe(hex(b.masterSeed));
    expect(hex(a.encryptionIV)).not.toBe(hex(b.encryptionIV));
  });

  it("writes an empty recycle bin reference and no colour", async () => {
    const source = model();
    source.meta.recycleBinUuid = null;
    source.meta.color = null;
    const file = await readKdbx(
      arrayBufferOf(await writeKdbx(source, utf8("pw"))),
      { password: utf8("pw"), keyFile: null },
    );
    expect(file.meta.recycleBinUuid).toBeNull();
    expect(file.meta.color).toBeNull();
  });

  it("falls back to the time of export for unreadable timestamps", async () => {
    const source = model();
    source.root.times = { created: "garbage", modified: null, expires: null };
    const before = Date.now() - 1000;
    const file = await readKdbx(
      arrayBufferOf(await writeKdbx(source, utf8("pw"))),
      { password: utf8("pw"), keyFile: null },
    );
    expect(Date.parse(file.root.times.created ?? "")).toBeGreaterThan(before);
    expect(file.root.times.modified).toBe(file.root.times.created);
  });

  it("fails without library details on an invalid model", async () => {
    const source = model();
    source.root.uuid = "not a uuid";
    expect(await failure(writeKdbx(source, utf8("pw")))).toBe("failed");
  });

  it("rejects invalid UUIDs when converting", () => {
    expect(() => uuidOfHex("0193")).toThrow(RangeError);
    expect(uuidOfHex("0193000a000040008000000000000001").id).toBe(
      "AZMACgAAQACAAAAAAAAAAQ==",
    );
  });
});
