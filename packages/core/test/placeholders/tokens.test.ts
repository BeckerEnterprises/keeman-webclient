import { describe, expect, it } from "vitest";
import { tokenize } from "../../src/placeholders/tokens";

describe("tokenize", () => {
  it("finds standard fields without regard to case", () => {
    expect(tokenize("a{username}b{PASSWORD}")).toEqual([
      { kind: "text", text: "a" },
      { kind: "field", field: "username", raw: "{username}" },
      { kind: "text", text: "b" },
      { kind: "field", field: "password", raw: "{PASSWORD}" },
    ]);
    expect(tokenize("{Title}{URL}{notes}").map((t) => t.kind)).toEqual([
      "field",
      "field",
      "field",
    ]);
  });

  it("reads custom fields with any name that is not empty", () => {
    expect(tokenize("{S:Host}{s:a b{c}")).toEqual([
      { kind: "custom", name: "Host", raw: "{S:Host}" },
      { kind: "custom", name: "a b{c", raw: "{s:a b{c}" },
    ]);
    expect(tokenize("{S:}")).toEqual([{ kind: "text", text: "{S:}" }]);
  });

  it("reads both forms of REF and makes the ID canonical", () => {
    expect(tokenize("{REF:P@I:0192B3A4000070008000000000000001}")).toEqual([
      {
        kind: "ref",
        field: "P",
        id: "0192b3a4-0000-7000-8000-000000000001",
        raw: "{REF:P@I:0192B3A4000070008000000000000001}",
      },
    ]);
    expect(
      tokenize("{ref:a@i:0192b3a4-0000-7000-8000-000000000001}")[0],
    ).toMatchObject({ kind: "ref", field: "A" });
  });

  it("keeps unknown and malformed placeholders as text", () => {
    for (const text of [
      "{FOO}",
      "{REF:X@I:0192b3a4000070008000000000000001}",
      "{REF:T@I:0192b3a4}",
      "{REF:T@U:0192b3a4000070008000000000000001}",
      "{USERNAME",
      "USERNAME}",
      "{}",
      "{constructor}",
      "{__proto__}",
      "{toString}",
    ])
      expect(tokenize(text), text).toEqual([{ kind: "text", text }]);
  });

  it("starts again after a `{` that opens no placeholder", () => {
    expect(tokenize("{{USERNAME}}")).toEqual([
      { kind: "text", text: "{" },
      { kind: "field", field: "username", raw: "{USERNAME}" },
      { kind: "text", text: "}" },
    ]);
    expect(tokenize("{a{TITLE}")).toEqual([
      { kind: "text", text: "{a" },
      { kind: "field", field: "title", raw: "{TITLE}" },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(tokenize("")).toEqual([]);
  });
});
