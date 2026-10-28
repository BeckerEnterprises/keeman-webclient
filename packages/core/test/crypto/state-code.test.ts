import { describe, expect, it } from "vitest";
import { concatBytes, toBase64Url, utf8Encode } from "../../src/crypto/bytes";
import { toBase32 } from "../../src/crypto/base32";
import { sodium } from "../../src/crypto/sodium";
import {
  compareStateCode,
  comparisonPointsStatus,
  formatStateCode,
  headCode,
  parseStateCode,
  stateCodeOf,
  stateCodeUri,
  type ChainPoint,
} from "../../src/crypto/state-code";
import { tv } from "../helpers";

const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b01";
const OTHER = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b02";

function hashOf(label: string): string {
  return toBase64Url(tv(label, 32));
}

function chain(from: number, to: number): ChainPoint[] {
  const out: ChainPoint[] = [];
  for (let v = from; v <= to; v++)
    out.push({ statement: { version: v }, hash: hashOf(`state-${String(v)}`) });
  return out;
}

function codeAt(points: ChainPoint[], version: number): string {
  const point = points.find((p) => p.statement.version === version);
  if (!point) throw new Error("no statement");
  return stateCodeOf(point.hash);
}

describe("state code", () => {
  it("hashes h(S) with its own context and output length 16", () => {
    const raw = tv("state-1", 32);
    const code = stateCodeOf(toBase64Url(raw));
    const expected = sodium().crypto_generichash(
      16,
      concatBytes(utf8Encode("keeman:v1:state-code"), Uint8Array.of(0x00), raw),
      null,
    );
    expect(code).toBe(toBase32(expected));
    expect(code).toMatch(/^[A-Z2-7]{25}[AEIMQUY4]$/);
    // Not the first 16 bytes of the 32-byte hash, not without separator.
    const long = sodium().crypto_generichash(
      32,
      concatBytes(utf8Encode("keeman:v1:state-code"), Uint8Array.of(0x00), raw),
      null,
    );
    expect(code).not.toBe(toBase32(long.subarray(0, 16)));
    const plain = sodium().crypto_generichash(
      16,
      concatBytes(utf8Encode("keeman:v1:state-code"), raw),
      null,
    );
    expect(code).not.toBe(toBase32(plain));
    expect(() => stateCodeOf("short")).toThrow();
  });

  it("formats the code for display and for the QR code", () => {
    const c = { version: 7, code: stateCodeOf(hashOf("state-7")) };
    const display = formatStateCode(c);
    expect(display).toMatch(/^v7 · [A-Z2-7]{4}( [A-Z2-7]{4}){5} [A-Z2-7]{2}$/);
    expect(display.replace(/^v7 · /, "").replaceAll(" ", "")).toBe(c.code);
    expect(stateCodeUri(VAULT, c)).toBe(`keeman:state:${VAULT}:7:${c.code}`);
    expect(
      headCode({ statement: { version: 7 }, hash: hashOf("state-7") }),
    ).toEqual(c);
  });
});

describe("state code input", () => {
  const code = stateCodeOf(hashOf("state-3"));
  const display = formatStateCode({ version: 3, code });
  const parsed = { version: 3, code, vaultId: null };

  it("reads the display form, compact forms, lowercase and the URI", () => {
    expect(parseStateCode(display)).toEqual(parsed);
    expect(parseStateCode(`\u00a0 3 ${code}\n`)).toEqual(parsed);
    expect(parseStateCode(`V3-${code.toLowerCase()}`)).toEqual(parsed);
    expect(parseStateCode(`v3:${code}`)).toEqual(parsed);
    expect(
      parseStateCode(
        `v3\u00a0\u00b7\t${code.slice(0, 13)} -\n${code.slice(13)}`,
      ),
    ).toEqual(parsed);
    expect(parseStateCode(`keeman:state:${VAULT}:3:${code}`)).toEqual({
      ...parsed,
      vaultId: VAULT,
    });
    expect(
      parseStateCode(`v${String(Number.MAX_SAFE_INTEGER)} ${code}`).version,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("needs a separator between version and code", () => {
    const letter = "K3QF6XMA2PLRTB6WQH4N7ZDEXA";
    const digit = `2${letter.slice(1)}`;
    expect(parseStateCode(`v3 ${letter}`).code).toBe(letter);
    expect(parseStateCode(`v3 ${digit}`).code).toBe(digit);
    for (const input of [`v3${letter}`, `v3${digit}`, `3${letter}`])
      expect(() => parseStateCode(input), input).toThrow(
        expect.objectContaining({ code: "validation" }),
      );
  });

  it("refuses ambiguous, malformed and non-canonical input", () => {
    const last = code.slice(-1);
    const nonCanonical = code.slice(0, -1) + (last === "B" ? "C" : "B");
    for (const input of [
      "",
      "v3",
      `v3${code}`,
      `v32${code.slice(1)}`,
      `v0 ${code}`,
      `v03 ${code}`,
      `v-3 ${code}`,
      `v${String(2 ** 53)} ${code}`,
      `v3 ${code.slice(1)}`,
      `v3 ${code}A`,
      `v3 ${nonCanonical}`,
      `v3 ${code.slice(0, -2)}0${last}`,
      `v3 ${code.slice(0, -2)}9${last}`,
      `v3 ${code.slice(0, -2)}ß${last}`,
      `v3 ${code.slice(0, -2)}·${last}`,
      `keeman:state:${VAULT.toUpperCase()}:3:${code}`,
      `keeman:state:${VAULT}:3:${code.toLowerCase()}`,
      `keeman:state:${VAULT}:03:${code}`,
      `keeman:state:${VAULT}:3:${code.slice(0, 13)} ${code.slice(13)}`,
      `keeman:status:${VAULT}:3:${code}`,
      `keeman:state:3:${code}`,
    ])
      expect(() => parseStateCode(input), input).toThrow(
        expect.objectContaining({ code: "validation" }),
      );
  });
});

describe("comparing a state code", () => {
  const statements = chain(1, 5);
  const entered = (
    version: number,
    code: string,
    vaultId: string | null = null,
  ) => ({
    version,
    code,
    vaultId,
  });

  it("matches only the statement of the same version", () => {
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements,
        entered: entered(5, codeAt(statements, 5)),
      }),
    ).toEqual({ result: "match" });
    // The other side is behind: it should check this device's code.
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements,
        entered: entered(3, codeAt(statements, 3), VAULT),
      }),
    ).toEqual({
      result: "behind",
      own: { version: 5, code: codeAt(statements, 5) },
    });
    // The code of another version of the same chain does not count.
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements,
        entered: entered(4, codeAt(statements, 3)),
      }),
    ).toEqual({
      result: "mismatch",
      own: { version: 4, code: codeAt(statements, 4) },
    });
  });

  it("reports a version above the head, a withheld statement and another vault", () => {
    const code = codeAt(statements, 5);
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements,
        entered: entered(6, code),
      }),
    ).toEqual({ result: "ahead" });
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements: [],
        entered: entered(1, code),
      }),
    ).toEqual({ result: "ahead" });
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements: chain(3, 5),
        entered: entered(2, code),
      }),
    ).toEqual({ result: "withheld" });
    expect(
      compareStateCode({
        vaultId: VAULT,
        statements,
        entered: entered(5, code, OTHER),
      }),
    ).toEqual({ result: "other_vault" });
  });
});

describe("comparison points", () => {
  const statements = chain(1, 4);

  it("are satisfied by the statement with their code", () => {
    expect(comparisonPointsStatus(statements, [])).toEqual({ status: "ok" });
    expect(
      comparisonPointsStatus(statements, [
        { version: 2, code: codeAt(statements, 2) },
        { version: 4, code: codeAt(statements, 4) },
      ]),
    ).toEqual({ status: "ok" });
  });

  it("make a fork before a rollback, the lowest version first", () => {
    const wrong = codeAt(statements, 1);
    const ahead = { version: 6, code: wrong };
    const above = { version: 5, code: wrong };
    expect(comparisonPointsStatus(statements, [ahead, above])).toEqual({
      status: "rollback",
      point: above,
    });
    const forked = { version: 3, code: wrong };
    const lower = { version: 2, code: wrong };
    expect(comparisonPointsStatus(statements, [ahead, forked, lower])).toEqual({
      status: "fork",
      point: lower,
    });
    // A statement that is not delivered cannot satisfy a point below the head.
    expect(
      comparisonPointsStatus(chain(3, 4), [
        { version: 2, code: codeAt(statements, 2) },
      ]),
    ).toEqual({
      status: "fork",
      point: { version: 2, code: codeAt(statements, 2) },
    });
    // Without a chain every point lies above the head.
    expect(comparisonPointsStatus([], [lower])).toEqual({
      status: "rollback",
      point: lower,
    });
  });
});
