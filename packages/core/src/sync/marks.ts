/**
 * High-water marks for the rollback detection: per vault
 * the highest revision and key version, the owners, the highest root
 * `seq` of the manifest, the checked head of the roles chain and the time
 * this device last confirmed the vault as current, per object the highest
 * `seq` (negative for a tombstone), per account revision and `seq` of
 * `user_data` with its confirmation. Only IDs, counters and times, nothing
 * secret.
 */
import * as v from "valibot";
import { UUID_PATTERN } from "../crypto/uuid";

export interface VaultMarks {
  rev: number;
  /**
   * Highest key version whose key this device held; a lower one from the
   * server is a rollback (a removed member might read what is written).
   */
  kv?: number;
  /**
   * Owners seen while this device held the current key; only their
   * pending keys are accepted without asking. Replaced, never merged.
   */
  ow?: string[];
  /**
   * Highest `seq` of the manifest root seen; a floor that no
   * acknowledgement lowers, so a root `seq` is never given out twice.
   */
  mf?: number;
  /**
   * Version and hash of the newest roles statement checked on this device;
   * only "understood" at a roles warning lowers it.
   */
  rl?: [number, string];
  /**
   * When this device last confirmed the vault as current (Unix ms, device
   * clock); `0` = never. Missing on marks from before this field existed.
   */
  ft?: number;
  /** Object ID → `seq`; negative: a tombstone with this `seq`. */
  obj: Record<string, number>;
}

export interface UserMarks {
  /** Revision and `seq` of `user_data`. */
  ud?: [number, number];
  /** When this device last confirmed `user_data` (Unix ms); `0` = never. */
  uf?: number;
  /** The confirmation period in days that applied at `uf`. */
  fd?: number;
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
  /** Replaces the owners of a vault. */
  rememberOwners(
    userId: string,
    vaultId: string,
    owners: readonly string[],
  ): Promise<boolean>;
  /** Replaces the roles floor of a vault; `undefined` removes it. */
  replaceRoles(
    userId: string,
    vaultId: string,
    rl: [number, string] | undefined,
  ): Promise<boolean>;
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

/** The higher roles floor; at the same version the first one stays. */
function higherRoles(
  a: [number, string] | undefined,
  b: [number, string] | undefined,
): [number, string] | undefined {
  if (!a) return b ? [b[0], b[1]] : undefined;
  if (!b || b[0] <= a[0]) return [a[0], a[1]];
  return [b[0], b[1]];
}

function maxDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

/**
 * Per-entry maximum of two mark sets. Owners are not a maximum: those of
 * `a` win, so stored owners come before the ones in memory. The period
 * `fd` goes with the later `uf`, so it can also go down.
 */
export function mergeMarks(a: UserMarks, b: UserMarks): UserMarks {
  const result: UserMarks = { vaults: {} };
  if (a.ud || b.ud) {
    const [ar, as] = a.ud ?? [0, 0];
    const [br, bs] = b.ud ?? [0, 0];
    result.ud = [Math.max(ar, br), Math.max(as, bs)];
  }
  if (a.uf !== undefined || b.uf !== undefined) {
    const later = b.uf !== undefined && (a.uf === undefined || b.uf > a.uf);
    const source = later ? b : a;
    result.uf = source.uf;
    if (source.fd !== undefined) result.fd = source.fd;
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
    const kv = Math.max(left?.kv ?? 0, right?.kv ?? 0);
    const ow = left?.ow ?? right?.ow;
    const mf = Math.max(left?.mf ?? 0, right?.mf ?? 0);
    const rl = higherRoles(left?.rl, right?.rl);
    const ft = maxDefined(left?.ft, right?.ft);
    result.vaults[id] = {
      rev: Math.max(left?.rev ?? 0, right?.rev ?? 0),
      ...(kv > 0 ? { kv } : {}),
      ...(ow ? { ow: [...ow] } : {}),
      ...(mf > 0 ? { mf } : {}),
      ...(rl ? { rl } : {}),
      ...(ft !== undefined ? { ft } : {}),
      obj,
    };
  }
  return result;
}

function copy(marks: UserMarks): UserMarks {
  return mergeMarks(marks, emptyMarks());
}

/**
 * `marks` replacing `current`; the manifest floor and the confirmation time
 * never go down, and the roles floor only changes through `replaceRoles`.
 */
function replacing(
  current: VaultMarks | undefined,
  marks: VaultMarks,
): VaultMarks {
  const mf = Math.max(current?.mf ?? 0, marks.mf ?? 0);
  const rl = higherRoles(current?.rl, marks.rl);
  const ft = maxDefined(current?.ft, marks.ft);
  return copyVault({
    ...marks,
    ...(mf > 0 ? { mf } : {}),
    ...(rl ? { rl } : {}),
    ...(ft !== undefined ? { ft } : {}),
  });
}

function copyVault(marks: VaultMarks): VaultMarks {
  return {
    rev: marks.rev,
    ...(marks.kv !== undefined ? { kv: marks.kv } : {}),
    ...(marks.ow !== undefined ? { ow: [...marks.ow] } : {}),
    ...(marks.mf !== undefined ? { mf: marks.mf } : {}),
    ...(marks.rl !== undefined ? { rl: [marks.rl[0], marks.rl[1]] } : {}),
    ...(marks.ft !== undefined ? { ft: marks.ft } : {}),
    obj: { ...marks.obj },
  };
}

function withRoles(
  marks: UserMarks,
  vaultId: string,
  rl: [number, string] | undefined,
): UserMarks {
  const next = copy(marks);
  const vault = { ...(next.vaults[vaultId] ?? { rev: 0, obj: {} }) };
  if (rl) vault.rl = [rl[0], rl[1]];
  else Reflect.deleteProperty(vault, "rl");
  next.vaults[vaultId] = vault;
  return next;
}

function withOwners(
  marks: UserMarks,
  vaultId: string,
  owners: readonly string[],
): UserMarks {
  const next = copy(marks);
  next.vaults[vaultId] = {
    ...(next.vaults[vaultId] ?? { rev: 0, obj: {} }),
    ow: [...owners],
  };
  return next;
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
      current.vaults[vaultId] = replacing(current.vaults[vaultId], marks);
      users.set(userId, current);
      return Promise.resolve(true);
    },
    replaceUserData: (userId, ud) => {
      const current = get(userId);
      current.ud = [ud[0], ud[1]];
      users.set(userId, current);
      return Promise.resolve(true);
    },
    rememberOwners: (userId, vaultId, owners) => {
      users.set(userId, withOwners(get(userId), vaultId, owners));
      return Promise.resolve(true);
    },
    replaceRoles: (userId, vaultId, rl) => {
      users.set(userId, withRoles(get(userId), vaultId, rl));
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
      uf: v.optional(Counter),
      fd: v.optional(v.pipe(Counter, v.minValue(1), v.maxValue(90))),
      vaults: v.record(
        Id,
        v.object({
          rev: Counter,
          kv: v.optional(Counter),
          ow: v.optional(v.array(Id)),
          mf: v.optional(Counter),
          rl: v.optional(
            v.tuple([
              v.pipe(Counter, v.minValue(1)),
              v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
            ]),
          ),
          ft: v.optional(Counter),
          obj: v.record(Id, ObjectMark),
        }),
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
        Object.entries(parsed.users).map(([id, marks]): [string, UserMarks] => [
          id,
          {
            ...(marks.ud ? { ud: marks.ud } : {}),
            ...(marks.uf !== undefined ? { uf: marks.uf } : {}),
            ...(marks.fd !== undefined ? { fd: marks.fd } : {}),
            vaults: marks.vaults,
          },
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
        next.vaults[vaultId] = replacing(next.vaults[vaultId], marks);
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
    async rememberOwners(userId, vaultId, owners) {
      await memory.rememberOwners(userId, vaultId, owners);
      return update(userId, (current) =>
        withOwners(current ?? emptyMarks(), vaultId, owners),
      );
    },
    async replaceRoles(userId, vaultId, rl) {
      await memory.replaceRoles(userId, vaultId, rl);
      return update(userId, (current) =>
        withRoles(current ?? emptyMarks(), vaultId, rl),
      );
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
