/**
 * `{REF:<F>@I:<UUID>}` placeholders: IDs in KeePass form
 * (32 hex digits) or with dashes. Rewritten references use the KeePass form.
 */
import { isJsonObject, type JsonObject } from "../crypto/bytes";
import { clone, own, setOwn } from "../model/json";

// Placeholders are case-insensitive.
const REF = /\{REF:([a-z])@I:([0-9a-f]{32}|[0-9a-f-]{36})\}/gi;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The canonical form (lowercase, dashes) of a REF target, if valid. */
export function canonicalRefId(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (DASHED.test(lower)) return lower;
  if (!/^[0-9a-f]{32}$/.test(lower)) return undefined;
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

/** 32 uppercase hex digits, as KeePass writes references. */
export function keepassRefId(id: string): string {
  return id.replaceAll("-", "").toUpperCase();
}

/** Targets referenced by `{REF:…@I:…}` in `text`, canonical. */
export function refTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(REF)) {
    const id = canonicalRefId(match[2] ?? "");
    if (id !== undefined) targets.push(id);
  }
  return targets;
}

/**
 * Replaces references whose target `map` changes; others stay as written.
 * `map` gets and returns canonical IDs.
 */
export function rewriteRefs(text: string, map: (id: string) => string): string {
  if (!text.includes("{")) return text;
  return text.replace(REF, (match, field: string, target: string) => {
    const id = canonicalRefId(target);
    if (id === undefined) return match;
    const next = map(id);
    return next === id ? match : `{REF:${field}@I:${keepassRefId(next)}}`;
  });
}

/** All `{REF:…@I:…}` in KeePass form, for the export. */
export function keepassRefs(text: string): string {
  if (!text.includes("{")) return text;
  return text.replace(REF, (match, field: string, target: string) => {
    const id = canonicalRefId(target);
    return id === undefined ? match : `{REF:${field}@I:${keepassRefId(id)}}`;
  });
}

const STRING_FIELDS = ["title", "username", "password", "url", "notes", "otp"];

function rewriteState(raw: JsonObject, map: (id: string) => string): void {
  for (const key of STRING_FIELDS) {
    const value = own(raw, key);
    if (typeof value === "string") setOwn(raw, key, rewriteRefs(value, map));
  }
  const fields = own(raw, "fields");
  if (Array.isArray(fields))
    for (const field of fields as unknown[]) {
      const value = isJsonObject(field) ? own(field, "value") : undefined;
      if (isJsonObject(field) && typeof value === "string")
        setOwn(field, "value", rewriteRefs(value, map));
    }
}

/** An entry with references rewritten in its state and all snapshots. */
export function entryWithRefs(
  raw: JsonObject,
  map: (id: string) => string,
): JsonObject {
  const next = clone(raw);
  rewriteState(next, map);
  const history = own(next, "history");
  if (Array.isArray(history))
    for (const snapshot of history as unknown[])
      if (isJsonObject(snapshot)) rewriteState(snapshot, map);
  return next;
}
