/**
 * The only module that touches browser storage. Exactly these
 * localStorage keys exist; nothing secret, no e-mail addresses, no tokens.
 */
import {
  storedSyncMarks,
  type KdfCost,
  type KdfMemory,
  type Language,
  type SyncMarks,
} from "@keeman/core";
import * as v from "valibot";

export const STORAGE_KEYS = {
  theme: "keeman.theme",
  locale: "keeman.locale",
  kdfSeen: "keeman.kdfSeen",
  syncSeen: "keeman.syncSeen",
  view: "keeman.view",
} as const;

export const ALLOWED_STORAGE_KEYS: readonly string[] =
  Object.values(STORAGE_KEYS);

export type Theme = "system" | "light" | "dark";

const MAX_KDF_ACCOUNTS = 20;

const KdfSeenSchema = v.object({
  v: v.literal(1),
  users: v.record(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
    v.object({
      ops: v.pipe(v.number(), v.integer(), v.minValue(1)),
      mem: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
});

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage may be unavailable (private mode); preferences are optional.
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // see write()
  }
}

export function loadTheme(): Theme {
  const value = read(STORAGE_KEYS.theme);
  if (value === "light" || value === "dark" || value === "system") return value;
  if (value !== null) remove(STORAGE_KEYS.theme);
  return "system";
}

export function saveTheme(theme: Theme): void {
  if (theme === "system") remove(STORAGE_KEYS.theme);
  else write(STORAGE_KEYS.theme, theme);
}

export function loadLocale(): Language | undefined {
  const value = read(STORAGE_KEYS.locale);
  if (value === "de" || value === "en") return value;
  if (value !== null) remove(STORAGE_KEYS.locale);
  return undefined;
}

export function saveLocale(locale: Language): void {
  write(STORAGE_KEYS.locale, locale);
}

function loadKdfSeen(): Map<string, KdfCost> {
  const text = read(STORAGE_KEYS.kdfSeen);
  if (text === null) return new Map();
  try {
    const parsed = v.parse(KdfSeenSchema, JSON.parse(text));
    return new Map(Object.entries(parsed.users));
  } catch {
    remove(STORAGE_KEYS.kdfSeen);
    return new Map();
  }
}

/** Last seen KDF parameters per account, most recently used last. */
export const kdfMemory: KdfMemory = {
  get(userId) {
    return loadKdfSeen().get(userId);
  },
  set(userId, cost) {
    const seen = loadKdfSeen();
    seen.delete(userId);
    seen.set(userId, { ops: cost.ops, mem: cost.mem });
    const entries = [...seen.entries()].slice(-MAX_KDF_ACCOUNTS);
    write(
      STORAGE_KEYS.kdfSeen,
      JSON.stringify({ v: 1, users: Object.fromEntries(entries) }),
    );
  },
  forget(userId) {
    const seen = loadKdfSeen();
    if (!seen.delete(userId)) return;
    write(
      STORAGE_KEYS.kdfSeen,
      JSON.stringify({ v: 1, users: Object.fromEntries(seen.entries()) }),
    );
  },
};

const SYNC_LOCK = "keeman-sync-seen";

/** Read-modify-write of the marks across tabs. */
function withSyncLock<T>(task: () => T): Promise<T> {
  const locks = (navigator as Partial<Pick<Navigator, "locks">>).locks;
  if (!locks) return Promise.resolve(task());
  return locks.request(SYNC_LOCK, () => task());
}

/** Rollback marks per account in `keeman.syncSeen`. */
export const syncMarks: SyncMarks = storedSyncMarks(
  {
    load: () => read(STORAGE_KEYS.syncSeen),
    save: (text) => write(STORAGE_KEYS.syncSeen, text),
    remove: () => {
      remove(STORAGE_KEYS.syncSeen);
    },
  },
  withSyncLock,
);

// ------------------------------------------------------------ keeman.view

export interface ViewLayout {
  detail: "right" | "bottom";
  /** "Show entries of subgroups". */
  subgroups: boolean;
  sort: "title" | "username" | "url" | "modified";
  dir: "asc" | "desc";
}

/** Deviations from the default: vault node and first level open. */
export interface TreeState {
  open: string[];
  closed: string[];
}

export const DEFAULT_LAYOUT: Readonly<ViewLayout> = Object.freeze({
  detail: "right",
  subgroups: false,
  sort: "title",
  dir: "asc",
});

const VIEW_MAX_ACCOUNTS = 20;
const VIEW_MAX_IDS = 2000;
const VIEW_MAX_CHARS = 500_000;
const Uuid = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
);

const ViewSchema = v.object({
  v: v.literal(1),
  layout: v.optional(
    v.object({
      detail: v.picklist(["right", "bottom"]),
      subgroups: v.boolean(),
      sort: v.picklist(["title", "username", "url", "modified"]),
      dir: v.picklist(["asc", "desc"]),
    }),
  ),
  users: v.optional(
    v.record(
      Uuid,
      v.object({
        tree: v.record(
          Uuid,
          v.object({ open: v.array(Uuid), closed: v.array(Uuid) }),
        ),
      }),
    ),
  ),
});

type ViewData = v.InferOutput<typeof ViewSchema>;

function loadView(): ViewData {
  const text = read(STORAGE_KEYS.view);
  if (text === null) return { v: 1 };
  try {
    return v.parse(ViewSchema, JSON.parse(text));
  } catch {
    remove(STORAGE_KEYS.view);
    return { v: 1 };
  }
}

function saveView(data: ViewData): void {
  const users = Object.entries(data.users ?? {});
  let text = JSON.stringify({ ...data, users: Object.fromEntries(users) });
  // Oldest accounts go first when the limit is reached.
  while (text.length > VIEW_MAX_CHARS && users.length > 0) {
    users.shift();
    text = JSON.stringify({ ...data, users: Object.fromEntries(users) });
  }
  write(STORAGE_KEYS.view, text);
}

/** Layout of the main view and the tree state per account and vault. */
export const viewState = {
  layout(): ViewLayout {
    return { ...DEFAULT_LAYOUT, ...loadView().layout };
  },
  saveLayout(layout: ViewLayout): void {
    saveView({ ...loadView(), layout: { ...layout } });
  },
  tree(userId: string, vaultId: string): TreeState {
    const state = loadView().users?.[userId]?.tree[vaultId];
    return {
      open: [...(state?.open ?? [])],
      closed: [...(state?.closed ?? [])],
    };
  },
  saveTree(userId: string, vaultId: string, state: TreeState): void {
    const data = loadView();
    const users = { ...data.users };
    const tree = { ...users[userId]?.tree };
    const open = state.open.slice(-VIEW_MAX_IDS);
    const closed = state.closed.slice(-(VIEW_MAX_IDS - open.length));
    if (open.length === 0 && closed.length === 0)
      Reflect.deleteProperty(tree, vaultId);
    else tree[vaultId] = { open, closed };
    // Most recently used account last.
    Reflect.deleteProperty(users, userId);
    users[userId] = { tree };
    const entries = Object.entries(users).slice(-VIEW_MAX_ACCOUNTS);
    saveView({ ...data, users: Object.fromEntries(entries) });
  },
  /** After deleting the account on this device. */
  forget(userId: string): void {
    const data = loadView();
    if (!data.users?.[userId]) return;
    const users = { ...data.users };
    Reflect.deleteProperty(users, userId);
    saveView({ ...data, users });
  },
};
