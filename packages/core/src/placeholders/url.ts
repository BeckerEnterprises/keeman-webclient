/**
 * Splitting a URL template: placeholders are opaque items, the
 * text around them decides the scheme and the position of every
 * placeholder, and the position decides how its value is encoded.
 */
import type { Token } from "./tokens";

export type Placeholder = Exclude<Token, { kind: "text" }>;
export type Item = { literal: string } | { token: Placeholder };
export type Position = "userinfo" | "host" | "path" | "query" | "fragment";

export interface Layout {
  items: Item[];
  /** Position of each item; template text keeps its characters anyway. */
  positions: Position[];
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HOST_FORBIDDEN = /[\t\n\r /?#@]/;

function isLiteral(item: Item | undefined, chars: string): boolean {
  return (
    item !== undefined && "literal" in item && chars.includes(item.literal)
  );
}

/** One item per code point; only ASCII characters separate parts. */
function literals(text: string): Item[] {
  return Array.from(text, (literal) => ({ literal }));
}

/** Template text as one item per code point, placeholders as one item. */
export function itemsOf(tokens: readonly Token[]): Item[] {
  return tokens.flatMap((token): Item[] =>
    token.kind === "text" ? literals(token.text) : [{ token }],
  );
}

/**
 * Items up to and including the scheme's colon: text only, and
 * after the colon neither the end nor a digit (`example.com:8080`).
 */
function schemeEnd(items: readonly Item[]): number | undefined {
  let prefix = "";
  for (const item of items) {
    if (!("literal" in item)) break;
    prefix += item.literal;
    if (item.literal === ":") break;
  }
  const match = SCHEME.exec(prefix);
  if (!match) return undefined;
  const end = match[0].length;
  const next = items[end];
  return next === undefined || isLiteral(next, "0123456789") ? undefined : end;
}

/** Does a resolved value bring its own scheme? */
export function hasScheme(text: string): boolean {
  return schemeEnd(literals(text)) !== undefined;
}

/** Scheme or `https://`, then the position of every item. */
export function layout(
  template: readonly Item[],
): Layout | "placeholder_in_scheme" {
  let items = [...template];
  let start = schemeEnd(items);
  if (start === undefined) {
    let marker = -1;
    for (let k = 0; k + 2 < items.length; k++) {
      if (
        isLiteral(items[k], ":") &&
        isLiteral(items[k + 1], "/") &&
        isLiteral(items[k + 2], "/")
      )
        marker = k;
    }
    if (items.slice(0, Math.max(0, marker)).some((i) => !("literal" in i)))
      return "placeholder_in_scheme";
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
    for (let k = i; k < end; k++) positions[k] = k < at ? "userinfo" : "host";
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
