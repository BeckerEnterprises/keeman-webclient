/**
 * Recognising placeholders: `{` content `}`, case-insensitive.
 * Content that matches no form leaves its `{` as text, and recognition
 * goes on with the next character.
 */

export type StandardField = "title" | "username" | "password" | "url" | "notes";
export type RefField = "T" | "U" | "P" | "A" | "N";

export type Token =
  | { kind: "text"; text: string }
  | { kind: "field"; field: StandardField; raw: string }
  | { kind: "custom"; name: string; raw: string }
  | { kind: "ref"; field: RefField; id: string; raw: string };

const STANDARD: ReadonlySet<string> = new Set<StandardField>([
  "title",
  "username",
  "password",
  "url",
  "notes",
]);
const REF =
  /^ref:([tupan])@i:([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** The longest standard name (`username`, `password`). */
const STANDARD_MAX = 8;
/** `ref:X@i:` followed by an ID of 32 or 36 characters. */
const REF_LENGTHS: ReadonlySet<number> = new Set([40, 44]);

/** The field a REF letter names. */
export const REF_FIELDS: Readonly<Record<RefField, StandardField>> = {
  T: "title",
  U: "username",
  P: "password",
  A: "url",
  N: "notes",
};

function canonicalId(id: string): string {
  const hex = id.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The placeholder in `text` between `start` and `end` (the content without
 * braces). Length and prefix decide before anything is copied, so a value
 * with many `{` before one `}` is read in linear time.
 */
function placeholder(
  text: string,
  start: number,
  end: number,
): Token | undefined {
  const length = end - start;
  const raw = () => text.slice(start - 1, end + 1);
  if (length <= STANDARD_MAX) {
    const lower = text.slice(start, end).toLowerCase();
    if (STANDARD.has(lower))
      return { kind: "field", field: lower as StandardField, raw: raw() };
  }
  if (
    length > 2 &&
    (text.charAt(start) === "s" || text.charAt(start) === "S") &&
    text.charAt(start + 1) === ":"
  )
    return { kind: "custom", name: text.slice(start + 2, end), raw: raw() };
  if (REF_LENGTHS.has(length)) {
    const ref = REF.exec(text.slice(start, end));
    if (ref)
      return {
        kind: "ref",
        field: (ref[1] ?? "").toUpperCase() as RefField,
        id: canonicalId(ref[2] ?? ""),
        raw: raw(),
      };
  }
  return undefined;
}

/** Text and placeholders in order; adjacent text is merged. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Where the text not yet taken begins, and the next `}` after the
  // current `{` (`text.length` if there is none), found once for all `{`
  // before it.
  let start = 0;
  let close = -1;
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "{") {
      if (close <= i) {
        const found = text.indexOf("}", i + 1);
        close = found === -1 ? text.length : found;
      }
      const token =
        close < text.length ? placeholder(text, i + 1, close) : undefined;
      if (token) {
        if (i > start)
          tokens.push({ kind: "text", text: text.slice(start, i) });
        tokens.push(token);
        i = close + 1;
        start = i;
        continue;
      }
    }
    i++;
  }
  if (start < text.length)
    tokens.push({ kind: "text", text: text.slice(start) });
  return tokens;
}
