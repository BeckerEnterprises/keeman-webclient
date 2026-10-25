/**
 * Splitting a URL template: placeholders are opaque items, the
 * text around them decides the scheme and the position of every
 * placeholder, and the position decides how its value is encoded.
 */
import type { Token } from "./tokens";

export type Placeholder = Exclude<Token, { kind: "text" }>;
/** Template text in runs, placeholders on their own. */
export type Item = { literal: string } | { token: Placeholder };
export type Position = "userinfo" | "host" | "path" | "query" | "fragment";

export interface Layout {
  items: Item[];
  /** Position of each placeholder item; text runs keep their characters. */
  positions: Position[];
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HOST_FORBIDDEN = /[\t\n\r /?#@]/;
const DIGIT = /^[0-9]$/;

/**
 * A template as its text with the placeholders between characters:
 * placeholder `n` stands before `text[at[n]]`. Only ASCII characters
 * separate parts, so offsets in UTF-16 units decide exactly as counting
 * code points would, and the work stays linear in the length.
 */
interface Flat {
  text: string;
  placeholders: Placeholder[];
  at: number[];
  /** The offsets that have a placeholder before them. */
  taken: Set<number>;
}

function flatten(tokens: readonly Token[]): Flat {
  let text = "";
  const placeholders: Placeholder[] = [];
  const at: number[] = [];
  for (const token of tokens) {
    if (token.kind === "text") text += token.text;
    else {
      placeholders.push(token);
      at.push(text.length);
    }
  }
  return { text, placeholders, at, taken: new Set(at) };
}

/**
 * End of the scheme, after its colon: text only, before the first
 * placeholder (`first`), and after the colon neither the end nor a digit
 * (`example.com:8080`). A placeholder right after the colon is neither.
 */
function schemeEnd(text: string, first: number): number | undefined {
  const colon = text.indexOf(":");
  const prefix = text.slice(
    0,
    Math.min(first, colon === -1 ? text.length : colon + 1),
  );
  const match = SCHEME.exec(prefix);
  if (!match) return undefined;
  const end = match[0].length;
  if (first === end) return end;
  const next = text.charAt(end);
  return next === "" || DIGIT.test(next) ? undefined : end;
}

/** Does a resolved value bring its own scheme? */
export function hasScheme(text: string): boolean {
  return schemeEnd(text, Infinity) !== undefined;
}

/** First index from `from` on whose character is one of `chars`, or -1. */
function firstOf(text: string, chars: string, from: number): number {
  for (let k = from; k < text.length; k++)
    if (chars.includes(text.charAt(k))) return k;
  return -1;
}

/** Scheme or `https://`, then the position of every placeholder. */
export function layout(
  tokens: readonly Token[],
): Layout | "placeholder_in_scheme" {
  const flat = flatten(tokens);
  let { text, at, taken } = flat;
  let start = schemeEnd(text, at[0] ?? Infinity);
  if (start === undefined) {
    // The last `://` with no placeholder inside; a placeholder before it
    // would stand in the scheme.
    let marker = text.lastIndexOf("://");
    while (marker >= 0 && (taken.has(marker + 1) || taken.has(marker + 2)))
      marker = marker === 0 ? -1 : text.lastIndexOf("://", marker - 1);
    const first = at[0];
    if (marker >= 0 && first !== undefined && first <= marker)
      return "placeholder_in_scheme";
    text = `https://${text}`;
    at = at.map((offset) => offset + "https://".length);
    taken = new Set(at);
    start = "https:".length;
  }
  const positions: Position[] = flat.placeholders.map(() => "path");
  // Placeholders up to `authorityEnd` are in the authority; the path
  // starts at `scan`.
  let scan = start;
  let authorityEnd = -1;
  if (
    !taken.has(start) &&
    text.charAt(start) === "/" &&
    !taken.has(start + 1) &&
    text.charAt(start + 1) === "/"
  ) {
    const from = start + 2;
    const found = firstOf(text, "/?#", from);
    authorityEnd = found === -1 ? text.length : found;
    const sign = text.lastIndexOf("@", authorityEnd - 1);
    const userinfoEnd = sign >= from ? sign : -1;
    at.forEach((offset, n) => {
      if (offset >= from && offset <= authorityEnd)
        positions[n] = offset <= userinfoEnd ? "userinfo" : "host";
    });
    scan = authorityEnd;
  }
  const query = text.indexOf("?", scan);
  const fragment = text.indexOf("#", scan);
  at.forEach((offset, n) => {
    if (offset < scan || offset <= authorityEnd) return;
    if (fragment !== -1 && fragment < offset) positions[n] = "fragment";
    else if (query !== -1 && query < offset) positions[n] = "query";
  });
  // Items: text runs between the placeholders.
  const items: Item[] = [];
  const itemPositions: Position[] = [];
  let previous = 0;
  flat.placeholders.forEach((token, n) => {
    const offset = at[n] ?? 0;
    if (offset > previous) {
      items.push({ literal: text.slice(previous, offset) });
      itemPositions.push("path");
    }
    items.push({ token });
    itemPositions.push(positions[n] ?? "path");
    previous = offset;
  });
  if (previous < text.length) {
    items.push({ literal: text.slice(previous) });
    itemPositions.push("path");
  }
  return { items, positions: itemPositions };
}

/** Host and port take values raw, but not these characters. */
export function validHost(value: string): boolean {
  return !HOST_FORBIDDEN.test(value);
}

/**
 * Encodes a value for every position but the host. Throws `URIError` for lone
 * surrogates, which is `invalid_url`.
 */
export function encodeFor(position: Position, value: string): string {
  if (position === "host") return value;
  const encoded = encodeURIComponent(value);
  return position === "path"
    ? encoded.replace(/%2F/g, "/").replace(/%3A/g, ":").replace(/%40/g, "@")
    : encoded;
}
