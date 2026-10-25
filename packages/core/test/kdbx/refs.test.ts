import { describe, expect, it } from "vitest";
import {
  canonicalRefId,
  entryWithRefs,
  keepassRefId,
  refTargets,
  rewriteRefs,
} from "../../src/kdbx/refs";

const A = "0193000c-0000-4000-8000-00000000000a";
const B = "0193000c-0000-4000-8000-00000000000b";
const A_HEX = "0193000C00004000800000000000000A";

describe("{REF} placeholders", () => {
  it("reads both ID forms and writes the KeePass form", () => {
    expect(canonicalRefId(A_HEX)).toBe(A);
    expect(canonicalRefId(A.toUpperCase())).toBe(A);
    expect(canonicalRefId("xyz")).toBeUndefined();
    expect(
      canonicalRefId("0193000c-0000-4000-8000-00000000000a-"),
    ).toBeUndefined();
    expect(keepassRefId(A)).toBe(A_HEX);
    expect(
      refTargets(
        `{REF:P@I:${A_HEX}} {ref:u@i:${B}} {REF:T@T:Title} {REF:P@I:----------------------------------XX}`,
      ),
    ).toEqual([A, B]);
  });

  it("rewrites only references whose target changes", () => {
    const map = (id: string) => (id === A ? B : id);
    expect(
      rewriteRefs(
        `pw {REF:P@I:${A_HEX}} and {REF:U@I:${A}} {REF:A@I:${B}}`,
        map,
      ),
    ).toBe(
      `pw {REF:P@I:${keepassRefId(B)}} and {REF:U@I:${keepassRefId(B)}} {REF:A@I:${B}}`,
    );
    expect(rewriteRefs("no placeholders", map)).toBe("no placeholders");
    const dashedJunk = "{REF:P@I:0193000c-0000-4000-8000-00000000000a00}";
    expect(rewriteRefs(dashedJunk, map)).toBe(dashedJunk);
    const nearMiss = "{REF:P@I:0193000c00004000800000000000000a----}";
    expect(rewriteRefs(nearMiss, map)).toBe(nearMiss);
  });

  it("rewrites the state and every snapshot of an entry", () => {
    const ref = `{REF:P@I:${A_HEX}}`;
    const raw = {
      title: ref,
      username: "u",
      password: ref,
      url: ref,
      notes: 7,
      otp: null,
      fields: [{ id: "f", name: "n", value: ref }, { id: "g", value: 3 }, "x"],
      history: [{ password: ref, fields: "bad" }, "junk"],
    };
    const next = entryWithRefs(raw, (id) => (id === A ? B : id));
    const want = `{REF:P@I:${keepassRefId(B)}}`;
    expect(next).toEqual({
      ...raw,
      title: want,
      password: want,
      url: want,
      fields: [{ id: "f", name: "n", value: want }, { id: "g", value: 3 }, "x"],
      history: [{ password: want, fields: "bad" }, "junk"],
    });
    expect(raw.title).toBe(ref);
    expect(entryWithRefs({ title: "t" }, (id) => id)).toEqual({ title: "t" });
  });
});
