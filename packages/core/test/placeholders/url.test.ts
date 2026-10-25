import { describe, expect, it } from "vitest";
import { tokenize, type Token } from "../../src/placeholders/tokens";
import {
  hasScheme,
  layout,
  type Item,
  type Position,
} from "../../src/placeholders/url";

/** The straightforward layout, one item per code point. */
const reference = (() => {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  type Literal = { literal: string };
  type Slot = Literal | { token: Exclude<Token, { kind: "text" }> };
  const isLiteral = (item: Slot | undefined, chars: string) =>
    item !== undefined && "literal" in item && chars.includes(item.literal);
  const literals = (text: string): Slot[] =>
    Array.from(text, (literal) => ({ literal }));
  const schemeEnd = (items: readonly Slot[]): number | undefined => {
    let prefix = "";
    for (const item of items) {
      if (!("literal" in item)) break;
      prefix += item.literal;
      if (item.literal === ":") break;
    }
    const match = scheme.exec(prefix);
    if (!match) return undefined;
    const end = match[0].length;
    const next = items[end];
    return next === undefined || isLiteral(next, "0123456789")
      ? undefined
      : end;
  };
  return {
    hasScheme: (text: string) => schemeEnd(literals(text)) !== undefined,
    layout(tokens: readonly Token[]) {
      let items: Slot[] = tokens.flatMap((token): Slot[] =>
        token.kind === "text" ? literals(token.text) : [{ token }],
      );
      let start = schemeEnd(items);
      if (start === undefined) {
        let marker = -1;
        for (let k = 0; k + 2 < items.length; k++)
          if (
            isLiteral(items[k], ":") &&
            isLiteral(items[k + 1], "/") &&
            isLiteral(items[k + 2], "/")
          )
            marker = k;
        if (items.slice(0, Math.max(0, marker)).some((i) => !("literal" in i)))
          return "placeholder_in_scheme" as const;
        items = [...literals("https://"), ...items];
        start = "https:".length;
      }
      const positions: Position[] = items.map(() => "path");
      let i = start;
      if (isLiteral(items[i], "/") && isLiteral(items[i + 1], "/")) {
        i += 2;
        let end = i;
        while (end < items.length && !isLiteral(items[end], "/?#")) end++;
        let at = -1;
        for (let k = i; k < end; k++) if (isLiteral(items[k], "@")) at = k;
        for (let k = i; k < end; k++)
          positions[k] = k < at ? "userinfo" : "host";
        i = end;
      }
      let position: Position = "path";
      for (; i < items.length; i++) {
        if (position === "path" && isLiteral(items[i], "?")) position = "query";
        else if (position !== "fragment" && isLiteral(items[i], "#"))
          position = "fragment";
        positions[i] = position;
      }
      return { items, positions };
    },
  };
})();

/** Text runs and placeholders with their positions, comparable. */
function shape(
  result:
    | string
    | { items: readonly (Item | { literal: string })[]; positions: Position[] },
): unknown {
  if (typeof result === "string") return result;
  const out: unknown[] = [];
  let run = "";
  result.items.forEach((item, k) => {
    if ("literal" in item) run += item.literal;
    else {
      out.push(run, [item.token.raw, result.positions[k]]);
      run = "";
    }
  });
  out.push(run);
  return out;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("URL layout", () => {
  it("places every placeholder exactly like the straightforward layout", () => {
    const pieces = [
      "https",
      "mailto",
      "ssh",
      ":",
      "/",
      "//",
      "://",
      "?",
      "#",
      "@",
      "x",
      "1",
      "8080",
      ".",
      "example.com",
      "{USERNAME}",
      "{S:Host}",
      "{REF:A@I:0192b3a4000070008000000000000001}",
      "{",
      "}",
      " ",
      "ſ",
      "\u{1F600}",
    ];
    const next = random(11);
    for (let run = 0; run < 5000; run++) {
      let text = "";
      const count = Math.floor(next() * 14);
      for (let k = 0; k < count; k++)
        text += pieces[Math.floor(next() * pieces.length)] ?? "";
      const tokens = tokenize(text);
      expect(shape(layout(tokens)), JSON.stringify(text)).toEqual(
        shape(reference.layout(tokens)),
      );
      expect(hasScheme(text), JSON.stringify(text)).toBe(
        reference.hasScheme(text),
      );
    }
  });

  it("agrees on separators and placeholders packed densely", () => {
    const fixed = [
      "{USERNAME}a://b:{S:Host}//c",
      "{USERNAME}a:/{S:Host}/",
      "https:{USERNAME}//x",
      "a:{USERNAME}",
      "//{USERNAME}@{S:Host}/p?{S:q}#{S:f}",
      "https://u@{USERNAME}@h/{S:p}",
      "x://y://{USERNAME}",
      "{USERNAME}://",
      "example.com:8080/{USERNAME}",
    ];
    for (const text of fixed) {
      const tokens = tokenize(text);
      expect(shape(layout(tokens)), text).toEqual(
        shape(reference.layout(tokens)),
      );
    }
    const pieces = [":", "/", "{USERNAME}", "{S:a}", "a", "1", "@", "?", "#"];
    const next = random(5);
    for (let run = 0; run < 20000; run++) {
      let text = "";
      const count = Math.floor(next() * 10);
      for (let k = 0; k < count; k++)
        text += pieces[Math.floor(next() * pieces.length)] ?? "";
      const tokens = tokenize(text);
      expect(shape(layout(tokens)), JSON.stringify(text)).toEqual(
        shape(reference.layout(tokens)),
      );
    }
  });

  it("stays linear for a long template", () => {
    const tokens = tokenize(`${"{".repeat(1 << 20)}}{USERNAME}`);
    const started = performance.now();
    const result = layout(tokens);
    // A few ms without coverage instrumentation (see tokens).
    expect(performance.now() - started).toBeLessThan(1000);
    expect(typeof result).toBe("object");
  });
});
