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

  it("keeps the manifest floor as a maximum that no replacement lowers", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, (task) => Promise.resolve(task()));
    const user = U(1);
    await marks.raise(user, {
      vaults: { [VAULT]: { rev: 3, mf: 5, obj: {} } },
    });
    await marks.raise(user, {
      vaults: { [VAULT]: { rev: 4, mf: 2, obj: {} } },
    });
    expect((await marks.read(user)).vaults[VAULT]).toEqual({
      rev: 4,
      mf: 5,
      obj: {},
    });
    // "Understood" replaces the marks but never lowers the floor, also when
    // another tab stored a higher one.
    await marks.replaceVault(user, VAULT, { rev: 2, mf: 3, obj: {} });
    expect(parse(store.text).users[user]).toEqual({
      vaults: { [VAULT]: { rev: 2, mf: 5, obj: {} } },
    });
    store.text = JSON.stringify({
      v: 1,
      users: { [user]: { vaults: { [VAULT]: { rev: 2, mf: 9, obj: {} } } } },
    });
    await marks.replaceVault(user, VAULT, { rev: 2, obj: {} });
    expect(parse(store.text).users[user]).toEqual({
      vaults: { [VAULT]: { rev: 2, mf: 9, obj: {} } },
    });
    // Data written before the floor existed stays valid.
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
    // Written before any sync: confirmed never, no marks from before
    // confirmation times.
    expect((await marks.read(user)).vaults[VAULT]).toEqual({
      rev: 5,
      ow: [U(2), U(3)],
      ft: 0,
      obj: {},
    });
    // Replaced, not merged: a demoted owner is gone.
    await marks.rememberOwners(user, VAULT, [U(2)]);
    expect(parse(store.text).users[user]).toEqual({
      vaults: { [VAULT]: { rev: 5, ow: [U(2)], ft: 0, obj: {} } },
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

describe("roles floor", () => {
  const H1 = "A".repeat(43);
  const H2 = "Q".repeat(42) + "A";
  const USER = U(1);

  it("only rises when merged and keeps the first at the same version", () => {
    const merged = mergeMarks(
      { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [2, H1] } } },
      { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [3, H2] } } },
    );
    expect(merged.vaults[VAULT]?.rl).toEqual([3, H2]);
    expect(
      mergeMarks(
        { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [3, H1] } } },
        { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [3, H2] } } },
      ).vaults[VAULT]?.rl,
    ).toEqual([3, H1]);
    expect(
      mergeMarks(
        { vaults: { [VAULT]: { rev: 1, obj: {} } } },
        { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [1, H2] } } },
      ).vaults[VAULT]?.rl,
    ).toEqual([1, H2]);
  });

  it("is lowered only by replaceRoles, also in storage", async () => {
    for (const marks of [
      inMemorySyncMarks(),
      storedSyncMarks(memoryStore(), lock),
    ]) {
      await marks.raise(USER, {
        vaults: { [VAULT]: { rev: 5, obj: {}, rl: [4, H1] } },
      });
      await marks.replaceVault(USER, VAULT, { rev: 1, obj: {} });
      expect((await marks.read(USER)).vaults[VAULT]?.rl).toEqual([4, H1]);
      await marks.replaceRoles(USER, VAULT, [2, H2]);
      expect((await marks.read(USER)).vaults[VAULT]?.rl).toEqual([2, H2]);
      await marks.replaceRoles(USER, VAULT, undefined);
      expect((await marks.read(USER)).vaults[VAULT]?.rl).toBeUndefined();
    }
  });

  it("drops stored marks with an invalid floor", async () => {
    const store = memoryStore();
    store.text = JSON.stringify({
      v: 1,
      users: {
        [USER]: { vaults: { [VAULT]: { rev: 1, obj: {}, rl: [0, H1] } } },
      },
    });
    const marks = storedSyncMarks(store, lock);
    expect((await marks.read(USER)).vaults[VAULT]).toBeUndefined();
  });
});

describe("comparison points", () => {
  const A = "K3QF6XMA2PLRTB6WQH4N7ZDEXA";
  const B = "LTI7RYKS2VIW4CMGXO2UE2YJZA";
  const USER = U(1);

  it("are united when merged, each with the higher seq", () => {
    const merged = mergeMarks(
      { vaults: { [VAULT]: { rev: 1, obj: {}, cp: [[3, A, 0]] } } },
      {
        vaults: {
          [VAULT]: {
            rev: 1,
            obj: {},
            cp: [
              [3, A, 7],
              [4, B, 0],
            ],
          },
        },
      },
    );
    expect(merged.vaults[VAULT]?.cp).toEqual([
      [3, A, 7],
      [4, B, 0],
    ]);
    expect(
      mergeMarks(
        { vaults: { [VAULT]: { rev: 1, obj: {} } } },
        { vaults: { [VAULT]: { rev: 1, obj: {} } } },
      ).vaults[VAULT]?.cp,
    ).toBeUndefined();
  });

  it("change only through replaceComparisons, also in storage", async () => {
    for (const marks of [
      inMemorySyncMarks(),
      storedSyncMarks(memoryStore(), lock),
    ]) {
      await marks.raise(USER, {
        vaults: { [VAULT]: { rev: 5, obj: {}, cp: [[3, A, 0]] } },
      });
      await marks.replaceVault(USER, VAULT, { rev: 1, obj: {} });
      expect((await marks.read(USER)).vaults[VAULT]?.cp).toEqual([[3, A, 0]]);
      await marks.replaceComparisons(USER, VAULT, [[4, B, 2]]);
      expect((await marks.read(USER)).vaults[VAULT]?.cp).toEqual([[4, B, 2]]);
      await marks.replaceComparisons(USER, VAULT, []);
      expect((await marks.read(USER)).vaults[VAULT]?.cp).toBeUndefined();
    }
  });

  it("drop stored marks with an invalid point", async () => {
    for (const cp of [[[0, A, 0]], [[1, A.toLowerCase(), 0]], [[1, A]]]) {
      const store = memoryStore();
      store.text = JSON.stringify({
        v: 1,
        users: { [USER]: { vaults: { [VAULT]: { rev: 1, obj: {}, cp } } } },
      });
      const marks = storedSyncMarks(store, lock);
      expect((await marks.read(USER)).vaults[VAULT]).toBeUndefined();
    }
    const store = memoryStore();
    store.text = JSON.stringify({
      v: 1,
      users: {
        [USER]: { vaults: { [VAULT]: { rev: 1, obj: {}, cp: [[2, A, 3]] } } },
      },
    });
    expect(
      (await storedSyncMarks(store, lock).read(USER)).vaults[VAULT]?.cp,
    ).toEqual([[2, A, 3]]);
  });
});

describe("confirmation of user_data", () => {
  const USER = U(1);

  it("keeps period and strict mode with the later uf, the other's where it has none", () => {
    expect(
      mergeMarks(
        { uf: 1, fd: 7, fs: true, vaults: {} },
        { uf: 2, fd: 3, fs: false, vaults: {} },
      ),
    ).toEqual({ uf: 2, fd: 3, fs: false, vaults: {} });
    expect(
      mergeMarks({ uf: 1, fd: 7, fs: true, vaults: {} }, { uf: 2, vaults: {} }),
    ).toEqual({ uf: 2, fd: 7, fs: true, vaults: {} });
    expect(
      mergeMarks(
        { uf: 3, fs: true, vaults: {} },
        { uf: 2, fs: false, vaults: {} },
      ),
    ).toEqual({ uf: 3, fs: true, vaults: {} });
  });

  it("stores strict mode and stays strict where it is no boolean", async () => {
    const store = memoryStore();
    const marks = storedSyncMarks(store, lock);
    await marks.raise(USER, { uf: 5, fd: 7, fs: true, vaults: {} });
    expect(await storedSyncMarks(store, lock).read(USER)).toMatchObject({
      uf: 5,
      fd: 7,
      fs: true,
    });
    store.text = JSON.stringify({
      v: 1,
      users: { [USER]: { uf: 5, fs: 1, vaults: {} } },
    });
    expect(await storedSyncMarks(store, lock).read(USER)).toEqual({
      uf: 5,
      fs: true,
      vaults: {},
    });
  });

  it("drops only the broken part of the stored marks", async () => {
    const store = memoryStore();
    const other = U(9);
    store.text = JSON.stringify({
      v: 1,
      users: {
        [USER]: {
          ud: [3, 4],
          uf: "never",
          vaults: {
            [VAULT]: { rev: 2, obj: {}, kv: 1e20 },
            [U(8)]: { rev: 5, obj: {}, ft: 1 },
          },
        },
        [other]: { vaults: { [VAULT]: { rev: 7, obj: {} } } },
      },
    });
    const marks = storedSyncMarks(store, lock);
    // A broken confirmation time counts as never, not as marks from before
    // confirmation times; the other vault and account stay.
    expect(await marks.read(USER)).toEqual({
      ud: [3, 4],
      uf: 0,
      vaults: { [U(8)]: { rev: 5, obj: {}, ft: 1 } },
    });
    expect((await marks.read(other)).vaults[VAULT]?.rev).toBe(7);
  });

  it("keeps at most 64 comparison points per vault, unwritten ones first", async () => {
    const marks = inMemorySyncMarks();
    const code = (i: number) =>
      `${"A".repeat(24)}${"BCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(i / 4) % 31] ?? "B"}${"AEIMQUY4"[i % 4] ?? "A"}`;
    const points = Array.from(
      { length: 70 },
      (_, i): [number, string, number] => [i + 1, code(i), i < 10 ? 0 : i],
    );
    await marks.replaceComparisons(USER, VAULT, points);
    const kept = (await marks.read(USER)).vaults[VAULT]?.cp ?? [];
    expect(kept).toHaveLength(64);
    // The unwritten ones exist nowhere else; the oldest written ones go.
    expect(kept.filter((p) => p[2] === 0)).toHaveLength(10);
    expect(kept.some((p) => p[2] === 10)).toBe(false);
  });
});
