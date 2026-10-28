/**
 * The read-only projection for the UI: vaults, tree and entry
 * summaries without secrets. Details of one entry are built on request.
 * Unchanged objects and vaults keep their identity between projections.
 */
import type { ObjectType } from "../crypto/aad";
import type { RoleOwner, RolePoint } from "../crypto/roles";
import { fromBase64Url, type JsonObject } from "../crypto/bytes";
import { fingerprint2Hex, fingerprintHex } from "../crypto/fingerprint";
import type { Contact } from "../model/user-data";
import { contactStatus } from "../sharing/contacts";
import {
  formatStateCode,
  stateCodeUri,
  type StateCode,
} from "../crypto/state-code";
import { isTimestamp } from "../crypto/time";
import {
  inspectEntry,
  type AttachmentInfo,
  type CustomField,
  type Entry,
  type EntryContent,
} from "../model/entry";
import { changedFields, historyOf } from "../model/history";
import {
  iconDataUrl,
  iconRefs,
  inspectIcon,
  type Icon,
  type IconSource,
} from "../model/icon";
import { DEFAULT_ICONS, iconName } from "../model/icons";
import { own } from "../model/json";
import { siblingOrder } from "../model/sort-key";
import { ancestors, buildTree, type TreeLayout } from "../model/tree";
import {
  resolveText,
  resolveUrl,
  type PlaceholderLookup,
  type ResolvedText,
  type ResolvedUrl,
  type TextField,
} from "../placeholders/resolve";
import { parseOtpUri } from "../totp/uri";
import {
  inspectGroup,
  inspectVaultMeta,
  parseIconRef,
  type CorruptReason,
  type Group,
  type IconRef,
  type VaultMeta,
} from "../model/vault";
import type { Candidate } from "../sharing/candidate";
import type { ConnectionState } from "./events";
import type { ManifestIssue, ManifestStatus } from "./manifest";
import type { RolesStatus } from "./roles";
import type { ObjectEntry, PendingReason, VaultState } from "./vault";
import { objectWritable, vaultWritable } from "./writer";

export interface CorruptObjectView {
  readonly id: string;
  readonly type: ObjectType;
  readonly reason: CorruptReason;
}

export type TreeNodeProblem = "orphan" | "cycle" | "missing";

export interface TreeNode {
  readonly id: string;
  readonly kind: "root" | "bin" | "group";
  /** The group's name; the root node shows the vault name in the UI. */
  readonly name: string;
  /** Built-in icon to show, also in place of a custom one. */
  readonly icon: string;
  /** ID of a valid custom icon to show instead. */
  readonly customIcon: string | undefined;
  /** Stored icon, for editing; `null` if none or invalid. */
  readonly iconRef: IconRef | null;
  readonly defaultEntryIcon: IconRef | null;
  readonly notes: string;
  /** Display parent; `null` for the root. */
  readonly parentId: string | null;
  readonly depth: number;
  readonly children: readonly string[];
  readonly entries: readonly string[];
  readonly inTrash: boolean;
  readonly problem: TreeNodeProblem | undefined;
  readonly writable: boolean;
  readonly readOnly: boolean;
  readonly rollback: boolean;
  readonly modified: string | undefined;
}

export interface VaultTree {
  readonly rootId: string;
  readonly missingRoot: boolean;
  /** The recycle bin node, if there is one. */
  readonly binId: string | undefined;
  readonly nodes: ReadonlyMap<string, TreeNode>;
  /** Orphans and cycle heads that "Repair" moves below the root. */
  readonly repairs: readonly string[];
}

export interface EntrySummary {
  readonly id: string;
  readonly vaultId: string;
  /** Display parent group. */
  readonly groupId: string;
  /** Title, username and URL with list references resolved. */
  readonly title: string;
  readonly username: string;
  readonly url: string;
  readonly icon: string;
  readonly customIcon: string | undefined;
  readonly tags: readonly string[];
  readonly expires: string | null;
  readonly created: string | undefined;
  readonly modified: string | undefined;
  readonly modifiedBy: string | undefined;
  readonly inTrash: boolean;
  readonly problem: "orphan" | undefined;
  readonly writable: boolean;
  /** `schema`: newer client; `invalid`: invalid list elements. */
  readonly readOnly: "schema" | "superseded" | "invalid" | undefined;
  readonly invalid: number;
  readonly rollback: boolean;
  readonly hasPassword: boolean;
  /** TOTP status only, never the secret. */
  readonly totp: "none" | "ok" | "unsupported";
  readonly historyCount: number;
}

export interface EntryValues {
  readonly title: string;
  readonly username: string;
  readonly password: string;
  readonly url: string;
  readonly notes: string;
  readonly icon: string;
  readonly customIcon: string | undefined;
  readonly fields: readonly CustomField[];
  readonly tags: readonly string[];
  readonly expires: string | null;
  /** The TOTP key URI; a secret like the password. */
  readonly otp: string | null;
  /** Metadata only; file keys stay in the core. */
  readonly attachments: readonly AttachmentInfo[];
}

/** The current values with `{REF}` resolved, the URL fully. */
export interface ResolvedValues {
  readonly title: ResolvedText;
  readonly username: ResolvedText;
  readonly password: ResolvedText;
  readonly notes: ResolvedText;
  /** In the order of `values.fields`. */
  readonly fields: readonly ResolvedText[];
  /** `undefined` for an empty URL. */
  readonly url: ResolvedUrl | undefined;
}

export interface HistoryItem {
  readonly index: number;
  readonly modified: string | undefined;
  readonly modifiedBy: string | undefined;
  readonly conflict: boolean;
  readonly restorable: boolean;
  readonly unreadable: boolean;
  readonly values: EntryValues;
  /** Content fields that differ from the next newer state. */
  readonly changed: readonly string[];
}

export interface EntryDetail {
  readonly summary: EntrySummary;
  /** Stored values, for editing; display and copy use `resolved`. */
  readonly values: EntryValues;
  readonly resolved: ResolvedValues;
  readonly attachments: readonly AttachmentInfo[];
  readonly history: readonly HistoryItem[];
  /** Group IDs from the root to the display parent. */
  readonly path: readonly string[];
}

export interface VaultView {
  readonly id: string;
  readonly role: "owner" | "member";
  /** `loading` until the first sync; `corrupt`: the vault key is unusable. */
  readonly status: "loading" | "ready" | "error" | "corrupt";
  /** `undefined` while loading or if `vault_meta` is missing or corrupt. */
  readonly name: string | undefined;
  readonly description: string;
  readonly color: string | null;
  readonly icon: string;
  readonly customIcon: string | undefined;
  readonly iconRef: IconRef | null;
  /** The icon library: valid live icons by ID. */
  readonly icons: ReadonlyMap<string, IconView>;
  /** Whether "Remove unused icons" may run. */
  readonly iconCleanup: "ok" | "corrupt" | "read_only";
  readonly writable: boolean;
  /** The server delivered older data than seen before. */
  readonly rollback: boolean;
  /** The rollback includes an older key version (a removed member could read new writes). */
  readonly keyRollback: boolean;
  readonly corrupt: readonly CorruptObjectView[];
  /**
   * The delivered state against the vault manifest: `mismatch` means the
   * server withholds data or delivers versions the manifest does not name.
   */
  readonly manifest: ManifestStatus;
  /** What does not match, for `mismatch`. */
  readonly manifestIssues: readonly ManifestIssue[];
  readonly rootGroupId: string | undefined;
  readonly recycleBinGroupId: string | null;
  readonly recycleBinEnabled: boolean;
  readonly historyMaxItems: number;
  readonly memberCount: number;
  readonly vaultKeyVersion: number;
  readonly memberKeyVersion: number;
  /** The current vault key: `pending` waits for a verification. */
  readonly keyStatus: "ok" | "pending" | "missing" | "invalid";
  /** The sender of a pending key, for the fingerprint dialog. */
  readonly pendingSender: Candidate | undefined;
  /** Why the pending key waits for the user. */
  readonly pendingReason: PendingReason | undefined;
  /** The owner-signed roles chain on this device. */
  readonly roles: RolesView;
  /** A member left; owners renew the key. */
  readonly rotationRequired: boolean;
  /**
   * Whether a device of the account confirmed the delivered state within
   * the period; `undefined` before the first sync. `stale` is read-only.
   */
  readonly freshness: "fresh" | "stale" | undefined;
  /** The last confirmation known (Unix ms); `undefined`: never. */
  readonly confirmedSince: number | undefined;
  readonly created: string;
  readonly error: unknown;
  readonly tree: VaultTree;
  readonly entries: ReadonlyMap<string, EntrySummary>;
}

/** An owner in the roles view. */
export interface RoleOwnerView {
  readonly userId: string;
  /**
   * The contact's address if the contact is verified with the keys the
   * chain names, else the server's; `undefined` if unknown.
   */
  readonly email: string | undefined;
  readonly verified: boolean;
  /** The server names other keys for the account than the chain. */
  readonly keysDiffer: boolean;
}

/** A state code for display. */
export interface StateCodeView {
  readonly version: number;
  /** 26 characters of Base32. */
  readonly code: string;
  /** "v7 · XXXX XXXX …". */
  readonly display: string;
}

/** The outcome of comparing a member's state code. */
export interface StateComparisonView {
  /**
   * `missing`: above the own head, and the server delivers nothing newer;
   * `withheld`: the server does not deliver the older statement;
   * `unavailable`: no checked chain to compare with.
   */
  readonly result:
    | "match"
    | "behind"
    | "mismatch"
    | "missing"
    | "withheld"
    | "other_vault"
    | "unavailable";
  readonly entered: StateCodeView;
  /**
   * This device's code to set against it: of the same version for
   * `mismatch`, else of the head.
   */
  readonly own: StateCodeView | undefined;
  /** The vault this device knows the code from, for `other_vault`. */
  readonly otherVault: string | undefined;
}

/** An owner of the statement an invitation names. */
export interface InvitationOwnerView {
  readonly userId: string;
  /** The contact's address if verified, else the server's. */
  readonly email: string | undefined;
  readonly verified: boolean;
  /** The server names other keys for the account than the statement. */
  readonly keysDiffer: boolean;
  readonly sender: boolean;
}

/** What the accept dialog shows of an invitation. */
export interface InvitationDetails {
  readonly vaultId: string;
  readonly vaultName: string | undefined;
  /**
   * `no_chain`: an older vault without owner list; `rejected`: the box
   * fails the roles check; `contradicted`: a member's code contradicts;
   * `sender_not_owner`: the sender owns no part of the statement named.
   */
  readonly status:
    "ok" | "no_chain" | "rejected" | "contradicted" | "sender_not_owner";
  /** Owners of the statement the box names. */
  readonly owners: readonly InvitationOwnerView[];
  /** The state code the account would have after accepting. */
  readonly code: (StateCodeView & { readonly uri: string }) | undefined;
  /** The head the dialog shows; accepting needs the same one. */
  readonly head:
    { readonly version: number; readonly hash: string } | undefined;
  /**
   * The chain contradicts what the account knew of the vault before (its
   * old anchor or this device's floor): accepted only explicitly.
   */
  readonly formerConflict: boolean;
}

/** The roles chain of a vault as this device checked it. */
export interface RolesView {
  /** `unsupported`: the server has no roles chains. */
  readonly status: RolesStatus | "unsupported";
  /**
   * Owners of the checked head; with a warning or before taking the list
   * over, those of the delivered head.
   */
  readonly owners: readonly RoleOwnerView[];
  /** Owners of the delivered head the anchor did not name. */
  readonly newOwners: readonly RoleOwnerView[];
  /** Co-owners must be verified before the owner list can be signed. */
  readonly verifyOwners: boolean;
  /** The server names other owners than the checked chain. */
  readonly ownersMismatch: boolean;
  /** The state code of the checked head, with the content of its QR code. */
  readonly code: (StateCodeView & { readonly uri: string }) | undefined;
  /** The member's code behind a warning. */
  readonly compared:
    | { readonly kind: "mismatch" | "missing"; readonly code: StateCodeView }
    | undefined;
  /** The last code that matched. */
  readonly lastMatch:
    | {
        readonly version: number;
        readonly at: string;
        readonly partner: RoleOwnerView | undefined;
      }
    | undefined;
  /**
   * The head "understood" or "take over" adopts, to be passed back with
   * them: `null` for no chain, `undefined` if it cannot be read.
   */
  readonly head: RolePoint | null | undefined;
}

/** A custom icon of a vault's library. */
export interface IconView {
  readonly id: string;
  readonly name: string;
  /** `data:image/png;base64,…` of the checked PNG. */
  readonly src: string;
  readonly hash: string;
  readonly source: IconSource | null;
  /** Referenced by a live object of the vault. */
  readonly used: boolean;
  readonly writable: boolean;
}

/** A pending invitation. */
export interface InvitationView {
  readonly vaultId: string;
  readonly keyVersion: number;
  readonly senderId: string;
  /** `undefined` if the server does not name the sender's key. */
  readonly sender: Candidate | undefined;
  /** From the box, informative only; `undefined` if it does not open. */
  readonly vaultName: string | undefined;
}

export interface SyncSnapshot {
  /** The vault list was loaded at least once. */
  readonly loaded: boolean;
  readonly invitations: readonly InvitationView[];
  readonly connection: ConnectionState;
  /** The marks could not be stored. */
  readonly marksLimited: boolean;
  /** Error of the last vault list request. */
  readonly error: unknown;
  readonly vaults: readonly VaultView[];
  /** Server time minus local time for TOTP, in ms. */
  readonly clockOffset: number;
}

interface Parsed<T> {
  raw: JsonObject;
  value: T;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Values compared by content; every other object by identity. */
const BY_CONTENT: ReadonlySet<string> = new Set([
  "iconRef",
  "defaultEntryIcon",
]);

/** Shallow equality of view objects; arrays of IDs compared by content. */
function sameView(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const x = left[key];
    const y = right[key];
    if (Array.isArray(x) && Array.isArray(y))
      return sameList(x as string[], y as string[]);
    if (BY_CONTENT.has(key)) return JSON.stringify(x) === JSON.stringify(y);
    return x === y;
  });
}

/** Caches parsed objects and views of one vault. */
function totpStatus(otp: string | null): EntrySummary["totp"] {
  if (otp === null) return "none";
  return parseOtpUri(otp).ok ? "ok" : "unsupported";
}

export class VaultProjection {
  readonly #groups = new Map<string, Parsed<Group>>();
  readonly #entries = new Map<string, Parsed<Entry>>();
  readonly #summaries = new Map<string, EntrySummary>();
  readonly #nodes = new Map<string, TreeNode>();
  readonly #icons = new Map<string, Parsed<Icon>>();
  readonly #iconViews = new Map<string, IconView>();
  #meta: Parsed<VaultMeta> | undefined;
  #layout: TreeLayout | undefined;
  #layoutMeta: JsonObject | undefined;
  #view: VaultView | undefined;
  #collator: Intl.Collator | undefined;
  #contacts: readonly Contact[] = [];

  constructor(readonly vaultId: string) {}

  /** Live, valid entries for placeholders; call after parsing. */
  readonly lookup: PlaceholderLookup = {
    entry: (id) => this.#entries.get(id)?.value,
  };

  get layout(): TreeLayout | undefined {
    return this.#layout;
  }

  #parseMeta(state: VaultState): VaultMeta | undefined {
    const meta = state.meta;
    if (!meta) {
      this.#meta = undefined;
      return undefined;
    }
    if (this.#meta?.raw !== meta.raw) {
      const inspected = inspectVaultMeta(meta.raw, meta.id, state.id);
      this.#meta =
        inspected.status === "ok"
          ? { raw: meta.raw, value: inspected.value }
          : undefined;
    }
    return this.#meta?.value;
  }

  /** Parses changed objects; returns true if anything changed. */
  #parse(state: VaultState): boolean {
    let changed = false;
    const seenGroups = new Set<string>();
    const seenEntries = new Set<string>();
    const seenIcons = new Set<string>();
    for (const object of state.objects.values()) {
      if (object.type === "group") {
        seenGroups.add(object.id);
        if (this.#groups.get(object.id)?.raw === object.raw) continue;
        const inspected = inspectGroup(object.raw);
        if (inspected.status === "ok")
          this.#groups.set(object.id, {
            raw: object.raw,
            value: inspected.value,
          });
        else this.#groups.delete(object.id);
        changed = true;
      } else if (object.type === "icon") {
        seenIcons.add(object.id);
        if (this.#icons.get(object.id)?.raw === object.raw) continue;
        const inspected = inspectIcon(object.raw);
        if (inspected.status === "ok")
          this.#icons.set(object.id, {
            raw: object.raw,
            value: inspected.value,
          });
        else this.#icons.delete(object.id);
        changed = true;
      } else if (object.type === "entry") {
        seenEntries.add(object.id);
        if (this.#entries.get(object.id)?.raw === object.raw) continue;
        const inspected = inspectEntry(object.raw);
        if (inspected.status === "ok")
          this.#entries.set(object.id, {
            raw: object.raw,
            value: inspected.value,
          });
        else this.#entries.delete(object.id);
        changed = true;
      }
    }
    for (const id of this.#groups.keys())
      if (!seenGroups.has(id)) {
        this.#groups.delete(id);
        changed = true;
      }
    for (const id of this.#entries.keys())
      if (!seenEntries.has(id)) {
        this.#entries.delete(id);
        this.#summaries.delete(id);
        changed = true;
      }
    for (const id of this.#icons.keys())
      if (!seenIcons.has(id)) {
        this.#icons.delete(id);
        changed = true;
      }
    return changed;
  }

  /** The layout of the current state, for planning writes. */
  layoutOf(state: VaultState, collator: Intl.Collator): TreeLayout {
    const meta = this.#parseMeta(state);
    const changed = this.#parse(state);
    if (
      this.#layout &&
      !changed &&
      this.#collator === collator &&
      this.#layoutMeta === state.meta?.raw
    )
      return this.#layout;
    this.#collator = collator;
    this.#layoutMeta = state.meta?.raw;
    const groups = new Map(
      [...this.#groups].map(([id, { value }]) => [
        id,
        {
          id,
          parentId: value.parentId,
          sortKey: value.sortKey,
          name: value.name,
          modified: timestamp(this.#groups.get(id)?.raw, "modified"),
        },
      ]),
    );
    const entries = new Map(
      [...this.#entries].map(([id, { value }]) => [
        id,
        {
          id,
          parentId: value.parentId,
          sortKey: value.sortKey,
          title: value.title,
        },
      ]),
    );
    this.#layout = buildTree({
      rootId: meta?.rootGroupId,
      binId: meta?.recycleBinGroupId ?? null,
      fallbackRootId: state.id,
      groups,
      entries,
      order: siblingOrder(collator),
    });
    return this.#layout;
  }

  group(id: string): Group | undefined {
    return this.#groups.get(id)?.value;
  }

  entry(id: string): Entry | undefined {
    return this.#entries.get(id)?.value;
  }

  /** A valid live icon of the library. */
  icon(id: string): Icon | undefined {
    return this.#icons.get(id)?.value;
  }

  /** The valid live icons of `state` by ID. */
  library(state: VaultState): ReadonlyMap<string, Icon> {
    this.#parse(state);
    return new Map([...this.#icons].map(([id, { value }]) => [id, value]));
  }

  /** `contacts` name the owners; without them the last ones given count. */
  view(
    state: VaultState,
    collator: Intl.Collator,
    contacts?: readonly Contact[],
  ): VaultView {
    if (contacts) this.#contacts = contacts;
    const meta = this.#parseMeta(state);
    const layout = this.layoutOf(state, collator);
    const writable = vaultWritable(state);
    const writableObject = (object: ObjectEntry | undefined) =>
      writable && object !== undefined && objectWritable(object);
    const custom = (ref: IconRef | null | undefined) =>
      ref?.type === "custom" && this.#icons.has(ref.id) ? ref.id : undefined;

    // Tree nodes, top-down, with the inherited default entry icon.
    const nodes = new Map<string, TreeNode>();
    const inherited = new Map<string, IconRef | null>();
    const queue = [layout.rootId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i] ?? layout.rootId;
      const object = state.objects.get(id);
      const group = this.#groups.get(id);
      const parentId =
        id === layout.rootId ? null : (layout.parent.get(id) ?? null);
      const kind =
        id === layout.rootId ? "root" : id === layout.binId ? "bin" : "group";
      const iconRef = group
        ? (parseIconRef(own(group.raw, "icon")) ?? null)
        : null;
      const fallback =
        kind === "bin" ? DEFAULT_ICONS.recycleBin : DEFAULT_ICONS.group;
      const own_ = group?.value.defaultEntryIcon ?? null;
      inherited.set(
        id,
        own_ ?? (parentId === null ? null : (inherited.get(parentId) ?? null)),
      );
      const problem = layout.problems.get(id);
      const node: TreeNode = {
        id,
        kind,
        name: group?.value.name ?? meta?.name ?? "",
        icon:
          kind === "root"
            ? iconName(meta?.icon ?? null, DEFAULT_ICONS.vault)
            : iconName(iconRef, fallback),
        customIcon: custom(kind === "root" ? meta?.icon : iconRef),
        iconRef,
        defaultEntryIcon: own_,
        notes: group?.value.notes ?? "",
        parentId,
        depth: layout.depth.get(id) ?? 0,
        children: layout.children.get(id) ?? [],
        entries: layout.entries.get(id) ?? [],
        inTrash: layout.inTrash.has(id),
        problem: kind === "root" && layout.missingRoot ? "missing" : problem,
        writable: writableObject(object),
        readOnly: (object?.readOnly ?? false) || (object?.superseded ?? false),
        rollback: object?.rollback ?? false,
        modified: timestamp(group?.raw, "modified"),
      };
      const previous = this.#nodes.get(id);
      nodes.set(id, previous && sameView(previous, node) ? previous : node);
      queue.push(...node.children);
    }
    this.#nodes.clear();
    for (const [id, node] of nodes) this.#nodes.set(id, node);

    const entries = new Map<string, EntrySummary>();
    for (const [id, { value }] of this.#entries) {
      const object = state.objects.get(id);
      const groupId = layout.parent.get(id) ?? layout.rootId;
      // Texts without a brace have nothing to resolve: the common case.
      const listed = (field: "title" | "username" | "url") =>
        value[field].includes("{")
          ? resolveText(id, field, this.lookup, { restricted: true }).value
          : value[field];
      const readOnly = object?.readOnly
        ? "schema"
        : object?.superseded
          ? "superseded"
          : value.invalid > 0
            ? "invalid"
            : undefined;
      const summary: EntrySummary = {
        id,
        vaultId: state.id,
        groupId,
        title: listed("title"),
        username: listed("username"),
        url: listed("url"),
        icon: iconName(
          value.icon ?? inherited.get(groupId) ?? null,
          DEFAULT_ICONS.entry,
        ),
        customIcon: custom(value.icon ?? inherited.get(groupId) ?? null),
        tags: value.tags,
        expires: value.expires,
        created: value.created,
        modified: value.modified,
        modifiedBy: value.modifiedBy,
        inTrash: layout.inTrash.has(id),
        problem: layout.problems.has(id) ? "orphan" : undefined,
        writable: writableObject(object),
        readOnly,
        invalid: value.invalid,
        rollback: object?.rollback ?? false,
        hasPassword: value.password !== "",
        totp: totpStatus(value.otp),
        historyCount: value.history.length,
      };
      const previous = this.#summaries.get(id);
      const kept = previous && sameView(previous, summary) ? previous : summary;
      this.#summaries.set(id, kept);
      entries.set(id, kept);
    }

    const repairs = [...layout.problems]
      .filter(([id]) => this.#groups.has(id) || this.#entries.has(id))
      .map(([id]) => id);
    const rollback =
      state.rollback ||
      state.rollbackDeletes.size > 0 ||
      [...state.objects.values()].some((o) => o.rollback);
    const roles = rolesView(state, this.#contacts);
    let status: VaultView["status"] = "ready";
    if (!state.keyOk) status = "corrupt";
    else if (state.error !== undefined) status = "error";
    else if (!state.synced) status = "loading";
    const previous = this.#view;
    const tree: VaultTree =
      previous &&
      previous.tree.rootId === layout.rootId &&
      previous.tree.missingRoot === layout.missingRoot &&
      previous.tree.binId === layout.binId &&
      sameList(previous.tree.repairs, repairs) &&
      previous.tree.nodes.size === nodes.size &&
      [...nodes].every(([id, node]) => previous.tree.nodes.get(id) === node)
        ? previous.tree
        : {
            rootId: layout.rootId,
            missingRoot: layout.missingRoot,
            binId: layout.binId,
            nodes,
            repairs,
          };
    const entryMap =
      previous &&
      previous.entries.size === entries.size &&
      [...entries].every(([id, e]) => previous.entries.get(id) === e)
        ? previous.entries
        : entries;
    const icons = this.#iconMap(state, writable);
    const corrupt = [...state.corrupt.values()].map((c) => ({
      id: c.id,
      type: c.type,
      reason: c.reason,
    }));
    const view: VaultView = {
      id: state.id,
      role: state.summary.role,
      status,
      name: meta?.name,
      description: meta?.description ?? "",
      color: meta?.color ?? null,
      icon: iconName(meta?.icon ?? null, DEFAULT_ICONS.vault),
      customIcon: custom(meta?.icon),
      iconRef: meta
        ? (parseIconRef(own(this.#meta?.raw ?? {}, "icon")) ?? null)
        : null,
      icons,
      iconCleanup: !writable
        ? "read_only"
        : corrupt.some((c) => c.type !== "icon" && c.type !== "manifest")
          ? "corrupt"
          : "ok",
      writable,
      rollback,
      keyRollback: state.summary.vault_key_version < state.keyFloor,
      corrupt:
        previous && JSON.stringify(previous.corrupt) === JSON.stringify(corrupt)
          ? previous.corrupt
          : corrupt,
      manifest: state.manifest.status,
      manifestIssues:
        previous &&
        JSON.stringify(previous.manifestIssues) ===
          JSON.stringify(state.manifest.issues)
          ? previous.manifestIssues
          : [...state.manifest.issues],
      rootGroupId: meta?.rootGroupId,
      recycleBinGroupId: meta?.recycleBinGroupId ?? null,
      recycleBinEnabled: meta?.recycleBinEnabled ?? false,
      historyMaxItems: meta?.historyMaxItems ?? 10,
      memberCount: state.summary.member_count,
      vaultKeyVersion: state.summary.vault_key_version,
      memberKeyVersion: state.summary.member_key_version,
      keyStatus: state.keyStatus,
      pendingSender: state.pendingSender,
      pendingReason: state.pendingReason,
      roles:
        previous && JSON.stringify(previous.roles) === JSON.stringify(roles)
          ? previous.roles
          : roles,
      rotationRequired: state.summary.rotation_required,
      freshness: state.freshness?.status,
      confirmedSince: state.freshness?.since,
      created: state.summary.created,
      error: state.error,
      tree,
      entries: entryMap,
    };
    this.#view = previous && sameView(previous, view) ? previous : view;
    return this.#view;
  }

  /** The library with usage; unchanged icons and maps keep their identity. */
  #iconMap(
    state: VaultState,
    writable: boolean,
  ): ReadonlyMap<string, IconView> {
    const used = usedIcons(state);
    const icons = new Map<string, IconView>();
    for (const [id, { value }] of this.#icons) {
      const object = state.objects.get(id);
      const previous = this.#iconViews.get(id);
      const view: IconView = {
        id,
        name: value.name,
        src:
          previous?.hash === value.hash
            ? previous.src
            : iconDataUrl(value.data),
        hash: value.hash,
        source: value.source,
        used: used.has(id),
        writable: writable && object !== undefined && objectWritable(object),
      };
      const same =
        previous !== undefined &&
        previous.name === view.name &&
        previous.hash === view.hash &&
        previous.used === view.used &&
        previous.writable === view.writable &&
        JSON.stringify(previous.source) === JSON.stringify(view.source);
      icons.set(id, same ? previous : view);
    }
    this.#iconViews.clear();
    for (const [id, view] of icons) this.#iconViews.set(id, view);
    const known = this.#view?.icons;
    return known &&
      known.size === icons.size &&
      [...icons].every(([id, icon]) => known.get(id) === icon)
      ? known
      : icons;
  }

  /** Values, history and path of one entry, built on request. */
  detail(
    state: VaultState,
    id: string,
    collator: Intl.Collator,
  ): EntryDetail | undefined {
    const view = this.view(state, collator);
    const summary = view.entries.get(id);
    const parsed = this.#entries.get(id);
    if (!summary || !parsed) return undefined;
    const layout = this.layoutOf(state, collator);
    const inheritedIcon = summary.icon;
    const values = (content: EntryContent, fallback: string): EntryValues => ({
      title: content.title,
      username: content.username,
      password: content.password,
      url: content.url,
      notes: content.notes,
      icon: iconName(content.icon, fallback),
      customIcon:
        content.icon === null
          ? summary.customIcon
          : content.icon.type === "custom" && this.#icons.has(content.icon.id)
            ? content.icon.id
            : undefined,
      fields: content.fields,
      tags: content.tags,
      expires: content.expires,
      otp: content.otp,
      attachments: content.attachments,
    });
    const snapshots = historyOf(parsed.raw);
    const history = parsed.value.history.map((snapshot, index): HistoryItem => {
      const newer = index === 0 ? parsed.raw : snapshots[index - 1];
      const own_ = snapshots[index];
      const comparable =
        typeof own_ === "object" &&
        own_ !== null &&
        typeof newer === "object" &&
        newer !== null;
      return {
        index,
        modified: snapshot.modified,
        modifiedBy: snapshot.modifiedBy,
        conflict: snapshot.conflict,
        restorable: !snapshot.readOnly && !snapshot.unreadable,
        unreadable: snapshot.unreadable,
        values: values(snapshot, inheritedIcon),
        changed: comparable
          ? changedFields(own_ as JsonObject, newer as JsonObject)
          : [],
      };
    });
    const resolve = (field: TextField) => resolveText(id, field, this.lookup);
    return {
      summary,
      values: values(parsed.value, inheritedIcon),
      resolved: {
        title: resolve("title"),
        username: resolve("username"),
        password: resolve("password"),
        notes: resolve("notes"),
        fields: parsed.value.fields.map((_, custom) => resolve({ custom })),
        url:
          parsed.value.url.trim() === ""
            ? undefined
            : resolveUrl(id, this.lookup),
      },
      attachments: parsed.value.attachments,
      history,
      path: ancestors(layout, id),
    };
  }
}

function timestamp(
  raw: JsonObject | undefined,
  key: string,
): string | undefined {
  const value = raw ? own(raw, key) : undefined;
  return isTimestamp(value) ? value : undefined;
}

/** IDs of icons that a live object refers to, from the raw JSON. */
export function usedIcons(state: VaultState): Set<string> {
  const used = new Set<string>();
  for (const object of state.objects.values())
    if (object.type !== "icon" && object.type !== "manifest")
      for (const id of iconRefs(object.raw)) used.add(id);
  return used;
}

/**
 * An address from the server as it may be shown: none with whitespace,
 * commas, control or format characters (bidi overrides), which could make
 * it read as several names or as someone else's.
 */
export function plausibleEmail(email: string | undefined): string | undefined {
  return email !== undefined &&
    email.includes("@") &&
    !/[\s,\p{C}]/u.test(email)
    ? email
    : undefined;
}

/**
 * The roles chain for display. An owner is named by the contact only if the
 * contact is verified with the keys the chain names; a contact's address
 * next to a forged head would otherwise look trustworthy.
 */
function rolesView(state: VaultState, contacts: readonly Contact[]): RolesView {
  const roles = state.roles;
  if (!roles)
    return {
      status: "unsupported",
      owners: [],
      newOwners: [],
      verifyOwners: false,
      ownersMismatch: false,
      code: undefined,
      compared: undefined,
      lastMatch: undefined,
      head: null,
    };
  const members = state.members ?? [];
  const entries: readonly RoleOwner[] = roles.head
    ? roles.head.statement.owners
    : roles.deliveredOwners;
  const named = (userId: string): RoleOwnerView => {
    const member = members.find((m) => m.user_id === userId);
    // Not in the chain (a comparison partner): the keys of the member list.
    const entry =
      entries.find((o) => o.userId === userId) ??
      (member?.signing_public_key
        ? {
            userId,
            publicKey: member.public_key,
            signingKey: member.signing_public_key,
          }
        : undefined);
    if (!entry)
      return {
        userId,
        email: plausibleEmail(member?.email),
        verified: false,
        keysDiffer: false,
      };
    const publicKey = fromBase64Url(entry.publicKey, 32);
    const status = contactStatus(contacts, userId, {
      v1: fingerprintHex(publicKey),
      v2: fingerprint2Hex(publicKey, fromBase64Url(entry.signingKey, 32)),
    });
    if (status === "verified")
      return {
        userId,
        email: contacts.find((c) => c.userId === userId)?.email,
        verified: true,
        keysDiffer: false,
      };
    return {
      userId,
      email: plausibleEmail(member?.email),
      verified: false,
      keysDiffer:
        member !== undefined &&
        (member.public_key !== entry.publicKey ||
          (member.signing_public_key ?? undefined) !== entry.signingKey),
    };
  };
  const ids = entries.map((o) => o.userId);
  const known = new Set(roles.anchor?.owners ?? []);
  const active = members.filter((m) => m.state === "active");
  const serverOwners = new Set(
    active.filter((m) => m.role === "owner").map((m) => m.user_id),
  );
  // Owners who left are dropped from the chain; that is no mismatch.
  const listed = ids.filter((id) => active.some((m) => m.user_id === id));
  const ownersMismatch =
    roles.status === "ok" &&
    state.members !== undefined &&
    (listed.some((id) => !serverOwners.has(id)) ||
      [...serverOwners].some((id) => !ids.includes(id)));
  return {
    status: roles.status,
    owners: ids.map(named),
    newOwners:
      roles.status === "ok" || roles.anchor === undefined
        ? []
        : roles.deliveredOwners
            .map((o) => o.userId)
            .filter((id) => !known.has(id))
            .map(named),
    verifyOwners: roles.verifyOwners,
    ownersMismatch,
    code: roles.code
      ? {
          ...stateCodeView(roles.code),
          uri: stateCodeUri(state.id, roles.code),
        }
      : undefined,
    compared: roles.compared
      ? { kind: roles.compared.kind, code: stateCodeView(roles.compared.point) }
      : undefined,
    lastMatch: state.lastMatch
      ? {
          version: state.lastMatch.version,
          at: state.lastMatch.at,
          partner:
            state.lastMatch.partner === null
              ? undefined
              : named(state.lastMatch.partner),
        }
      : undefined,
    head:
      roles.status === "unanchored" && roles.head
        ? { version: roles.head.statement.version, hash: roles.head.hash }
        : roles.deliveredHead !== undefined
          ? roles.deliveredHead
          : roles.version === null
            ? null
            : undefined,
  };
}

export function stateCodeView(code: StateCode): StateCodeView {
  return {
    version: code.version,
    code: code.code,
    display: formatStateCode(code),
  };
}
