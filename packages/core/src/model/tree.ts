/**
 * The tree as shown: root, recycle bin, orphans and cycles. Every
 * group and entry gets a display parent; nothing is dropped. Linear in the
 * number of objects.
 */
import type { Sibling } from "./sort-key";

export interface TreeGroupInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sortKey: string;
  readonly name: string;
  readonly modified: string | undefined;
}

export interface TreeEntryInput {
  readonly id: string;
  readonly parentId: string;
  readonly sortKey: string;
  readonly title: string;
}

export interface TreeInput {
  /** `vault_meta.rootGroupId`; `undefined` if `vault_meta` is unusable. */
  rootId: string | undefined;
  /** `vault_meta.recycleBinGroupId`. */
  binId: string | null;
  /** Node ID of the root when neither `rootId` nor the group exists. */
  fallbackRootId: string;
  groups: ReadonlyMap<string, TreeGroupInput>;
  entries: ReadonlyMap<string, TreeEntryInput>;
  order: (a: Sibling, b: Sibling) => number;
}

export type TreeProblem = "orphan" | "cycle";

export interface TreeLayout {
  /** The root node: the root group, or a stand-in if it is missing. */
  rootId: string;
  missingRoot: boolean;
  /** A group other than the root that `recycleBinGroupId` names. */
  binId: string | undefined;
  /** Display parent of every group except the root, and of every entry. */
  parent: ReadonlyMap<string, string>;
  /** Child groups per group, sorted. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Entries per group, sorted by key, title and ID. */
  entries: ReadonlyMap<string, readonly string[]>;
  depth: ReadonlyMap<string, number>;
  /** Groups and entries below the recycle bin (not the bin itself). */
  inTrash: ReadonlySet<string>;
  problems: ReadonlyMap<string, TreeProblem>;
}

function newest(
  ids: string[],
  groups: ReadonlyMap<string, TreeGroupInput>,
): string {
  let best = ids[0] ?? "";
  for (const id of ids.slice(1)) {
    const a = groups.get(id)?.modified ?? "";
    const b = groups.get(best)?.modified ?? "";
    if (a > b || (a === b && id < best)) best = id;
  }
  return best;
}

export function buildTree(input: TreeInput): TreeLayout {
  const { groups, entries } = input;
  const missingRoot = input.rootId === undefined || !groups.has(input.rootId);
  const rootId = input.rootId ?? input.fallbackRootId;
  const isParent = (id: string | null): id is string =>
    id !== null && (id === rootId || groups.has(id));
  const parent = new Map<string, string>();
  const problems = new Map<string, TreeProblem>();

  for (const group of groups.values()) {
    if (group.id === rootId) continue;
    if (isParent(group.parentId)) parent.set(group.id, group.parentId);
    else {
      parent.set(group.id, rootId);
      problems.set(group.id, "orphan");
    }
  }

  // Cycles: walk up until the root or a finished group; a group seen on the
  // current walk closes a cycle, whose newest member moves below the root.
  const state = new Map<string, 1 | 2>();
  for (const start of parent.keys()) {
    const path: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && current !== rootId && !state.has(current)) {
      state.set(current, 1);
      path.push(current);
      current = parent.get(current);
    }
    if (current !== undefined && state.get(current) === 1) {
      const head = newest(path.slice(path.indexOf(current)), groups);
      parent.set(head, rootId);
      problems.set(head, "cycle");
    }
    for (const id of path) state.set(id, 2);
  }

  const children = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const [id, of] of parent) add(children, of, id);
  const groupSibling = (id: string): Sibling => {
    const group = groups.get(id);
    return { id, sortKey: group?.sortKey ?? "", name: group?.name ?? "" };
  };
  for (const list of children.values())
    list.sort((a, b) => input.order(groupSibling(a), groupSibling(b)));

  const binId =
    input.binId !== null && input.binId !== rootId && groups.has(input.binId)
      ? input.binId
      : undefined;
  const depth = new Map<string, number>([[rootId, 0]]);
  const inTrash = new Set<string>();
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] ?? rootId;
    const trashed = id === binId || inTrash.has(id);
    for (const child of children.get(id) ?? []) {
      depth.set(child, (depth.get(id) ?? 0) + 1);
      if (trashed) inTrash.add(child);
      queue.push(child);
    }
  }

  const entryLists = new Map<string, string[]>();
  for (const entry of entries.values()) {
    let of = entry.parentId;
    if (!isParent(of)) {
      of = rootId;
      problems.set(entry.id, "orphan");
    }
    parent.set(entry.id, of);
    if (of === binId || inTrash.has(of)) inTrash.add(entry.id);
    add(entryLists, of, entry.id);
  }
  const entrySibling = (id: string): Sibling => {
    const entry = entries.get(id);
    return { id, sortKey: entry?.sortKey ?? "", name: entry?.title ?? "" };
  };
  for (const list of entryLists.values())
    list.sort((a, b) => input.order(entrySibling(a), entrySibling(b)));

  return {
    rootId,
    missingRoot,
    binId,
    parent,
    children,
    entries: entryLists,
    depth,
    inTrash,
    problems,
  };
}

/** Groups (top-down, starting with `groupId`) and entries of a subtree. */
export function subtree(
  layout: TreeLayout,
  groupId: string,
): { groups: string[]; entries: string[] } {
  const groups = [groupId];
  const entries: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const id = groups[i] ?? groupId;
    groups.push(...(layout.children.get(id) ?? []));
    entries.push(...(layout.entries.get(id) ?? []));
  }
  return { groups, entries };
}

/** IDs from the root down to the display parent of `id`. */
export function ancestors(layout: TreeLayout, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = layout.parent.get(id);
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = layout.parent.get(current);
  }
  return chain.reverse();
}

/** `id` lies in the subtree of `groupId` (or is it). */
export function isWithin(
  layout: TreeLayout,
  id: string,
  groupId: string,
): boolean {
  return id === groupId || ancestors(layout, id).includes(groupId);
}
