import { describe, expect, it } from "vitest";
import { fromHex, toBase64Url } from "../../src/crypto/bytes";
import {
  faviconIconName,
  faviconTarget,
  iconDataUrl,
  iconHash,
  iconRefs,
  inspectIcon,
  InvalidIcon,
  isIconPng,
  MAX_ICON_BYTES,
  newIcon,
  renameIconRefs,
  uploadIconName,
} from "../../src/model/icon";
import { iconPng } from "../helpers";

const USER = "0192b3a4-5c6d-7e8f-9a0b-000000000009";
const STAMP = { now: "2026-10-23T08:00:00.000Z", userId: USER };
/** Signature, IHDR 64 × 64 and IEND with real CRCs (Python, hashlib). */
const MINIMAL = fromHex(
  "89504e470d0a1a0a0000000d4948445200000040000000400806000000aa6971de0000000049454e44ae426082",
);

function raw(data: string, extra: Record<string, unknown> = {}) {
  return { schema: 1, seq: 1, mime: "image/png", data, ...extra };
}

describe("icon objects", () => {
  it("hashes the PNG bytes with BLAKE2b-256", () => {
    // hashlib.blake2b(png, digest_size=32).hexdigest()
    expect(iconHash(MINIMAL)).toBe(
      "5d46e83bcbc9d382185fbe9c07ff62bb0bc81f5f6612243ed54dacf120ab2d03",
    );
  });

  it("writes new icons and reads them back", () => {
    const png = iconPng(1);
    const content = newIcon(
      {
        png,
        name: "Nordhost",
        source: { type: "favicon", origin: "https://www.example.net" },
      },
      STAMP,
    );
    expect(content).toEqual({
      schema: 1,
      seq: 1,
      name: "Nordhost",
      mime: "image/png",
      data: toBase64Url(png),
      width: 64,
      height: 64,
      hash: iconHash(png),
      source: { type: "favicon", origin: "https://www.example.net" },
      created: STAMP.now,
      modified: STAMP.now,
      modifiedBy: USER,
    });
    expect(inspectIcon(content)).toMatchObject({
      status: "ok",
      seq: 1,
      readOnly: false,
      value: {
        name: "Nordhost",
        data: toBase64Url(png),
        hash: iconHash(png),
        source: { type: "favicon", origin: "https://www.example.net" },
      },
    });
  });

  it("refuses to write anything but an icon PNG", () => {
    for (const png of [
      iconPng(0, 63, 64),
      iconPng(0, 64, 65),
      new Uint8Array(10),
    ])
      expect(() =>
        newIcon({ png, name: "x", source: { type: "upload" } }, STAMP),
      ).toThrow(InvalidIcon);
  });

  it("needs mime and valid PNG data", () => {
    const data = toBase64Url(iconPng(2));
    expect(inspectIcon(raw(data)).status).toBe("ok");
    const big = new Uint8Array(MAX_ICON_BYTES + 1);
    big.set(iconPng(2));
    const cases: Record<string, unknown>[] = [
      { schema: 1, seq: 1, data },
      raw(data, { mime: "image/svg+xml" }),
      raw(data, { mime: "IMAGE/PNG" }),
      { schema: 1, seq: 1, mime: "image/png" },
      raw(toBase64Url(iconPng(2, 63, 64))),
      raw(toBase64Url(iconPng(2, 64, 32))),
      raw(toBase64Url(big)),
      raw(`${data}=`),
      raw(data.replace(/_/g, "/").replace(/-/g, "+") + "+"),
      raw(` ${data}`),
      raw(
        toBase64Url(
          new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ),
      ),
      raw(42 as unknown as string),
    ];
    for (const value of cases)
      expect(
        inspectIcon(value).status,
        JSON.stringify(value).slice(0, 80),
      ).toBe("corrupt");
    expect(inspectIcon({ mime: "image/png", data, seq: 1 }).status).toBe(
      "corrupt",
    );
  });

  it("accepts exactly 32 KiB of PNG bytes", () => {
    const png = new Uint8Array(MAX_ICON_BYTES);
    png.set(iconPng(3));
    expect(isIconPng(png)).toBe(true);
    expect(inspectIcon(raw(toBase64Url(png))).status).toBe("ok");
  });

  it("uses defaults for invalid optional fields and recomputes the hash", () => {
    const png = iconPng(4);
    const inspected = inspectIcon(
      raw(toBase64Url(png), {
        name: 5,
        hash: "00".repeat(32),
        width: 16,
        height: "x",
        source: { type: "favicon" },
        unknown: true,
      }),
    );
    expect(inspected).toMatchObject({
      status: "ok",
      value: { name: "", hash: iconHash(png), source: null },
    });
    expect(
      inspectIcon(raw(toBase64Url(png), { source: { type: "kdbx", x: 1 } })),
    ).toMatchObject({ value: { source: { type: "kdbx" } } });
  });

  it("is read-only with a newer schema", () => {
    expect(
      inspectIcon({ ...raw(toBase64Url(iconPng(5))), schema: 2 }),
    ).toMatchObject({ status: "ok", readOnly: true });
  });

  it("builds standard Base64 data URLs", () => {
    expect(iconDataUrl("-_8")).toBe("data:image/png;base64,+/8=");
    expect(iconDataUrl("AAAA")).toBe("data:image/png;base64,AAAA");
    expect(iconDataUrl("AAAAAA")).toBe("data:image/png;base64,AAAAAA==");
    const data = toBase64Url(MINIMAL);
    const url = iconDataUrl(data);
    expect(
      Uint8Array.from(atob(url.split(",")[1] ?? ""), (c) => c.charCodeAt(0)),
    ).toEqual(MINIMAL);
  });

  it("names uploads after the file and favicons after the host", () => {
    expect(uploadIconName("Nordhost Logo.png")).toBe("Nordhost Logo");
    expect(uploadIconName("  spaced .svg ")).toBe("spaced");
    expect(uploadIconName("archive.tar.gz")).toBe("archive.tar");
    expect(uploadIconName(".hidden")).toBe(".hidden");
    expect(uploadIconName(".png")).toBe(".png");
    expect(uploadIconName("   .png")).toBe("Icon");
    expect(uploadIconName("")).toBe("Icon");
    expect(uploadIconName(`${"ä".repeat(70)}.png`)).toBe("ä".repeat(64));
    expect(faviconIconName("https://www.example.net")).toBe("www.example.net");
    expect(faviconIconName("http://example.com:8080")).toBe("example.com:8080");
    expect(faviconIconName("nonsense")).toBe("nonsense");
  });
});

describe("favicon targets", () => {
  it("keeps only scheme, host and port", () => {
    const cases: [string, string | undefined][] = [
      ["https://www.example.com/login?x=1#y", "https://www.example.com/"],
      ["https://user:pw@example.com", "https://example.com/"],
      ["HTTP://Example.COM:80/a", "http://example.com/"],
      ["http://example.com:8080", "http://example.com:8080/"],
      ["www.example.net", "https://www.example.net/"],
      ["example.org:8443/path", "https://example.org:8443/"],
      ["  bücher.example ", "https://xn--bcher-kva.example/"],
      ["ftp://example.com", undefined],
      ["mailto:a@example.com", undefined],
      ["javascript:alert(1)", undefined],
      ["data:image/png;base64,AAAA", undefined],
      ["file:///etc/passwd", undefined],
      ["", undefined],
      ["https://", undefined],
      ["http://exa mple.com", undefined],
    ];
    for (const [url, expected] of cases)
      expect(faviconTarget(url), url).toBe(expected);
  });
});

describe("icon references", () => {
  const A = "0192b3a4-5c6d-7e8f-9a0b-0000000000a1";
  const B = "0192b3a4-5c6d-7e8f-9a0b-0000000000a2";
  const C = "0192b3a4-5c6d-7e8f-9a0b-0000000000a3";

  it("collects custom references of the object and its snapshots", () => {
    const raw = {
      icon: { type: "custom", id: A },
      defaultEntryIcon: { type: "custom", id: B },
      history: [
        { icon: { type: "custom", id: C } },
        { icon: { type: "builtin", name: "server" } },
        { icon: { type: "custom", id: "not-a-uuid" } },
        "broken",
        null,
      ],
    };
    expect([...iconRefs(raw)].sort()).toEqual([A, B, C]);
    expect(iconRefs({ icon: null }).size).toBe(0);
    expect(iconRefs({ history: "x" }).size).toBe(0);
  });

  it("renames only the id and keeps everything else", () => {
    const raw = {
      title: "T",
      icon: { type: "custom", id: A, extra: 1 },
      defaultEntryIcon: { type: "custom", id: C },
      history: [{ icon: { type: "custom", id: A }, title: "alt" }, "x"],
    };
    const renamed = renameIconRefs(raw, new Map([[A, B]]));
    expect(renamed).toEqual({
      title: "T",
      icon: { type: "custom", id: B, extra: 1 },
      defaultEntryIcon: { type: "custom", id: C },
      history: [{ icon: { type: "custom", id: B }, title: "alt" }, "x"],
    });
    // The original stays untouched.
    expect(raw.icon.id).toBe(A);
  });
});
