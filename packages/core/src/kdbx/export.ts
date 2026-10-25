/**
 * The KDBX export model of a vault: the tree as shown, KeePass
 * icon indices, strings with protection, history oldest first, attachments
 * as shared binaries. Corrupt objects and unreadable attachments are not
 * exported but reported. The worker writes the model; `verifyKdbxExport`
 * compares it with the file read back.
 */
import type { Entry, EntryContent } from "../model/entry";
import { KEEPASS_ICONS } from "../model/icons";
import type { TreeLayout } from "../model/tree";
import type { Group, IconRef, VaultMeta } from "../model/vault";
import { keepassRefs } from "./refs";
import type {
  KdbxAttachmentRef,
  KdbxExportEntry,
  KdbxExportEntryState,
  KdbxExportGroup,
  KdbxExportModel,
  KdbxFile,
  KdbxGroupFile,
  KdbxString,
  KdbxTimes,
} from "./types";

const DEFAULT_ENTRY_ICON = 0;
const DEFAULT_GROUP_ICON = 48;
const STANDARD_KEYS = new Set([
  "Title",
  "UserName",
  "Password",
  "URL",
  "Notes",
  "otp",
]);
const ICON_INDEX = new Map(KEEPASS_ICONS.map((name, index) => [name, index]));
// Not allowed in XML 1.0, including unpaired surrogates.
const XML_INVALID = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
  ].join("|"),
  "g",
);

export type KdbxExportItem =
  | {
      kind: "attachment_unreadable";
      path: readonly string[];
      title: string;
      name: string;
    }
  | {
      kind: "attachment_renamed";
      path: readonly string[];
      title: string;
      from: string;
      to: string;
    }
  | {
      kind: "field_renamed";
      path: readonly string[];
      title: string;
      from: string;
      to: string;
    }
  | {
      kind: "snapshots_skipped";
      path: readonly string[];
      title: string;
      count: number;
    }
  /** A missing or corrupt custom icon; `title` is `null` for a group. */
  | {
      kind: "custom_icon_missing";
      path: readonly string[];
      title: string | null;
    };

export interface KdbxExportReport {
  groups: number;
  entries: number;
  /** Corrupt objects of the vault; not exported. */
  corrupt: number;
  /** Characters removed from unprotected strings (not allowed in XML). */
  removedCharacters: number;
  /** The root group was missing; a stand-in with a new UUID was written. */
  substituteRoot: boolean;
  items: KdbxExportItem[];
}

export interface KdbxExportSource {
  meta: VaultMeta;
  layout: TreeLayout;
  group(id: string): { value: Group; times: KdbxTimes } | undefined;
  entry(id: string): { value: Entry; times: KdbxTimes } | undefined;
  /** PNG bytes of a valid live custom icon. */
  icon(id: string): Uint8Array | undefined;
  corrupt: number;
  newId(): string;
}

/** An attachment the export needs; the engine downloads it. */
export interface KdbxExportAttachment {
  entryId: string;
  attachmentId: string;
  path: readonly string[];
  title: string;
  name: string;
}

function hexOf(id: string): string {
  return id.replaceAll("-", "");
}

function iconIndex(ref: IconRef | null, fallback: number): number {
  return ref?.type === "builtin"
    ? (ICON_INDEX.get(ref.name) ?? fallback)
    : fallback;
}

/** Index and custom icon of a state or group. */
interface IconChoice {
  icon: number;
  customIcon: string | null;
  missing: boolean;
}

class ExportBuilder {
  readonly report: KdbxExportReport;
  /** Each custom icon once, in the order of first use. */
  readonly customIcons: { uuid: string; data: Uint8Array }[] = [];
  readonly #iconUuids = new Map<string, string | null>();
  /** Each attachment once; states refer to it by index. */
  readonly attachments: KdbxExportAttachment[] = [];
  readonly #attachmentIndex = new Map<string, number>();
  readonly #source: KdbxExportSource;

  constructor(source: KdbxExportSource) {
    this.#source = source;
    this.report = {
      groups: 0,
      entries: 0,
      corrupt: source.corrupt,
      removedCharacters: 0,
      substituteRoot: source.layout.missingRoot,
      items: [],
    };
  }

  /** A custom reference becomes the default index plus the icon's UUID. */
  #icon(ref: IconRef | null, fallback: number): IconChoice {
    if (ref?.type !== "custom")
      return {
        icon: iconIndex(ref, fallback),
        customIcon: null,
        missing: false,
      };
    let uuid = this.#iconUuids.get(ref.id);
    if (uuid === undefined) {
      const data = this.#source.icon(ref.id);
      uuid = data === undefined ? null : hexOf(ref.id);
      if (uuid !== null && data !== undefined)
        this.customIcons.push({ uuid, data });
      this.#iconUuids.set(ref.id, uuid);
    }
    return { icon: fallback, customIcon: uuid, missing: uuid === null };
  }

  /** Unprotected text: line breaks as LF, characters XML forbids removed. */
  text(value: string): string {
    const lines = value.replace(/\r\n?/g, "\n");
    return lines.replace(XML_INVALID, () => {
      this.report.removedCharacters++;
      return "";
    });
  }

  #string(key: string, value: string, isProtected: boolean): KdbxString {
    const refs = keepassRefs(value);
    return {
      key: this.text(key),
      value: isProtected ? refs : this.text(refs),
      protected: isProtected,
    };
  }

  /** Attachment names are unique per state in KDBX. */
  #attachments(
    content: EntryContent,
    entry: { id: string; path: readonly string[]; title: string },
  ): KdbxAttachmentRef[] {
    const used = new Set<string>();
    return content.attachments.map((info) => {
      let index = this.#attachmentIndex.get(info.id);
      if (index === undefined) {
        index = this.attachments.length;
        this.attachments.push({
          entryId: entry.id,
          attachmentId: info.id,
          path: entry.path,
          title: entry.title,
          name: info.name,
        });
        this.#attachmentIndex.set(info.id, index);
      }
      const base = this.text(info.name);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${String(n)})`;
      if (name !== base)
        this.report.items.push({
          kind: "attachment_renamed",
          path: entry.path,
          title: entry.title,
          from: info.name,
          to: name,
        });
      used.add(name);
      return { name, binary: index };
    });
  }

  #state(
    content: EntryContent,
    defaultIcon: IconRef | null,
    times: KdbxTimes,
    rename: (from: string, to: string) => void,
    entry: { id: string; path: readonly string[]; title: string },
    onMissingIcon: () => void,
  ): KdbxExportEntryState {
    const strings = [
      this.#string("Title", content.title, false),
      this.#string("UserName", content.username, false),
      this.#string("Password", content.password, true),
      this.#string("URL", content.url, false),
      this.#string("Notes", content.notes, false),
    ];
    if (content.otp !== null)
      strings.push(this.#string("otp", content.otp, true));
    const used = new Set(STANDARD_KEYS);
    for (const field of content.fields) {
      const key = this.text(field.name);
      let name = key;
      for (let n = 2; name.trim() === "" || used.has(name); n++)
        name = `${key} (${String(n)})`;
      if (name !== key) rename(field.name, name);
      used.add(name);
      strings.push(this.#string(name, field.value, field.protected));
    }
    const choice = this.#icon(content.icon ?? defaultIcon, DEFAULT_ENTRY_ICON);
    if (choice.missing) onMissingIcon();
    return {
      uuid: "",
      icon: choice.icon,
      customIcon: choice.customIcon,
      strings,
      // KeePass splits tags at `,`, `;` and tabs and drops empty ones.
      tags: content.tags
        .map((tag) =>
          this.text(tag)
            .replace(/[,;\t]/g, "_")
            .trim(),
        )
        .filter((tag) => tag !== ""),
      times: { ...times, expires: content.expires },
      attachments: this.#attachments(content, entry),
    };
  }

  #entry(
    id: string,
    path: readonly string[],
    defaultIcon: IconRef | null,
  ): KdbxExportEntry | undefined {
    const item = this.#source.entry(id);
    if (item === undefined) return undefined;
    const { value, times } = item;
    const renames = new Map<string, string>();
    const rename = (from: string, to: string) => renames.set(from, to);
    const uuid = hexOf(id);
    const owner = { id, path, title: value.title };
    // An object, so the check below sees what the callback sets.
    const icon = { missing: false };
    const onMissingIcon = () => {
      icon.missing = true;
    };
    const readable = value.history.filter((snapshot) => !snapshot.unreadable);
    const history = readable
      .slice()
      .reverse()
      .map((snapshot) => ({
        ...this.#state(
          snapshot,
          defaultIcon,
          {
            created: times.created,
            modified: snapshot.modified ?? null,
            expires: null,
          },
          rename,
          owner,
          onMissingIcon,
        ),
        uuid,
      }));
    const current = this.#state(
      value,
      defaultIcon,
      times,
      rename,
      owner,
      onMissingIcon,
    );
    const title = value.title;
    if (icon.missing)
      this.report.items.push({ kind: "custom_icon_missing", path, title });
    for (const [from, to] of renames)
      this.report.items.push({ kind: "field_renamed", path, title, from, to });
    const skipped = value.history.length - readable.length;
    if (skipped > 0)
      this.report.items.push({
        kind: "snapshots_skipped",
        path,
        title,
        count: skipped,
      });
    this.report.entries++;
    return { ...current, uuid, history };
  }

  group(
    id: string,
    path: readonly string[],
    inherited: IconRef | null,
  ): KdbxExportGroup {
    const { layout } = this.#source;
    const item = this.#source.group(id);
    const isRoot = id === layout.rootId;
    const group = item?.value;
    const defaultIcon = group?.defaultEntryIcon ?? inherited;
    const groups: KdbxExportGroup[] = [];
    for (const child of layout.children.get(id) ?? []) {
      const name = this.#source.group(child)?.value.name ?? "";
      groups.push(this.group(child, [...path, name], defaultIcon));
      this.report.groups++;
    }
    const entries: KdbxExportEntry[] = [];
    for (const child of layout.entries.get(id) ?? []) {
      const entry = this.#entry(child, path, defaultIcon);
      if (entry !== undefined) entries.push(entry);
    }
    const missing = isRoot && layout.missingRoot;
    const choice = this.#icon(group?.icon ?? null, DEFAULT_GROUP_ICON);
    if (choice.missing)
      this.report.items.push({
        kind: "custom_icon_missing",
        path,
        title: null,
      });
    return {
      uuid: missing ? hexOf(this.#source.newId()) : hexOf(id),
      name: this.text(missing ? this.#source.meta.name : (group?.name ?? "")),
      notes: this.text(group?.notes ?? ""),
      icon: choice.icon,
      customIcon: choice.customIcon,
      times: item?.times ?? { created: null, modified: null, expires: null },
      groups,
      entries,
    };
  }
}

/**
 * The export model of a vault and its report; `binaries` stays
 * empty until [`attachKdbxBinaries`] adds the downloaded attachments.
 */
export function buildKdbxExport(source: KdbxExportSource): {
  model: KdbxExportModel;
  report: KdbxExportReport;
  attachments: KdbxExportAttachment[];
} {
  const builder = new ExportBuilder(source);
  const { meta, layout } = source;
  const root = builder.group(layout.rootId, [], null);
  return {
    model: {
      meta: {
        name: builder.text(meta.name),
        description: builder.text(meta.description),
        color: meta.color,
        historyMaxItems: meta.historyMaxItems,
        recycleBinEnabled: meta.recycleBinEnabled,
        recycleBinUuid: layout.binId === undefined ? null : hexOf(layout.binId),
      },
      root,
      binaries: [],
      customIcons: builder.customIcons,
    },
    report: builder.report,
    attachments: builder.attachments,
  };
}

function remapStates(
  group: KdbxExportGroup,
  map: (refs: KdbxAttachmentRef[]) => KdbxAttachmentRef[],
): void {
  for (const entry of group.entries) {
    entry.attachments = map(entry.attachments);
    for (const state of entry.history)
      state.attachments = map(state.attachments);
  }
  for (const child of group.groups) remapStates(child, map);
}

/**
 * Puts the downloaded attachments into the model, in the order of
 * `attachments`; one that could not be read (`undefined`) is left out of
 * every state and reported.
 */
export function attachKdbxBinaries(
  model: KdbxExportModel,
  report: KdbxExportReport,
  attachments: readonly KdbxExportAttachment[],
  files: readonly (Uint8Array | undefined)[],
): void {
  const target = new Map<number, number>();
  attachments.forEach((attachment, index) => {
    const file = files[index];
    if (file === undefined) {
      report.items.push({
        kind: "attachment_unreadable",
        path: attachment.path,
        title: attachment.title,
        name: attachment.name,
      });
      return;
    }
    target.set(index, model.binaries.length);
    model.binaries.push(file);
  });
  remapStates(model.root, (refs) =>
    refs.flatMap((ref) => {
      const binary = target.get(ref.binary);
      return binary === undefined ? [] : [{ name: ref.name, binary }];
    }),
  );
}

function seconds(iso: string | null): string | null {
  return iso === null ? null : iso.slice(0, 19);
}

function sameTimes(model: KdbxTimes, file: KdbxTimes): boolean {
  return (["created", "modified", "expires"] as const).every(
    (key) => model[key] === null || seconds(model[key]) === seconds(file[key]),
  );
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((byte, i) => byte === b[i])
  );
}

/** Two binary pools; the file may order and merge them differently. */
interface Pools {
  model: readonly Uint8Array[];
  file: readonly Uint8Array[];
}

function sameAttachments(
  model: readonly KdbxAttachmentRef[],
  file: readonly KdbxAttachmentRef[],
  pools: Pools,
): boolean {
  const byName = new Map(file.map((ref) => [ref.name, ref.binary]));
  return (
    model.length === file.length &&
    model.every((ref) => {
      const other = byName.get(ref.name);
      return (
        other !== undefined &&
        sameBytes(pools.model[ref.binary], pools.file[other])
      );
    })
  );
}

function sameState(
  model: KdbxExportEntryState,
  file: {
    uuid: string;
    icon: number | null;
    customIcon: string | null;
    strings: KdbxString[];
    tags: string[];
    times: KdbxTimes;
    attachments: KdbxAttachmentRef[];
  },
  pools: Pools,
): boolean {
  return (
    model.uuid === file.uuid &&
    model.icon === file.icon &&
    model.customIcon === file.customIcon &&
    JSON.stringify(model.strings) === JSON.stringify(file.strings) &&
    JSON.stringify(model.tags) === JSON.stringify(file.tags) &&
    sameTimes(model.times, file.times) &&
    sameAttachments(model.attachments, file.attachments, pools)
  );
}

function sameGroup(
  model: KdbxExportGroup,
  file: KdbxGroupFile,
  pools: Pools,
): boolean {
  return (
    model.uuid === file.uuid &&
    model.name === file.name &&
    model.notes === file.notes &&
    model.icon === file.icon &&
    model.customIcon === file.customIcon &&
    sameTimes(model.times, file.times) &&
    model.groups.length === file.groups.length &&
    model.entries.length === file.entries.length &&
    model.groups.every((group, i) => {
      const other = file.groups[i];
      return other !== undefined && sameGroup(group, other, pools);
    }) &&
    model.entries.every((entry, i) => {
      const other = file.entries[i];
      return (
        other !== undefined &&
        sameState(entry, other, pools) &&
        entry.history.length === other.history.length &&
        entry.history.every((state, j) => {
          const past = other.history[j];
          return past !== undefined && sameState(state, past, pools);
        })
      );
    })
  );
}

/** The self-check before the download: same content read back. */
export function verifyKdbxExport(
  model: KdbxExportModel,
  file: KdbxFile,
): boolean {
  const { meta } = model;
  return (
    file.header.version === "4.0" &&
    file.header.cipher === "aes" &&
    file.header.kdf === "argon2id" &&
    file.meta.name === meta.name &&
    file.meta.description === meta.description &&
    file.meta.color === meta.color &&
    file.meta.historyMaxItems === meta.historyMaxItems &&
    file.meta.recycleBinEnabled === meta.recycleBinEnabled &&
    file.meta.recycleBinUuid === meta.recycleBinUuid &&
    model.customIcons.length === file.customIcons.length &&
    model.customIcons.every((icon) =>
      sameBytes(
        icon.data,
        file.customIcons.find((other) => other.uuid === icon.uuid)?.data,
      ),
    ) &&
    sameGroup(model.root, file.root, {
      model: model.binaries,
      file: file.binaries,
    })
  );
}

/**
 * `<vault name>-<YYYY-MM-DD>.kdbx` with the local date: reserved
 * and control characters become `_`, dots and spaces at the edges go, at
 * most 100 code points; an empty name becomes “KeeMan”.
 */
export function kdbxFileName(vaultName: string, date: Date): string {
  const cleaned = vaultName
    // eslint-disable-next-line no-control-regex -- control characters become _
    .replace(/[/\\:*?"<>|\u0000-\u001F\u007F]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const name = Array.from(cleaned)
    .slice(0, 100)
    .join("")
    .replace(/[.\s]+$/, "");
  const day = [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `${name === "" ? "KeeMan" : name}-${day}.kdbx`;
}
