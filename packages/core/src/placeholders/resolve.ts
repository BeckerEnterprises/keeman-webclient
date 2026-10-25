/**
 * Resolving placeholders: `{REF}` in every field, all placeholders
 * in the URL. Results keep track of secret parts (masked in the display),
 * cycles and missing targets.
 */
import { REF_FIELDS, tokenize, type StandardField, type Token } from "./tokens";
import {
  encodeFor,
  hasScheme,
  layout,
  validHost,
  type Placeholder,
} from "./url";

export interface PlaceholderEntry {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  fields: readonly { name: string; value: string; protected: boolean }[];
}

/** Live, valid entries of one vault by canonical ID. */
export interface PlaceholderLookup {
  entry(id: string): PlaceholderEntry | undefined;
}

export type PlaceholderWarning = "cycle" | "missing" | "too_complex";
export type UrlError =
  "placeholder_in_scheme" | "invalid_host" | "invalid_url" | "too_complex";
export type SchemeProblem = "scheme_forbidden" | "scheme_not_allowed";
export type TextField = StandardField | { custom: number };

export interface ResolvedText {
  value: string;
  /** Secret parts as `••••••`. */
  display: string;
  secret: boolean;
  /** The stored text contains a `{REF}` (the “Referenz” mark). */
  refs: boolean;
  warnings: PlaceholderWarning[];
}

export type ResolvedUrl =
  | {
      ok: true;
      url: string;
      display: string;
      secret: boolean;
      warnings: PlaceholderWarning[];
    }
  | { ok: false; error: UrlError; warnings: PlaceholderWarning[] };

/** Never allowed, not even by setting. */
export const FORBIDDEN_SCHEMES: readonly string[] = [
  "javascript",
  "data",
  "file",
  "blob",
  "vbscript",
  "about",
];

const MAX_DEPTH = 10;
/** Limits of one resolution, so that a prepared entry cannot freeze the client. */
const MAX_REFS = 1000;
const MAX_CHARS = 1_048_576;
const MASK = "••••••";

/** Thrown when a resolution exceeds a limit; caught at the entry points. */
class TooComplex extends Error {}

interface Part {
  text: string;
  /** From a password, a protected field or a secret REF URL. */
  secret: boolean;
  /** From notes: kept out of list views like secrets. */
  notes: boolean;
}

interface Context {
  lookup: PlaceholderLookup;
  /** `<entry>|<field>` pairs being resolved. */
  stack: string[];
  depth: number;
  warnings: Set<PlaceholderWarning>;
  /** List views: only T, U and A without secrets or notes. */
  restricted: boolean;
  /** `{REF}` inserted so far, with all levels. */
  refs: number;
  /** Characters of text taken into the result so far. */
  chars: number;
  /** Tokens of the values used, by `<entry>|<field>`. */
  tokens: Map<string, Token[]>;
}

type UrlParts = { ok: true; parts: Part[] } | { ok: false; error: UrlError };

function fold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

function plain(text: string): Part {
  return { text, secret: false, notes: false };
}

/** Text taken into the result: counted against the limit. */
function piece(context: Context, text: string): Part {
  context.chars += text.length;
  if (context.chars > MAX_CHARS) throw new TooComplex();
  return plain(text);
}

function tokensOf(context: Context, key: string, text: string): Token[] {
  let tokens = context.tokens.get(key);
  if (!tokens) {
    tokens = tokenize(text);
    context.tokens.set(key, tokens);
  }
  return tokens;
}

/** An empty value keeps its origin, too. */
function mark(parts: readonly Part[], flag: "secret" | "notes"): Part[] {
  const marked = parts.length === 0 ? [plain("")] : parts;
  return marked.map((part) => ({ ...part, [flag]: true }));
}

function join(parts: readonly Part[]): string {
  return parts.map((part) => part.text).join("");
}

/** Each run of secret parts becomes one mask. */
function display(parts: readonly Part[]): string {
  let out = "";
  let masked = false;
  for (const part of parts) {
    if (part.secret && !masked) out += MASK;
    else if (!part.secret) out += part.text;
    masked = part.secret;
  }
  return out;
}

function within<T>(context: Context, key: string, run: () => T): T | undefined {
  if (context.stack.includes(key)) {
    context.warnings.add("cycle");
    return undefined;
  }
  context.stack.push(key);
  try {
    return run();
  } finally {
    context.stack.pop();
  }
}

/** A stored value (`key`: `<entry>|<field>`): only `{REF}` is resolved. */
function textParts(text: string, context: Context, key: string): Part[] {
  return tokensOf(context, key, text).flatMap((token) => {
    if (token.kind === "text") return [piece(context, token.text)];
    const parts = token.kind === "ref" ? refParts(token, context) : undefined;
    return parts ?? [piece(context, token.raw)];
  });
}

/** The value of a `{REF}`, or `undefined` if the placeholder stays. */
function refParts(
  token: Extract<Token, { kind: "ref" }>,
  context: Context,
): Part[] | undefined {
  if (context.restricted && !["T", "U", "A"].includes(token.field))
    return undefined;
  const target = context.lookup.entry(token.id);
  if (!target) {
    context.warnings.add("missing");
    return undefined;
  }
  if (context.depth >= MAX_DEPTH) {
    context.warnings.add("cycle");
    return undefined;
  }
  const field = REF_FIELDS[token.field];
  context.refs++;
  if (context.refs > MAX_REFS) throw new TooComplex();
  context.depth++;
  try {
    return within(context, `${token.id}|${field}`, () => {
      if (token.field === "A") return referencedUrl(token.id, target, context);
      const parts = textParts(target[field], context, `${token.id}|${field}`);
      if (token.field === "P") return mark(parts, "secret");
      return token.field === "N" ? mark(parts, "notes") : parts;
    });
  } finally {
    context.depth--;
  }
}

/** `{REF:A}`: the target's resolved URL, without the scheme check. */
function referencedUrl(
  id: string,
  target: PlaceholderEntry,
  context: Context,
): Part[] | undefined {
  const restricted = context.restricted;
  context.restricted = false;
  try {
    const result = urlParts(id, target, context);
    if (!result.ok) {
      context.warnings.add("missing");
      return undefined;
    }
    const secret = result.parts.some((p) => p.secret);
    if (restricted && (secret || result.parts.some((p) => p.notes)))
      return undefined;
    return secret ? mark(result.parts, "secret") : result.parts;
  } finally {
    context.restricted = restricted;
  }
}

/** A placeholder of a URL template, or `undefined` if it stays. */
function valueParts(
  token: Placeholder,
  entryId: string,
  entry: PlaceholderEntry,
  context: Context,
): Part[] | undefined {
  if (token.kind === "ref") return refParts(token, context);
  if (token.kind === "field") {
    return within(context, `${entryId}|${token.field}`, () => {
      const parts = textParts(
        entry[token.field],
        context,
        `${entryId}|${token.field}`,
      );
      if (token.field === "password") return mark(parts, "secret");
      return token.field === "notes" ? mark(parts, "notes") : parts;
    });
  }
  const name = fold(token.name);
  const field = entry.fields.find((f) => fold(f.name) === name);
  if (!field) {
    context.warnings.add("missing");
    return undefined;
  }
  return within(context, `${entryId}|S:${name}`, () => {
    const parts = textParts(field.value, context, `${entryId}|S:${name}`);
    return field.protected ? mark(parts, "secret") : parts;
  });
}

/** Resolves a URL template, without the scheme check. */
function urlParts(
  entryId: string,
  entry: PlaceholderEntry,
  context: Context,
): UrlParts {
  const tokens = tokensOf(context, `${entryId}|url template`, entry.url.trim());
  const [first] = tokens;
  const single =
    tokens.length === 1 && first?.kind !== "text" ? first : undefined;
  const singleValue = single && valueParts(single, entryId, entry, context);
  let parts: Part[] = [];
  if (singleValue !== undefined) {
    parts = hasScheme(join(singleValue))
      ? singleValue
      : [piece(context, "https://"), ...singleValue];
  } else {
    const split = layout(tokens);
    if (typeof split === "string") return { ok: false, error: split };
    for (const [index, item] of split.items.entries()) {
      if ("literal" in item) {
        parts.push(piece(context, item.literal));
        continue;
      }
      const value =
        item.token === single
          ? undefined // the single placeholder stays
          : valueParts(item.token, entryId, entry, context);
      const position = split.positions[index] ?? "path";
      if (value === undefined) parts.push(piece(context, item.token.raw));
      else if (position === "host" && !validHost(join(value)))
        return { ok: false, error: "invalid_host" };
      else {
        try {
          for (const part of value)
            parts.push({ ...part, text: encodeFor(position, part.text) });
        } catch {
          return { ok: false, error: "invalid_url" };
        }
      }
    }
  }
  try {
    new URL(join(parts));
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  return { ok: true, parts };
}

function contextFor(lookup: PlaceholderLookup, restricted: boolean): Context {
  return {
    lookup,
    stack: [],
    depth: 0,
    warnings: new Set(),
    restricted,
    refs: 0,
    chars: 0,
    tokens: new Map(),
  };
}

function warningsOf(context: Context): PlaceholderWarning[] {
  return [...context.warnings].sort();
}

/**
 * A field of an entry with `{REF}` resolved. `restricted` is for
 * list views: only T, U and A without secrets or notes.
 */
export function resolveText(
  entryId: string,
  field: TextField,
  lookup: PlaceholderLookup,
  options: { restricted?: boolean } = {},
): ResolvedText {
  const entry = lookup.entry(entryId);
  const custom =
    typeof field === "object" ? entry?.fields[field.custom] : undefined;
  const text =
    typeof field === "object" ? (custom?.value ?? "") : (entry?.[field] ?? "");
  const secret = field === "password" || custom?.protected === true;
  const context = contextFor(lookup, options.restricted ?? false);
  const key =
    typeof field === "object"
      ? `${entryId}|S:${fold(custom?.name ?? "")}`
      : `${entryId}|${field}`;
  context.stack.push(key);
  // Read once: `textParts` takes the same tokens from the cache.
  const refs =
    text.includes("{") &&
    tokensOf(context, key, text).some((t) => t.kind === "ref");
  let parts: Part[];
  try {
    parts = text.includes("{")
      ? textParts(text, context, key)
      : [piece(context, text)];
  } catch (error) {
    if (!(error instanceof TooComplex)) throw error;
    // Too many references: the stored value, unresolved.
    return {
      value: text,
      display: secret ? MASK : text,
      secret,
      refs,
      warnings: ["too_complex"],
    };
  }
  if (secret) parts = mark(parts, "secret");
  return {
    value: join(parts),
    display: display(parts),
    secret: parts.some((p) => p.secret),
    refs,
    warnings: warningsOf(context),
  };
}

/** The URL of an entry, without the scheme check. */
export function resolveUrl(
  entryId: string,
  lookup: PlaceholderLookup,
): ResolvedUrl {
  const entry = lookup.entry(entryId);
  if (!entry) return { ok: false, error: "invalid_url", warnings: [] };
  const context = contextFor(lookup, false);
  context.stack.push(`${entryId}|url`);
  let result: UrlParts;
  try {
    result = urlParts(entryId, entry, context);
  } catch (error) {
    if (!(error instanceof TooComplex)) throw error;
    return { ok: false, error: "too_complex", warnings: [] };
  }
  const warnings = warningsOf(context);
  if (!result.ok) return { ok: false, error: result.error, warnings };
  return {
    ok: true,
    url: join(result.parts),
    display: display(result.parts),
    secret: result.parts.some((p) => p.secret),
    warnings,
  };
}

/**
 * May a resolved URL be opened? The scheme is the one the
 * browser's URL parser sees.
 */
export function checkScheme(
  url: string,
  allowed: readonly string[],
): SchemeProblem | undefined {
  let scheme: string;
  try {
    scheme = new URL(url).protocol.slice(0, -1);
  } catch {
    return "scheme_not_allowed";
  }
  if (FORBIDDEN_SCHEMES.includes(scheme)) return "scheme_forbidden";
  return allowed.some((s) => s.toLowerCase() === scheme)
    ? undefined
    : "scheme_not_allowed";
}
