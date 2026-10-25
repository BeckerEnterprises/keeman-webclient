import { describe, expect, it } from "vitest";
import {
  higherMark,
  inMemorySyncMarks,
  isOlder,
  isUserDataOlder,
  MARKS_MAX_ACCOUNTS,
  mergeMarks,
  storedSyncMarks,
  type MarksStore,
} from "../../src/sync/marks";

const U = (n: number) =>
  `0192b3a4-5c6d-7e8f-9a0b-${n.toString(16).padStart(12, "0")}`;
const VAULT = U(100);
const OBJ = U(200);

function memoryStore(): MarksStore & { text: string | null; fail: boolean } {
  return {
    text: null,
    fail: false,
    load() {
      return this.text;
    },
    save(text) {
      if (this.fail) return false;
      this.text = text;
      return true;
    },
    remove() {
      this.text = null;
    },
  };
}

const lock = <T>(task: () => T) => Promise.resolve(task());

function parse(text: string | null): { users: Record<string, unknown> } {
  return JSON.parse(text ?? "{}") as { users: Record<string, unknown> };
}

describe("rollback marks", () => {
  it("orders objects and tombstones", () => {
    expect(isOlder(undefined, 1, false)).toBe(false);
    expect(isOlder(5, 4, false)).toBe(true);
    expect(isOlder(5, 5, false)).toBe(false);
    expect(isOlder(5, 6, true)).toBe(false);
    // A live object at or below a tombstone is a revival.
    expect(isOlder(-6, 6, false)).toBe(true);
    expect(isOlder(-6, 7, false)).toBe(false);
    expect(isOlder(-6, 6, true)).toBe(false);
    expect(isOlder(-6, 5, true)).toBe(true);
    expect(higherMark(undefined, 3)).toBe(3);
    expect(higherMark(5, -5)).toBe(-5);
    expect(higherMark(-5, 5)).toBe(-5);
    expect(isUserDataOlder(undefined, 1, 1)).toBe(false);
    expect(isUserDataOlder([4, 9], 3, 9)).toBe(true);
    expect(isUserDataOlder([4, 9], 4, 8)).toBe(true);
    expect(isUserDataOlder([4, 9], 5, 9)).toBe(false);
  });

  it("merges as maximum per entry", () => {
    const merged = mergeMarks(
      { ud: [3, 1], vaults: { [VAULT]: { rev: 4, obj: { [OBJ]: 2, a: 7 } } } },
      {
        ud: [2, 5],
        vaults: {
          [VAULT]: { rev: 3, obj: { [OBJ]: -3 } },
          x: { rev: 1, obj: {} },
        },
      },
    );
    expect(merged).toEqual({
      ud: [3, 5],
      vaults: {
        [VAULT]: { rev: 4, obj: { [OBJ]: -3, a: 7 } },
        x: { rev: 1, obj: {} },
      },
    });
    expect(mergeMarks({ vaults: {} }, { vaults: {} })).toEqual({ vaults: {} });
  });

  it("keeps marks in memory", async () => {
    const marks = inMemorySyncMarks();
    await marks.raise(U(1), {
      ud: [2, 2],
      vaults: { [VAULT]: { rev: 5, obj: { [OBJ]: 3 } } },
    });
    await marks.raise(U(1), {
      vaults: { [VAULT]: { rev: 4, obj: { [OBJ]: 1 } } },
    });
    expect(await marks.read(U(1))).toEqual({
      ud: [2, 2],
      vaults: { [VAULT]: { rev: 5, obj: { [OBJ]: 3 } } },
    });
    await marks.replaceVault(U(1), VAULT, { rev: 1, obj: { [OBJ]: 1 } });
    await marks.replaceUserData(U(1), [1, 1]);
    expect(await marks.read(U(1))).toEqual({
      ud: [1, 1],
      vaults: { [VAULT]: { rev: 1, obj: { [OBJ]: 1 } } },
    });
    await marks.forgetVault(U(1), VAULT);
    expect((await marks.read(U(1))).vaults).toEqual({});
    await marks.forgetUser(U(1));
    expect(await marks.read(U(1))).toEqual({ vaults: {} });
  });
});

describe("stored marks", () => {
  it("stores, raises and replaces under the lock", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, lock);
    expect(
      await marks.raise(U(1), {
        ud: [1, 1],
        vaults: { [VAULT]: { rev: 2, obj: { [OBJ]: 2 } } },
      }),
    ).toBe(true);
    expect(parse(store.text)).toEqual({
      v: 1,
      users: {
        [U(1)]: {
          ud: [1, 1],
          vaults: { [VAULT]: { rev: 2, obj: { [OBJ]: 2 } } },
        },
      },
    });
    // Another tab wrote higher values meanwhile: the maximum stays.
    const other = storedSyncMarks(store, lock);
    await other.raise(U(1), { vaults: { [VAULT]: { rev: 9, obj: {} } } });
    await marks.raise(U(1), {
      vaults: { [VAULT]: { rev: 3, obj: { [OBJ]: 1 } } },
    });
    expect((await marks.read(U(1))).vaults[VAULT]).toEqual({
      rev: 9,
      obj: { [OBJ]: 2 },
    });
    await marks.replaceVault(U(1), VAULT, { rev: 1, obj: {} });
    await marks.replaceUserData(U(1), [0, 0]);
    expect(await other.read(U(1))).toEqual({
      ud: [0, 0],
      vaults: { [VAULT]: { rev: 9, obj: {} } },
    });
    await marks.forgetVault(U(1), VAULT);
    expect((await storedSyncMarks(store, lock).read(U(1))).vaults).toEqual({});
    await marks.forgetUser(U(1));
    expect(parse(store.text).users).toEqual({});
  });

  it("keeps the key version as a maximum and reads older data without it", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, (task) => Promise.resolve(task()));
    const user = U(1);
    await marks.raise(user, {
      vaults: { [VAULT]: { rev: 3, kv: 2, obj: {} } },
    });
    await marks.raise(user, {
      vaults: { [VAULT]: { rev: 4, kv: 1, obj: {} } },
    });
    expect((await marks.read(user)).vaults[VAULT]).toEqual({
      rev: 4,
      kv: 2,
      obj: {},
    });
    // "Understood" replaces it, also with none at all.
    await marks.replaceVault(user, VAULT, { rev: 4, obj: {} });
    expect(parse(store.text).users[user]).toEqual({
      vaults: { [VAULT]: { rev: 4, obj: {} } },
    });
    // Data written before the key version existed stays valid.
    store.text = JSON.stringify({
      v: 1,
      users: { [user]: { vaults: { [VAULT]: { rev: 7, obj: {} } } } },
    });
    const fresh = storedSyncMarks(store, (task) => Promise.resolve(task()));
    expect((await fresh.read(user)).vaults[VAULT]).toEqual({ rev: 7, obj: {} });
  });

  it("replaces the owners, keeps them through raises and reads older data without them", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, (task) => Promise.resolve(task()));
    const user = U(1);
    await marks.rememberOwners(user, VAULT, [U(2), U(3)]);
    await marks.raise(user, { vaults: { [VAULT]: { rev: 5, obj: {} } } });
    expect((await marks.read(user)).vaults[VAULT]).toEqual({
      rev: 5,
      ow: [U(2), U(3)],
      obj: {},
    });
    // Replaced, not merged: a demoted owner is gone.
    await marks.rememberOwners(user, VAULT, [U(2)]);
    expect(parse(store.text).users[user]).toEqual({
      vaults: { [VAULT]: { rev: 5, ow: [U(2)], obj: {} } },
    });
    // Another tab stored newer owners: stored ones come before memory.
    store.text = JSON.stringify({
      v: 1,
      users: {
        [user]: { vaults: { [VAULT]: { rev: 5, ow: [U(4)], obj: {} } } },
      },
    });
    expect((await marks.read(user)).vaults[VAULT]?.ow).toEqual([U(4)]);
    // Data from before the owners existed stays valid.
    store.text = JSON.stringify({
      v: 1,
      users: { [user]: { vaults: { [VAULT]: { rev: 7, obj: {} } } } },
    });
    const fresh = storedSyncMarks(store, (task) => Promise.resolve(task()));
    expect((await fresh.read(user)).vaults[VAULT]).toEqual({ rev: 7, obj: {} });
    // Owners must be account IDs.
    store.text = JSON.stringify({
      v: 1,
      users: {
        [user]: { vaults: { [VAULT]: { rev: 7, ow: ["x"], obj: {} } } },
      },
    });
    const invalid = storedSyncMarks(store, (task) => Promise.resolve(task()));
    expect((await invalid.read(user)).vaults[VAULT]).toBeUndefined();
  });

  it("discards invalid data and keeps the most recent accounts", async () => {
    const store = memoryStore();
    store.text = '{"v":1,"users":{"nope":{}}}';
    const marks = storedSyncMarks(store, lock);
    expect(await marks.read(U(1))).toEqual({ vaults: {} });
    expect(store.text).toBeNull();
    store.text = "{not json";
    expect(await marks.read(U(1))).toEqual({ vaults: {} });
    for (let i = 0; i <= MARKS_MAX_ACCOUNTS; i++)
      await marks.raise(U(i + 1), {
        vaults: { [VAULT]: { rev: i + 1, obj: {} } },
      });
    const users = Object.keys(parse(store.text).users);
    expect(users).toHaveLength(MARKS_MAX_ACCOUNTS);
    expect(users).not.toContain(U(1));
    expect(users.at(-1)).toBe(U(MARKS_MAX_ACCOUNTS + 1));
  });

  it("drops other accounts when too large and reports when it cannot store", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, lock);
    const big = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [U(1000 + i), i + 1]),
      );
    await marks.raise(U(1), {
      vaults: { [VAULT]: { rev: 1, obj: big(20_000) } },
    });
    expect(
      await marks.raise(U(2), {
        vaults: { [VAULT]: { rev: 1, obj: big(30_000) } },
      }),
    ).toBe(true);
    expect(Object.keys(parse(store.text).users)).toEqual([U(2)]);
    expect(
      await marks.raise(U(2), {
        vaults: { [VAULT]: { rev: 1, obj: big(50_000) } },
      }),
    ).toBe(false);
    // Values that could not be stored stay in memory.
    store.fail = true;
    expect(await marks.raise(U(3), { ud: [5, 5], vaults: {} })).toBe(false);
    expect((await marks.read(U(3))).ud).toEqual([5, 5]);
  });
});
