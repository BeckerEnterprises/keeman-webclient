/**
 * Entries: validation with defaults, read-only entries with
 * invalid list fields, the editor's draft with its save rules, and saving
 * that changes only what differs and keeps unknown keys, also in lists.
 */
import { isJsonObject, type JsonObject } from "../crypto/bytes";
import { isTimestamp } from "../crypto/time";
import { isUuid } from "../crypto/uuid";
import { parseOtpUri } from "../totp/uri";
import {
  ENTRY_LIMIT,
  EntryTooLarge,
  historyOf,
  restorable,
  sameEntryContent,
  setHistory,
  snapshotOf,
  utf8Length,
  withContentOf,
} from "./history";
import { clone, isPositiveInteger, own, same, seqOf, setOwn } from "./json";
import {
  OBJECT_SCHEMA,
  parseIconRef,
  type IconRef,
  type Inspected,
  type Stamp,
} from "./vault";

export interface CustomField {
  id: string;
  name: string;
  value: string;
  protected: boolean;
}

/** Attachment metadata without the file key. */
export interface AttachmentInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  compression: "gzip" | "none";
}

export interface EntryContent {
  /** `null`: the group chain's default icon applies. */
  icon: IconRef | null;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otp: string | null;
  fields: CustomField[];
  attachments: AttachmentInfo[];
  tags: string[];
  expires: string | null;
}

export interface HistorySnapshot extends EntryContent {
  conflict: boolean;
  /** A newer schema: shown, but not restorable. */
  readOnly: boolean;
  /** Not an object: nothing to show. */
  unreadable: boolean;
  modified: string | undefined;
  modifiedBy: string | undefined;
}

export interface Entry extends EntryContent {
  parentId: string;
  sortKey: string;
  previousParentId: string | undefined;
  history: HistorySnapshot[];
  /** Invalid list elements, also in snapshots: the entry is read-only. */
  invalid: number;
  created: string | undefined;
  modified: string | undefined;
  modifiedBy: string | undefined;
}

/** What the editor changes. */
export interface EntryDraft {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  icon: IconRef | null;
  tags: string[];
  expires: string | null;
  /** Without `id` for a new field. */
  fields: { id?: string; name: string; value: string; protected: boolean }[];
  /** A TOTP key URI; an unsupported stored value may stay unchanged. */
  otp: string | null;
  /**
   * Attachment IDs in order: stored ones, and uploads the core staged for
   * this entry. File keys never appear here.
   */
  attachments: string[];
}

export type DraftProblem =
  | {
      kind:
        | "field_name_empty"
        | "field_name_too_long"
        | "field_name_reserved"
        | "field_name_duplicate";
      index: number;
    }
  | { kind: "too_many_fields" | "too_many_attachments" }
  | { kind: "tag_invalid" | "tag_duplicate"; index: number }
  | { kind: "expires_invalid" }
  /** A new `otp` that is no readable TOTP URI, HOTP/Steam, or a migration QR. */
  | { kind: "otp_invalid" | "otp_unsupported" | "otp_migration" };

export const MAX_FIELDS = 100;
/** Attachments per entry. */
export const MAX_ATTACHMENTS = 50;
const MAX_NAME = 128;
const RESERVED = new Set([
  "title",
  "username",
  "password",
  "url",
  "notes",
  "otp",
]);
const FILE_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function text(raw: JsonObject, key: string): string {
  const value = own(raw, key);
  return typeof value === "string" ? value : "";
}

function timestamp(raw: JsonObject, key: string): string | undefined {
  const value = own(raw, key);
  return isTimestamp(value) ? value : undefined;
}

interface ListResult<T> {
  items: T[];
  invalid: number;
}

function list<T>(
  raw: JsonObject,
  key: string,
  parse: (item: unknown) => T | undefined,
): ListResult<T> {
  if (!Object.prototype.hasOwnProperty.call(raw, key))
    return { items: [], invalid: 0 };
  const value = raw[key];
  if (!Array.isArray(value)) return { items: [], invalid: 1 };
  const items: T[] = [];
  let invalid = 0;
  for (const item of value as unknown[]) {
    const parsed = parse(item);
    if (parsed === undefined) invalid++;
    else items.push(parsed);
  }
  return { items, invalid };
}

function parseField(item: unknown): CustomField | undefined {
  if (!isJsonObject(item)) return undefined;
  const id = own(item, "id");
  const name = own(item, "name");
  const value = own(item, "value");
  const prot = own(item, "protected");
  if (!isUuid(id) || typeof name !== "string" || typeof value !== "string")
    return undefined;
  if (prot !== undefined && typeof prot !== "boolean") return undefined;
  return { id, name, value, protected: prot === true };
}

function parseAttachment(item: unknown): AttachmentInfo | undefined {
  if (!isJsonObject(item)) return undefined;
  const id = own(item, "id");
  const name = own(item, "name");
  const mime = own(item, "mime");
  const size = own(item, "size");
  const key = own(item, "key");
  const compression = own(item, "compression");
  if (
    !isUuid(id) ||
    typeof name !== "string" ||
    typeof mime !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof key !== "string" ||
    !FILE_KEY.test(key) ||
    (compression !== "gzip" && compression !== "none")
  )
    return undefined;
  return { id, name, mime, size, compression };
}

function parseTag(item: unknown): string | undefined {
  return typeof item === "string" ? item : undefined;
}

/** Content and the number of invalid list elements. */
function readContent(raw: JsonObject): {
  content: EntryContent;
  invalid: number;
} {
  const fields = list(raw, "fields", parseField);
  const attachments = list(raw, "attachments", parseAttachment);
  const tags = list(raw, "tags", parseTag);
  const otp = own(raw, "otp");
  const icon = own(raw, "icon");
  return {
    content: {
      icon: icon === null ? null : (parseIconRef(icon) ?? null),
      title: text(raw, "title"),
      username: text(raw, "username"),
      password: text(raw, "password"),
      url: text(raw, "url"),
      notes: text(raw, "notes"),
      otp: typeof otp === "string" ? otp : null,
      fields: fields.items,
      attachments: attachments.items,
      tags: tags.items,
      expires: timestamp(raw, "expires") ?? null,
    },
    invalid: fields.invalid + attachments.invalid + tags.invalid,
  };
}

function readSnapshot(item: unknown): {
  snapshot: HistorySnapshot;
  invalid: number;
} {
  if (!isJsonObject(item))
    return {
      snapshot: {
        ...readContent({}).content,
        conflict: false,
        readOnly: true,
        unreadable: true,
        modified: undefined,
        modifiedBy: undefined,
      },
      invalid: 1,
    };
  const { content, invalid } = readContent(item);
  const modifiedBy = own(item, "modifiedBy");
  return {
    snapshot: {
      ...content,
      conflict: own(item, "conflict") === true,
      readOnly: !restorable(item),
      unreadable: false,
      modified: timestamp(item, "modified"),
      modifiedBy: isUuid(modifiedBy) ? modifiedBy : undefined,
    },
    invalid,
  };
}

/** `entry`: corrupt only without `schema`, `seq` or `parentId`. */
export function inspectEntry(raw: JsonObject): Inspected<Entry> {
  const schema = own(raw, "schema");
  const parentId = own(raw, "parentId");
  if (
    !isPositiveInteger(schema) ||
    !isPositiveInteger(own(raw, "seq")) ||
    !isUuid(parentId)
  )
    return { status: "corrupt", reason: "validation" };
  const { content, invalid } = readContent(raw);
  const history = own(raw, "history");
  let invalidCount = invalid;
  const snapshots: HistorySnapshot[] = [];
  if (history !== undefined && !Array.isArray(history)) invalidCount++;
  for (const item of historyOf(raw)) {
    const read = readSnapshot(item);
    invalidCount += read.invalid;
    snapshots.push(read.snapshot);
  }
  const sortKey = own(raw, "sortKey");
  const previous = own(raw, "previousParentId");
  const modifiedBy = own(raw, "modifiedBy");
  return {
    status: "ok",
    raw,
    seq: seqOf(raw),
    readOnly: schema > OBJECT_SCHEMA,
    value: {
      ...content,
      parentId,
      sortKey: typeof sortKey === "string" ? sortKey : "",
      previousParentId: isUuid(previous) ? previous : undefined,
      history: snapshots,
      invalid: invalidCount,
      created: timestamp(raw, "created"),
      modified: timestamp(raw, "modified"),
      modifiedBy: isUuid(modifiedBy) ? modifiedBy : undefined,
    },
  };
}

export function draftOf(entry: EntryContent): EntryDraft {
  return {
    title: entry.title,
    username: entry.username,
    password: entry.password,
    url: entry.url,
    notes: entry.notes,
    icon: entry.icon,
    tags: [...entry.tags],
    expires: entry.expires,
    fields: entry.fields.map((f) => ({ ...f })),
    otp: entry.otp,
    attachments: entry.attachments.map((a) => a.id),
  };
}

/** The value to store: a readable URI normalised, others as given. */
function storedOtp(otp: string | null): string | null {
  if (otp === null) return null;
  const parsed = parseOtpUri(otp);
  return parsed.ok ? parsed.normalized : otp;
}

function otpProblem(otp: string): DraftProblem | undefined {
  if (/^\s*otpauth-migration:/i.test(otp)) return { kind: "otp_migration" };
  const parsed = parseOtpUri(otp);
  if (parsed.ok) return undefined;
  return {
    kind:
      parsed.problem === "hotp" || parsed.problem === "steam"
        ? "otp_unsupported"
        : "otp_invalid",
  };
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

/** Case-insensitive comparison of names. */
function fold(value: string): string {
  return value.toUpperCase().toLowerCase();
}

/** Save rules; field names only when the fields changed. */
export function validateEntryDraft(
  draft: EntryDraft,
  base:
    | (Pick<EntryDraft, "fields" | "otp"> & {
        attachments: readonly (string | { id: string })[];
      })
    | undefined,
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  // Checked only when the list changed.
  if (
    draft.attachments.length > MAX_ATTACHMENTS &&
    !(base && same(draft.attachments, attachmentIds(base.attachments)))
  )
    problems.push({ kind: "too_many_attachments" });
  // An unchanged value stays, even one this version cannot use.
  if (draft.otp !== null && draft.otp !== base?.otp) {
    const problem = otpProblem(draft.otp);
    if (problem) problems.push(problem);
  }
  const fieldsChanged = !base || !sameFields(draft.fields, base.fields);
  if (fieldsChanged) {
    if (draft.fields.length > MAX_FIELDS)
      problems.push({ kind: "too_many_fields" });
    const seen = new Set<string>();
    draft.fields.forEach((field, index) => {
      const name = field.name.trim();
      const folded = fold(name);
      if (name === "") problems.push({ kind: "field_name_empty", index });
      else if (codePoints(name) > MAX_NAME)
        problems.push({ kind: "field_name_too_long", index });
      else if (RESERVED.has(folded))
        problems.push({ kind: "field_name_reserved", index });
      else if (seen.has(folded))
        problems.push({ kind: "field_name_duplicate", index });
      seen.add(folded);
    });
  }
  const tags = new Set<string>();
  draft.tags.forEach((tag, index) => {
    const value = tag.trim();
    if (
      value === "" ||
      value.includes(",") ||
      value.includes(";") ||
      codePoints(value) > MAX_NAME
    )
      problems.push({ kind: "tag_invalid", index });
    else if (tags.has(fold(value)))
      problems.push({ kind: "tag_duplicate", index });
    tags.add(fold(value));
  });
  if (draft.expires !== null && !isTimestamp(draft.expires))
    problems.push({ kind: "expires_invalid" });
  return problems;
}

type FieldLike = {
  id?: string;
  name: string;
  value: string;
  protected: boolean;
};

function sameFields(a: readonly FieldLike[], b: readonly FieldLike[]): boolean {
  return (
    a.length === b.length &&
    a.every((field, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        field.id === other.id &&
        field.name === other.name &&
        field.value === other.value &&
        field.protected === other.protected
      );
    })
  );
}

function fieldsRaw(
  raw: JsonObject,
  draft: EntryDraft["fields"],
  newId: () => string,
): unknown[] {
  const stored = new Map<string, JsonObject>();
  for (const item of arrayOf(own(raw, "fields")))
    if (isJsonObject(item) && isUuid(own(item, "id")))
      stored.set(own(item, "id") as string, item);
  return draft.map((field) => {
    const existing = field.id === undefined ? undefined : stored.get(field.id);
    if (!existing)
      return {
        id: newId(),
        name: field.name.trim(),
        value: field.value,
        protected: field.protected,
      };
    const item = clone(existing);
    setOwn(item, "name", field.name.trim());
    setOwn(item, "value", field.value);
    if (field.protected || own(item, "protected") !== undefined)
      setOwn(item, "protected", field.protected);
    return item;
  });
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function attachmentIds(list: readonly (string | { id: string })[]): string[] {
  return list.map((item) => (typeof item === "string" ? item : item.id));
}

/**
 * The stored list for `ids`: kept elements unchanged (file key and unknown
 * keys included), new ones from `added`.
 */
function attachmentsRaw(
  baseRaw: JsonObject,
  ids: readonly string[],
  added: ReadonlyMap<string, JsonObject>,
): JsonObject[] {
  const stored = new Map<string, JsonObject>();
  for (const element of arrayOf(own(baseRaw, "attachments")))
    if (isJsonObject(element) && typeof element.id === "string")
      stored.set(element.id, element);
  return ids.map((id) => {
    const element = stored.get(id) ?? added.get(id);
    if (!element) throw new Error("Unknown attachment");
    return clone(element);
  });
}

export interface SaveContext {
  stamp: Stamp;
  historyMaxItems: number;
  newId: () => string;
}

/**
 * The entry after an edit, or `undefined` if nothing changed. Writes only
 * fields that differ from the parsed base and adds a snapshot for content
 * changes. Throws `EntryTooLarge`.
 */
export function applyEntryEdit(
  baseRaw: JsonObject,
  draft: EntryDraft,
  context: SaveContext,
  added: ReadonlyMap<string, JsonObject> = new Map(),
): JsonObject | undefined {
  const inspected = inspectEntry(baseRaw);
  if (inspected.status !== "ok") throw new Error("Corrupt entry");
  const base = inspected.value;
  const changes = new Map<string, unknown>();
  for (const key of ["title", "username", "password", "url", "notes"] as const)
    if (draft[key] !== base[key]) changes.set(key, draft[key]);
  if (!same(draft.icon, base.icon)) changes.set("icon", draft.icon);
  if (draft.expires !== base.expires) changes.set("expires", draft.expires);
  if (draft.otp !== base.otp) changes.set("otp", storedOtp(draft.otp));
  const tags = draft.tags.map((tag) => tag.trim());
  if (!same(tags, base.tags)) changes.set("tags", tags);
  if (!sameFields(draft.fields, base.fields))
    changes.set("fields", fieldsRaw(baseRaw, draft.fields, context.newId));
  if (!same(draft.attachments, attachmentIds(base.attachments)))
    changes.set(
      "attachments",
      attachmentsRaw(baseRaw, draft.attachments, added),
    );
  if (changes.size === 0) return undefined;
  const next = clone(baseRaw);
  for (const [key, value] of changes) setOwn(next, key, value);
  return finishEdit(baseRaw, next, context);
}

/** Bookkeeping and history of a changed entry. */
function finishEdit(
  baseRaw: JsonObject,
  next: JsonObject,
  context: SaveContext,
): JsonObject {
  if (!sameEntryContent(baseRaw, next))
    setHistory(
      next,
      [snapshotOf(baseRaw), ...historyOf(baseRaw)],
      context.historyMaxItems,
    );
  setOwn(next, "modified", context.stamp.now);
  setOwn(next, "modifiedBy", context.stamp.userId);
  setOwn(next, "seq", seqOf(baseRaw) + 1);
  return next;
}

/**
 * Restores snapshot `index`; `undefined` if it is the current
 * content already. Throws for snapshots that cannot be restored.
 */
export function restoreEntrySnapshot(
  baseRaw: JsonObject,
  index: number,
  context: SaveContext,
): JsonObject | undefined {
  const snapshot = historyOf(baseRaw)[index];
  if (!restorable(snapshot)) throw new Error("Snapshot cannot be restored");
  const next = withContentOf(baseRaw, snapshot);
  if (sameEntryContent(baseRaw, next)) return undefined;
  return finishEdit(baseRaw, next, context);
}

/**
 * Removes invalid list elements from the entry and its snapshots, and
 * snapshots that are no objects; no new snapshot.
 */
export function withoutInvalidElements(
  baseRaw: JsonObject,
  stamp: Stamp,
): JsonObject {
  const clean = (raw: JsonObject) => {
    const parsers: [string, (item: unknown) => unknown][] = [
      ["fields", parseField],
      ["attachments", parseAttachment],
      ["tags", parseTag],
    ];
    for (const [key, parse] of parsers) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      const value = raw[key];
      setOwn(
        raw,
        key,
        Array.isArray(value)
          ? (value as unknown[]).filter((item) => parse(item) !== undefined)
          : [],
      );
    }
  };
  const next = clone(baseRaw);
  clean(next);
  if (Object.prototype.hasOwnProperty.call(next, "history")) {
    const history = historyOf(next).filter(isJsonObject);
    history.forEach(clean);
    setOwn(next, "history", history);
  }
  setOwn(next, "modified", stamp.now);
  setOwn(next, "modifiedBy", stamp.userId);
  setOwn(next, "seq", seqOf(baseRaw) + 1);
  return next;
}

/** A new entry. */
export function newEntry(
  input: { parentId: string; sortKey: string; draft: EntryDraft },
  context: SaveContext,
  added: ReadonlyMap<string, JsonObject> = new Map(),
): JsonObject {
  const { draft } = input;
  const { stamp } = context;
  const raw: JsonObject = {
    schema: OBJECT_SCHEMA,
    seq: 1,
    parentId: input.parentId,
    sortKey: input.sortKey,
    icon: draft.icon,
    title: draft.title,
    username: draft.username,
    password: draft.password,
    url: draft.url,
    notes: draft.notes,
    otp: storedOtp(draft.otp),
    fields: fieldsRaw({}, draft.fields, context.newId),
    attachments: attachmentsRaw({}, draft.attachments, added),
    tags: draft.tags.map((tag) => tag.trim()),
    expires: draft.expires,
    created: stamp.now,
    modified: stamp.now,
    modifiedBy: stamp.userId,
    history: [],
  };
  if (utf8Length(JSON.stringify(raw)) > ENTRY_LIMIT)
    throw new EntryTooLarge("Entry exceeds 1 MiB");
  return raw;
}

export function emptyDraft(): EntryDraft {
  return {
    title: "",
    username: "",
    password: "",
    url: "",
    notes: "",
    icon: null,
    tags: [],
    expires: null,
    fields: [],
    otp: null,
    attachments: [],
  };
}
