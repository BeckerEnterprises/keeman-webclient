/**
 * Which attachments an entry references: those of its current
 * content and of every snapshot. The server keeps a blob until no version
 * of the entry needs it any more.
 */
import type { JsonObject } from "../crypto/bytes";
import { historyOf } from "../model/history";
import { own } from "../model/json";

/** One stored attachment element with its file key. */
export interface StoredAttachment {
  id: string;
  key: string;
  compression: "gzip" | "none";
  size: number;
}

function elements(content: unknown): unknown[] {
  if (typeof content !== "object" || content === null) return [];
  const list = own(content as JsonObject, "attachments");
  return Array.isArray(list) ? list : [];
}

function idOf(element: unknown): string | undefined {
  if (typeof element !== "object" || element === null) return undefined;
  const id = own(element as JsonObject, "id");
  return typeof id === "string" ? id : undefined;
}

/** IDs referenced by the entry or any snapshot of it. */
export function referencedAttachments(raw: JsonObject): Set<string> {
  const ids = new Set<string>();
  for (const content of [raw, ...historyOf(raw)])
    for (const element of elements(content)) {
      const id = idOf(element);
      if (id !== undefined) ids.add(id);
    }
  return ids;
}

/** Attachments the old version needed and the new one does not. */
export function unreferenced(before: JsonObject, after: JsonObject): string[] {
  const kept = referencedAttachments(after);
  return [...referencedAttachments(before)].filter((id) => !kept.has(id));
}

/**
 * The stored element of an attachment, from the current content first,
 * then the snapshots, newest first; only well-formed ones.
 */
export function storedAttachment(
  raw: JsonObject,
  id: string,
): StoredAttachment | undefined {
  for (const content of [raw, ...historyOf(raw)])
    for (const element of elements(content)) {
      if (idOf(element) !== id) continue;
      const item = element as JsonObject;
      const key = own(item, "key");
      const compression = own(item, "compression");
      const size = own(item, "size");
      if (
        typeof key === "string" &&
        (compression === "gzip" || compression === "none") &&
        typeof size === "number" &&
        Number.isSafeInteger(size) &&
        size >= 0
      )
        return { id, key, compression, size };
    }
  return undefined;
}
