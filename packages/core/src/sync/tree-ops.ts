/**
 * Plans for changes of the tree: moving, the recycle bin, permanent
 * deletion, repair and new groups. Each plan reads the current state when
 * it runs, so a repetition after a conflict decides again.
 */
import type { JsonObject } from "../crypto/bytes";
import { utf8Length } from "../model/history";
import { keysAtEnd, keysForInsert, type Sibling } from "../model/sort-key";
import { isWithin, subtree, type TreeLayout } from "../model/tree";
import { tokenize } from "../placeholders/tokens";
import {
  applyObjectChange,
  inspectVaultMeta,
  newGroup,
  type IconRef,
  type Stamp,
  type VaultMeta,
} from "../model/vault";
import { SyncError } from "./errors";
import type { VaultState } from "./vault";
import type { VaultProjection } from "./views";
import { objectWritable, vaultWritable, type Intent } from "./writer";

export type ItemRef = { kind: "group" | "entry"; id: string };

/** Where moved objects go; `before`: the sibling group to insert before. */
export interface MoveTarget {
  vaultId: string;
  groupId: string;
  before?: string;
}

export type MoveBlock = "root" | "bin" | "cycle" | "target" | "read_only";

export type MoveCheck = { ok: true } | { ok: false; reason: MoveBlock };

export interface DeletePlan {
  /** `trash`: into the recycle bin; `permanent`: tombstones after confirmation. */
  mode: "trash" | "permanent" | "blocked";
  reason?: "root" | "bin" | "read_only" | "mixed";
  groups: number;
  entries: number;
  /** The recycle bin is created by this deletion. */
  createsBin: boolean;
}

export type BinState = "usable" | "create" | "disabled" | "unusable";

export interface Ops {
  state: VaultState;
  projection: VaultProjection;
  collator: Intl.Collator;
  stamp: () => Stamp;
}

export const MAX_OPS = 500;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;

export function layoutOf(ops: Ops): TreeLayout {
  return ops.projection.layoutOf(ops.state, ops.collator);
}

export function metaOf(state: VaultState): VaultMeta {
  const meta = state.meta;
  const inspected = meta && inspectVaultMeta(meta.raw, meta.id, state.id);
  if (inspected?.status !== "ok") throw new SyncError("read_only");
  return inspected.value;
}

/** A group that can take children: an existing group or the root. */
export function isGroupNode(ops: Ops, layout: TreeLayout, id: string): boolean {
  return (
    ops.projection.group(id) !== undefined ||
    (id === layout.rootId && !layout.missingRoot)
  );
}

function writable(state: VaultState, id: string): boolean {
  const object = state.objects.get(id);
  return object !== undefined && objectWritable(object);
}

function groupSiblings(
  ops: Ops,
  layout: TreeLayout,
  parentId: string,
  without: ReadonlySet<string>,
): Sibling[] {
  return (layout.children.get(parentId) ?? [])
    .filter((id) => !without.has(id))
    .map((id) => {
      const group = ops.projection.group(id);
      return { id, sortKey: group?.sortKey ?? "", name: group?.name ?? "" };
    });
}

function entryKeys(
  ops: Ops,
  layout: TreeLayout,
  parentId: string,
  without: ReadonlySet<string>,
): string[] {
  return (layout.entries.get(parentId) ?? [])
    .filter((id) => !without.has(id))
    .map((id) => ops.projection.entry(id)?.sortKey ?? "");
}

/** Sort keys for groups and entries placed into `parentId`, plus re-keyed siblings. */
function placement(
  ops: Ops,
  layout: TreeLayout,
  parentId: string,
  items: readonly ItemRef[],
  before: string | undefined,
): { keys: Map<string, string>; rekey: Intent[] } {
  const moved = new Set(items.map((i) => i.id));
  const groups = items.filter((i) => i.kind === "group");
  const entries = items.filter((i) => i.kind === "entry");
  const keys = new Map<string, string>();
  const rekey: Intent[] = [];
  if (groups.length > 0) {
    const siblings = groupSiblings(ops, layout, parentId, moved);
    let index =
      before === undefined ? -1 : siblings.findIndex((s) => s.id === before);
    if (index < 0) index = siblings.length;
    const insertion = keysForInsert(siblings, index, groups.length);
    groups.forEach((item, i) => keys.set(item.id, insertion.keys[i] ?? ""));
    for (const [id, sortKey] of insertion.rekey) {
      const object = ops.state.objects.get(id);
      if (!object || !objectWritable(object)) throw new SyncError("read_only");
      rekey.push({
        kind: "update",
        id,
        baseRaw: object.raw,
        baseRevision: object.revision,
        local: applyObjectChange(object.raw, { sortKey }, ops.stamp()),
      });
    }
  }
  if (entries.length > 0) {
    const entryKeyList = keysAtEnd(
      entryKeys(ops, layout, parentId, moved),
      entries.length,
    );
    entries.forEach((item, i) => keys.set(item.id, entryKeyList[i] ?? ""));
  }
  return { keys, rekey };
}

/** A real group as previous parent, never the stand-in root. */
function previousParent(
  ops: Ops,
  layout: TreeLayout,
  id: string,
): string | undefined {
  const parent = layout.parent.get(id);
  if (parent === undefined || !isGroupNode(ops, layout, parent))
    return undefined;
  return layout.inTrash.has(parent) || parent === layout.binId
    ? undefined
    : parent;
}

export interface Base {
  raw: JsonObject;
  revision: number;
}

export function basesOf(
  state: VaultState,
  items: readonly ItemRef[],
): Map<string, Base> {
  const bases = new Map<string, Base>();
  for (const item of items) {
    const object = state.objects.get(item.id);
    if (!object || object.type !== item.kind) throw new SyncError("not_found");
    bases.set(item.id, { raw: object.raw, revision: object.revision });
  }
  return bases;
}

// ------------------------------------------------------------ checks

export function checkMove(
  source: Ops,
  target: Ops,
  items: readonly ItemRef[],
  to: MoveTarget,
): MoveCheck {
  if (!vaultWritable(source.state) || !vaultWritable(target.state))
    return { ok: false, reason: "read_only" };
  const layout = layoutOf(source);
  const targetLayout = source === target ? layout : layoutOf(target);
  if (!isGroupNode(target, targetLayout, to.groupId))
    return { ok: false, reason: "target" };
  const across = source !== target;
  if (
    across &&
    (targetLayout.inTrash.has(to.groupId) || to.groupId === targetLayout.binId)
  )
    return { ok: false, reason: "target" };
  for (const item of items) {
    if (item.kind === "group") {
      if (item.id === layout.rootId) return { ok: false, reason: "root" };
      if (across && item.id === layout.binId)
        return { ok: false, reason: "bin" };
      if (!across && isWithin(layout, to.groupId, item.id))
        return { ok: false, reason: "cycle" };
    }
    if (!writable(source.state, item.id))
      return { ok: false, reason: "read_only" };
    if (!across) continue;
    const { groups, entries } =
      item.kind === "group"
        ? subtree(layout, item.id)
        : { groups: [], entries: [item.id] };
    if (groups.some((id) => id === layout.binId))
      return { ok: false, reason: "bin" };
    for (const id of [...groups, ...entries])
      if (!writable(source.state, id))
        return { ok: false, reason: "read_only" };
  }
  return { ok: true };
}

export function binState(ops: Ops, layout: TreeLayout): BinState {
  const meta = metaOf(ops.state);
  if (!meta.recycleBinEnabled) return "disabled";
  const id = meta.recycleBinGroupId;
  if (id === null || id === layout.rootId) return "create";
  if (layout.binId === id)
    return writable(ops.state, id) ? "usable" : "unusable";
  return ops.state.corrupt.has(id) || ops.state.objects.has(id)
    ? "unusable"
    : "create";
}

function union(
  layout: TreeLayout,
  items: readonly ItemRef[],
): { groups: string[]; entries: string[] } {
  const groups = new Set<string>();
  const entries = new Set<string>();
  for (const item of items) {
    if (item.kind === "entry") {
      entries.add(item.id);
      continue;
    }
    const tree = subtree(layout, item.id);
    tree.groups.forEach((id) => groups.add(id));
    tree.entries.forEach((id) => entries.add(id));
  }
  return { groups: [...groups], entries: [...entries] };
}

/**
 * Entries whose `{REF}` stops working when `items` leave the vault:
 * references from other entries to moved ones and from moved
 * entries to the rest, in the current values.
 */
export function brokenReferences(ops: Ops, items: readonly ItemRef[]): number {
  const moved = new Set(union(layoutOf(ops), items).entries);
  let count = 0;
  for (const id of ops.state.objects.keys()) {
    const entry = ops.projection.entry(id);
    if (!entry) continue;
    const texts = [
      entry.title,
      entry.username,
      entry.password,
      entry.url,
      entry.notes,
      ...entry.fields.map((field) => field.value),
    ];
    const crosses = texts.some(
      (text) =>
        text.includes("{") &&
        tokenize(text).some(
          (token) =>
            token.kind === "ref" &&
            ops.projection.entry(token.id) !== undefined &&
            moved.has(token.id) !== moved.has(id),
        ),
    );
    if (crosses) count++;
  }
  return count;
}

export function deletePlan(ops: Ops, items: readonly ItemRef[]): DeletePlan {
  const layout = layoutOf(ops);
  const { groups, entries } = union(layout, items);
  const counts = {
    groups: groups.length,
    entries: entries.length,
    createsBin: false,
  };
  for (const item of items) {
    if (item.kind !== "group") continue;
    if (item.id === layout.rootId)
      return { mode: "blocked", reason: "root", ...counts };
    if (item.id === layout.binId || groups.includes(layout.binId ?? ""))
      return { mode: "blocked", reason: "bin", ...counts };
  }
  const trashed = items.filter((i) => layout.inTrash.has(i.id)).length;
  if (trashed > 0 && trashed < items.length)
    return { mode: "blocked", reason: "mixed", ...counts };
  const bin = binState(ops, layout);
  if (!vaultWritable(ops.state))
    return { mode: "blocked", reason: "read_only", ...counts };
  if (trashed === 0 && (bin === "usable" || bin === "create")) {
    if (!items.every((i) => writable(ops.state, i.id)))
      return { mode: "blocked", reason: "read_only", ...counts };
    return { mode: "trash", ...counts, createsBin: bin === "create" };
  }
  if (![...groups, ...entries].every((id) => writable(ops.state, id)))
    return { mode: "blocked", reason: "read_only", ...counts };
  return { mode: "permanent", ...counts };
}

// ------------------------------------------------------------ plans

/** Moves within one vault; in and out of the bin set `previousParentId`. */
export function planMove(
  ops: Ops,
  items: readonly ItemRef[],
  to: MoveTarget,
  bases: Map<string, Base>,
): Intent[] {
  const layout = layoutOf(ops);
  if (!isGroupNode(ops, layout, to.groupId))
    throw new SyncError("invalid_target");
  const { keys, rekey } = placement(ops, layout, to.groupId, items, to.before);
  const intoTrash =
    to.groupId === layout.binId || layout.inTrash.has(to.groupId);
  const intents: Intent[] = [...rekey];
  for (const item of items) {
    const base = bases.get(item.id);
    if (!base) continue;
    const change: Record<string, unknown> = {
      parentId: to.groupId,
      sortKey: keys.get(item.id),
    };
    const inTrash = layout.inTrash.has(item.id);
    if (intoTrash && !inTrash)
      change.previousParentId = previousParent(ops, layout, item.id);
    if (!intoTrash && inTrash) change.previousParentId = undefined;
    intents.push({
      kind: "update",
      id: item.id,
      baseRaw: base.raw,
      baseRevision: base.revision,
      local: applyObjectChange(base.raw, change, ops.stamp()),
    });
  }
  return intents;
}

/** Into the bin; creates it first when missing. */
export function planTrash(
  ops: Ops,
  items: readonly ItemRef[],
  bases: Map<string, Base>,
  newBin: { id: string; name: string },
): Intent[] {
  const layout = layoutOf(ops);
  const state = binState(ops, layout);
  if (state === "usable" && layout.binId !== undefined)
    return planMove(
      ops,
      items,
      { vaultId: ops.state.id, groupId: layout.binId },
      bases,
    );
  if (state !== "create" || layout.missingRoot)
    throw new SyncError("read_only");
  const meta = ops.state.meta;
  if (!meta) throw new SyncError("read_only");
  const stamp = ops.stamp();
  const [binKey = ""] = keysForInsert(
    groupSiblings(ops, layout, layout.rootId, new Set()),
    layout.children.get(layout.rootId)?.length ?? 0,
    1,
  ).keys;
  const intents: Intent[] = [
    {
      kind: "create",
      id: newBin.id,
      type: "group",
      content: newGroup(
        {
          name: newBin.name,
          parentId: layout.rootId,
          sortKey: binKey,
          icon: { type: "builtin", name: "trash-2" },
        },
        stamp,
      ),
    },
    {
      kind: "update",
      id: meta.id,
      baseRaw: meta.raw,
      baseRevision: meta.revision,
      local: applyObjectChange(
        meta.raw,
        { recycleBinGroupId: newBin.id },
        stamp,
      ),
    },
  ];
  const keys = keysAtEnd([], items.length);
  items.forEach((item, i) => {
    const base = bases.get(item.id);
    if (!base) return;
    intents.push({
      kind: "update",
      id: item.id,
      baseRaw: base.raw,
      baseRevision: base.revision,
      local: applyObjectChange(
        base.raw,
        {
          parentId: newBin.id,
          sortKey: keys[i],
          previousParentId: previousParent(ops, layout, item.id),
        },
        stamp,
      ),
    });
  });
  return intents;
}

/** Out of the bin to `previousParentId` or the root. */
export function planRestore(
  ops: Ops,
  items: readonly ItemRef[],
  bases: Map<string, Base>,
): Intent[] {
  const layout = layoutOf(ops);
  if (layout.missingRoot) throw new SyncError("read_only");
  const targets = new Map<string, ItemRef[]>();
  for (const item of items) {
    if (!layout.inTrash.has(item.id)) continue;
    const previous =
      item.kind === "group"
        ? ops.projection.group(item.id)?.previousParentId
        : ops.projection.entry(item.id)?.previousParentId;
    const target =
      previous !== undefined &&
      isGroupNode(ops, layout, previous) &&
      previous !== layout.binId &&
      !layout.inTrash.has(previous) &&
      !isWithin(layout, previous, item.id)
        ? previous
        : layout.rootId;
    targets.set(target, [...(targets.get(target) ?? []), item]);
  }
  const intents: Intent[] = [];
  for (const [target, list] of targets)
    intents.push(
      ...planMove(ops, list, { vaultId: ops.state.id, groupId: target }, bases),
    );
  return intents;
}

/** Tombstones bottom-up: entries first, then groups from the deepest level. */
export function destroyIntents(ops: Ops, items: readonly ItemRef[]): Intent[] {
  const layout = layoutOf(ops);
  for (const item of items)
    if (
      item.kind === "group" &&
      (item.id === layout.rootId || item.id === layout.binId)
    )
      throw new SyncError("invalid_target");
  const { groups, entries } = union(layout, items);
  if (groups.includes(layout.binId ?? ""))
    throw new SyncError("invalid_target");
  const ids = [
    ...entries,
    ...groups.sort(
      (a, b) => (layout.depth.get(b) ?? 0) - (layout.depth.get(a) ?? 0),
    ),
  ];
  return ids.map((id) => {
    const object = ops.state.objects.get(id);
    if (!object || !objectWritable(object)) throw new SyncError("read_only");
    return { kind: "delete", id, baseRevision: object.revision };
  });
}

/** Orphans and cycle heads below the root. */
export function repairIntents(ops: Ops): Intent[] {
  const layout = layoutOf(ops);
  if (layout.missingRoot) return [];
  const items: ItemRef[] = [];
  for (const id of layout.problems.keys()) {
    if (!writable(ops.state, id)) continue;
    if (ops.projection.group(id)) items.push({ kind: "group", id });
    else if (ops.projection.entry(id)) items.push({ kind: "entry", id });
  }
  return planMove(
    ops,
    items,
    { vaultId: ops.state.id, groupId: layout.rootId },
    basesOf(ops.state, items),
  );
}

/** A new root group for a vault whose root is missing. */
export function newRootIntents(ops: Ops, id: string, name: string): Intent[] {
  const layout = layoutOf(ops);
  const meta = ops.state.meta;
  if (!layout.missingRoot) return [];
  if (!meta || !objectWritable(meta)) throw new SyncError("read_only");
  const stamp = ops.stamp();
  return [
    {
      kind: "create",
      id,
      type: "group",
      content: newGroup({ name, parentId: null }, stamp),
    },
    {
      kind: "update",
      id: meta.id,
      baseRaw: meta.raw,
      baseRevision: meta.revision,
      local: applyObjectChange(meta.raw, { rootGroupId: id }, stamp),
    },
  ];
}

export interface GroupProps {
  name: string;
  icon?: IconRef | null;
  defaultEntryIcon?: IconRef | null;
  notes?: string;
}

export function planNewGroup(
  ops: Ops,
  id: string,
  parentId: string,
  props: GroupProps,
): Intent[] {
  const layout = layoutOf(ops);
  if (
    !isGroupNode(ops, layout, parentId) ||
    layout.inTrash.has(parentId) ||
    parentId === layout.binId
  )
    throw new SyncError("invalid_target");
  const { keys, rekey } = placement(
    ops,
    layout,
    parentId,
    [{ kind: "group", id }],
    undefined,
  );
  return [
    ...rekey,
    {
      kind: "create",
      id,
      type: "group",
      content: newGroup(
        { ...props, parentId, sortKey: keys.get(id) ?? "" },
        ops.stamp(),
      ),
    },
  ];
}

/** Splits intents into batches of at most 500 ops and about 12 MiB. */
export function chunks(intents: readonly Intent[]): Intent[][] {
  const result: Intent[][] = [];
  let current: Intent[] = [];
  let bytes = 0;
  for (const intent of intents) {
    const content =
      intent.kind === "create"
        ? intent.content
        : intent.kind === "update"
          ? intent.local
          : undefined;
    // Encrypted size: padding, envelope and Base64url, plus the op itself.
    const size = content
      ? Math.ceil(((utf8Length(JSON.stringify(content)) + 297) * 4) / 3) + 300
      : 600;
    if (
      current.length > 0 &&
      (current.length >= MAX_OPS || bytes + size > MAX_BATCH_BYTES)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(intent);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}
