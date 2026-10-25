import { describe, expect, it } from "vitest";
import { fromBase32, toBase32 } from "../../src/crypto/base32";
import {
  bytesEqual,
  concatBytes,
  decodeJsonObject,
  encodeJsonObject,
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode,
  wipe,
} from "../../src/crypto/bytes";
import { normalizeEmail, normalizePassword } from "../../src/crypto/normalize";
import { pad, unpad } from "../../src/crypto/padding";
import { scoped, systemRandomness } from "../../src/crypto/random";
import { initCrypto } from "../../src/crypto/sodium";
import { isTimestamp } from "../../src/crypto/time";
import { assertUuid, isUuid, uuidv7 } from "../../src/crypto/uuid";
import { expectCryptoError, scriptedRandomness } from "../helpers";

describe("initCrypto", () => {
  it("can be awaited repeatedly", async () => {
    await expect(initCrypto()).resolves.toBeUndefined();
    await expect(initCrypto()).resolves.toBeUndefined();
  });
});

describe("Base64url", () => {
  it("round-trips canonical values", () => {
    for (const length of [0, 1, 2, 3, 16, 32, 73]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it.each([["AA=="], ["AA+/"], ["AA AA"], ["A"], ["AB"], ["AAA!"]])(
    "rejects %j",
    (text) => {
      expectCryptoError(() => fromBase64Url(text), "format");
    },
  );

  it("checks the decoded length", () => {
    expect(fromBase64Url(toBase64Url(new Uint8Array(32)), 32)).toHaveLength(32);
    expectCryptoError(
      () => fromBase64Url(toBase64Url(new Uint8Array(31)), 32),
      "format",
    );
  });
});

describe("hex", () => {
  it("round-trips and rejects invalid input", () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
    expectCryptoError(() => fromHex("0F"), "format");
    expectCryptoError(() => fromHex("abc"), "format");
  });
});

describe("UTF-8 and JSON", () => {
  it("refuses ill-formed strings when encoding", () => {
    expect(utf8Decode(utf8Encode("Grüße 🔑"))).toBe("Grüße 🔑");
    expectCryptoError(() => utf8Encode("a\uD800b"), "validation");
  });

  it("rejects invalid UTF-8", () => {
    expectCryptoError(() => utf8Decode(Uint8Array.of(0xc3, 0x28)), "encoding");
  });

  it("decodes JSON objects strictly", () => {
    expect(decodeJsonObject(utf8Encode('{"a":1}'))).toEqual({ a: 1 });
    expectCryptoError(
      () => decodeJsonObject(utf8Encode('﻿{"a":1}')),
      "encoding",
    );
    expectCryptoError(() => decodeJsonObject(utf8Encode("[1]")), "encoding");
    expectCryptoError(() => decodeJsonObject(utf8Encode("null")), "encoding");
    expectCryptoError(() => decodeJsonObject(utf8Encode("{")), "encoding");
    expectCryptoError(() => decodeJsonObject(Uint8Array.of(0xff)), "encoding");
  });

  it("refuses lone surrogates in keys and values", () => {
    expect(encodeJsonObject({ a: "ok", nested: { b: ["x"] } })).toEqual(
      utf8Encode('{"a":"ok","nested":{"b":["x"]}}'),
    );
    expectCryptoError(() => encodeJsonObject({ a: "\uDC00" }), "validation");
    expectCryptoError(() => encodeJsonObject({ "\uD800": 1 }), "validation");
  });
});

describe("byte helpers", () => {
  it("concatenates, compares and wipes", () => {
    const joined = concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3));
    expect(joined).toEqual(Uint8Array.of(1, 2, 3));
    expect(bytesEqual(joined, Uint8Array.of(1, 2, 3))).toBe(true);
    expect(bytesEqual(joined, Uint8Array.of(1, 2))).toBe(false);
    expect(bytesEqual(joined, Uint8Array.of(1, 2, 4))).toBe(false);
    wipe(joined, undefined);
    expect(joined).toEqual(new Uint8Array(3));
  });
});

describe("Base32 (RFC 4648)", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %j as %j", (plain, encoded) => {
    expect(toBase32(utf8Encode(plain))).toBe(encoded);
    expect(fromBase32(encoded)).toEqual(utf8Encode(plain));
  });

  it("rejects invalid input", () => {
    expectCryptoError(() => fromBase32("M"), "format");
    expectCryptoError(() => fromBase32("MZ1Q"), "format");
    expectCryptoError(() => fromBase32("MZ"), "format");
  });
});

describe("padding", () => {
  it.each([0, 1, 255, 256, 257, 511])(
    "pads %i bytes to a multiple of 256",
    (length) => {
      const padded = pad(new Uint8Array(length).fill(7));
      expect(padded.length % 256).toBe(0);
      expect(padded.length - length).toBeGreaterThanOrEqual(1);
      expect(padded.length - length).toBeLessThanOrEqual(256);
      expect(unpad(padded)).toEqual(new Uint8Array(length).fill(7));
    },
  );

  it("rejects non-canonical padding", () => {
    expectCryptoError(() => unpad(new Uint8Array(0)), "padding");
    expectCryptoError(() => unpad(new Uint8Array(255)), "padding");
    const notMultiple = new Uint8Array(300);
    notMultiple[299 - 10] = 0x80;
    expectCryptoError(() => unpad(notMultiple), "padding");
    expectCryptoError(() => unpad(new Uint8Array(256)), "padding");
    const trailingGarbage = pad(Uint8Array.of(1));
    trailingGarbage[255] = 1;
    expectCryptoError(() => unpad(trailingGarbage), "padding");
  });
});

describe("UUIDs", () => {
  it("lays out UUIDv7 per RFC 9562", () => {
    const id = uuidv7(
      Uint8Array.from({ length: 10 }, () => 0xff),
      0x0192b3a45c6d,
    );
    expect(id).toBe("0192b3a4-5c6d-7fff-bfff-ffffffffffff");
    expect(uuidv7(new Uint8Array(10), 0)).toBe(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(isUuid(systemRandomness.id("x"))).toBe(true);
  });

  it("validates inputs", () => {
    expectCryptoError(() => uuidv7(new Uint8Array(9)), "validation");
    expectCryptoError(() => uuidv7(new Uint8Array(10), -1), "validation");
    expectCryptoError(() => uuidv7(new Uint8Array(10), 2 ** 48), "validation");
    expect(isUuid("0192B3A4-5C6D-7E8F-9A0B-1C2D3E4F5A6B")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expectCryptoError(() => {
      assertUuid("not-a-uuid", "id");
    }, "validation");
  });
});

describe("normalisation", () => {
  it("normalises passwords to NFC without trimming", () => {
    expect(normalizePassword(" Grüße ")).toEqual(utf8Encode(" Grüße "));
    expectCryptoError(() => normalizePassword("pw\uD800"), "validation");
  });

  it("normalises e-mail addresses", () => {
    expect(normalizeEmail("  Alïce@Example.COM\n")).toBe("alïce@example.com");
    expect(normalizeEmail("﻿a@b")).toBe("﻿a@b");
  });
});

describe("randomness and time", () => {
  it("scopes labels and validates timestamps", () => {
    const rnd = scriptedRandomness(
      { "a.b": Uint8Array.of(1) },
      { "a.c": "id" },
    );
    const scopedRnd = scoped(rnd, "a");
    expect(scopedRnd.bytes("b", 1)).toEqual(Uint8Array.of(1));
    expect(scopedRnd.id("c")).toBe("id");
    expect(systemRandomness.bytes("x", 24)).toHaveLength(24);
    expect(isTimestamp("2026-10-23T08:42:00.000Z")).toBe(true);
    expect(isTimestamp("2026-10-23T08:42:00Z")).toBe(false);
    expect(isTimestamp(1)).toBe(false);
  });

  it("scripted randomness refuses reuse, unknown labels and wrong lengths", () => {
    const rnd = scriptedRandomness({ n: new Uint8Array(24) }, { u: "x" });
    expect(rnd.unused()).toEqual(["n", "u"]);
    rnd.bytes("n", 24);
    expect(() => rnd.bytes("n", 24)).toThrow(/twice/);
    expect(() => rnd.bytes("m", 24)).toThrow(/No scripted bytes/);
    expect(() =>
      scriptedRandomness({ n: new Uint8Array(1) }).bytes("n", 2),
    ).toThrow(/must be/);
    expect(() => rnd.id("v")).toThrow(/No scripted ID/);
    expect(rnd.unused()).toEqual(["u"]);
  });
});
