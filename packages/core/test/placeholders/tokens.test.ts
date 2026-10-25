import { describe, expect, it } from "vitest";
import { tokenize, type Token } from "../../src/placeholders/tokens";

/** The straightforward reading the fast one must match exactly. */
function reference(text: string): Token[] {
  const standard = new Set(["title", "username", "password", "url", "notes"]);
  const ref =
    /^ref:([tupan])@i:([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const canonical = (id: string) => {
    const hex = id.replaceAll("-", "").toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const placeholder = (content: string, raw: string): Token | undefined => {
    const lower = content.toLowerCase();
    if (standard.has(lower))
      return { kind: "field", field: lower as "title", raw };
    if (/^s:/i.test(content) && content.length > 2)
      return { kind: "custom", name: content.slice(2), raw };
    const match = ref.exec(content);
    return match
      ? {
          kind: "ref",
          field: (match[1] ?? "").toUpperCase() as "T",
          id: canonical(match[2] ?? ""),
          raw,
        }
      : undefined;
  };
  const tokens: Token[] = [];
  let buffer = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "{") {
      const end = text.indexOf("}", i + 1);
      const token =
        end > i
          ? placeholder(text.slice(i + 1, end), text.slice(i, end + 1))
          : undefined;
      if (token) {
        if (buffer !== "") tokens.push({ kind: "text", text: buffer });
        buffer = "";
        tokens.push(token);
        i = end + 1;
        continue;
      }
    }
    buffer += text.charAt(i);
    i++;
  }
  if (buffer !== "") tokens.push({ kind: "text", text: buffer });
  return tokens;
}

/** A small deterministic generator, so a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

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

  it("reads exactly like the straightforward reading", () => {
    const pieces = [
      "{",
      "}",
      "{",
      "s:",
      "S:",
      "ref:p@i:",
      "REF:A@I:",
      "0192b3a4000070008000000000000001",
      "0192B3A4-0000-7000-8000-000000000001",
      "title",
      "UserName",
      "url",
      "x",
      " ",
      "ſ:",
      "İ",
      "\u212A",
    ];
    const next = random(7);
    for (let run = 0; run < 3000; run++) {
      let text = "";
      const count = Math.floor(next() * 12);
      for (let k = 0; k < count; k++)
        text += pieces[Math.floor(next() * pieces.length)] ?? "";
      expect(tokenize(text), JSON.stringify(text)).toEqual(reference(text));
    }
  });

  it("stays linear with many { before one }", () => {
    const cases = [
      "{".repeat(1 << 20) + "}",
      "{x".repeat(1 << 19) + "}",
      "{ref:p@i:".repeat(1 << 17) + "}",
      "{s:".repeat(1 << 18),
      "{".repeat(1 << 20),
    ];
    for (const text of cases) {
      const started = performance.now();
      const tokens = tokenize(text);
      // About 25 ms without coverage instrumentation; the limit holds with
      // it and is still far below the minutes a quadratic reading takes.
      expect(performance.now() - started).toBeLessThan(1000);
      expect(tokens.length).toBeGreaterThan(0);
    }
  });
});
