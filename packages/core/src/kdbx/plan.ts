/**
 * Planning a KDBX import: a pure function from the file read in
 * the worker to the objects to write and the report. Objects keep the
 * file's UUIDs; conflicts with the target are resolved while writing
 * (`sync/kdbx-import.ts`), which also rewrites `parentId` and `{REF}`.
 */
import { generateNKeysBetween } from "fractional-indexing";
import type { JsonObject } from "../crypto/bytes";
import { MAX_ATTACHMENTS, MAX_FIELDS } from "../model/entry";
import { referencedAttachments } from "../attachments/refs";
import { ENTRY_LIMIT, setHistory, utf8Length } from "../model/history";
import { iconHash, isIconPng, newIcon } from "../model/icon";
import { KEEPASS_ICONS } from "../model/icons";
import { OBJECT_SCHEMA, type IconRef, type Stamp } from "../model/vault";
import type { OtpProblem } from "../totp/uri";
import { convertOtp } from "./otp";
import type {
  KdbxAttachmentRef,
  KdbxEntryFile,
  KdbxEntryState,
  KdbxFile,
  KdbxGroupFile,
  KdbxIgnoredKind,
  KdbxString,
  KdbxTimes,
} from "./types";

const GROUP_LIMIT = 64 * 1024;
const META_LIMIT = 16 * 1024;
const MAX_NAME = 128;
const MAX_GROUP_NAME = 256;
const ZERO_UUID = "0".repeat(32);
/** Same length as a file key, so planned sizes are exact. */
export const PLANNED_KEY = "A".repeat(43);
/** MIME types by file extension. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
};
const STANDARD: Readonly<Record<string, string>> = {
  Title: "title",
  UserName: "username",
  Password: "password",
  URL: "url",
  Notes: "notes",
};
const RESERVED = new Set([
  "title",
  "username",
  "password",
  "url",
  "notes",
  "otp",
]);

export type KdbxImportMode = "vault" | "group";

export interface KdbxImportOptions {
  mode: KdbxImportMode;
  /** Vault mode: the name from the dialog. */
  name: string;
  /** Group mode: `historyMaxItems` of the target vault. */
  historyMaxItems: number;
  /** “Feld” or “Field”, in the language of the UI. */
  emptyFieldName: string;
  stamp: Stamp;
  newId: (label: string) => string;
  /** `attachment_max_bytes` of the server. */
  attachmentMaxBytes: number;
  /**
   * The file's custom icons by UUID, re-encoded by the app; one
   * that is missing here could not be read.
   */
  icons?: ReadonlyMap<string, Uint8Array>;
  /** Group mode: IDs of the target vault's icons by hash. */
  existingIcons?: ReadonlyMap<string, string>;
}

/** Group names below the KDBX root; empty for its direct children. */
export type KdbxPath = readonly string[];

/** Report lines: titles, paths and field names, never values. */
export type KdbxReportItem =
  | {
      kind: "field_renamed";
      path: KdbxPath;
      title: string;
      from: string;
      to: string;
    }
  | { kind: "fields_skipped"; path: KdbxPath; title: string; names: string[] }
  | { kind: "entry_skipped"; path: KdbxPath; title: string }
  | { kind: "tags_truncated"; path: KdbxPath; title: string }
  | { kind: "history_trimmed"; path: KdbxPath; title: string; dropped: number }
  | { kind: "group_truncated"; path: KdbxPath }
  | {
      kind: "attachment_too_large";
      path: KdbxPath;
      title: string;
      name: string;
    }
  | {
      kind: "attachments_skipped";
      path: KdbxPath;
      title: string;
      names: string[];
    }
  /** A custom icon that could not be read; `title` is `null` for a group. */
  | { kind: "custom_icon_unreadable"; path: KdbxPath; title: string | null }
  | { kind: "otp_kept"; path: KdbxPath; title: string; problem: OtpProblem }
  | { kind: "otp_unconverted"; path: KdbxPath; title: string; names: string[] };

export interface KdbxImportReport {
  groups: number;
  entries: number;
  items: KdbxReportItem[];
  /** Null or repeated UUIDs that got new IDs. */
  newIds: number;
  /** IDs changed because they were taken in the target; set by the job. */
  conflicts: number;
  /** Attachments to upload. */
  attachments: number;
  /** Custom icons to write. */
  icons: number;
  /** Group mode: the KDBX recycle bin, skipped with its content. */
  skippedBin: { groups: number; entries: number } | null;
  descriptionTruncated: boolean;
  extraRoots: number;
  ignored: Record<KdbxIgnoredKind, number>;
}

/** A binary of the file that becomes an attachment of an entry. */
export interface KdbxPlannedAttachment {
  id: string;
  /** Index into `binaries` of the plan. */
  binary: number;
  name: string;
  mime: string;
}

export interface KdbxPlannedObject {
  id: string;
  type: "group" | "entry" | "icon";
  /**
   * Content with the planned IDs; the job maps them before writing.
   * Attachment elements carry `PLANNED_KEY` until the upload.
   */
  raw: JsonObject;
  /** Entries: what the job uploads before writing them. */
  attachments?: KdbxPlannedAttachment[];
}

export interface KdbxImportPlan {
  mode: KdbxImportMode;
  /** Vault mode: the `vault_meta` content. */
  meta: JsonObject | null;
  /** The KDBX root: the vault's root group, or the new subgroup. */
  root: KdbxPlannedObject;
  /** Custom icons, written before the groups. */
  icons: KdbxPlannedObject[];
  /** Further groups, parents first. */
  groups: KdbxPlannedObject[];
  entries: KdbxPlannedObject[];
  report: KdbxImportReport;
  /** The binaries of the file. */
  binaries: readonly Uint8Array[];
}

/** The MIME type of a KDBX binary by its name. */
export function mimeOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function dashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function truncate(text: string, max: number): string {
  const points = codePoints(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}

function fold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

function sizeOf(raw: JsonObject): number {
  return utf8Length(JSON.stringify(raw));
}

/** Shortens `raw[key]` (a string) until `raw` fits `limit` bytes. */
function shrink(raw: JsonObject, key: string, limit: number): boolean {
  if (sizeOf(raw) <= limit) return false;
  const points = codePoints(String(raw[key]));
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    raw[key] = points.slice(0, middle).join("");
    if (sizeOf(raw) <= limit) low = middle;
    else high = middle - 1;
  }
  raw[key] = points.slice(0, low).join("");
  return true;
}

function iconOf(index: number | null): IconRef | null {
  const name = index === null ? undefined : KEEPASS_ICONS[index];
  return name === undefined ? null : { type: "builtin", name };
}

/** −1 (unlimited) and values above 100 become 100. */
export function historyLimitOf(value: number | null): number {
  if (value === null) return 10;
  return value < 0 || value > 100 ? 100 : value;
}

function color(file: KdbxFile): string | null {
  for (const value of [file.meta.color, file.meta.publicColor])
    if (value !== null && /^#[0-9A-Fa-f]{6}$/.test(value)) return value;
  return null;
}

function titleOf(state: KdbxEntryState): string {
  return state.strings.find((s) => s.key === "Title")?.value ?? "";
}

/** Tags: trimmed, non-empty, ≤ 128 code points, case-folded unique. */
function tagsOf(tags: readonly string[]): {
  tags: string[];
  truncated: boolean;
} {
  const seen = new Set<string>();
  const out: string[] = [];
  let truncated = false;
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed === "") continue;
    const value = truncate(trimmed, MAX_NAME);
    if (value !== trimmed) truncated = true;
    if (seen.has(fold(value))) continue;
    seen.add(fold(value));
    out.push(value);
  }
  return { tags: out, truncated };
}

class Planner {
  readonly report: KdbxImportReport;
  readonly icons: KdbxPlannedObject[] = [];
  readonly groups: KdbxPlannedObject[] = [];
  readonly entries: KdbxPlannedObject[] = [];
  readonly #options: KdbxImportOptions;
  readonly #historyMaxItems: number;
  readonly #used = new Set<string>();
  /** Groups that kept their UUID, by KDBX UUID. */
  readonly #groupIds = new Map<string, string>();
  readonly #inBin = new Set<string>();
  readonly #previous = new Map<KdbxPlannedObject, string>();
  readonly #bin: string | null;
  readonly #binaries: readonly Uint8Array[];
  /** Icon IDs by KDBX UUID; `null` for an unreadable icon. */
  readonly #iconIds = new Map<string, string | null>();
  readonly #iconsByHash: Map<string, string>;
  readonly #iconNames: ReadonlyMap<string, string>;

  constructor(file: KdbxFile, options: KdbxImportOptions) {
    this.#options = options;
    this.#binaries = file.binaries;
    this.#iconsByHash = new Map(options.existingIcons);
    this.#iconNames = new Map(
      file.customIcons.map((icon) => [icon.uuid, icon.name]),
    );
    this.#historyMaxItems =
      options.mode === "vault"
        ? historyLimitOf(file.meta.historyMaxItems)
        : options.historyMaxItems;
    const bin = file.meta.recycleBinUuid;
    this.#bin = bin !== null && bin !== file.root.uuid ? bin : null;
    this.report = {
      groups: 0,
      entries: 0,
      items: [],
      newIds: 0,
      conflicts: 0,
      attachments: 0,
      icons: 0,
      skippedBin: null,
      descriptionTruncated: false,
      extraRoots: file.extraRoots,
      ignored: { ...file.ignored },
    };
  }

  #id(uuid: string, label: string): string {
    const id = dashed(uuid);
    if (uuid !== ZERO_UUID && !this.#used.has(id)) {
      this.#used.add(id);
      return id;
    }
    this.report.newIds++;
    const fresh = this.#options.newId(label);
    this.#used.add(fresh);
    return fresh;
  }

  /**
   * The icon of a group or entry state: a custom icon if the
   * file has one and it could be read, else the standard index.
   */
  #icon(
    index: number | null,
    customIcon: string | null,
  ): { icon: IconRef | null; unreadable: boolean } {
    if (customIcon === null) return { icon: iconOf(index), unreadable: false };
    let id = this.#iconIds.get(customIcon);
    if (id === undefined) {
      id = null;
      const png = this.#options.icons?.get(customIcon);
      if (png !== undefined && isIconPng(png)) {
        const hash = iconHash(png);
        id = this.#iconsByHash.get(hash) ?? null;
        if (id === null) {
          id = this.#options.newId("icon_id");
          this.#iconsByHash.set(hash, id);
          this.icons.push({
            id,
            type: "icon",
            raw: newIcon(
              {
                png,
                name: this.#iconNames.get(customIcon) ?? "",
                source: { type: "kdbx" },
              },
              this.#options.stamp,
            ),
          });
        }
      }
      this.#iconIds.set(customIcon, id);
    }
    return id === null
      ? { icon: iconOf(index), unreadable: true }
      : { icon: { type: "custom", id }, unreadable: false };
  }

  #times(times: KdbxTimes): { created: string; modified: string } {
    const now = this.#options.stamp.now;
    return { created: times.created ?? now, modified: times.modified ?? now };
  }

  /**
   * The group and its subtree, parents first; `sortKey` from the caller.
   * `inBin`: the group lies in the recycle bin (the bin itself does not).
   */
  group(
    group: KdbxGroupFile,
    parentId: string | null,
    sortKey: string,
    path: KdbxPath,
    inBin: boolean,
  ): KdbxPlannedObject {
    const id = this.#id(group.uuid, "group_id");
    if (id === dashed(group.uuid)) this.#groupIds.set(group.uuid, id);
    if (inBin) this.#inBin.add(group.uuid);
    const icon = this.#icon(group.icon, group.customIcon);
    const raw: JsonObject = {
      schema: OBJECT_SCHEMA,
      seq: 1,
      parentId,
      sortKey,
      name: group.name,
      icon: icon.icon,
      defaultEntryIcon: null,
      notes: group.notes,
      ...this.#times(group.times),
      modifiedBy: this.#options.stamp.userId,
    };
    if (shrink(raw, "notes", GROUP_LIMIT)) {
      if (shrink(raw, "name", GROUP_LIMIT))
        raw.name = truncate(String(raw.name), MAX_GROUP_NAME);
      this.report.items.push({ kind: "group_truncated", path });
    }
    if (icon.unreadable)
      this.report.items.push({
        kind: "custom_icon_unreadable",
        path,
        title: null,
      });
    const planned: KdbxPlannedObject = { id, type: "group", raw };
    if (parentId !== null) this.groups.push(planned);
    if (inBin && group.previousParent !== null)
      this.#previous.set(planned, group.previousParent);

    const below = inBin || group.uuid === this.#bin;
    const entryKeys = generateNKeysBetween(null, null, group.entries.length);
    group.entries.forEach((entry, index) => {
      this.#entry(entry, id, entryKeys[index] ?? "", path, below);
    });
    const children = group.groups.filter((child) => {
      if (this.#options.mode === "vault" || child.uuid !== this.#bin)
        return true;
      this.report.skippedBin = this.#count(child);
      return false;
    });
    const groupKeys = generateNKeysBetween(null, null, children.length);
    children.forEach((child, index) => {
      this.group(
        child,
        id,
        groupKeys[index] ?? "",
        [...path, child.name],
        below,
      );
    });
    return planned;
  }

  #count(group: KdbxGroupFile): { groups: number; entries: number } {
    const total = { groups: 1, entries: group.entries.length };
    for (const child of group.groups) {
      const below = this.#count(child);
      total.groups += below.groups;
      total.entries += below.entries;
    }
    return total;
  }

  #entry(
    entry: KdbxEntryFile,
    parentId: string,
    sortKey: string,
    path: KdbxPath,
    inBin: boolean,
  ): void {
    const title = titleOf(entry);
    const id = this.#id(entry.uuid, "entry_id");
    const fieldIds = new Map<string, string>();
    const renames = new Map<string, string>();
    const skipped = new Set<string>();
    const unconverted = new Set<string>();
    // Set inside `content`; an object, so the checks below see the updates.
    const notes: {
      kept?: OtpProblem;
      tagsTruncated: boolean;
      iconUnreadable: boolean;
    } = {
      tagsTruncated: false,
      iconUnreadable: false,
    };
    const attachments = this.#attachments(entry, path, title);
    const elements = (refs: readonly KdbxAttachmentRef[]): JsonObject[] =>
      refs.flatMap((ref) => {
        const planned = attachments.get(ref.binary);
        return planned === undefined
          ? []
          : [
              {
                id: planned.id,
                name: ref.name,
                mime: mimeOfName(ref.name),
                size: this.#binaries[ref.binary]?.length ?? 0,
                key: PLANNED_KEY,
                compression: "none",
              },
            ];
      });

    /** OTP warnings count for the current state only. */
    const content = (state: KdbxEntryState, current: boolean): JsonObject => {
      const values: Record<string, string> = {};
      for (const item of state.strings) {
        const key = STANDARD[item.key];
        if (key !== undefined && values[key] === undefined)
          values[key] = item.value;
      }
      const otp = convertOtp(
        state.strings,
        values.title ?? "",
        values.username ?? "",
      );
      if (current) {
        notes.kept = otp.kept;
        for (const name of otp.unconverted) unconverted.add(name);
      }
      const tags = tagsOf(state.tags);
      notes.tagsTruncated ||= tags.truncated;
      const icon = this.#icon(state.icon, state.customIcon);
      notes.iconUnreadable ||= icon.unreadable;
      return {
        icon: icon.icon,
        title: values.title ?? "",
        username: values.username ?? "",
        password: values.password ?? "",
        url: values.url ?? "",
        notes: values.notes ?? "",
        otp: otp.otp,
        fields: this.#fields(state.strings, otp.consumed, {
          ids: fieldIds,
          renames,
          skipped,
        }),
        attachments: elements(state.attachments),
        tags: tags.tags,
        expires: state.times.expires,
      };
    };

    const raw: JsonObject = {
      schema: OBJECT_SCHEMA,
      seq: 1,
      parentId,
      sortKey,
      ...content(entry, true),
      ...this.#times(entry.times),
      modifiedBy: this.#options.stamp.userId,
      history: [],
    };
    if (sizeOf(raw) > ENTRY_LIMIT) {
      this.report.items.push({ kind: "entry_skipped", path, title });
      return;
    }
    const snapshots = entry.history
      .slice()
      .reverse()
      .map((state) => {
        const snapshot: JsonObject = {
          schema: OBJECT_SCHEMA,
          ...content(state, false),
        };
        if (state.times.created !== null)
          snapshot.created = state.times.created;
        if (state.times.modified !== null)
          snapshot.modified = state.times.modified;
        return snapshot;
      });
    setHistory(raw, snapshots, this.#historyMaxItems);
    const dropped = snapshots.length - (raw.history as unknown[]).length;

    // Only binaries the kept states still use go up.
    const used = referencedAttachments(raw);
    const planned: KdbxPlannedObject = {
      id,
      type: "entry",
      raw,
      attachments: [...attachments.values()].filter((a) => used.has(a.id)),
    };
    this.report.attachments += planned.attachments?.length ?? 0;
    if (inBin && entry.previousParent !== null)
      this.#previous.set(planned, entry.previousParent);
    this.entries.push(planned);

    for (const [from, to] of renames)
      this.report.items.push({ kind: "field_renamed", path, title, from, to });
    if (skipped.size > 0)
      this.report.items.push({
        kind: "fields_skipped",
        path,
        title,
        names: [...skipped],
      });
    if (notes.tagsTruncated)
      this.report.items.push({ kind: "tags_truncated", path, title });
    if (dropped > 0)
      this.report.items.push({ kind: "history_trimmed", path, title, dropped });
    if (notes.iconUnreadable)
      this.report.items.push({ kind: "custom_icon_unreadable", path, title });
    if (notes.kept !== undefined)
      this.report.items.push({
        kind: "otp_kept",
        path,
        title,
        problem: notes.kept,
      });
    if (unconverted.size > 0)
      this.report.items.push({
        kind: "otp_unconverted",
        path,
        title,
        names: [...unconverted],
      });
  }

  /**
   * The binaries of an entry that become attachments: the current
   * state first, then the history from new to old; the same content is
   * one attachment; too large or beyond 50 is skipped with a report line.
   */
  #attachments(
    entry: KdbxEntryFile,
    path: KdbxPath,
    title: string,
  ): Map<number, KdbxPlannedAttachment> {
    const planned = new Map<number, KdbxPlannedAttachment>();
    const refused = new Set<number>();
    const skipped: string[] = [];
    const states = [entry, ...entry.history.slice().reverse()];
    for (const ref of states.flatMap((state) => state.attachments)) {
      if (planned.has(ref.binary) || refused.has(ref.binary)) continue;
      const size = this.#binaries[ref.binary]?.length ?? 0;
      if (size > this.#options.attachmentMaxBytes) {
        refused.add(ref.binary);
        this.report.items.push({
          kind: "attachment_too_large",
          path,
          title,
          name: ref.name,
        });
      } else if (planned.size >= MAX_ATTACHMENTS) {
        refused.add(ref.binary);
        skipped.push(ref.name);
      } else {
        planned.set(ref.binary, {
          id: this.#options.newId("attachment_id"),
          binary: ref.binary,
          name: ref.name,
          mime: mimeOfName(ref.name),
        });
      }
    }
    if (skipped.length > 0)
      this.report.items.push({
        kind: "attachments_skipped",
        path,
        title,
        names: skipped,
      });
    return planned;
  }

  /** Field name rules of the KDBX import; IDs stay per KDBX key across states. */
  #fields(
    strings: readonly KdbxString[],
    consumed: ReadonlySet<string>,
    track: {
      ids: Map<string, string>;
      renames: Map<string, string>;
      skipped: Set<string>;
    },
  ): JsonObject[] {
    const fields: JsonObject[] = [];
    const taken = new Set<string>();
    for (const item of strings) {
      if (STANDARD[item.key] !== undefined || consumed.has(item.key)) continue;
      if (fields.length >= MAX_FIELDS) {
        track.skipped.add(item.key);
        continue;
      }
      const base = truncate(
        item.key.trim() || this.#options.emptyFieldName,
        MAX_NAME,
      );
      let name = base;
      for (let n = 2; RESERVED.has(fold(name)) || taken.has(fold(name)); n++) {
        const suffix = ` (${String(n)})`;
        name = truncate(base, MAX_NAME - suffix.length) + suffix;
      }
      taken.add(fold(name));
      if (name !== item.key) track.renames.set(item.key, name);
      let fieldId = track.ids.get(item.key);
      if (fieldId === undefined) {
        fieldId = this.#options.newId("field_id");
        track.ids.set(item.key, fieldId);
      }
      fields.push({
        id: fieldId,
        name,
        value: item.value,
        protected: item.protected,
      });
    }
    return fields;
  }

  /** `previousParentId` only towards imported groups outside the bin. */
  resolvePrevious(): void {
    for (const [planned, uuid] of this.#previous) {
      const id = this.#groupIds.get(uuid);
      if (id !== undefined && !this.#inBin.has(uuid) && uuid !== this.#bin)
        planned.raw.previousParentId = id;
    }
  }

  binId(): string | null {
    return this.#bin === null ? null : (this.#groupIds.get(this.#bin) ?? null);
  }

  meta(file: KdbxFile, rootId: string): JsonObject {
    const { stamp } = this.#options;
    const raw: JsonObject = {
      schema: OBJECT_SCHEMA,
      seq: 1,
      name: this.#options.name,
      description: file.meta.description,
      icon: { type: "builtin", name: "database" },
      color: color(file),
      rootGroupId: rootId,
      recycleBinGroupId: this.binId(),
      recycleBinEnabled: file.meta.recycleBinEnabled,
      historyMaxItems: this.#historyMaxItems,
      created: stamp.now,
      modified: stamp.now,
      modifiedBy: stamp.userId,
    };
    this.report.descriptionTruncated = shrink(raw, "description", META_LIMIT);
    return raw;
  }
}

/** Plans the import of `file`. */
export function planKdbxImport(
  file: KdbxFile,
  options: KdbxImportOptions,
): KdbxImportPlan {
  const planner = new Planner(file, options);
  const root = planner.group(file.root, null, "", [], false);
  planner.resolvePrevious();
  const report = planner.report;
  report.groups = planner.groups.length + (options.mode === "group" ? 1 : 0);
  report.entries = planner.entries.length;
  report.icons = planner.icons.length;
  return {
    mode: options.mode,
    meta: options.mode === "vault" ? planner.meta(file, root.id) : null,
    root,
    icons: planner.icons,
    groups: planner.groups,
    entries: planner.entries,
    report,
    binaries: file.binaries,
  };
}
