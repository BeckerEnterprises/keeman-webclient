/**
 * Custom icons: the `icon` objects of a vault form its icon
 * library. Readers check the PNG themselves, because a member's client may
 * skip the re-encoding, and compute the hash for deduplication. Image work
 * is the app's job; the core only takes finished PNG bytes.
 */
import {
  fromBase64Url,
  isJsonObject,
  toBase64Url,
  toHex,
  type JsonObject,
} from "../crypto/bytes";
import { sodium } from "../crypto/sodium";
import { historyOf } from "./history";
import { clone, own, setOwn } from "./json";
import {
  inspectBase,
  OBJECT_SCHEMA,
  parseIconRef,
  type Inspected,
  type Stamp,
} from "./vault";

export const ICON_SIZE = 64;
/** Largest PNG of an icon object. */
export const MAX_ICON_BYTES = 32_768;
/** Longest name of an uploaded icon, in code points. */
const MAX_UPLOAD_NAME = 64;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Length 13 and type `IHDR` of the first chunk. */
const IHDR = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

export type IconSource =
  { type: "upload" } | { type: "favicon"; origin: string } | { type: "kdbx" };

export interface Icon {
  name: string;
  /** Checked canonical Base64url of the PNG. */
  data: string;
  /** BLAKE2b-256 of the PNG bytes as hex, computed by the reader. */
  hash: string;
  source: IconSource | null;
}

/** PNG signature and a first `IHDR` chunk with 64 × 64. */
export function isIconPng(png: Uint8Array): boolean {
  if (png.length < 24 || png.length > MAX_ICON_BYTES) return false;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return (
    SIGNATURE.every((byte, i) => png[i] === byte) &&
    IHDR.every((byte, i) => png[8 + i] === byte) &&
    view.getUint32(16) === ICON_SIZE &&
    view.getUint32(20) === ICON_SIZE
  );
}

export function iconHash(png: Uint8Array): string {
  return toHex(sodium().crypto_generichash(32, png, null));
}

/** The checked PNG bytes of `data`, or `undefined`. */
function pngOf(data: unknown): Uint8Array | undefined {
  if (typeof data !== "string" || data.length > 43_691) return undefined;
  try {
    const png = fromBase64Url(data);
    return isIconPng(png) ? png : undefined;
  } catch {
    return undefined;
  }
}

function parseSource(value: unknown): IconSource | null {
  if (!isJsonObject(value)) return null;
  const type = own(value, "type");
  if (type === "upload" || type === "kdbx") return { type };
  const origin = own(value, "origin");
  if (type === "favicon" && typeof origin === "string") return { type, origin };
  return null;
}

/** `icon`: `mime` and `data` are required. */
export function inspectIcon(raw: JsonObject): Inspected<Icon> {
  return inspectBase(raw, (r) => {
    const data = own(r, "data");
    const png = own(r, "mime") === "image/png" ? pngOf(data) : undefined;
    if (!png) return undefined;
    const name = own(r, "name");
    return {
      name: typeof name === "string" ? name : "",
      data: data as string,
      hash: iconHash(png),
      source: parseSource(own(r, "source")),
    };
  });
}

/** `data:` URL of checked icon data: standard Base64. */
export function iconDataUrl(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return `data:image/png;base64,${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
}

export class InvalidIcon extends Error {
  constructor() {
    super("Not a 64 × 64 PNG of at most 32 KiB");
    this.name = "InvalidIcon";
  }
}

/** A new icon object; throws `InvalidIcon` for anything but an icon PNG. */
export function newIcon(
  input: { png: Uint8Array; name: string; source: IconSource },
  stamp: Stamp,
): JsonObject {
  if (!isIconPng(input.png)) throw new InvalidIcon();
  return {
    schema: OBJECT_SCHEMA,
    seq: 1,
    name: input.name,
    mime: "image/png",
    data: toBase64Url(input.png),
    width: ICON_SIZE,
    height: ICON_SIZE,
    hash: iconHash(input.png),
    source: { ...input.source },
    created: stamp.now,
    modified: stamp.now,
    modifiedBy: stamp.userId,
  };
}

/** Name of an uploaded icon: the file name without extension. */
export function uploadIconName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  const name = Array.from(stem).slice(0, MAX_UPLOAD_NAME).join("").trim();
  return name === "" ? "Icon" : name;
}

/**
 * `scheme://host[:port]/` of an http or https URL, the only part that goes
 * to the favicon proxy. Without a scheme `https://` is assumed;
 * `host:port` is no scheme.
 */
export function faviconTarget(url: string): string | undefined {
  const text = url.trim();
  const scheme =
    text.includes("://") || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text);
  try {
    const parsed = new URL(scheme ? text : `https://${text}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    return parsed.hostname === ""
      ? undefined
      : `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return undefined;
  }
}

/** Name of a favicon: the host of its origin. */
export function faviconIconName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Fields of `vault_meta`, groups, entries and snapshots with an `IconRef`. */
const REF_FIELDS = ["icon", "defaultEntryIcon"] as const;

/** Raw objects that may carry icon references: the object and its snapshots. */
function holders(raw: JsonObject): JsonObject[] {
  return [raw, ...historyOf(raw).filter(isJsonObject)];
}

/** IDs of the custom icons an object or its snapshots refer to. */
export function iconRefs(raw: JsonObject): Set<string> {
  const ids = new Set<string>();
  for (const holder of holders(raw))
    for (const field of REF_FIELDS) {
      const ref = parseIconRef(own(holder, field));
      if (ref?.type === "custom") ids.add(ref.id);
    }
  return ids;
}

/**
 * A copy with custom references renamed by `ids`; only `id` changes, other
 * keys of the `IconRef` stay.
 */
export function renameIconRefs(
  raw: JsonObject,
  ids: ReadonlyMap<string, string>,
): JsonObject {
  const copy = clone(raw);
  for (const holder of holders(copy))
    for (const field of REF_FIELDS) {
      const value = own(holder, field);
      const ref = parseIconRef(value);
      const renamed = ref?.type === "custom" ? ids.get(ref.id) : undefined;
      if (renamed !== undefined && isJsonObject(value))
        setOwn(value, "id", renamed);
    }
  return copy;
}
