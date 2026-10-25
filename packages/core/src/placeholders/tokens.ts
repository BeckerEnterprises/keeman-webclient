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

function placeholder(content: string, raw: string): Token | undefined {
  const lower = content.toLowerCase();
  if (STANDARD.has(lower))
    return { kind: "field", field: lower as StandardField, raw };
  if (/^s:/i.test(content) && content.length > 2)
    return { kind: "custom", name: content.slice(2), raw };
  const ref = REF.exec(content);
  if (ref)
    return {
      kind: "ref",
      field: (ref[1] ?? "").toUpperCase() as RefField,
      id: canonicalId(ref[2] ?? ""),
      raw,
    };
  return undefined;
}

/** Text and placeholders in order; adjacent text is merged. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let buffer = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) === "{") {
      const end = text.indexOf("}", i + 1);
      if (end > i) {
        const raw = text.slice(i, end + 1);
        const token = placeholder(text.slice(i + 1, end), raw);
        if (token) {
          if (buffer !== "") tokens.push({ kind: "text", text: buffer });
          buffer = "";
          tokens.push(token);
          i = end + 1;
          continue;
        }
      }
    }
    buffer += text.charAt(i);
    i++;
  }
  if (buffer !== "") tokens.push({ kind: "text", text: buffer });
  return tokens;
}
