/**
 * High-water marks for the rollback detection: per vault
 * the highest revision, per object the highest `seq` (negative for a
 * tombstone), per account revision and `seq` of `user_data`. Only IDs and
 * counters, nothing secret.
 */
import * as v from "valibot";
import { UUID_PATTERN } from "../crypto/uuid";

export interface VaultMarks {
  rev: number;
  /** Object ID → `seq`; negative: a tombstone with this `seq`. */
  obj: Record<string, number>;
}

export interface UserMarks {
  /** Revision and `seq` of `user_data`. */
  ud?: [number, number];
  vaults: Record<string, VaultMarks>;
}

/** Where the marks of all accounts on this device live (`keeman.syncSeen`). */
export interface SyncMarks {
  read(userId: string): Promise<UserMarks>;
  /** Raises every entry to at least these values; `false`: not persisted. */
  raise(userId: string, marks: UserMarks): Promise<boolean>;
  /** Replaces the marks of a vault ("understood"). */
  replaceVault(
    userId: string,
    vaultId: string,
    marks: VaultMarks,
  ): Promise<boolean>;
  replaceUserData(userId: string, ud: [number, number]): Promise<boolean>;
  forgetVault(userId: string, vaultId: string): Promise<boolean>;
  forgetUser(userId: string): Promise<boolean>;
}

export function objectMark(seq: number, deleted: boolean): number {
  return deleted ? -seq : seq;
}

/** Order of marks: a tombstone ranks above the live object with the same `seq`. */
function rank(mark: number): number {
  return mark > 0 ? 2 * mark : -2 * mark + 1;
}

/** Whether an object or tombstone is older than the mark. */
export function isOlder(
  mark: number | undefined,
  seq: number,
  deleted: boolean,
): boolean {
  return mark !== undefined && rank(objectMark(seq, deleted)) < rank(mark);
}

export function higherMark(a: number | undefined, b: number): number {
  return a === undefined || rank(b) > rank(a) ? b : a;
}

export function isUserDataOlder(
  ud: [number, number] | undefined,
  revision: number,
  seq: number,
): boolean {
  return ud !== undefined && (revision < ud[0] || seq < ud[1]);
}

function emptyMarks(): UserMarks {
  return { vaults: {} };
}

/** Per-entry maximum of two mark sets. */
export function mergeMarks(a: UserMarks, b: UserMarks): UserMarks {
  const result: UserMarks = { vaults: {} };
  if (a.ud || b.ud) {
    const [ar, as] = a.ud ?? [0, 0];
    const [br, bs] = b.ud ?? [0, 0];
    result.ud = [Math.max(ar, br), Math.max(as, bs)];
  }
  for (const id of new Set([
    ...Object.keys(a.vaults),
    ...Object.keys(b.vaults),
  ])) {
    const left = a.vaults[id];
    const right = b.vaults[id];
    const obj: Record<string, number> = { ...left?.obj };
    for (const [objectId, mark] of Object.entries(right?.obj ?? {}))
      obj[objectId] = higherMark(obj[objectId], mark);
    result.vaults[id] = {
      rev: Math.max(left?.rev ?? 0, right?.rev ?? 0),
      obj,
    };
  }
  return result;
}

function copy(marks: UserMarks): UserMarks {
  return mergeMarks(marks, emptyMarks());
}

/** Marks kept in memory only (tests, and the fallback without storage). */
export function inMemorySyncMarks(): SyncMarks {
  const users = new Map<string, UserMarks>();
  const get = (userId: string) => users.get(userId) ?? emptyMarks();
  return {
    read: (userId) => Promise.resolve(copy(get(userId))),
    raise: (userId, marks) => {
      users.set(userId, mergeMarks(get(userId), marks));
      return Promise.resolve(true);
    },
    replaceVault: (userId, vaultId, marks) => {
      const current = get(userId);
      current.vaults[vaultId] = { rev: marks.rev, obj: { ...marks.obj } };
      users.set(userId, current);
      return Promise.resolve(true);
    },
    replaceUserData: (userId, ud) => {
      const current = get(userId);
      current.ud = [ud[0], ud[1]];
      users.set(userId, current);
      return Promise.resolve(true);
    },
    forgetVault: (userId, vaultId) => {
      const current = get(userId);
      Reflect.deleteProperty(current.vaults, vaultId);
      users.set(userId, current);
      return Promise.resolve(true);
    },
    forgetUser: (userId) => {
      users.delete(userId);
      return Promise.resolve(true);
    },
  };
}

/** At most this many accounts and characters in storage. */
export const MARKS_MAX_ACCOUNTS = 20;
export const MARKS_MAX_CHARS = 2_000_000;

const Id = v.pipe(v.string(), v.regex(UUID_PATTERN));
const Counter = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ObjectMark = v.pipe(
  v.number(),
  v.safeInteger(),
  v.check((n) => n !== 0),
);

const StoredSchema = v.object({
  v: v.literal(1),
  users: v.record(
    Id,
    v.object({
      ud: v.optional(v.tuple([Counter, Counter])),
      vaults: v.record(
        Id,
        v.object({ rev: Counter, obj: v.record(Id, ObjectMark) }),
      ),
    }),
  ),
});

export interface MarksStore {
  /** The stored text, or `null`. */
  load(): string | null;
  /** `false` if the text could not be stored (quota, private mode). */
  save(text: string): boolean;
  remove(): void;
}

/** Runs `task` exclusively across tabs (Web Locks in the app). */
export type MarksLock = <T>(task: () => T) => Promise<T>;

/**
 * Marks in a key-value store: read-modify-write under a lock, per-entry
 * maximum, most recently used accounts last, size limits. Invalid stored
 * data is discarded. If storing fails, the values stay in memory and the
 * methods report `false`.
 */
export function storedSyncMarks(store: MarksStore, lock: MarksLock): SyncMarks {
  const memory = inMemorySyncMarks();
  const loadAll = (): Map<string, UserMarks> => {
    const text = store.load();
    if (text === null) return new Map();
    try {
      const parsed = v.parse(StoredSchema, JSON.parse(text));
      return new Map(
        Object.entries(parsed.users).map(([id, marks]) => [
          id,
          marks.ud
            ? { ud: marks.ud, vaults: marks.vaults }
            : { vaults: marks.vaults },
        ]),
      );
    } catch {
      store.remove();
      return new Map();
    }
  };
  const saveAll = (users: Map<string, UserMarks>, current: string): boolean => {
    const entries = [...users.entries()].slice(-MARKS_MAX_ACCOUNTS);
    for (;;) {
      const text = JSON.stringify({ v: 1, users: Object.fromEntries(entries) });
      if (text.length <= MARKS_MAX_CHARS) return store.save(text);
      // Drop the least recently used other account first.
      const index = entries.findIndex(([id]) => id !== current);
      if (index < 0) return false;
      entries.splice(index, 1);
    }
  };
  const update = (
    userId: string,
    change: (marks: UserMarks | undefined) => UserMarks | undefined,
  ): Promise<boolean> =>
    lock(() => {
      const users = loadAll();
      const next = change(users.get(userId));
      users.delete(userId);
      if (next) users.set(userId, next);
      return saveAll(users, userId);
    });
  return {
    async read(userId) {
      const stored = await lock(() => loadAll().get(userId));
      return mergeMarks(stored ?? emptyMarks(), await memory.read(userId));
    },
    async raise(userId, marks) {
      await memory.raise(userId, marks);
      return update(userId, (current) =>
        mergeMarks(current ?? emptyMarks(), marks),
      );
    },
    async replaceVault(userId, vaultId, marks) {
      await memory.replaceVault(userId, vaultId, marks);
      return update(userId, (current) => {
        const next = copy(current ?? emptyMarks());
        next.vaults[vaultId] = { rev: marks.rev, obj: { ...marks.obj } };
        return next;
      });
    },
    async replaceUserData(userId, ud) {
      await memory.replaceUserData(userId, ud);
      return update(userId, (current) => ({
        ...copy(current ?? emptyMarks()),
        ud,
      }));
    },
    async forgetVault(userId, vaultId) {
      await memory.forgetVault(userId, vaultId);
      return update(userId, (current) => {
        const next = copy(current ?? emptyMarks());
        Reflect.deleteProperty(next.vaults, vaultId);
        return next;
      });
    },
    async forgetUser(userId) {
      await memory.forgetUser(userId);
      return update(userId, () => undefined);
    },
  };
}
